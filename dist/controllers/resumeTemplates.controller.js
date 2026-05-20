"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.downloadTemplate = exports.previewSampleTemplate = exports.getTemplateQuota = exports.getPublicTemplate = exports.listPublicTemplates = void 0;
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const ResumeTemplate_1 = require("../models/ResumeTemplate");
const User_1 = require("../models/User");
const templateRenderer_service_1 = require("../services/resume/templateRenderer.service");
const templateAiFiller_service_1 = require("../services/resume/templateAiFiller.service");
const templateDownloadQuota_service_1 = require("../services/resume/templateDownloadQuota.service");
exports.listPublicTemplates = (0, asyncHandler_1.asyncHandler)(async (_req, res) => {
    const docs = await ResumeTemplate_1.ResumeTemplate.find({ status: 'published' })
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
});
exports.getPublicTemplate = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const doc = await ResumeTemplate_1.ResumeTemplate.findOne({
        slug: req.params.slug,
        status: 'published',
    }).lean();
    if (!doc)
        throw ApiError_1.ApiError.notFound('Template not found');
    const html = doc.liveSource === 'enhanced' && doc.htmlEnhanced
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
});
exports.getTemplateQuota = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const user = await User_1.User.findById(req.user.id);
    if (!user)
        throw ApiError_1.ApiError.unauthorized();
    const status = await (0, templateDownloadQuota_service_1.getTemplateDownloadStatus)(user);
    res.json({
        tier: status.tier,
        limit: status.limit,
        used: status.used,
        remaining: status.unlimited ? null : status.remaining,
        unlimited: status.unlimited,
        resetsAt: status.resetsAt.toISOString(),
    });
});
exports.previewSampleTemplate = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const doc = await ResumeTemplate_1.ResumeTemplate.findOne({
        slug: req.params.slug,
        status: 'published',
    }).lean();
    if (!doc)
        throw ApiError_1.ApiError.notFound('Template not found');
    const sourceHtml = doc.liveSource === 'enhanced' && doc.htmlEnhanced
        ? doc.htmlEnhanced
        : doc.htmlOriginal;
    const filled = (0, templateRenderer_service_1.fillWithSample)(sourceHtml);
    const pdf = await (0, templateRenderer_service_1.renderTemplatePdf)(filled);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${doc.slug}_sample.pdf"`);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.end(pdf);
});
exports.downloadTemplate = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const user = await User_1.User.findById(req.user.id);
    if (!user)
        throw ApiError_1.ApiError.unauthorized();
    const status = await (0, templateDownloadQuota_service_1.consumeTemplateDownload)(user);
    const doc = await ResumeTemplate_1.ResumeTemplate.findOne({
        slug: req.params.slug,
        status: 'published',
    }).lean();
    if (!doc)
        throw ApiError_1.ApiError.notFound('Template not found');
    const sourceHtml = doc.liveSource === 'enhanced' && doc.htmlEnhanced
        ? doc.htmlEnhanced
        : doc.htmlOriginal;
    const enhanced = await (0, templateAiFiller_service_1.aiEnhanceTemplateContent)(user, doc.slug);
    const filled = (0, templateRenderer_service_1.fillPlaceholders)(sourceHtml, user, enhanced ?? {});
    const pdf = await (0, templateRenderer_service_1.renderTemplatePdf)(filled);
    const safeName = (user.profile?.fullName || 'resume')
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase()
        .slice(0, 40) || 'resume';
    const filename = `${safeName}_${doc.slug}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Template-Quota-Used', String(status.used));
    if (!status.unlimited) {
        res.setHeader('X-Template-Quota-Remaining', String(status.remaining));
    }
    res.end(pdf);
});
