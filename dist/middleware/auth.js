"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authorize = exports.optionalAuth = exports.authenticateOrGuest = exports.authenticate = void 0;
const jwt_1 = require("../utils/jwt");
const ApiError_1 = require("../utils/ApiError");
const User_1 = require("../models/User");
const authenticate = async (req, _res, next) => {
    try {
        const header = req.headers.authorization;
        if (!header || !header.startsWith('Bearer ')) {
            throw ApiError_1.ApiError.unauthorized('Access token required');
        }
        const token = header.split(' ')[1];
        if (!token)
            throw ApiError_1.ApiError.unauthorized('Access token required');
        let payload;
        try {
            payload = (0, jwt_1.verifyAccessToken)(token);
        }
        catch {
            throw ApiError_1.ApiError.unauthorized('Invalid or expired access token');
        }
        if (payload.role === 'guest') {
            throw ApiError_1.ApiError.forbidden('Sign in with a full account to use this feature');
        }
        const user = await User_1.User.findById(payload.userId).select('email role subscription');
        if (!user)
            throw ApiError_1.ApiError.unauthorized('User not found');
        req.user = {
            _id: user._id,
            id: user._id.toString(),
            email: user.email,
            role: user.role,
            subscription: user.subscription.tier,
        };
        next();
    }
    catch (err) {
        next(err);
    }
};
exports.authenticate = authenticate;
const authenticateOrGuest = async (req, _res, next) => {
    try {
        const header = req.headers.authorization;
        if (!header || !header.startsWith('Bearer ')) {
            throw ApiError_1.ApiError.unauthorized('Access token required');
        }
        const token = header.split(' ')[1];
        if (!token)
            throw ApiError_1.ApiError.unauthorized('Access token required');
        let payload;
        try {
            payload = (0, jwt_1.verifyAccessToken)(token);
        }
        catch {
            throw ApiError_1.ApiError.unauthorized('Invalid or expired access token');
        }
        if (payload.role === 'guest') {
            req.user = {
                id: payload.userId,
                email: payload.email,
                role: 'guest',
                subscription: 'free',
            };
            return next();
        }
        const user = await User_1.User.findById(payload.userId).select('email role subscription');
        if (!user)
            throw ApiError_1.ApiError.unauthorized('User not found');
        req.user = {
            _id: user._id,
            id: user._id.toString(),
            email: user.email,
            role: user.role,
            subscription: user.subscription.tier,
        };
        next();
    }
    catch (err) {
        next(err);
    }
};
exports.authenticateOrGuest = authenticateOrGuest;
const optionalAuth = async (req, _res, next) => {
    try {
        const header = req.headers.authorization;
        if (!header || !header.startsWith('Bearer '))
            return next();
        const token = header.split(' ')[1];
        const payload = (0, jwt_1.verifyAccessToken)(token);
        if (payload.role === 'guest') {
            req.user = {
                id: payload.userId,
                email: payload.email,
                role: 'guest',
                subscription: 'free',
            };
            return next();
        }
        const user = await User_1.User.findById(payload.userId).select('email role subscription');
        if (user) {
            req.user = {
                _id: user._id,
                id: user._id.toString(),
                email: user.email,
                role: user.role,
                subscription: user.subscription.tier,
            };
        }
        next();
    }
    catch {
        next();
    }
};
exports.optionalAuth = optionalAuth;
const authorize = (...roles) => (req, _res, next) => {
    if (!req.user)
        return next(ApiError_1.ApiError.unauthorized());
    if (!roles.includes(req.user.role))
        return next(ApiError_1.ApiError.forbidden('Insufficient permissions'));
    next();
};
exports.authorize = authorize;
