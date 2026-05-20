"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listMyReports = exports.createReport = exports.createReportSchema = void 0;
const zod_1 = require("zod");
const mongoose_1 = __importDefault(require("mongoose"));
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const Report_1 = require("../models/Report");
const audit_service_1 = require("../services/security/audit.service");
exports.createReportSchema = zod_1.z.object({
    body: zod_1.z.object({
        subjectType: zod_1.z.enum(['job', 'recruiter', 'message', 'company', 'review']),
        subjectId: zod_1.z.string().regex(/^[0-9a-fA-F]{24}$/),
        reason: zod_1.z.enum([
            'fake_job',
            'fake_recruiter',
            'asks_payment',
            'mlm_scam',
            'misleading_salary',
            'discriminatory',
            'duplicate',
            'harassment',
            'spam',
            'phishing_link',
            'whatsapp_only_contact',
            'other',
        ]),
        description: zod_1.z.string().max(2000).optional(),
        evidenceUrls: zod_1.z.array(zod_1.z.string().url()).max(5).optional(),
    }),
});
exports.createReport = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const dup = await Report_1.Report.findOne({
        reporter: req.user._id,
        subjectType: req.body.subjectType,
        subjectId: req.body.subjectId,
        status: { $in: ['open', 'under_review'] },
    });
    if (dup) {
        res.json({ success: true, data: dup, deduped: true });
        return;
    }
    const report = await Report_1.Report.create({
        reporter: req.user._id,
        subjectType: req.body.subjectType,
        subjectId: new mongoose_1.default.Types.ObjectId(req.body.subjectId),
        reason: req.body.reason,
        description: req.body.description,
        evidenceUrls: req.body.evidenceUrls ?? [],
    });
    await (0, audit_service_1.writeAudit)({
        actor: { id: req.user._id, email: req.user.email },
        actorType: 'user',
        category: 'security',
        action: `report:${req.body.subjectType}:${req.body.reason}`,
        target: { type: req.body.subjectType, id: req.body.subjectId },
        req,
    });
    res.status(201).json({ success: true, data: report });
});
exports.listMyReports = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const reports = await Report_1.Report.find({ reporter: req.user._id })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean();
    res.json({ success: true, data: reports });
});
