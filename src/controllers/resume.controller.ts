import { Response } from 'express';
import crypto from 'node:crypto';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest } from '../types';
import { User } from '../models/User';
import { logger } from '../utils/logger';
import { parseResumeText } from '../services/ai/resumeParser.service';
import {
  CLOUDINARY_FOLDERS,
  destroyAsset,
  isCloudinaryConfigured,
  signedDeliveryUrl,
  uploadBuffer,
} from '../config/cloudinary';

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
  await user.save();

  if (oldPublicId && oldPublicId !== result.publicId) {
    await destroyAsset(oldPublicId, 'raw', 'authenticated');
  }

  res.status(201).json({
    success: true,
    message: 'Resume uploaded',
    data: {
      file: user.profile.resumeFile,
      extractedTextLength: resumeText.length,
      // Clients should call GET /resume to obtain a fresh signed URL each time.
      downloadUrl: `/api/v1/users/resume`,
    },
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

  res.redirect(302, signed);
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

export const deleteResumeHandler = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const user = await User.findById(req.user._id);
  if (!user || !user.profile.resumeFile) throw ApiError.notFound('No resume to delete');

  const publicId = user.profile.resumeFile.publicId;
  user.profile.resumeFile = undefined;
  user.profile.resumeText = undefined;
  user.profile.resumeUrl = undefined;
  await user.save();

  if (publicId) await destroyAsset(publicId, 'raw', 'authenticated');

  res.json({ success: true, message: 'Resume deleted' });
});
