"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.unregisterDeviceToken = exports.registerDeviceToken = exports.registerTokenSchema = void 0;
const zod_1 = require("zod");
const DeviceToken_1 = require("../models/DeviceToken");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
exports.registerTokenSchema = zod_1.z.object({
    body: zod_1.z.object({
        token: zod_1.z.string().min(20).max(2048),
        platform: zod_1.z.enum(['ios', 'android', 'web']),
        appVersion: zod_1.z.string().max(40).optional(),
    }),
});
exports.registerDeviceToken = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const { token, platform, appVersion } = req.body;
    const updated = await DeviceToken_1.DeviceToken.findOneAndUpdate({ token }, {
        $set: {
            user: req.user._id,
            platform,
            appVersion,
            lastSeenAt: new Date(),
        },
    }, { upsert: true, new: true, setDefaultsOnInsert: true });
    res.status(201).json({ success: true, data: updated });
});
exports.unregisterDeviceToken = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const { token } = req.params;
    await DeviceToken_1.DeviceToken.deleteOne({ token, user: req.user._id });
    res.json({ success: true, message: 'Token unregistered' });
});
