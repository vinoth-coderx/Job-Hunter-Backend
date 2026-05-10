"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.firebaseLogin = exports.checkEmailExists = exports.checkEmailExistsSchema = exports.firebaseLoginSchema = exports.googleMobileLogin = exports.googleMobileSchema = exports.guestLogin = exports.googleCallback = exports.me = exports.logout = exports.refreshToken = exports.login = exports.register = exports.loginSchema = exports.registerSchema = void 0;
const zod_1 = require("zod");
const google_auth_library_1 = require("google-auth-library");
const User_1 = require("../models/User");
const ApiError_1 = require("../utils/ApiError");
const jwt_1 = require("../utils/jwt");
const crypto_1 = require("crypto");
const asyncHandler_1 = require("../utils/asyncHandler");
const logger_1 = require("../utils/logger");
const crypto_2 = require("../utils/crypto");
const security_1 = require("../middleware/security");
const env_1 = require("../config/env");
const admin_service_1 = require("../services/firebase/admin.service");
const googleAudiences = [
    env_1.env.GOOGLE_CLIENT_ID,
    env_1.env.GOOGLE_ANDROID_CLIENT_ID,
    env_1.env.GOOGLE_IOS_CLIENT_ID,
].filter((id) => Boolean(id));
const googleClient = new google_auth_library_1.OAuth2Client();
const strongPassword = zod_1.z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(100)
    .regex(/[A-Z]/, 'Password must contain an uppercase letter')
    .regex(/[a-z]/, 'Password must contain a lowercase letter')
    .regex(/[0-9]/, 'Password must contain a number')
    .regex(/[^A-Za-z0-9]/, 'Password must contain a special character');
exports.registerSchema = zod_1.z.object({
    body: zod_1.z.object({
        email: zod_1.z.string().email().max(254),
        password: strongPassword,
        fullName: zod_1.z.string().min(2).max(100),
        phone: zod_1.z.string().max(20).optional(),
    }),
});
exports.loginSchema = zod_1.z.object({
    body: zod_1.z.object({
        email: zod_1.z.string().email(),
        password: zod_1.z.string().min(1),
    }),
});
exports.register = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { email, password, fullName, phone } = req.body;
    const existing = await User_1.User.findOne({ email });
    if (existing)
        throw ApiError_1.ApiError.conflict('Email already registered');
    const verificationToken = (0, crypto_2.randomToken)(32);
    const user = await User_1.User.create({
        email,
        password,
        authProvider: 'local',
        isEmailVerified: false,
        emailVerificationToken: verificationToken,
        profile: {
            fullName,
            phone,
            skills: [],
            experienceYears: 0,
            preferredRoles: [],
            preferredLocations: [],
            preferredJobTypes: [],
            preferredRemote: [],
        },
        subscription: { tier: 'free', status: 'active' },
    });
    const tokens = (0, jwt_1.generateTokenPair)({
        userId: user._id.toString(),
        email: user.email,
        role: user.role,
    });
    user.refreshTokens = [tokens.refreshToken];
    await user.save();
    logger_1.logger.info(`New user registered: ${email}`);
    res.status(201).json({
        success: true,
        message: 'Registered successfully',
        data: {
            user: {
                id: user._id,
                email: user.email,
                fullName: user.profile.fullName,
                role: user.role,
                subscription: user.subscription,
            },
            ...tokens,
        },
    });
});
exports.login = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { email, password } = req.body;
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const lockKey = `${email}:${ip}`;
    if (await (0, security_1.isLockedOut)(lockKey)) {
        throw ApiError_1.ApiError.tooMany('Too many failed attempts. Try again in 30 minutes.');
    }
    const user = await User_1.User.findOne({ email }).select('+password +refreshTokens');
    if (!user) {
        await (0, security_1.recordFailedLogin)(lockKey);
        throw ApiError_1.ApiError.unauthorized('Invalid email or password');
    }
    if (user.authProvider === 'google' && !user.password) {
        throw ApiError_1.ApiError.badRequest('Use Google login for this account');
    }
    const valid = await user.comparePassword(password);
    if (!valid) {
        const { locked } = await (0, security_1.recordFailedLogin)(lockKey);
        if (locked)
            logger_1.logger.warn(`Account locked: ${email} from ${ip}`);
        throw ApiError_1.ApiError.unauthorized('Invalid email or password');
    }
    await (0, security_1.clearFailedLogins)(lockKey);
    const tokens = (0, jwt_1.generateTokenPair)({
        userId: user._id.toString(),
        email: user.email,
        role: user.role,
    });
    user.refreshTokens = [...(user.refreshTokens || []).slice(-4), tokens.refreshToken];
    user.lastLogin = new Date();
    await user.save();
    res.json({
        success: true,
        message: 'Logged in successfully',
        data: {
            user: {
                id: user._id,
                email: user.email,
                fullName: user.profile.fullName,
                role: user.role,
                subscription: user.subscription,
            },
            ...tokens,
        },
    });
});
exports.refreshToken = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { refreshToken: token } = req.body;
    if (!token)
        throw ApiError_1.ApiError.badRequest('Refresh token required');
    const payload = (0, jwt_1.verifyRefreshToken)(token);
    const user = await User_1.User.findById(payload.userId).select('+refreshTokens');
    if (!user)
        throw ApiError_1.ApiError.unauthorized('User not found');
    if (!user.refreshTokens?.includes(token)) {
        throw ApiError_1.ApiError.unauthorized('Invalid refresh token');
    }
    const tokens = (0, jwt_1.generateTokenPair)({
        userId: user._id.toString(),
        email: user.email,
        role: user.role,
    });
    user.refreshTokens = [
        ...user.refreshTokens.filter((t) => t !== token),
        tokens.refreshToken,
    ].slice(-5);
    await user.save();
    res.json({ success: true, data: tokens });
});
exports.logout = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const { refreshToken: token } = req.body;
    const user = await User_1.User.findById(req.user._id).select('+refreshTokens');
    if (user && token) {
        user.refreshTokens = (user.refreshTokens || []).filter((t) => t !== token);
        await user.save();
    }
    res.json({ success: true, message: 'Logged out' });
});
exports.me = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!req.user)
        throw ApiError_1.ApiError.unauthorized();
    const user = await User_1.User.findById(req.user._id);
    if (!user)
        throw ApiError_1.ApiError.notFound('User not found');
    res.json({
        success: true,
        data: {
            id: user._id,
            email: user.email,
            role: user.role,
            activeRole: user.activeRole,
            profile: user.profile,
            subscription: user.subscription,
            isEmailVerified: user.isEmailVerified,
            createdAt: user.createdAt,
        },
    });
});
exports.googleCallback = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const user = req.user;
    if (!user)
        throw ApiError_1.ApiError.unauthorized('Google authentication failed');
    const tokens = (0, jwt_1.generateTokenPair)({
        userId: user._id.toString(),
        email: user.email,
        role: user.role,
    });
    const dbUser = await User_1.User.findById(user._id).select('+refreshTokens');
    if (dbUser) {
        dbUser.refreshTokens = [...(dbUser.refreshTokens || []).slice(-4), tokens.refreshToken];
        dbUser.lastLogin = new Date();
        await dbUser.save();
    }
    res.json({
        success: true,
        message: 'Google login successful',
        data: { ...tokens },
    });
});
exports.guestLogin = (0, asyncHandler_1.asyncHandler)(async (_req, res) => {
    const guestId = `guest:${(0, crypto_1.randomUUID)()}`;
    const accessToken = (0, jwt_1.generateGuestAccessToken)({
        userId: guestId,
        email: 'guest@jobhunter.local',
        role: 'guest',
    });
    res.json({
        success: true,
        message: 'Guest session created',
        data: {
            user: {
                id: guestId,
                email: null,
                fullName: 'Guest',
                role: 'guest',
                subscription: { tier: 'free', status: 'active' },
                isGuest: true,
            },
            accessToken,
            refreshToken: null,
        },
    });
});
exports.googleMobileSchema = zod_1.z.object({
    body: zod_1.z.object({
        idToken: zod_1.z.string().min(20),
        platform: zod_1.z.enum(['android', 'ios', 'web']).optional(),
    }),
});
exports.googleMobileLogin = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    if (!googleAudiences.length) {
        throw ApiError_1.ApiError.internal('Google login not configured (set GOOGLE_CLIENT_ID/ANDROID_CLIENT_ID/IOS_CLIENT_ID)');
    }
    const { idToken } = req.body;
    let payload;
    try {
        const ticket = await googleClient.verifyIdToken({
            idToken,
            audience: googleAudiences,
        });
        payload = ticket.getPayload();
    }
    catch (err) {
        logger_1.logger.warn('Invalid Google ID token', err);
        throw ApiError_1.ApiError.unauthorized('Invalid Google ID token');
    }
    if (!payload)
        throw ApiError_1.ApiError.unauthorized('Empty Google token payload');
    if (!payload.email)
        throw ApiError_1.ApiError.unauthorized('Google account has no email');
    if (payload.email_verified === false)
        throw ApiError_1.ApiError.unauthorized('Google email not verified');
    const email = payload.email.toLowerCase();
    let user = await User_1.User.findOne({ $or: [{ googleId: payload.sub }, { email }] }).select('+refreshTokens');
    if (!user) {
        user = await User_1.User.create({
            email,
            googleId: payload.sub,
            authProvider: 'google',
            isEmailVerified: true,
            profile: {
                fullName: payload.name || email.split('@')[0],
                avatar: payload.picture,
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
        user.googleId = payload.sub;
        user.isEmailVerified = true;
        if (!user.profile.avatar && payload.picture)
            user.profile.avatar = payload.picture;
        await user.save();
    }
    const tokens = (0, jwt_1.generateTokenPair)({
        userId: user._id.toString(),
        email: user.email,
        role: user.role,
    });
    user.refreshTokens = [...(user.refreshTokens || []).slice(-4), tokens.refreshToken];
    user.lastLogin = new Date();
    await user.save();
    logger_1.logger.info(`Google mobile login: ${email}`);
    res.json({
        success: true,
        message: 'Google login successful',
        data: {
            user: {
                id: user._id,
                email: user.email,
                fullName: user.profile.fullName,
                avatar: user.profile.avatar,
                role: user.role,
                subscription: user.subscription,
            },
            ...tokens,
        },
    });
});
exports.firebaseLoginSchema = zod_1.z.object({
    body: zod_1.z.object({
        idToken: zod_1.z.string().min(20),
        fullName: zod_1.z.string().min(2).max(100).optional(),
        phone: zod_1.z.string().max(20).optional(),
    }),
});
exports.checkEmailExistsSchema = zod_1.z.object({
    body: zod_1.z.object({
        email: zod_1.z.string().email(),
    }),
});
exports.checkEmailExists = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const admin = await (0, admin_service_1.getFirebaseAdmin)();
    if (!admin) {
        throw ApiError_1.ApiError.internal('Firebase Auth is not configured on the server (set FIREBASE_SERVICE_ACCOUNT_JSON)');
    }
    const email = req.body.email.toLowerCase().trim();
    try {
        await admin.auth().getUserByEmail(email);
        res.json({ success: true, data: { exists: true } });
    }
    catch (err) {
        const code = err.code;
        if (code === 'auth/user-not-found') {
            res.json({ success: true, data: { exists: false } });
            return;
        }
        logger_1.logger.warn('checkEmailExists lookup failed', err);
        throw ApiError_1.ApiError.internal('Failed to check email');
    }
});
exports.firebaseLogin = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const admin = await (0, admin_service_1.getFirebaseAdmin)();
    if (!admin) {
        throw ApiError_1.ApiError.internal('Firebase Auth is not configured on the server (set FIREBASE_SERVICE_ACCOUNT_JSON)');
    }
    const { idToken, fullName, phone } = req.body;
    let decoded;
    try {
        decoded = await admin.auth().verifyIdToken(idToken, true);
    }
    catch (err) {
        logger_1.logger.warn('Firebase ID token verification failed', err);
        throw ApiError_1.ApiError.unauthorized('Invalid Firebase ID token');
    }
    const firebaseUid = decoded.uid;
    const email = decoded.email?.toLowerCase();
    if (!email) {
        throw ApiError_1.ApiError.unauthorized('Firebase token has no email — provider must include email scope');
    }
    let user = await User_1.User.findOne({
        $or: [{ firebaseUid }, { email }],
    }).select('+refreshTokens');
    if (!user) {
        user = await User_1.User.create({
            email,
            firebaseUid,
            authProvider: 'firebase',
            isEmailVerified: decoded.email_verified ?? false,
            profile: {
                fullName: fullName?.trim() || decoded.name || email.split('@')[0],
                phone: phone?.trim(),
                avatar: decoded.picture,
                skills: [],
                experienceYears: 0,
                preferredRoles: [],
                preferredLocations: [],
                preferredJobTypes: [],
                preferredRemote: [],
            },
            subscription: { tier: 'free', status: 'active' },
        });
        logger_1.logger.info(`New user via Firebase Auth: ${email}`);
    }
    else if (!user.firebaseUid) {
        user.firebaseUid = firebaseUid;
        if (!user.isEmailVerified && decoded.email_verified) {
            user.isEmailVerified = true;
        }
        if (!user.profile.avatar && decoded.picture) {
            user.profile.avatar = decoded.picture;
        }
        await user.save();
        logger_1.logger.info(`Linked Firebase UID to existing account: ${email}`);
    }
    const tokens = (0, jwt_1.generateTokenPair)({
        userId: user._id.toString(),
        email: user.email,
        role: user.role,
    });
    user.refreshTokens = [...(user.refreshTokens || []).slice(-4), tokens.refreshToken];
    user.lastLogin = new Date();
    await user.save();
    res.json({
        success: true,
        message: 'Firebase login successful',
        data: {
            user: {
                id: user._id,
                email: user.email,
                fullName: user.profile.fullName,
                avatar: user.profile.avatar,
                role: user.role,
                subscription: user.subscription,
            },
            ...tokens,
        },
    });
});
