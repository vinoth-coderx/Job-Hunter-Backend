"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.passport = exports.initPassport = void 0;
const passport_1 = __importDefault(require("passport"));
exports.passport = passport_1.default;
const passport_google_oauth20_1 = require("passport-google-oauth20");
const env_1 = require("./env");
const User_1 = require("../models/User");
const logger_1 = require("../utils/logger");
const initPassport = () => {
    if (!env_1.env.GOOGLE_CLIENT_ID || !env_1.env.GOOGLE_CLIENT_SECRET || !env_1.env.GOOGLE_CALLBACK_URL) {
        logger_1.logger.info('Web Google OAuth disabled (no client secret) — mobile POST /auth/google still works');
        return;
    }
    passport_1.default.use(new passport_google_oauth20_1.Strategy({
        clientID: env_1.env.GOOGLE_CLIENT_ID,
        clientSecret: env_1.env.GOOGLE_CLIENT_SECRET,
        callbackURL: env_1.env.GOOGLE_CALLBACK_URL,
    }, async (_accessToken, _refreshToken, profile, done) => {
        try {
            const email = profile.emails?.[0]?.value;
            if (!email)
                return done(new Error('No email returned from Google'));
            let user = await User_1.User.findOne({ $or: [{ googleId: profile.id }, { email }] });
            if (!user) {
                user = await User_1.User.create({
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
            }
            else if (!user.googleId) {
                user.googleId = profile.id;
                user.isEmailVerified = true;
                await user.save();
            }
            done(null, user);
        }
        catch (err) {
            done(err);
        }
    }));
};
exports.initPassport = initPassport;
