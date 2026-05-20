"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteTemplate = exports.archiveTemplate = exports.publishTemplate = exports.enhanceTemplateEndpoint = exports.updateTemplate = exports.createTemplate = exports.getAdminTemplate = exports.listAdminTemplates = exports.statusActionSchema = exports.updateTemplateSchema = exports.createTemplateSchema = void 0;
const zod_1 = require("zod");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const ResumeTemplate_1 = require("../models/ResumeTemplate");
const templateEnhancer_service_1 = require("../services/resume/templateEnhancer.service");
const templateRenderer_service_1 = require("../services/resume/templateRenderer.service");
const cloudinary_1 = require("../config/cloudinary");
const logger_1 = require("../utils/logger");
const SLUG_RE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
exports.createTemplateSchema = zod_1.z.object({
    body: zod_1.z.object({
        slug: zod_1.z
            .string()
            .trim()
            .toLowerCase()
            .min(3)
            .max(40)
            .regex(SLUG_RE, 'slug must be lowercase letters/digits/- only'),
        name: zod_1.z.string().trim().min(1).max(80),
        description: zod_1.z.string().trim().max(400).default(''),
        category: zod_1.z.string().trim().toLowerCase().max(40).default('general'),
        htmlOriginal: zod_1.z.string().min(100, 'template HTML looks too short').max(200_000),
        isPremium: zod_1.z.boolean().default(false),
        sortOrder: zod_1.z.number().int().min(0).max(10_000).default(100),
        previewImageUrl: zod_1.z.string().url().nullable().default(null),
    }),
});
exports.updateTemplateSchema = zod_1.z.object({
    body: zod_1.z.object({
        name: zod_1.z.string().trim().min(1).max(80).optional(),
        description: zod_1.z.string().trim().max(400).optional(),
        category: zod_1.z.string().trim().toLowerCase().max(40).optional(),
        htmlOriginal: zod_1.z.string().min(100).max(200_000).optional(),
        isPremium: zod_1.z.boolean().optional(),
        sortOrder: zod_1.z.number().int().min(0).max(10_000).optional(),
        previewImageUrl: zod_1.z.string().url().nullable().optional(),
        liveSource: zod_1.z.enum(['original', 'enhanced']).optional(),
    }),
    params: zod_1.z.object({ slug: zod_1.z.string().min(1) }),
});
exports.statusActionSchema = zod_1.z.object({
    params: zod_1.z.object({ slug: zod_1.z.string().min(1) }),
});
const liveHtmlOf = (t) => t.liveSource === 'enhanced' && t.htmlEnhanced ? t.htmlEnhanced : t.htmlOriginal;
const refreshThumbnailFor = async (slug, html, existingUrl) => {
    if (!(0, cloudinary_1.isCloudinaryConfigured)()) {
        logger_1.logger.warn(`Skipping template thumbnail for ${slug}: Cloudinary not configured`);
        return existingUrl;
    }
    try {
        const png = await (0, templateRenderer_service_1.renderTemplateThumbnail)(html);
        const result = await (0, cloudinary_1.uploadBuffer)(png, {
            folder: 'job_hunter/resume_template_thumbs',
            publicId: `tpl_${slug}`,
            resourceType: 'image',
            overwrite: true,
            tags: ['resume-template-thumb'],
            format: 'png',
        });
        if (existingUrl) {
            const oldId = (0, cloudinary_1.publicIdFromUrl)(existingUrl);
            if (oldId && oldId !== result.publicId) {
                await (0, cloudinary_1.destroyAsset)(oldId, 'image', 'upload');
            }
        }
        return result.url;
    }
    catch (err) {
        logger_1.logger.warn(`Template thumbnail refresh failed for ${slug}: ${err.message}`);
        return existingUrl;
    }
};
exports.listAdminTemplates = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const status = req.query.status;
    const filter = status ? { status } : {};
    const docs = await ResumeTemplate_1.ResumeTemplate.find(filter)
        .sort({ sortOrder: 1, createdAt: -1 })
        .select('-htmlOriginal -htmlEnhanced')
        .lean();
    res.json({
        templates: docs.map((t) => ({
            ...t,
            _id: t._id.toString(),
            createdBy: t.createdBy?.toString() ?? null,
        })),
        minPublishScore: ResumeTemplate_1.MIN_PUBLISH_ATS_SCORE,
    });
});
exports.getAdminTemplate = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const doc = await ResumeTemplate_1.ResumeTemplate.findOne({ slug: req.params.slug }).lean();
    if (!doc)
        throw ApiError_1.ApiError.notFound('Template not found');
    res.json({
        template: {
            ...doc,
            _id: doc._id.toString(),
            createdBy: doc.createdBy?.toString() ?? null,
        },
        liveHtml: liveHtmlOf(doc),
        minPublishScore: ResumeTemplate_1.MIN_PUBLISH_ATS_SCORE,
    });
});
exports.createTemplate = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const body = req.body;
    const existing = await ResumeTemplate_1.ResumeTemplate.findOne({ slug: body.slug });
    if (existing)
        throw ApiError_1.ApiError.conflict(`Slug '${body.slug}' is already used.`);
    const score = (0, templateEnhancer_service_1.scoreTemplate)(body.htmlOriginal);
    const doc = await ResumeTemplate_1.ResumeTemplate.create({
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
        minPublishScore: ResumeTemplate_1.MIN_PUBLISH_ATS_SCORE,
    });
});
exports.updateTemplate = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const body = req.body;
    const doc = await ResumeTemplate_1.ResumeTemplate.findOne({ slug: req.params.slug });
    if (!doc)
        throw ApiError_1.ApiError.notFound('Template not found');
    Object.assign(doc, body);
    const liveCopyChanged = Boolean(body.htmlOriginal || body.liveSource);
    if (liveCopyChanged) {
        const score = (0, templateEnhancer_service_1.scoreTemplate)(liveHtmlOf(doc));
        doc.atsScore = score.score;
        doc.atsScoreSource = score.source;
        doc.atsNotes = score.notes;
        if (doc.status === 'published' && score.score < ResumeTemplate_1.MIN_PUBLISH_ATS_SCORE) {
            doc.status = 'enhanced';
        }
    }
    if (liveCopyChanged && doc.status === 'published') {
        doc.previewImageUrl = await refreshThumbnailFor(doc.slug, liveHtmlOf(doc), doc.previewImageUrl);
    }
    await doc.save();
    res.json({ template: doc.toJSON() });
});
exports.enhanceTemplateEndpoint = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const doc = await ResumeTemplate_1.ResumeTemplate.findOne({ slug: req.params.slug });
    if (!doc)
        throw ApiError_1.ApiError.notFound('Template not found');
    const result = await (0, templateEnhancer_service_1.enhanceTemplate)(doc.htmlOriginal);
    doc.htmlEnhanced = result.html;
    if (doc.status === 'draft')
        doc.status = 'enhanced';
    const score = (0, templateEnhancer_service_1.scoreTemplate)(result.html);
    doc.atsScore = score.score;
    doc.atsScoreSource = score.source;
    doc.atsNotes = score.notes;
    await doc.save();
    res.json({
        template: doc.toJSON(),
        changes: result.changes,
        usedAi: result.usedAi,
        warnings: result.warnings,
        minPublishScore: ResumeTemplate_1.MIN_PUBLISH_ATS_SCORE,
    });
});
exports.publishTemplate = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const doc = await ResumeTemplate_1.ResumeTemplate.findOne({ slug: req.params.slug });
    if (!doc)
        throw ApiError_1.ApiError.notFound('Template not found');
    const score = (0, templateEnhancer_service_1.scoreTemplate)(liveHtmlOf(doc));
    doc.atsScore = score.score;
    doc.atsScoreSource = score.source;
    doc.atsNotes = score.notes;
    if (score.score < ResumeTemplate_1.MIN_PUBLISH_ATS_SCORE) {
        await doc.save();
        throw ApiError_1.ApiError.badRequest(`ATS score ${score.score} is below the minimum ${ResumeTemplate_1.MIN_PUBLISH_ATS_SCORE}. ` +
            `Run AI enhance or edit the template before publishing.`);
    }
    doc.status = 'published';
    doc.previewImageUrl = await refreshThumbnailFor(doc.slug, liveHtmlOf(doc), doc.previewImageUrl);
    await doc.save();
    res.json({ template: doc.toJSON() });
});
exports.archiveTemplate = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const doc = await ResumeTemplate_1.ResumeTemplate.findOneAndUpdate({ slug: req.params.slug }, { $set: { status: 'archived' } }, { new: true });
    if (!doc)
        throw ApiError_1.ApiError.notFound('Template not found');
    res.json({ template: doc.toJSON() });
});
exports.deleteTemplate = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const doc = await ResumeTemplate_1.ResumeTemplate.findOneAndDelete({
        slug: req.params.slug,
    });
    if (!doc)
        throw ApiError_1.ApiError.notFound('Template not found');
    if (doc.previewImageUrl) {
        const publicId = (0, cloudinary_1.publicIdFromUrl)(doc.previewImageUrl);
        if (publicId)
            await (0, cloudinary_1.destroyAsset)(publicId, 'image', 'upload');
    }
    res.json({ slug: req.params.slug });
});
