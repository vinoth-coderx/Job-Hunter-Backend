"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.completenessFromUser = exports.completenessFromProfile = void 0;
const completenessFromProfile = (p) => {
    let s = 0;
    if (p.fullName)
        s += 5;
    if (p.headline && p.headline.length >= 10)
        s += 10;
    if (p.experienceYears > 0)
        s += 5;
    if (p.skills?.length >= 5)
        s += 20;
    else if (p.skills?.length >= 1)
        s += 10;
    if (p.preferredRoles?.length > 0)
        s += 10;
    if (p.preferredLocations?.length > 0)
        s += 10;
    if (p.preferredJobTypes?.length > 0)
        s += 5;
    if (p.expectedSalaryMin && p.expectedSalaryMin > 0)
        s += 5;
    if (p.resumeUrl || p.resumeFile)
        s += 20;
    if (p.resumeText && p.resumeText.length > 200)
        s += 10;
    return Math.max(0, Math.min(100, s));
};
exports.completenessFromProfile = completenessFromProfile;
const completenessFromUser = (user) => (0, exports.completenessFromProfile)(user.profile);
exports.completenessFromUser = completenessFromUser;
