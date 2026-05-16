import { Response } from 'express';
import { z } from 'zod';
import { Alert } from '../models/Alert';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { AuthRequest } from '../types';
import { suggestAlertNames } from '../services/ai/alertNamer.service';

export const createAlertSchema = z.object({
  body: z.object({
    label: z.string().max(120).optional(),
    query: z.string().max(200).default(''),
    filters: z.array(z.string().max(80)).max(20).default([]),
    location: z.string().max(120).optional(),
    sort: z.string().max(40).optional(),
    active: z.boolean().default(true),
  }),
});

export const updateAlertSchema = z.object({
  body: z.object({
    label: z.string().max(120).optional(),
    query: z.string().max(200).optional(),
    filters: z.array(z.string().max(80)).max(20).optional(),
    location: z.string().max(120).optional(),
    sort: z.string().max(40).optional(),
    active: z.boolean().optional(),
  }),
});

export const createAlert = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const { label, query, filters, location, sort, active } = req.body;

  // Dedupe by user + (query, filters, location) so re-saving the same
  // search just toggles its active flag instead of creating a duplicate.
  const sortedFilters = [...filters].sort();
  const existing = await Alert.findOne({
    user: req.user._id,
    query: query || '',
    filters: sortedFilters,
    location: location || null,
  });

  if (existing) {
    existing.label = label ?? existing.label;
    existing.sort = sort ?? existing.sort;
    existing.active = active;
    await existing.save();
    res.json({ success: true, data: existing });
    return;
  }

  const created = await Alert.create({
    user: req.user._id,
    label,
    query: query || '',
    filters: sortedFilters,
    location,
    sort,
    active,
  });

  res.status(201).json({ success: true, data: created });
});

export const listAlerts = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const items = await Alert.find({ user: req.user._id }).sort({ createdAt: -1 });
  res.json({ success: true, data: items });
});

export const updateAlert = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const { id } = req.params;
  const updated = await Alert.findOneAndUpdate(
    { _id: id, user: req.user._id },
    { $set: req.body },
    { new: true, runValidators: true },
  );
  if (!updated) throw ApiError.notFound('Alert not found');
  res.json({ success: true, data: updated });
});

export const deleteAlert = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const { id } = req.params;
  const removed = await Alert.findOneAndDelete({ _id: id, user: req.user._id });
  if (!removed) throw ApiError.notFound('Alert not found');
  res.json({ success: true, message: 'Alert deleted' });
});

export const suggestAlertNameSchema = z.object({
  body: z.object({
    query: z.string().max(200).default(''),
    filters: z.array(z.string().max(80)).max(20).default([]),
    location: z.string().max(120).optional(),
  }),
});

/**
 * Suggest 2-3 alert names for the seeker's saved-search payload. Cached
 * 7d server-side and uses Groq (weight 0), so re-asking on the same
 * filters never burns quota.
 */
export const suggestAlertNamesEndpoint = asyncHandler(
  async (req: AuthRequest, res: Response) => {
    if (!req.user) throw ApiError.unauthorized();
    const { query, filters, location } = req.body as z.infer<
      typeof suggestAlertNameSchema
    >['body'];
    const names = await suggestAlertNames(
      { query, filters, location },
      { userId: String(req.user._id) },
    );
    res.json({ success: true, data: { names } });
  },
);
