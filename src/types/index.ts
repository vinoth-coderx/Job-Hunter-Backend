import { Request } from 'express';

export type UserRole = 'user' | 'admin' | 'guest';

export interface JwtPayload {
  userId: string;
  email: string;
  role: UserRole;
}

export type AuthRequest = Request;

export type SubscriptionTier = 'free' | 'weekly' | 'monthly' | 'yearly';
export type SubscriptionStatus = 'active' | 'expired' | 'cancelled' | 'refunded';
export type JobSource =
  | 'native'
  | 'adzuna'
  | 'serpapi'
  | 'rapidapi'
  | 'arbeitnow'
  | 'theirstack'
  | 'puppeteer'
  | 'playwright';
export type JobType = 'full-time' | 'part-time' | 'contract' | 'internship' | 'temporary' | 'unknown';
export type RemoteType = 'remote' | 'hybrid' | 'onsite' | 'unknown';
export type JobStatus = 'draft' | 'active' | 'paused' | 'closed' | 'expired';
export type ScreeningQuestionType = 'text' | 'mcq' | 'yes_no';
export type CompanySize = '1-10' | '11-50' | '51-200' | '201-500' | '500-1000' | '1000+';
export type NotificationType =
  | 'new_job_match'
  | 'application_status'
  | 'interview_scheduled'
  | 'new_message'
  | 'auto_apply_summary'
  | 'profile_viewed'
  | 'subscription_expiry'
  | 'company_new_job'
  | 'new_applicant'
  | 'system';

export interface ScrapedJob {
  externalId: string;
  source: JobSource;
  title: string;
  company: string;
  location: string;
  description: string;
  url: string;
  salaryMin?: number;
  salaryMax?: number;
  currency?: string;
  jobType?: JobType;
  remoteType?: RemoteType;
  skills?: string[];
  postedAt: Date;
  raw?: Record<string, unknown>;
}

export interface UserProfile {
  fullName: string;
  headline?: string;
  skills: string[];
  experienceYears: number;
  preferredRoles: string[];
  preferredLocations: string[];
  preferredJobTypes: JobType[];
  preferredRemote: RemoteType[];
  expectedSalaryMin?: number;
  resumeText?: string;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  message?: string;
  data?: T;
  error?: string;
  meta?: {
    page?: number;
    limit?: number;
    total?: number;
    totalPages?: number;
  };
}
