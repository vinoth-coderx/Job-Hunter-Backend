import { JobType, RemoteType } from '../../types';

export interface CompletenessProfile {
  fullName: string;
  headline?: string;
  experienceYears: number;
  skills: string[];
  preferredRoles: string[];
  preferredLocations: string[];
  preferredJobTypes: JobType[];
  preferredRemote?: RemoteType[];
  expectedSalaryMin?: number;
  resumeUrl?: string;
  resumeText?: string;
  resumeFile?: unknown;
}

// Weighted profile completeness score, 0-100. Same weights the
// gamification badges (profile_starter ≥50, profile_pro ≥90) read,
// so anything that touches this also moves the user-visible badge state.
export const completenessFromProfile = (p: CompletenessProfile): number => {
  let s = 0;
  if (p.fullName) s += 5;
  if (p.headline && p.headline.length >= 10) s += 10;
  if (p.experienceYears > 0) s += 5;
  if (p.skills?.length >= 5) s += 20;
  else if (p.skills?.length >= 1) s += 10;
  if (p.preferredRoles?.length > 0) s += 10;
  if (p.preferredLocations?.length > 0) s += 10;
  if (p.preferredJobTypes?.length > 0) s += 5;
  if (p.expectedSalaryMin && p.expectedSalaryMin > 0) s += 5;
  if (p.resumeUrl || p.resumeFile) s += 20;
  if (p.resumeText && p.resumeText.length > 200) s += 10;
  return Math.max(0, Math.min(100, s));
};

export const completenessFromUser = (user: {
  profile: CompletenessProfile;
}): number => completenessFromProfile(user.profile);
