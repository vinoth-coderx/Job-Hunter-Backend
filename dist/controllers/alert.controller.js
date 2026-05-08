"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteAlert = exports.updateAlert = exports.listAlerts = exports.createAlert = exports.updateAlertSchema = exports.createAlertSchema = void 0;
const zod_1 = require("zod");
const Alert_1 = require("../models/Alert");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
exports.createAlertSchema = zod_1.z.object({
    body: zod_1.z.object({
        label: zod_1.z.string().max(120).optional(),
        query: zod_1.z.string().max(200).default(''),
        filters: zod_1.z.array(zod_1.z.string().max(80)).max(20).default([]),
        location: zod_1.z.string().max(120).optional(),
        sort: zod_1.z.string().max(40).optional(),
        active: zod_1.z.boolean().default(true),
    }),
});
exports.updateAlertSchema = zod_1.z.object({
    body: zod_1.z.object({
        label: zod_1.z.string().max(120).optional(),
        query: zod_1.z.string().max(200).optional(),
        filters: zod_1.z.array(zod_1.z.string().max(80)).max(20).optional(),
        location: zod_1.z.string().max(120).optional(),
        sort: zod_1.z.string().max(40).optional(),
        active: zod_1.z.boolean().optional(),
    }),
});
exports.createAlert = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const { label, query, filters, location, sort, active } = req.body;
    const sortedFilters = [...filters].sort();
    const existing = await Alert_1.Alert.findOne({
        user: req.user._id,
        query: query || '',
        filters: sortedFilters,
        location: location || null,
    });
    if (existing) {
        existing.label = label ?? existing.label;
        existing.sort = sort ?? existing.sort;
        existing.active = active;
        await existing.save();
        res.json({ success: true, data: existing });
        return;
    }
    const created = await Alert_1.Alert.create({
        user: req.user._id,
        label,
        query: query || '',
        filters: sortedFilters,
        location,
        sort,
        active,
    });
    res.status(201).json({ success: true, data: created });
});
exports.listAlerts = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const items = await Alert_1.Alert.find({ user: req.user._id }).sort({ createdAt: -1 });
    res.json({ success: true, data: items });
});
exports.updateAlert = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const { id } = req.params;
    const updated = await Alert_1.Alert.findOneAndUpdate({ _id: id, user: req.user._id }, { $set: req.body }, { new: true, runValidators: true });
    if (!updated)
        throw ApiError_1.ApiError.notFound('Alert not found');
    res.json({ success: true, data: updated });
});
exports.deleteAlert = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const { id } = req.params;
    const removed = await Alert_1.Alert.findOneAndDelete({ _id: id, user: req.user._id });
    if (!removed)
        throw ApiError_1.ApiError.notFound('Alert not found');
    res.json({ success: true, message: 'Alert deleted' });
});
