import { Request } from 'express';

export interface JwtPayload {
  userId: string;
  email: string;
  role: 'user' | 'admin';
}

export type AuthRequest = Request;

export type SubscriptionTier = 'free' | 'weekly' | 'monthly' | 'yearly';
export type SubscriptionStatus = 'active' | 'expired' | 'cancelled';
export type JobSource = 'adzuna' | 'serpapi' | 'rapidapi' | 'puppeteer' | 'playwright';
export type JobType = 'full-time' | 'part-time' | 'contract' | 'internship' | 'temporary' | 'unknown';
export type RemoteType = 'remote' | 'hybrid' | 'onsite' | 'unknown';

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
