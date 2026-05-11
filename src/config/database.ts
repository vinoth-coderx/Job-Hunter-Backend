import mongoose from 'mongoose';
import { env } from './env';
import { logger } from '../utils/logger';

mongoose.set('strictQuery', true);

const resolveMongoUri = (): { uri: string; label: 'prod' | 'test/dev' } => {
  if (env.NODE_ENV === 'production') {
    return {
      uri: env.MONGODB_URI_PROD ?? env.MONGODB_URI,
      label: 'prod',
    };
  }
  return { uri: env.MONGODB_URI, label: 'test/dev' };
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
