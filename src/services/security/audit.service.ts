import { Request } from 'express';
import { AuditLog, AuditCategory, AuditActorType, IAuditLog } from '../../models/AuditLog';
import { logger } from '../../utils/logger';
import mongoose from 'mongoose';

export interface WriteAuditInput {
  actor?: { id?: string | mongoose.Types.ObjectId; email?: string };
  actorType: AuditActorType;
  category: AuditCategory;
  action: string;
  target?: { type: string; id?: string | mongoose.Types.ObjectId; label?: string };
  metadata?: Record<string, unknown>;
  outcome?: 'success' | 'failure';
  req?: Request;
}

const headerString = (val: unknown): string | undefined => {
  if (Array.isArray(val)) return val[0];
  if (typeof val === 'string') return val;
  return undefined;
};

export const writeAudit = async (input: WriteAuditInput): Promise<IAuditLog | null> => {
  try {
    const ip = input.req ? input.req.ip ?? headerString(input.req.headers['x-forwarded-for']) : undefined;
    const userAgent = input.req ? headerString(input.req.headers['user-agent']) : undefined;
    const doc = await AuditLog.create({
      actor: input.actor?.id
        ? typeof input.actor.id === 'string'
          ? new mongoose.Types.ObjectId(input.actor.id)
          : input.actor.id
        : undefined,
      actorType: input.actorType,
      actorEmail: input.actor?.email,
      category: input.category,
      action: input.action,
      target: input.target
        ? {
            type: input.target.type,
            id: input.target.id
              ? typeof input.target.id === 'string'
                ? new mongoose.Types.ObjectId(input.target.id)
                : input.target.id
              : undefined,
            label: input.target.label,
          }
        : undefined,
      metadata: input.metadata,
      ip,
      userAgent,
      outcome: input.outcome ?? 'success',
    });
    return doc;
  } catch (err) {
    // Audit logging must never break the calling request. Log + drop.
    logger.error(`[audit] write failed: ${(err as Error).message}`);
    return null;
  }
};
