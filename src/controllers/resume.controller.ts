import { Response } from 'express';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest } from '../types';
import { User } from '../models/User';
import { logger } from '../utils/logger';
import { parseResumeText } from '../services/ai/resumeParser.service';
import { runResumeOnboarding } from '../services/ai/combined/resumeOnboarding.service';
import { enforceQuota, refundQuota } from '../services/ai/quota.service';
import { getCreditWeight } from '../config/aiCreditWeights';
import { maybeGrantProfileCompleteBonus } from '../services/coins/coin.service';
import { Job } from '../models/Job';
import { JOB_FRESHNESS_DAYS } from '../config/constants';
import {
  CLOUDINARY_FOLDERS,
  destroyAsset,
  isCloudinaryConfigured,
  signedDeliveryUrl,
  uploadBuffer,
} from '../config/cloudinary';
import { generateBrandedResumePdf } from '../services/resume/resumePdf.service';

const SIGNED_URL_TTL_SEC = 600; // 10 min — long enough to start a download.

const extractTextFromBuffer = async (buffer: Buffer, mime: string): Promise<string> => {
  try {
    if (mime === 'application/pdf') {
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      try {
        const result = await parser.getText();
        const text = result.pages?.map((p) => p.text || '').join('\n') || result.text || '';
        return text.trim().slice(0, 20000);
      } finally {
        await parser.destroy().catch(() => {});
      }
    }
    if (
      mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      mime === 'application/msword'
    ) {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      return (result.value || '').trim().slice(0, 20000);
    }
    return '';
  } catch (err) {
    logger.warn('Resume text extraction failed', { err });
    return '';
  }
};

const formatFromMime = (mime: string): string => {
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'application/msword') return 'doc';
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return 'docx';
  }
  return 'bin';
};

export const uploadResumeHandler = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  if (!req.file || !req.file.buffer) {
    throw ApiError.badRequest('No file uploaded — field name must be "resume"');
  }
  if (!isCloudinaryConfigured()) {
    throw ApiError.internal('Cloudinary is not configured on the server');
  }

  const user = await User.findById(req.user._id);
  if (!user) throw ApiError.notFound('User not found');

  const oldPublicId = user.profile.resumeFile?.publicId;

  // Random suffix in the public_id so even if a URL leaks, a fresh
  // upload immediately invalidates it.
  const suffix = crypto.randomBytes(6).toString('hex');
  const fmt = formatFromMime(req.file.mimetype);

  const result = await uploadBuffer(req.file.buffer, {
    folder: CLOUDINARY_FOLDERS.RESUME,
    publicId: `user_${user._id.toString()}_${suffix}`,
    resourceType: 'raw',
    type: 'authenticated',
    overwrite: false,
    tags: ['resume', `user:${user._id.toString()}`],
    format: fmt,
  });

  // Defensive guard: Cloudinary occasionally returns a 200 with an
  // empty publicId on misconfigured accounts. Catching it here and
  // 500ing surfaces the failure to the client instead of silently
  // persisting a half-formed resumeFile that the download/delete
  // paths will reject with "no resume on file" later.
  if (!result.publicId) {
    logger.error('Cloudinary upload returned empty publicId', { result });
    throw ApiError.internal(
      'Resume storage misconfigured: upload returned no asset id',
    );
  }

  const resumeText = await extractTextFromBuffer(req.file.buffer, req.file.mimetype);

  user.profile.resumeFile = {
    publicId: result.publicId,
    url: result.url,
    filename: result.publicId.split('/').pop() ?? result.publicId,
    originalName: req.file.originalname,
    mimeType: req.file.mimetype,
    size: result.bytes || req.file.size,
    uploadedAt: new Date(),
  };
  user.profile.resumeUrl = result.url;
  if (resumeText) user.profile.resumeText = resumeText;
  user.markModified('profile.resumeFile');
  await user.save();

  // Round-trip verification: re-read the user document and confirm
  // resumeFile.publicId actually landed in Mongo. Mongoose's strict
  // schema mode has been observed to silently drop sub-document
  // writes when the parent path isn't explicitly marked modified —
  // the markModified above + this read-back catches any residual
  // drift before the client thinks the upload succeeded.
  const reread = await User.findById(user._id).select('profile.resumeFile').lean();
  const storedPublicId = reread?.profile?.resumeFile?.publicId;
  if (!storedPublicId) {
    logger.error('Resume upload did not persist resumeFile', {
      userId: user._id.toString(),
      expectedPublicId: result.publicId,
      stored: reread?.profile?.resumeFile ?? null,
    });
    throw ApiError.internal(
      'Resume upload didn\'t persist correctly. Please contact support.',
    );
  }

  if (oldPublicId && oldPublicId !== result.publicId) {
    await destroyAsset(oldPublicId, 'raw', 'authenticated');
  }

  // A resume upload often pushes the user across the 100% threshold —
  // check immediately so the seeker sees the bonus reflected in the
  // upload response (no separate refresh needed).
  const completenessGrant = await maybeGrantProfileCompleteBonus(user);

  res.status(201).json({
    success: true,
    message: 'Resume uploaded',
    data: {
      file: user.profile.resumeFile,
      extractedTextLength: resumeText.length,
      // Clients should call GET /resume to obtain a fresh signed URL each time.
      downloadUrl: `/api/v1/users/resume`,
    },
    coinsAwarded: completenessGrant?.amount ?? 0,
    coinsBalance:
      completenessGrant?.balance ?? user.gamification?.coins ?? 0,
  });
});

export const downloadResumeHandler = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();

  const user = await User.findById(req.user._id);
  if (!user || !user.profile.resumeFile?.publicId) {
    throw ApiError.notFound('No resume on file');
  }

  const file = user.profile.resumeFile;
  const signed = signedDeliveryUrl(file.publicId!, {
    resourceType: 'raw',
    type: 'authenticated',
    format: formatFromMime(file.mimeType),
    expiresInSec: SIGNED_URL_TTL_SEC,
    attachmentFilename: file.originalName,
  });

  // Why we proxy instead of `res.redirect(302, signed)`:
  // Mobile HTTP clients (Dart's `package:http`) follow 302s but keep the
  // original Authorization header attached to the follow-up request.
  // Cloudinary saw the unrecognised Bearer token and returned 404 with
  // no body, which the client surfaced as "no resume on file" — even
  // though the asset was perfectly fine. Streaming the bytes through
  // here strips that header path entirely and lets us bubble a real
  // upstream-failure message when Cloudinary itself errors.
  try {
    const upstream = await fetch(signed, {
      redirect: 'follow',
      headers: { Accept: file.mimeType || 'application/octet-stream' },
    });
    if (!upstream.ok || !upstream.body) {
      logger.warn('Resume proxy: upstream non-2xx', {
        status: upstream.status,
        publicId: file.publicId,
      });
      // Upstream-404 means the Mongo `resumeFile` record points at an
      // asset that no longer exists in Cloudinary (deleted manually,
      // failed upload that left a stub, env swap, etc.). Two things:
      //
      //   1. Heal the user doc — clear the orphaned reference so the
      //      next call short-circuits at the "no resume on file" guard
      //      above instead of round-tripping to Cloudinary again.
      //   2. Surface the right status — 410 Gone is what the Flutter
      //      `_handleMissingResume` already branches on to prompt
      //      re-upload. Returning 500 here got logged as a server-side
      //      bug and showed a generic error on the client.
      if (upstream.status === 404) {
        await User.updateOne(
          { _id: user._id },
          { $unset: { 'profile.resumeFile': '' } },
        ).catch((e) => {
          logger.warn('Resume proxy: failed to clear orphaned resumeFile', {
            err: (e as Error).message,
          });
        });
        throw ApiError.gone(
          'Your resume is no longer in storage. Please re-upload it.',
        );
      }
      // Anything else (502 from Cloudinary, transient 5xx) is a real
      // server-side problem and stays an internal error.
      throw ApiError.internal(
        `Resume storage returned ${upstream.status}. Please re-upload your resume.`,
      );
    }
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    if (file.size) res.setHeader('Content-Length', String(file.size));
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${file.originalName || 'resume'}"`,
    );
    // Stream the body through. `Readable.fromWeb` lifts the WHATWG
    // ReadableStream that `fetch` returns into a Node stream so we can
    // pipe it into the Express response.
    const nodeStream = Readable.fromWeb(upstream.body as never);
    nodeStream.pipe(res);
    await new Promise<void>((resolve, reject) => {
      nodeStream.on('end', resolve);
      nodeStream.on('error', reject);
      res.on('close', resolve);
    });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    logger.warn('Resume proxy fetch failed', { err });
    throw ApiError.internal('Could not load resume from storage');
  }
});

export const resumeMetaHandler = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const user = await User.findById(req.user._id).select('profile.resumeFile profile.resumeText');
  if (!user || !user.profile.resumeFile) {
    res.json({ success: true, data: null });
    return;
  }
  res.json({
    success: true,
    data: {
      file: user.profile.resumeFile,
      hasExtractedText: !!user.profile.resumeText,
      extractedTextLength: user.profile.resumeText?.length || 0,
      downloadUrl: `/api/v1/users/resume`,
    },
  });
});

/**
 * Runs the stored resume text through the LLM parser and returns a
 * structured JSON the client can merge into its local resume profile.
 * Idempotent — safe to retry. Always returns 200 with whatever could be
 * parsed; an empty object means the LLM had nothing to work with (e.g.
 * scanned PDF with no extractable text).
 */
export const parseResumeHandler = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const user = await User.findById(req.user._id).select('profile.resumeText profile.resumeFile');
  if (!user) throw ApiError.notFound('User not found');

  const text = user.profile.resumeText || '';
  if (!text) {
    res.json({
      success: true,
      message: 'No resume text available — upload a text-based PDF or DOCX first.',
      data: null,
    });
    return;
  }

  const parsed = await parseResumeText(text);
  res.json({ success: true, data: parsed });
});

/**
 * Single-call onboarding: takes the user's stored resume text + the freshest
 * native+external job pool, runs ONE Gemini "smart" call, and returns the
 * parsed resume, top matches, and concrete resume improvement suggestions.
 *
 * Counts as a single AI quota slot. Refunds the slot if the LLM produces no
 * usable result (quota over → 429 with countdown payload).
 */
export const resumeOnboardHandler = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const userId = String(req.user._id);

  const user = await User.findById(userId).select('profile.resumeText profile.fullName profile.skills');
  if (!user) throw ApiError.notFound('User not found');

  const text = user.profile.resumeText || '';
  if (!text) {
    res.json({
      success: true,
      message: 'No resume text available — upload a text-based PDF or DOCX first.',
      data: null,
    });
    return;
  }

  const weight = getCreditWeight('resume_onboarding');
  const quota = await enforceQuota(userId, weight);

  const sinceMs = Date.now() - JOB_FRESHNESS_DAYS * 24 * 60 * 60 * 1000;
  const candidates = await Job.find({
    status: 'active',
    postedAt: { $gte: new Date(sinceMs) },
  })
    .sort({ postedAt: -1 })
    .limit(30)
    .lean();

  let result;
  try {
    result = await runResumeOnboarding(text, candidates as never);
  } catch (err) {
    await refundQuota(userId, weight);
    throw err;
  }

  if (!result) {
    await refundQuota(userId, weight);
    res.json({
      success: true,
      message: 'Resume too short or AI unavailable',
      data: null,
      quota,
    });
    return;
  }

  res.json({ success: true, data: result, quota });
});

/**
 * Branded resume PDF download. Renders the user's structured resume
 * profile through the Job Hunter template (Puppeteer-headless) and
 * streams the PDF bytes back. No AI cost — pure template render — but
 * we still require a populated profile so the output isn't an empty
 * shell.
 */
export const downloadBrandedResumePdfHandler = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const user = await User.findById(req.user._id);
    if (!user) throw ApiError.notFound('User not found');

    const p = user.profile;
    const hasContent =
      Boolean(p.resumeProfile?.profileSummary) ||
      (p.skills && p.skills.length > 0) ||
      (p.resumeProfile?.employments && p.resumeProfile.employments.length > 0) ||
      (p.resumeProfile?.educations && p.resumeProfile.educations.length > 0);
    if (!hasContent) {
      throw ApiError.badRequest(
        'Fill in at least your summary, skills, or experience before downloading the branded resume',
      );
    }

    const { buffer, filename } = await generateBrandedResumePdf(user);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`,
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(buffer);
  },
);

export const deleteResumeHandler = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const user = await User.findById(req.user._id);
  if (!user) throw ApiError.notFound('User not found');

  // Resume state is spread across three fields (resumeFile, resumeText,
  // resumeUrl) and they can drift on legacy accounts — e.g. resumeText
  // got persisted but the Cloudinary upload never completed, leaving
  // resumeFile undefined. Clear every trace regardless so the user can
  // recover from those stuck states by tapping Remove + re-uploading.
  const hadAnything =
    Boolean(user.profile.resumeFile) ||
    Boolean(user.profile.resumeText) ||
    Boolean(user.profile.resumeUrl);
  if (!hadAnything) {
    res.json({ success: true, message: 'No resume to delete' });
    return;
  }

  const publicId = user.profile.resumeFile?.publicId;
  user.profile.resumeFile = undefined;
  user.profile.resumeText = undefined;
  user.profile.resumeUrl = undefined;
  await user.save();

  if (publicId) await destroyAsset(publicId, 'raw', 'authenticated');

  res.json({ success: true, message: 'Resume deleted' });
});
