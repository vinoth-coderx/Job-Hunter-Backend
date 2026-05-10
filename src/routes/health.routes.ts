import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { redis } from '../config/redis';
import { Job } from '../models/Job';
import { env } from '../config/env';
import { JOB_FRESHNESS_DAYS } from '../config/constants';

const router = Router();
const startedAt = Date.now();

const formatBytes = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

const checkMongo = async (): Promise<{ status: string; latencyMs?: number; error?: string }> => {
  const start = Date.now();
  try {
    if (mongoose.connection.readyState !== 1) {
      return { status: 'down', error: `readyState=${mongoose.connection.readyState}` };
    }
    await mongoose.connection.db?.admin().ping();
    return { status: 'up', latencyMs: Date.now() - start };
  } catch (err) {
    return { status: 'down', error: (err as Error).message };
  }
};

const checkRedis = async (): Promise<{ status: string; latencyMs?: number; error?: string }> => {
  const start = Date.now();
  try {
    if (redis.status !== 'ready') {
      return { status: 'down', error: `status=${redis.status}` };
    }
    const pong = await redis.ping();
    return { status: pong === 'PONG' ? 'up' : 'degraded', latencyMs: Date.now() - start };
  } catch (err) {
    return { status: 'down', error: (err as Error).message };
  }
};

router.get('/health', (_req: Request, res: Response) => {
  res.json({
    success: true,
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  });
});

router.get('/health/live', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'alive', timestamp: new Date().toISOString() });
});

router.get('/health/ready', async (_req: Request, res: Response) => {
  const [mongo, redisCheck] = await Promise.all([checkMongo(), checkRedis()]);
  const allUp = mongo.status === 'up' && redisCheck.status === 'up';
  res.status(allUp ? 200 : 503).json({
    status: allUp ? 'ready' : 'not_ready',
    checks: { mongo, redis: redisCheck },
    timestamp: new Date().toISOString(),
  });
});

router.get('/health/deep', async (_req: Request, res: Response) => {
  const start = Date.now();
  const [mongo, redisCheck] = await Promise.all([checkMongo(), checkRedis()]);

  let jobStats: { total?: number; freshLast10Days?: number; lastFetchedAt?: Date | null; error?: string } = {};
  try {
    const cutoff = new Date(Date.now() - JOB_FRESHNESS_DAYS * 24 * 60 * 60 * 1000);
    const [total, fresh, latest] = await Promise.all([
      Job.estimatedDocumentCount(),
      Job.countDocuments({ isActive: true, postedAt: { $gte: cutoff } }),
      Job.findOne({}, { fetchedAt: 1 }).sort({ fetchedAt: -1 }).lean(),
    ]);
    jobStats = {
      total,
      freshLast10Days: fresh,
      lastFetchedAt: latest?.fetchedAt ?? null,
    };
  } catch (err) {
    jobStats = { error: (err as Error).message };
  }

  const mem = process.memoryUsage();
  const allUp = mongo.status === 'up' && redisCheck.status === 'up';

  res.status(allUp ? 200 : 503).json({
    status: allUp ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    checkLatencyMs: Date.now() - start,
    environment: env.NODE_ENV,
    nodeVersion: process.version,
    pid: process.pid,
    checks: { mongo, redis: redisCheck },
    jobStats,
    memory: {
      rss: formatBytes(mem.rss),
      heapTotal: formatBytes(mem.heapTotal),
      heapUsed: formatBytes(mem.heapUsed),
      external: formatBytes(mem.external),
    },
  });
});

export default router;
