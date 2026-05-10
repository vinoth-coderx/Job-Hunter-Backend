/**
 * Centralised Cloudinary client. All file uploads in the app — avatars,
 * resumes, company logos, office photos — flow through here.
 *
 * Setup:
 *   Cloudinary Console → Dashboard → API Environment variable copies the
 *   triplet (cloud_name, api_key, api_secret). Put those in `.env`.
 *
 * Resource types we use:
 *   - 'image' for avatars / logos / office photos (auto-optimised by CDN)
 *   - 'raw'   for resumes (PDF / DOC / DOCX) — uploaded as 'authenticated'
 *             so the secure_url alone won't grant access; download routes
 *             must mint a signed URL via [signedDeliveryUrl].
 *
 * Folder names below are hardcoded — they're not secrets and changing
 * them would orphan existing assets. Only the credentials live in env.
 */

import { v2 as cloudinary, type UploadApiOptions } from 'cloudinary';
import { Readable } from 'node:stream';
import { env } from './env';
import { logger } from '../utils/logger';

let configured = false;

const ensureConfigured = (): boolean => {
  if (configured) return true;
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = env;
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    return false;
  }
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
    secure: true,
  });
  configured = true;
  logger.info(`Cloudinary configured (cloud_name=${CLOUDINARY_CLOUD_NAME})`);
  return true;
};

export const isCloudinaryConfigured = (): boolean =>
  Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);

// Folder layout — hardcoded; only credentials are sensitive.
export const CLOUDINARY_FOLDERS = {
  AVATAR: 'job_hunter/avatars',
  RESUME: 'job_hunter/resumes',
  COMPANY_LOGO: 'job_hunter/company_logos',
  OFFICE_PHOTO: 'job_hunter/office_photos',
} as const;

export type CloudinaryResourceType = 'image' | 'raw' | 'video';
export type CloudinaryDeliveryType = 'upload' | 'authenticated' | 'private';

export interface CloudinaryUploadResult {
  url: string;        // secure_url (HTTPS)
  publicId: string;
  bytes: number;
  format: string;
  resourceType: CloudinaryResourceType;
  type: CloudinaryDeliveryType;
  width?: number;
  height?: number;
}

export interface UploadOpts {
  folder: string;
  /** When provided, overwrite is honoured; otherwise Cloudinary mints a random ID. */
  publicId?: string;
  resourceType?: CloudinaryResourceType;
  type?: CloudinaryDeliveryType;
  overwrite?: boolean;
  tags?: string[];
  /** Forces a specific format (e.g. 'pdf' for resumes). */
  format?: string;
}

/** Upload an in-memory Buffer to Cloudinary via the streaming API. */
export const uploadBuffer = (
  buffer: Buffer,
  opts: UploadOpts,
): Promise<CloudinaryUploadResult> => {
  if (!ensureConfigured()) {
    return Promise.reject(
      new Error('Cloudinary not configured — set CLOUDINARY_CLOUD_NAME / API_KEY / API_SECRET'),
    );
  }
  const uploadOptions: UploadApiOptions = {
    folder: opts.folder,
    public_id: opts.publicId,
    resource_type: opts.resourceType ?? 'image',
    type: opts.type ?? 'upload',
    overwrite: opts.overwrite ?? true,
    tags: opts.tags,
    format: opts.format,
    use_filename: false,
    unique_filename: !opts.publicId,
  };
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(uploadOptions, (err, result) => {
      if (err || !result) {
        return reject(err ?? new Error('Cloudinary upload returned no result'));
      }
      resolve({
        url: result.secure_url,
        publicId: result.public_id,
        bytes: result.bytes ?? 0,
        format: result.format ?? '',
        resourceType: (result.resource_type as CloudinaryResourceType) ?? 'image',
        type: (result.type as CloudinaryDeliveryType) ?? 'upload',
        width: result.width,
        height: result.height,
      });
    });
    Readable.from(buffer).pipe(stream);
  });
};

/** Best-effort delete — never throws; failures are logged only. */
export const destroyAsset = async (
  publicId: string,
  resourceType: CloudinaryResourceType = 'image',
  type: CloudinaryDeliveryType = 'upload',
): Promise<void> => {
  if (!ensureConfigured()) return;
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, {
      resource_type: resourceType,
      type,
      invalidate: true,
    });
  } catch (err) {
    logger.warn('Cloudinary destroy failed', { publicId, err });
  }
};

/**
 * Mint a short-lived signed URL for a non-public asset (used for resumes
 * stored as type='authenticated'). Default TTL: 10 minutes.
 */
export const signedDeliveryUrl = (
  publicId: string,
  opts: {
    resourceType?: CloudinaryResourceType;
    type?: CloudinaryDeliveryType;
    format?: string;
    expiresInSec?: number;
    attachmentFilename?: string;
  } = {},
): string => {
  if (!ensureConfigured()) {
    throw new Error('Cloudinary not configured — cannot sign URL');
  }
  const expiresAt = Math.floor(Date.now() / 1000) + (opts.expiresInSec ?? 600);
  return cloudinary.url(publicId, {
    sign_url: true,
    type: opts.type ?? 'authenticated',
    resource_type: opts.resourceType ?? 'raw',
    secure: true,
    format: opts.format,
    expires_at: expiresAt,
    attachment: opts.attachmentFilename,
  });
};

/**
 * Parse the public_id out of a Cloudinary delivery URL — handy when an
 * older record only stored the URL string (e.g. office photos array).
 * Returns null for URLs that don't match the Cloudinary pattern.
 */
export const publicIdFromUrl = (url: string | undefined | null): string | null => {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes('cloudinary.com')) return null;
    // Pattern: /<cloud_name>/<resource_type>/<delivery_type>/[v<version>/]<public_id>[.<ext>]
    const match = parsed.pathname.match(
      /\/(?:image|raw|video)\/(?:upload|authenticated|private)\/(?:v\d+\/)?(.+?)(?:\.[a-z0-9]+)?$/i,
    );
    return match?.[1] ?? null;
  } catch {
    return null;
  }
};

export { cloudinary };
