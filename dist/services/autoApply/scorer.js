"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scoreForAutoApply = void 0;
const scoreForAutoApply = (user, job) => {
    const userSkills = (user.profile.skills ?? []).map((s) => s.toLowerCase());
    const jobSkills = (job.skills ?? []).map((s) => s.toLowerCase());
    const desc = (job.description ?? '').toLowerCase();
    const title = (job.title ?? '').toLowerCase();
    let skills = 0;
    let matched = [];
    if (jobSkills.length > 0) {
        matched = userSkills.filter((s) => jobSkills.includes(s));
        skills = (matched.length / jobSkills.length) * 40;
        const inDesc = userSkills.filter((s) => !matched.includes(s) && desc.includes(s)).length;
        skills += Math.min(8, inDesc * 2);
    }
    else if (userSkills.length > 0) {
        const overlap = userSkills.filter((s) => desc.includes(s));
        skills = (overlap.length / userSkills.length) * 40;
        matched = overlap;
    }
    skills = Math.min(40, skills);
    let location = 0;
    const userLocs = (user.profile.preferredLocations ?? []).map((l) => l.toLowerCase());
    const jobLoc = (job.location ?? '').toLowerCase();
    if (userLocs.some((l) => jobLoc.includes(l))) {
        location = 20;
    }
    else if (job.remoteType === 'remote' &&
        user.profile.preferredRemote?.includes('remote')) {
        location = 20;
    }
    else if (job.remoteType === 'hybrid' &&
        user.profile.preferredRemote?.includes('hybrid')) {
        location = 12;
    }
    else if (userLocs.length === 0) {
        location = 14;
    }
    let experience = 20;
    const userYears = user.profile.experienceYears ?? 0;
    const minReq = job.experienceMinYears;
    const maxReq = job.experienceMaxYears;
    if (minReq !== undefined && maxReq !== undefined) {
        if (userYears < minReq) {
            const gap = minReq - userYears;
            experience = Math.max(0, 20 - gap * 5);
        }
        else if (userYears > maxReq) {
            const over = userYears - maxReq;
            experience = Math.max(8, 20 - over * 2);
        }
    }
    else if (minReq !== undefined && userYears < minReq) {
        experience = Math.max(0, 20 - (minReq - userYears) * 5);
    }
    let salary = 10;
    const expectedMin = user.profile.expectedSalaryMin;
    if (expectedMin !== undefined && expectedMin > 0) {
        const offered = job.salaryMax ?? job.salaryMin ?? 0;
        if (offered === 0) {
            salary = 6;
        }
        else if (offered >= expectedMin) {
            salary = 10;
        }
        else {
            salary = Math.max(0, 10 * (offered / expectedMin) - 5);
        }
    }
    let titleScore = 0;
    const userRoles = (user.profile.preferredRoles ?? []).map((r) => r.toLowerCase());
    if (userRoles.length === 0) {
        titleScore = 6;
    }
    else if (userRoles.some((r) => title.includes(r))) {
        titleScore = 10;
    }
    else if (userRoles.some((r) => r.split(/\s+/).some((token) => token.length >= 3 && title.includes(token)))) {
        titleScore = 5;
    }
    const total = Math.round(skills + location + experience + salary + titleScore);
    const missingRequiredSkills = jobSkills.length > 0
        ? jobSkills.filter((s) => !userSkills.includes(s))
        : [];
    return {
        total: Math.max(0, Math.min(100, total)),
        breakdown: {
            skills: Math.round(skills),
            location: Math.round(location),
            experience: Math.round(experience),
            salary: Math.round(salary),
            title: Math.round(titleScore),
        },
        matchedSkills: matched.slice(0, 12),
        missingRequiredSkills: missingRequiredSkills.slice(0, 12),
    };
};
exports.scoreForAutoApply = scoreForAutoApply;
