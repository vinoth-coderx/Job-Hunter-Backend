import { NextFunction, Request, Response } from 'express';
import { ApiError } from '../utils/ApiError';
import { SecurityEvent } from '../models/SecurityEvent';
import { logger } from '../utils/logger';

// Magic-number signatures for the file types we accept. MIME headers
// can be lied about by the client; the first few bytes can't. We
// validate every uploaded buffer against this table after multer parses
// it but before any cloud upload runs.
type Sig = { name: string; bytes: number[]; offset?: number };
const SIGS: Sig[] = [
  { name: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
  { name: 'jpg', bytes: [0xff, 0xd8, 0xff] },
  { name: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { name: 'webp', bytes: [0x52, 0x49, 0x46, 0x46], offset: 0 },
  { name: 'gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { name: 'doc', bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
  { name: 'docx-zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { name: 'xls', bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
];

const matchesSig = (buf: Buffer, sig: Sig): boolean => {
  const offset = sig.offset ?? 0;
  if (buf.length < offset + sig.bytes.length) return false;
  for (let i = 0; i < sig.bytes.length; i++) {
    if (buf[offset + i] !== sig.bytes[i]) return false;
  }
  return true;
};

const looksSafe = (buf: Buffer): boolean => SIGS.some((s) => matchesSig(buf, s));

// Quick-and-dirty malware heuristic — full ClamAV scan is wired into a
// follow-up cloud function call. This catches the obvious EICAR-style
// test signatures and embedded JS in PDFs which is the most common
// real-world payload we'd see in resume uploads.
const SUSPICIOUS_PATTERNS = [
  Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'),
  Buffer.from('/JavaScript'),
  Buffer.from('/JS'),
  Buffer.from('<script'),
];

const looksSuspicious = (buf: Buffer): boolean =>
  SUSPICIOUS_PATTERNS.some((p) => buf.includes(p));

export const verifyUploadSafety = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  const files: { buffer?: Buffer; originalname?: string }[] = [];
  // multer.single: req.file. multer.array: req.files (array). We
  // intentionally don't support fields() uploads here.
  const reqFile = (req as unknown as { file?: { buffer?: Buffer; originalname?: string } }).file;
  if (reqFile) files.push(reqFile);
  const reqFiles = (req as unknown as { files?: { buffer?: Buffer; originalname?: string }[] }).files;
  if (Array.isArray(reqFiles)) files.push(...reqFiles);

  for (const f of files) {
    if (!f.buffer) continue;
    if (!looksSafe(f.buffer)) {
      logger.warn(`[fileSafety] magic number mismatch: ${f.originalname}`);
      return next(new ApiError(400, 'Uploaded file did not match its declared type'));
    }
    if (looksSuspicious(f.buffer)) {
      await SecurityEvent.create({
        user: (req as Request & { userId?: string }).userId
          ? undefined
          : undefined,
        type: 'malware_upload_blocked',
        severity: 'high',
        ip: req.ip,
        userAgent: req.headers['user-agent'] as string | undefined,
        metadata: { filename: f.originalname },
      }).catch(() => undefined);
      return next(new ApiError(400, 'Upload blocked: file appears unsafe'));
    }
  }
  next();
};
