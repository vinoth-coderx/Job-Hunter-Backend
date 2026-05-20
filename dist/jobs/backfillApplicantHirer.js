"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.backfillApplicantHirerLinks = void 0;
const AppliedJob_1 = require("../models/AppliedJob");
const Job_1 = require("../models/Job");
const logger_1 = require("../utils/logger");
const backfillApplicantHirerLinks = async () => {
    try {
        const orphans = (await AppliedJob_1.AppliedJob.find({
            $or: [{ hirerProfile: { $exists: false } }, { hirerProfile: null }],
            job: { $exists: true },
        })
            .select('_id job')
            .limit(2000)
            .lean()).filter((a) => a.job);
        if (orphans.length === 0)
            return;
        const jobIds = [...new Set(orphans.map((a) => a.job.toString()))];
        const jobs = await Job_1.Job.find({ _id: { $in: jobIds } })
            .select('_id hirerProfile')
            .lean();
        const map = new Map();
        for (const j of jobs) {
            if (j.hirerProfile)
                map.set(j._id.toString(), j.hirerProfile.toString());
        }
        let updated = 0;
        for (const a of orphans) {
            const hp = map.get(a.job.toString());
            if (!hp)
                continue;
            await AppliedJob_1.AppliedJob.updateOne({ _id: a._id }, { $set: { hirerProfile: hp } });
            updated++;
        }
        if (updated > 0) {
            logger_1.logger.info(`Backfilled hirerProfile on ${updated} applications`);
        }
    }
    catch (err) {
        logger_1.logger.warn('Applicant hirer backfill failed', err);
    }
};
exports.backfillApplicantHirerLinks = backfillApplicantHirerLinks;
