import passport from 'passport';
import { Strategy as GoogleStrategy, Profile } from 'passport-google-oauth20';
import { env } from './env';
import { User } from '../models/User';
import { logger } from '../utils/logger';

export const initPassport = (): void => {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_CALLBACK_URL) {
    logger.info('Web Google OAuth disabled (no client secret) — mobile POST /auth/google still works');
    return;
  }

  passport.use(
    new GoogleStrategy(
      {
        clientID: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        callbackURL: env.GOOGLE_CALLBACK_URL,
      },
      async (
        _accessToken: string,
        _refreshToken: string,
        profile: Profile,
        done: (err: Error | null, user?: Express.User | false) => void,
      ) => {
        try {
          const email = profile.emails?.[0]?.value;
          if (!email) return done(new Error('No email returned from Google'));

          let user = await User.findOne({ $or: [{ googleId: profile.id }, { email }] });

          if (!user) {
            user = await User.create({
              email,
              googleId: profile.id,
              authProvider: 'google',
              isEmailVerified: true,
              profile: {
                fullName: profile.displayName || email.split('@')[0],
                avatar: profile.photos?.[0]?.value,
                skills: [],
                experienceYears: 0,
                preferredRoles: [],
                preferredLocations: [],
                preferredJobTypes: [],
                preferredRemote: [],
              },
              subscription: { tier: 'free', status: 'active' },
            });
          } else if (!user.googleId) {
            user.googleId = profile.id;
            user.isEmailVerified = true;
            await user.save();
          }

          done(null, user as unknown as Express.User);
        } catch (err) {
          done(err as Error);
        }
      },
    ),
  );
};

export { passport };
