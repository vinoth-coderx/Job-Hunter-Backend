import { Types } from 'mongoose';
import { SubscriptionTier } from './index';

declare global {
  namespace Express {
    interface User {
      _id: Types.ObjectId;
      id: string;
      email: string;
      role: 'user' | 'admin';
      subscription?: SubscriptionTier;
    }
    interface Request {
      user?: User;
    }
  }
}

export {};
