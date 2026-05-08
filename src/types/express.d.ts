import { Types } from 'mongoose';
import { SubscriptionTier, UserRole } from './index';

declare global {
  namespace Express {
    interface User {
      // For guest sessions there is no DB record, so _id is optional.
      _id?: Types.ObjectId;
      id: string;
      email: string;
      role: UserRole;
      subscription?: SubscriptionTier;
    }
    interface Request {
      user?: User;
    }
  }
}

export {};
