import mongoose from 'mongoose';
import { env } from './env';
import { logger } from '../utils/logger';

mongoose.set('strictQuery', true);

/**
 * Single-connection bootstrap used by one-off CLI scripts. The HTTP
 * server uses `dbConnections.ts` instead, which opens BOTH the test
 * and live clusters simultaneously so admin requests can be served
 * against either DB via the X-Runtime-Mode header.
 *
 * Scripts pick which cluster they target via the `RUNTIME_MODE` env
 * (defaults to `live` for safety). Examples:
 *
 *   RUNTIME_MODE=test npm run seed:admin -- --email=…
 *   RUNTIME_MODE=live npm run fetch:jobs
 */
const resolveMongoUri = (): { uri: string; label: 'live' | 'test' } => {
  const mode = process.env.RUNTIME_MODE === 'test' ? 'test' : 'live';
  if (mode === 'live') {
    return {
      uri: env.MONGODB_URI_PROD ?? env.MONGODB_URI,
      label: 'live',
    };
  }
  return { uri: env.MONGODB_URI, label: 'test' };
};

export const connectDatabase = async (): Promise<void> => {
  const { uri, label } = resolveMongoUri();
  try {
    await mongoose.connect(uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
    logger.info(`MongoDB connected successfully (${label} cluster)`);
  } catch (error) {
    logger.error('MongoDB connection error:', error);
    process.exit(1);
  }
};

mongoose.connection.on('disconnected', () => {
  logger.warn('MongoDB disconnected');
});

mongoose.connection.on('reconnected', () => {
  logger.info('MongoDB reconnected');
});

export const disconnectDatabase = async (): Promise<void> => {
  await mongoose.disconnect();
  logger.info('MongoDB disconnected');
};
