import mongoose from 'mongoose';
import { env } from './env';
import { readRuntimeMode } from './runtimeMode';
import { logger } from '../utils/logger';

mongoose.set('strictQuery', true);

/**
 * The Mongo cluster the process connects to is driven by the persisted
 * runtime mode (file-backed in `secrets/.runtime-mode`), NOT by
 * `NODE_ENV`. This lets an operator flip between the test + live
 * clusters from the admin UI without touching deployment env.
 *
 * `MONGODB_URI` is the test/dev cluster (also the fallback if no live
 * URI is set). `MONGODB_URI_PROD` is the live cluster.
 */
const resolveMongoUri = (): { uri: string; label: 'live' | 'test' } => {
  const mode = readRuntimeMode();
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
