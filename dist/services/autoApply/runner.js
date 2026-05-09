"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.submitApprovedApplications = exports.runAutoApplyForUser = void 0;
const AutoApplySettings_1 = require("../../models/AutoApplySettings");
const AutoApplyLog_1 = require("../../models/AutoApplyLog");
const AppliedJob_1 = require("../../models/AppliedJob");
const Job_1 = require("../../models/Job");
const Notification_1 = require("../../models/Notification");
const logger_1 = require("../../utils/logger");
const scorer_1 = require("./scorer");
const limits_1 = require("./limits");
const coverLetter_service_1 = require("../ai/coverLetter.service");
const startOfDay = (d) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
};
const runAutoApplyForUser = async (user, options = {}) => {
    const settings = await AutoApplySettings_1.AutoApplySettings.findOne({ user: user._id });
    if (!settings)
        return null;
    const rawTier = (user.subscription?.tier ?? 'free');
    const tier = (0, limits_1.effectiveTier)(rawTier, (0, limits_1.computeTrialState)(user.subscription));
    if (!(0, limits_1.isAutoApplyEligible)(tier))
        return null;
    if (!settings.isEnabled)
        return null;
    if (settings.isPaused &&
        (!settings.pauseUntil || settings.pauseUntil > new Date())) {
        return null;
    }
    const today = startOfDay(new Date());
    if (!options.manual) {
        const already = await AutoApplyLog_1.AutoApplyLog.findOne({
            user: user._id,
            runDate: { $gte: today },
            triggeredManually: false,
        }).select('_id').lean();
        if (already)
            return null;
    }
    if (!user.profile.resumeUrl && !user.profile.resumeFile) {
        logger_1.logger.info(`[autoApply] skip ${user.email}: no resume on file`);
        return null;
    }
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const reapplyCutoff = new Date(Date.now() - settings.matchingRules.reapplyCooldownDays * 24 * 60 * 60 * 1000);
    const sources = settings.preferences.sources?.length
        ? settings.preferences.sources
        : ['native'];
    const orFilters = [];
    if (sources.includes('native')) {
        orFilters.push({ isNative: true, status: 'active' });
    }
    if (sources.includes('external')) {
        orFilters.push({ isNative: false, isActive: true });
    }
    if (orFilters.length === 0) {
        orFilters.push({ isNative: true, status: 'active' });
    }
    const baseFilter = {
        postedAt: { $gte: cutoff },
        $or: orFilters,
    };
    if (settings.preferences.locations?.length) {
        baseFilter.location = {
            $regex: settings.preferences.locations.map(escapeRegex).join('|'),
            $options: 'i',
        };
    }
    if (settings.preferences.jobTypes?.length) {
        baseFilter.jobType = { $in: settings.preferences.jobTypes };
    }
    if (settings.preferences.minSalary) {
        baseFilter.$or = [
            { salaryMin: { $gte: settings.preferences.minSalary } },
            { salaryMax: { $gte: settings.preferences.minSalary } },
        ];
    }
    const pool = await Job_1.Job.find(baseFilter).sort({ postedAt: -1 }).limit(500);
    const recentApplications = await AppliedJob_1.AppliedJob.find({
        user: user._id,
        appliedAt: { $gte: reapplyCutoff },
    })
        .select('job hirerProfile jobSnapshot.company')
        .lean();
    const appliedJobIds = new Set(recentApplications.map((a) => a.job.toString()));
    const cooldownCompanies = new Set(recentApplications.map((a) => (a.jobSnapshot.company || '').toLowerCase()));
    const blacklist = new Set((settings.matchingRules.blacklistedCompanies || []).map((c) => c.toLowerCase()));
    const includeKW = (settings.matchingRules.mustIncludeKeywords || []).map((k) => k.toLowerCase());
    const excludeKW = (settings.matchingRules.excludeKeywords || []).map((k) => k.toLowerCase());
    const ranked = [];
    const skipped = [];
    for (const job of pool) {
        if (appliedJobIds.has(job._id.toString())) {
            skipped.push({ job: job._id, reason: 'already_applied' });
            continue;
        }
        const company = (job.company || '').toLowerCase();
        if (blacklist.has(company)) {
            skipped.push({ job: job._id, reason: 'blacklisted' });
            continue;
        }
        if (cooldownCompanies.has(company)) {
            skipped.push({ job: job._id, reason: 'cooldown' });
            continue;
        }
        const blob = `${job.title} ${job.description}`.toLowerCase();
        if (includeKW.length && !includeKW.every((kw) => blob.includes(kw))) {
            skipped.push({ job: job._id, reason: 'keyword_excluded' });
            continue;
        }
        if (excludeKW.some((kw) => blob.includes(kw))) {
            skipped.push({ job: job._id, reason: 'keyword_excluded' });
            continue;
        }
        const score = (0, scorer_1.scoreForAutoApply)(user, job);
        if (score.total < settings.matchingRules.minMatchPercentage) {
            skipped.push({ job: job._id, reason: 'below_match', matchScore: score.total });
            continue;
        }
        if (score.matchedSkills.length < settings.matchingRules.minSkillsMatchCount) {
            skipped.push({ job: job._id, reason: 'missing_required_skills', matchScore: score.total });
            continue;
        }
        if (settings.preferences.minSalary) {
            const offered = job.salaryMax ?? job.salaryMin ?? 0;
            if (offered > 0 && offered < settings.preferences.minSalary) {
                skipped.push({ job: job._id, reason: 'salary_below_threshold', matchScore: score.total });
                continue;
            }
        }
        ranked.push({ job, score: score.total, matched: score.matchedSkills.length });
    }
    ranked.sort((a, b) => b.score - a.score || b.matched - a.matched);
    const limit = Math.min(settings.dailyLimit, ranked.length);
    const selected = ranked.slice(0, limit);
    const overflow = ranked.slice(limit);
    for (const o of overflow) {
        skipped.push({ job: o.job._id, reason: 'limit_reached', matchScore: o.score });
    }
    const applied = [];
    const coverLetterEnabled = settings.aiCoverLetter.enabled && tier === 'yearly';
    if (!settings.reviewMode && !options.dryRun) {
        for (const cand of selected) {
            try {
                let quickNote;
                if (coverLetterEnabled) {
                    try {
                        const cl = await (0, coverLetter_service_1.generateCoverLetter)({
                            user,
                            job: cand.job,
                            tone: settings.aiCoverLetter.tone,
                            baseTemplate: settings.aiCoverLetter.baseTemplate,
                        });
                        quickNote = cl.letter;
                    }
                    catch (e) {
                        logger_1.logger.warn(`[autoApply] cover-letter failed for ${cand.job._id}: ${e.message}`);
                    }
                }
                const result = await submitNativeApplication(user, cand.job, cand.score, { quickNote, coverLetterUsed: !!quickNote });
                applied.push(result);
            }
            catch (err) {
                logger_1.logger.warn(`[autoApply] apply failed: ${err.message}`);
                skipped.push({
                    job: cand.job._id,
                    reason: 'already_applied',
                    matchScore: cand.score,
                });
            }
        }
    }
    const appliedForLog = settings.reviewMode
        ? selected.map((cand) => ({
            job: cand.job._id,
            companyName: cand.job.company,
            jobTitle: cand.job.title,
            matchScore: cand.score,
            source: cand.job.isNative ? 'native' : 'external',
            appliedAt: new Date(),
            coverLetterUsed: false,
            status: 'pending_review',
        }))
        : applied;
    const log = await AutoApplyLog_1.AutoApplyLog.create({
        user: user._id,
        runDate: new Date(),
        jobsScanned: pool.length,
        jobsMatched: ranked.length,
        jobsApplied: settings.reviewMode ? 0 : applied.length,
        jobsSkipped: skipped.length,
        appliedJobs: appliedForLog,
        skippedJobs: skipped,
        awaitingApproval: settings.reviewMode && selected.length > 0,
        notificationSent: false,
        triggeredManually: !!options.manual,
    });
    settings.lastRunAt = new Date();
    if (applied.length > 0) {
        settings.totalAutoApplied += applied.length;
    }
    await settings.save();
    try {
        if (applied.length > 0 || (settings.reviewMode && selected.length > 0)) {
            await Notification_1.Notification.create({
                user: user._id,
                role: 'seeker',
                type: 'auto_apply_summary',
                title: settings.reviewMode
                    ? `${selected.length} matches ready to review`
                    : `Applied to ${applied.length} jobs for you`,
                body: settings.reviewMode
                    ? 'Open Auto-Apply to approve or skip today\'s matches.'
                    : `Best match: ${applied[0]?.jobTitle ?? '—'} @ ${applied[0]?.companyName ?? '—'}`,
                data: { logId: log._id.toString() },
            });
            log.notificationSent = true;
            await log.save();
        }
    }
    catch {
    }
    return {
        userId: user._id.toString(),
        ranAt: new Date(),
        jobsScanned: pool.length,
        jobsMatched: ranked.length,
        jobsApplied: applied.length,
        jobsSkipped: skipped.length,
        awaitingApproval: settings.reviewMode && selected.length > 0,
        logId: log._id.toString(),
    };
};
exports.runAutoApplyForUser = runAutoApplyForUser;
const submitNativeApplication = async (user, job, score, options = {}) => {
    if (!job.isNative || job.status !== 'active' || !job.isActive) {
        throw new Error('Job not eligible (not native/active)');
    }
    if (job.applicationDeadline && job.applicationDeadline < new Date()) {
        throw new Error('Past deadline');
    }
    if ((job.screeningQuestions ?? []).some((q) => q.isRequired)) {
        throw new Error('Has required screening questions');
    }
    const exists = await AppliedJob_1.AppliedJob.findOne({ user: user._id, job: job._id });
    if (exists)
        throw new Error('Already applied');
    const application = await AppliedJob_1.AppliedJob.create({
        user: user._id,
        job: job._id,
        hirerProfile: job.hirerProfile,
        jobSnapshot: {
            title: job.title,
            company: job.company,
            location: job.location,
            url: job.url,
        },
        applyType: 'auto_apply',
        source: 'native',
        resumeUrlSnapshot: user.profile.resumeUrl,
        quickNote: options.quickNote,
        matchScore: score,
        status: 'applied',
        statusHistory: [{ status: 'applied', changedAt: new Date(), changedBy: user._id }],
    });
    await Job_1.Job.updateOne({ _id: job._id }, { $inc: { applicationsCount: 1 } });
    return {
        job: job._id,
        application: application._id,
        companyName: job.company,
        jobTitle: job.title,
        matchScore: score,
        source: 'native',
        appliedAt: new Date(),
        coverLetterUsed: !!options.coverLetterUsed,
        status: 'applied',
    };
};
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const submitApprovedApplications = async (user, jobIds) => {
    const applied = [];
    const failed = [];
    const jobs = await Job_1.Job.find({ _id: { $in: jobIds } });
    for (const job of jobs) {
        try {
            const score = (0, scorer_1.scoreForAutoApply)(user, job).total;
            const entry = await submitNativeApplication(user, job, score);
            applied.push(entry);
        }
        catch (err) {
            failed.push({ jobId: job._id.toString(), error: err.message });
        }
    }
    if (applied.length > 0) {
        await AutoApplySettings_1.AutoApplySettings.updateOne({ user: user._id }, { $inc: { totalAutoApplied: applied.length } });
    }
    return { applied, failed };
};
exports.submitApprovedApplications = submitApprovedApplications;
