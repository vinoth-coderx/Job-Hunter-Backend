"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.consumeTemplateDownload = exports.getTemplateDownloadStatus = void 0;
const User_1 = require("../../models/User");
const subscriptionPlans_service_1 = require("../subscriptionPlans.service");
const ApiError_1 = require("../../utils/ApiError");
const IST_OFFSET_MIN = 330;
const istMonthBoundaries = (now = new Date()) => {
    const utcMs = now.getTime();
    const istMs = utcMs + IST_OFFSET_MIN * 60 * 1000;
    const ist = new Date(istMs);
    const startIstMs = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1, 0, 0, 0);
    const nextStartIstMs = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() + 1, 1, 0, 0, 0);
    return {
        start: new Date(startIstMs - IST_OFFSET_MIN * 60 * 1000),
        nextStart: new Date(nextStartIstMs - IST_OFFSET_MIN * 60 * 1000),
    };
};
const userTier = (user) => user.subscription?.tier || 'free';
const currentCounter = (user) => {
    const raw = user.templateDownloads;
    return {
        count: raw?.count ?? 0,
        periodStart: raw?.periodStart ?? new Date(0),
    };
};
const getTemplateDownloadStatus = async (user) => {
    const tier = userTier(user);
    const plan = await (0, subscriptionPlans_service_1.getPlan)(tier);
    const limit = plan?.templateDownloadsPerMonth ?? 0;
    const { start, nextStart } = istMonthBoundaries();
    const { count, periodStart } = currentCounter(user);
    const inThisPeriod = periodStart.getTime() >= start.getTime();
    const used = inThisPeriod ? count : 0;
    const unlimited = limit < 0;
    const remaining = unlimited
        ? Number.POSITIVE_INFINITY
        : Math.max(0, limit - used);
    return {
        tier,
        limit,
        used,
        remaining,
        unlimited,
        periodStart: inThisPeriod ? periodStart : start,
        resetsAt: nextStart,
    };
};
exports.getTemplateDownloadStatus = getTemplateDownloadStatus;
const consumeTemplateDownload = async (user) => {
    const status = await (0, exports.getTemplateDownloadStatus)(user);
    if (status.limit === 0) {
        throw ApiError_1.ApiError.forbidden('Resume template downloads aren\'t available on your current plan.');
    }
    if (!status.unlimited && status.remaining <= 0) {
        throw ApiError_1.ApiError.forbidden(`Monthly limit of ${status.limit} downloads reached. Resets ${status.resetsAt.toISOString().slice(0, 10)}.`);
    }
    const { start } = istMonthBoundaries();
    const inThisPeriod = status.periodStart.getTime() >= start.getTime() && status.used > 0;
    let updated;
    if (status.unlimited) {
        updated = await User_1.User.findOneAndUpdate({ _id: user._id }, inThisPeriod
            ? { $inc: { 'templateDownloads.count': 1 } }
            : {
                $set: {
                    'templateDownloads.count': 1,
                    'templateDownloads.periodStart': start,
                },
            }, { new: true });
    }
    else if (inThisPeriod) {
        updated = await User_1.User.findOneAndUpdate({
            _id: user._id,
            'templateDownloads.count': { $lt: status.limit },
        }, { $inc: { 'templateDownloads.count': 1 } }, { new: true });
        if (!updated) {
            throw ApiError_1.ApiError.forbidden(`Monthly limit of ${status.limit} downloads reached. Resets ${status.resetsAt.toISOString().slice(0, 10)}.`);
        }
    }
    else {
        updated = await User_1.User.findOneAndUpdate({ _id: user._id }, {
            $set: {
                'templateDownloads.count': 1,
                'templateDownloads.periodStart': start,
            },
        }, { new: true });
    }
    if (!updated) {
        throw ApiError_1.ApiError.internal('Failed to record template download');
    }
    return (0, exports.getTemplateDownloadStatus)(updated);
};
exports.consumeTemplateDownload = consumeTemplateDownload;
