"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.compareSalary = exports.submitSalary = exports.getInsights = exports.compareSchema = exports.submitSchema = exports.insightsQuerySchema = void 0;
const zod_1 = require("zod");
const SalarySubmission_1 = require("../models/SalarySubmission");
const redis_1 = require("../config/redis");
const asyncHandler_1 = require("../utils/asyncHandler");
const ApiError_1 = require("../utils/ApiError");
const MIN_DATA_POINTS = 5;
const CACHE_TTL_SECONDS = 60 * 60;
const cacheKey = (role, city) => `salary:${role.toLowerCase()}:${city.toLowerCase()}`;
const percentile = (sorted, p) => {
    if (sorted.length === 0)
        return 0;
    const rank = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(rank);
    const hi = Math.ceil(rank);
    if (lo === hi)
        return sorted[lo];
    return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo));
};
exports.insightsQuerySchema = zod_1.z.object({
    query: zod_1.z.object({
        role: zod_1.z.string().min(2).max(100),
        city: zod_1.z.string().min(2).max(100),
    }),
});
exports.submitSchema = zod_1.z.object({
    body: zod_1.z.object({
        role: zod_1.z.string().min(2).max(100),
        city: zod_1.z.string().min(2).max(100),
        industry: zod_1.z.string().max(100).optional(),
        company: zod_1.z.string().max(200).optional(),
        experienceYears: zod_1.z.coerce.number().min(0).max(60),
        salaryInr: zod_1.z.coerce.number().min(50_000).max(50_000_000),
    }),
});
exports.compareSchema = zod_1.z.object({
    body: zod_1.z.object({
        role: zod_1.z.string().min(2).max(100),
        city: zod_1.z.string().min(2).max(100),
        salaryInr: zod_1.z.coerce.number().min(50_000).max(50_000_000),
    }),
});
exports.getInsights = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { role, city } = req.query;
    const key = cacheKey(role, city);
    const cached = await redis_1.redis.get(key);
    if (cached) {
        res.json({ success: true, data: JSON.parse(cached), cached: true });
        return;
    }
    const docs = await SalarySubmission_1.SalarySubmission.find({
        role: role.toLowerCase(),
        city: city.toLowerCase(),
    })
        .select('salaryInr experienceYears company submittedAt')
        .lean();
    if (docs.length < MIN_DATA_POINTS) {
        res.json({
            success: true,
            data: {
                role,
                city,
                dataPointsCount: docs.length,
                notEnoughData: true,
                minDataPoints: MIN_DATA_POINTS,
            },
        });
        return;
    }
    const salaries = docs.map((d) => d.salaryInr).sort((a, b) => a - b);
    const p10 = percentile(salaries, 10);
    const p25 = percentile(salaries, 25);
    const p50 = percentile(salaries, 50);
    const p75 = percentile(salaries, 75);
    const p90 = percentile(salaries, 90);
    const buckets = {
        '0-2': [],
        '2-5': [],
        '5-10': [],
        '10+': [],
    };
    for (const d of docs) {
        const y = d.experienceYears;
        if (y < 2)
            buckets['0-2'].push(d.salaryInr);
        else if (y < 5)
            buckets['2-5'].push(d.salaryInr);
        else if (y < 10)
            buckets['5-10'].push(d.salaryInr);
        else
            buckets['10+'].push(d.salaryInr);
    }
    const byExperience = Object.entries(buckets)
        .filter(([, v]) => v.length > 0)
        .map(([range, v]) => ({
        range,
        average: Math.round(v.reduce((s, n) => s + n, 0) / v.length),
        min: Math.min(...v),
        max: Math.max(...v),
        sampleSize: v.length,
    }));
    const byCompany = new Map();
    for (const d of docs) {
        if (!d.company)
            continue;
        const c = d.company.trim();
        if (!c)
            continue;
        const arr = byCompany.get(c) ?? [];
        arr.push(d.salaryInr);
        byCompany.set(c, arr);
    }
    const topCompanies = [...byCompany.entries()]
        .filter(([, v]) => v.length >= 3)
        .map(([company, v]) => ({
        companyName: company,
        averageSalary: Math.round(v.reduce((s, n) => s + n, 0) / v.length),
        sampleSize: v.length,
    }))
        .sort((a, b) => b.averageSalary - a.averageSalary)
        .slice(0, 5);
    const now = Date.now();
    const recentCutoff = now - 365 * 24 * 60 * 60 * 1000;
    const priorCutoff = now - 2 * 365 * 24 * 60 * 60 * 1000;
    const recent = docs
        .filter((d) => d.submittedAt.getTime() >= recentCutoff)
        .map((d) => d.salaryInr);
    const prior = docs
        .filter((d) => d.submittedAt.getTime() < recentCutoff &&
        d.submittedAt.getTime() >= priorCutoff)
        .map((d) => d.salaryInr);
    let yoyChangePercent = null;
    if (recent.length >= MIN_DATA_POINTS && prior.length >= MIN_DATA_POINTS) {
        const avgRecent = recent.reduce((s, n) => s + n, 0) / recent.length;
        const avgPrior = prior.reduce((s, n) => s + n, 0) / prior.length;
        yoyChangePercent = Math.round(((avgRecent - avgPrior) / avgPrior) * 100);
    }
    const payload = {
        role,
        city,
        dataPointsCount: docs.length,
        percentiles: { p10, p25, p50, p75, p90 },
        byExperience,
        topCompanies,
        yoyChangePercent,
        lastUpdated: new Date(),
    };
    await redis_1.redis.setex(key, CACHE_TTL_SECONDS, JSON.stringify(payload));
    res.json({ success: true, data: payload });
});
exports.submitSalary = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const body = req.body;
    await SalarySubmission_1.SalarySubmission.findOneAndUpdate({
        user: req.user._id,
        role: body.role.toLowerCase(),
        city: body.city.toLowerCase(),
    }, {
        $set: {
            user: req.user._id,
            role: body.role.toLowerCase(),
            city: body.city.toLowerCase(),
            industry: body.industry?.toLowerCase(),
            company: body.company,
            experienceYears: body.experienceYears,
            salaryInr: body.salaryInr,
            submittedAt: new Date(),
        },
    }, { upsert: true, new: true });
    await redis_1.redis.del(cacheKey(body.role, body.city));
    res.status(201).json({ success: true, message: 'Submitted — thank you!' });
});
exports.compareSalary = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const { role, city, salaryInr } = req.body;
    const docs = await SalarySubmission_1.SalarySubmission.find({
        role: role.toLowerCase(),
        city: city.toLowerCase(),
    })
        .select('salaryInr')
        .lean();
    if (docs.length < MIN_DATA_POINTS) {
        res.json({
            success: true,
            data: {
                notEnoughData: true,
                minDataPoints: MIN_DATA_POINTS,
                dataPointsCount: docs.length,
            },
        });
        return;
    }
    const salaries = docs.map((d) => d.salaryInr).sort((a, b) => a - b);
    const lessThan = salaries.filter((s) => s < salaryInr).length;
    const percentileRank = Math.round((lessThan / salaries.length) * 100);
    const median = percentile(salaries, 50);
    res.json({
        success: true,
        data: {
            percentile: percentileRank,
            median,
            yourSalary: salaryInr,
            dataPointsCount: salaries.length,
        },
    });
});
