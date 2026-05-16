import { Response } from 'express';
import { AuthRequest } from '../types';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { ResumeTemplate } from '../models/ResumeTemplate';
import { User } from '../models/User';
import {
  fillPlaceholders,
  fillWithSample,
  renderTemplatePdf,
} from '../services/resume/templateRenderer.service';
import { aiEnhanceTemplateContent } from '../services/resume/templateAiFiller.service';
import {
  consumeTemplateDownload,
  getTemplateDownloadStatus,
} from '../services/resume/templateDownloadQuota.service';

/**
 * User-facing template catalog.
 *
 * Only `published` templates are returned. The list view excludes the
 * HTML body to keep the payload small; the detail endpoint returns the
 * live HTML (either the original or the AI-enhanced copy, whichever the
 * admin set as live).
 */

export const listPublicTemplates = asyncHandler(
  async (_req: AuthRequest, res: Response) => {
    const docs = await ResumeTemplate.find({ status: 'published' })
      .sort({ sortOrder: 1, name: 1 })
      .select('slug name description category previewImageUrl atsScore isPremium')
      .lean();
    res.json({
      templates: docs.map((t) => ({
        slug: t.slug,
        name: t.name,
        description: t.description,
        category: t.category,
        previewImageUrl: t.previewImageUrl,
        atsScore: t.atsScore,
        isPremium: t.isPremium,
      })),
    });
  },
);

export const getPublicTemplate = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const doc = await ResumeTemplate.findOne({
      slug: req.params.slug,
      status: 'published',
    }).lean();
    if (!doc) throw ApiError.notFound('Template not found');

    const html =
      doc.liveSource === 'enhanced' && doc.htmlEnhanced
        ? doc.htmlEnhanced
        : doc.htmlOriginal;

    res.json({
      template: {
        slug: doc.slug,
        name: doc.name,
        description: doc.description,
        category: doc.category,
        previewImageUrl: doc.previewImageUrl,
        atsScore: doc.atsScore,
        isPremium: doc.isPremium,
        html,
      },
    });
  },
);

/**
 * Returns the seeker's current monthly download quota. Used by the
 * Flutter detail screen to render "X of Y left this month" and disable
 * the download button when the cap is hit.
 */
export const getTemplateQuota = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const user = await User.findById(req.user.id);
    if (!user) throw ApiError.unauthorized();
    const status = await getTemplateDownloadStatus(user);
    res.json({
      tier: status.tier,
      limit: status.limit,
      used: status.used,
      remaining: status.unlimited ? null : status.remaining,
      unlimited: status.unlimited,
      resetsAt: status.resetsAt.toISOString(),
    });
  },
);

/**
 * Renders the template filled with *sample* data and streams it back as
 * `application/pdf`. Used by the seeker preview screen so the visitor
 * sees a fully-finished resume before committing their own data. No
 * quota check — sample previews are essentially marketing content and
 * are safe to render on every open (Puppeteer page reuse keeps the cost
 * close to a thumbnail render).
 */
export const previewSampleTemplate = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    const doc = await ResumeTemplate.findOne({
      slug: req.params.slug,
      status: 'published',
    }).lean();
    if (!doc) throw ApiError.notFound('Template not found');

    const sourceHtml =
      doc.liveSource === 'enhanced' && doc.htmlEnhanced
        ? doc.htmlEnhanced
        : doc.htmlOriginal;

    const filled = fillWithSample(sourceHtml);
    const pdf = await renderTemplatePdf(filled);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${doc.slug}_sample.pdf"`,
    );
    // Aggressive caching — sample output is identical across users and
    // changes only when the admin re-publishes the template (rare).
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.end(pdf);
  },
);

/**
 * Generates a PDF of the template filled with the requesting user's
 * profile data and streams it back as `application/pdf`. Enforces the
 * monthly quota *before* spending Puppeteer CPU.
 */
export const downloadTemplate = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const user = await User.findById(req.user.id);
    if (!user) throw ApiError.unauthorized();

    // 1. Quota check + atomic consume (throws 403 when cap reached).
    const status = await consumeTemplateDownload(user);

    // 2. Load the live HTML.
    const doc = await ResumeTemplate.findOne({
      slug: req.params.slug,
      status: 'published',
    }).lean();
    if (!doc) throw ApiError.notFound('Template not found');
    const sourceHtml =
      doc.liveSource === 'enhanced' && doc.htmlEnhanced
        ? doc.htmlEnhanced
        : doc.htmlOriginal;

    // 3. Try to AI-enhance the long-form sections. Best-effort: if AI
    //    is disabled / quota-busted / parse-failed, the helper returns
    //    null and we fall through to plain field substitution. The
    //    AI credit cost (`resume_template_fill`, weight 3) is bundled
    //    with the template-download quota credit — admins can split
    //    them via AppConfig if they want stricter accounting.
    const enhanced = await aiEnhanceTemplateContent(user, doc.slug);
    const filled = fillPlaceholders(sourceHtml, user, enhanced ?? {});
    const pdf = await renderTemplatePdf(filled);

    const safeName =
      (user.profile?.fullName || 'resume')
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase()
        .slice(0, 40) || 'resume';
    const filename = `${safeName}_${doc.slug}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`,
    );
    // Surface the updated counter so clients can refresh the quota
    // banner without a follow-up request.
    res.setHeader('X-Template-Quota-Used', String(status.used));
    if (!status.unlimited) {
      res.setHeader('X-Template-Quota-Remaining', String(status.remaining));
    }
    res.end(pdf);
  },
);
