"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildAllJobsPayload = void 0;
const Job_1 = require("../models/Job");
const env_1 = require("../config/env");
const buildAllJobsPayload = async () => {
    const cutoff = new Date(Date.now() - env_1.env.JOB_FRESHNESS_DAYS * 24 * 60 * 60 * 1000);
    const items = await Job_1.Job.find({ isActive: true, postedAt: { $gte: cutoff } }, { raw: 0 })
        .sort({ postedAt: -1 })
        .lean();
    return {
        success: true,
        data: items,
        meta: {
            total: items.length,
            freshnessDays: env_1.env.JOB_FRESHNESS_DAYS,
            servedAt: new Date().toISOString(),
        },
    };
};
exports.buildAllJobsPayload = buildAllJobsPayload;
