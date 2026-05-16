import { Response } from 'express';
import { z } from 'zod';
import { AuthRequest } from '../types';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import {
  ResumeTemplate,
  MIN_PUBLISH_ATS_SCORE,
  ResumeTemplateStatus,
} from '../models/ResumeTemplate';
import {
  enhanceTemplate,
  scoreTemplate,
} from '../services/resume/templateEnhancer.service';
import { renderTemplateThumbnail } from '../services/resume/templateRenderer.service';
import {
  uploadBuffer,
  destroyAsset,
  publicIdFromUrl,
  isCloudinaryConfigured,
} from '../config/cloudinary';
import { logger } from '../utils/logger';

/**
 * Admin CRUD for resume templates.
 *
 * Flow:
 *   1. POST /admin/resume-templates          { html, name, ... } → status=draft, scored
 *   2. POST /:slug/enhance                    runs AI enhancer, status=enhanced
 *   3. PATCH /:slug                           accept/reject enhanced, switch liveSource
 *   4. POST /:slug/publish                    flips status=published if ATS >= MIN
 *   5. POST /:slug/archive                    hides from user template picker
 *   6. DELETE /:slug
 */

const SLUG_RE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;

export const createTemplateSchema = z.object({
  body: z.object({
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .min(3)
      .max(40)
      .regex(SLUG_RE, 'slug must be lowercase letters/digits/- only'),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(400).default(''),
    category: z.string().trim().toLowerCase().max(40).default('general'),
    htmlOriginal: z.string().min(100, 'template HTML looks too short').max(200_000),
    isPremium: z.boolean().default(false),
    sortOrder: z.number().int().min(0).max(10_000).default(100),
    previewImageUrl: z.string().url().nullable().default(null),
  }),
});

export const updateTemplateSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(400).optional(),
    category: z.string().trim().toLowerCase().max(40).optional(),
    htmlOriginal: z.string().min(100).max(200_000).optional(),
    isPremium: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
    previewImageUrl: z.string().url().nullable().optional(),
    liveSource: z.enum(['original', 'enhanced']).optional(),
  }),
  params: z.object({ slug: z.string().min(1) }),
});

export const statusActionSchema = z.object({
  params: z.object({ slug: z.string().min(1) }),
});

const liveHtmlOf = (
  t: { liveSource: string; htmlOriginal: string; htmlEnhanced: string | null },
): string =>
  t.liveSource === 'enhanced' && t.htmlEnhanced ? t.htmlEnhanced : t.htmlOriginal;

/**
 * Render the live HTML to a PNG thumbnail and upload to Cloudinary.
 * Best-effort: a Puppeteer or Cloudinary failure is logged but doesn't
 * prevent the underlying publish/edit action — the template's preview
 * just stays at its previous value.
 */
const refreshThumbnailFor = async (
  slug: string,
  html: string,
  existingUrl: string | null,
): Promise<string | null> => {
  if (!isCloudinaryConfigured()) {
    logger.warn(
      `Skipping template thumbnail for ${slug}: Cloudinary not configured`,
    );
    return existingUrl;
  }
  try {
    const png = await renderTemplateThumbnail(html);
    const result = await uploadBuffer(png, {
      folder: 'job_hunter/resume_template_thumbs',
      publicId: `tpl_${slug}`,
      resourceType: 'image',
      overwrite: true,
      tags: ['resume-template-thumb'],
      format: 'png',
    });
    // If the previous thumbnail was at a different public_id (e.g. slug
    // pattern changed), best-effort drop it so we don't pay storage for
    // dead assets.
    if (existingUrl) {
      const oldId = publicIdFromUrl(existingUrl);
      if (oldId && oldId !== result.publicId) {
        await destroyAsset(oldId, 'image', 'upload');
      }
    }
    return result.url;
  } catch (err) {
    logger.warn(
      `Template thumbnail refresh failed for ${slug}: ${(err as Error).message}`,
    );
    return existingUrl;
  }
};

export const listAdminTemplates = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const status = req.query.status as ResumeTemplateStatus | undefined;
    const filter = status ? { status } : {};
    // Exclude the heavy HTML fields from the list view; load detail on click.
    const docs = await ResumeTemplate.find(filter)
      .sort({ sortOrder: 1, createdAt: -1 })
      .select('-htmlOriginal -htmlEnhanced')
      .lean();
    res.json({
      templates: docs.map((t) => ({
        ...t,
        _id: t._id.toString(),
        createdBy: t.createdBy?.toString() ?? null,
      })),
      minPublishScore: MIN_PUBLISH_ATS_SCORE,
    });
  },
);

export const getAdminTemplate = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const doc = await ResumeTemplate.findOne({ slug: req.params.slug }).lean();
    if (!doc) throw ApiError.notFound('Template not found');
    res.json({
      template: {
        ...doc,
        _id: doc._id.toString(),
        createdBy: doc.createdBy?.toString() ?? null,
      },
      liveHtml: liveHtmlOf(doc),
      minPublishScore: MIN_PUBLISH_ATS_SCORE,
    });
  },
);

export const createTemplate = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const body = req.body as z.infer<typeof createTemplateSchema>['body'];
    const existing = await ResumeTemplate.findOne({ slug: body.slug });
    if (existing) throw ApiError.conflict(`Slug '${body.slug}' is already used.`);

    const score = scoreTemplate(body.htmlOriginal);

    const doc = await ResumeTemplate.create({
      ...body,
      htmlEnhanced: null,
      liveSource: 'original',
      status: 'draft',
      atsScore: score.score,
      atsScoreSource: score.source,
      atsNotes: score.notes,
      createdBy: req.user?._id ?? null,
    });

    res.status(201).json({
      template: doc.toJSON(),
      minPublishScore: MIN_PUBLISH_ATS_SCORE,
    });
  },
);

export const updateTemplate = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const body = req.body as z.infer<typeof updateTemplateSchema>['body'];
    const doc = await ResumeTemplate.findOne({ slug: req.params.slug });
    if (!doc) throw ApiError.notFound('Template not found');

    Object.assign(doc, body);

    // If the original HTML or liveSource changed, rescore so the gate is
    // always evaluated against the live copy. Published templates whose
    // score drops below the gate are automatically reverted to 'enhanced'.
    const liveCopyChanged = Boolean(body.htmlOriginal || body.liveSource);
    if (liveCopyChanged) {
      const score = scoreTemplate(liveHtmlOf(doc));
      doc.atsScore = score.score;
      doc.atsScoreSource = score.source;
      doc.atsNotes = score.notes;
      if (doc.status === 'published' && score.score < MIN_PUBLISH_ATS_SCORE) {
        doc.status = 'enhanced';
      }
    }

    // Keep the thumbnail in sync with the live copy when the template is
    // already published; for draft/enhanced templates the thumbnail will
    // be rendered next time the admin clicks publish.
    if (liveCopyChanged && doc.status === 'published') {
      doc.previewImageUrl = await refreshThumbnailFor(
        doc.slug,
        liveHtmlOf(doc),
        doc.previewImageUrl,
      );
    }

    await doc.save();
    res.json({ template: doc.toJSON() });
  },
);

export const enhanceTemplateEndpoint = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const doc = await ResumeTemplate.findOne({ slug: req.params.slug });
    if (!doc) throw ApiError.notFound('Template not found');

    const result = await enhanceTemplate(doc.htmlOriginal);
    doc.htmlEnhanced = result.html;
    if (doc.status === 'draft') doc.status = 'enhanced';

    // Score the proposed enhanced HTML so the admin can see whether
    // accepting the suggestion would clear the publish gate.
    const score = scoreTemplate(result.html);
    doc.atsScore = score.score;
    doc.atsScoreSource = score.source;
    doc.atsNotes = score.notes;

    await doc.save();
    res.json({
      template: doc.toJSON(),
      changes: result.changes,
      usedAi: result.usedAi,
      warnings: result.warnings,
      minPublishScore: MIN_PUBLISH_ATS_SCORE,
    });
  },
);

export const publishTemplate = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const doc = await ResumeTemplate.findOne({ slug: req.params.slug });
    if (!doc) throw ApiError.notFound('Template not found');

    // Re-score against the currently-live copy so admins can't sneak past
    // the gate by editing-then-publishing without going through update().
    const score = scoreTemplate(liveHtmlOf(doc));
    doc.atsScore = score.score;
    doc.atsScoreSource = score.source;
    doc.atsNotes = score.notes;
    if (score.score < MIN_PUBLISH_ATS_SCORE) {
      await doc.save();
      throw ApiError.badRequest(
        `ATS score ${score.score} is below the minimum ${MIN_PUBLISH_ATS_SCORE}. ` +
          `Run AI enhance or edit the template before publishing.`,
      );
    }
    doc.status = 'published';
    // Refresh the public thumbnail on every publish so card previews
    // always match what users would actually see.
    doc.previewImageUrl = await refreshThumbnailFor(
      doc.slug,
      liveHtmlOf(doc),
      doc.previewImageUrl,
    );
    await doc.save();
    res.json({ template: doc.toJSON() });
  },
);

export const archiveTemplate = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const doc = await ResumeTemplate.findOneAndUpdate(
      { slug: req.params.slug },
      { $set: { status: 'archived' } },
      { new: true },
    );
    if (!doc) throw ApiError.notFound('Template not found');
    res.json({ template: doc.toJSON() });
  },
);

export const deleteTemplate = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const doc = await ResumeTemplate.findOneAndDelete({
      slug: req.params.slug,
    });
    if (!doc) throw ApiError.notFound('Template not found');
    if (doc.previewImageUrl) {
      const publicId = publicIdFromUrl(doc.previewImageUrl);
      if (publicId) await destroyAsset(publicId, 'image', 'upload');
    }
    res.json({ slug: req.params.slug });
  },
);
