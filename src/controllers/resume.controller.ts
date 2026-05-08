import { Response } from 'express';
import path from 'path';
import fs from 'fs/promises';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest } from '../types';
import { User } from '../models/User';
import { logger } from '../utils/logger';
import { RESUME_DIR } from '../middleware/upload';
import { parseResumeText } from '../services/ai/resumeParser.service';

const extractText = async (filePath: string, mime: string): Promise<string> => {
  try {
    if (mime === 'application/pdf') {
      const { PDFParse } = await import('pdf-parse');
      const buf = await fs.readFile(filePath);
      const parser = new PDFParse({ data: new Uint8Array(buf) });
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
      const result = await mammoth.extractRawText({ path: filePath });
      return (result.value || '').trim().slice(0, 20000);
    }
    return '';
  } catch (err) {
    logger.warn('Resume text extraction failed', { filePath, err });
    return '';
  }
};

const removeFileQuiet = async (filename?: string): Promise<void> => {
  if (!filename) return;
  try {
    await fs.unlink(path.join(RESUME_DIR, filename));
  } catch {
    // already gone
  }
};

export const uploadResumeHandler = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  if (!req.file) throw ApiError.badRequest('No file uploaded — field name must be "resume"');

  const user = await User.findById(req.user._id);
  if (!user) {
    await removeFileQuiet(req.file.filename);
    throw ApiError.notFound('User not found');
  }

  const oldFilename = user.profile.resumeFile?.filename;

  const resumeText = await extractText(req.file.path, req.file.mimetype);

  user.profile.resumeFile = {
    filename: req.file.filename,
    originalName: req.file.originalname,
    mimeType: req.file.mimetype,
    size: req.file.size,
    uploadedAt: new Date(),
  };
  if (resumeText) user.profile.resumeText = resumeText;
  await user.save();

  if (oldFilename && oldFilename !== req.file.filename) {
    await removeFileQuiet(oldFilename);
  }

  res.status(201).json({
    success: true,
    message: 'Resume uploaded',
    data: {
      file: user.profile.resumeFile,
      extractedTextLength: resumeText.length,
      downloadUrl: `/api/v1/users/resume`,
    },
  });
});

export const downloadResumeHandler = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();

  const user = await User.findById(req.user._id);
  if (!user || !user.profile.resumeFile) throw ApiError.notFound('No resume on file');

  const filePath = path.join(RESUME_DIR, user.profile.resumeFile.filename);
  try {
    await fs.access(filePath);
  } catch {
    throw ApiError.notFound('Resume file missing on disk');
  }

  res.setHeader('Content-Type', user.profile.resumeFile.mimeType);
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${user.profile.resumeFile.originalName.replace(/"/g, '')}"`,
  );
  res.sendFile(filePath);
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

  const filename = user.profile.resumeFile.filename;
  user.profile.resumeFile = undefined;
  user.profile.resumeText = undefined;
  await user.save();

  await removeFileQuiet(filename);

  res.json({ success: true, message: 'Resume deleted' });
});
