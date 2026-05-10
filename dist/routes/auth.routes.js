"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const passport_1 = __importDefault(require("passport"));
const auth_controller_1 = require("../controllers/auth.controller");
const auth_1 = require("../middleware/auth");
const rateLimiter_1 = require("../middleware/rateLimiter");
const validate_1 = require("../middleware/validate");
const env_1 = require("../config/env");
const router = (0, express_1.Router)();
router.post('/register', rateLimiter_1.authLimiter, (0, validate_1.validate)(auth_controller_1.registerSchema), auth_controller_1.register);
router.post('/login', rateLimiter_1.authLimiter, (0, validate_1.validate)(auth_controller_1.loginSchema), auth_controller_1.login);
router.post('/refresh', auth_controller_1.refreshToken);
router.post('/logout', auth_1.authenticate, auth_controller_1.logout);
router.get('/me', auth_1.authenticate, auth_controller_1.me);
router.post('/google', rateLimiter_1.authLimiter, (0, validate_1.validate)(auth_controller_1.googleMobileSchema), auth_controller_1.googleMobileLogin);
router.post('/google/mobile', rateLimiter_1.authLimiter, (0, validate_1.validate)(auth_controller_1.googleMobileSchema), auth_controller_1.googleMobileLogin);
router.post('/firebase', rateLimiter_1.authLimiter, (0, validate_1.validate)(auth_controller_1.firebaseLoginSchema), auth_controller_1.firebaseLogin);
router.post('/check-email-exists', rateLimiter_1.authLimiter, (0, validate_1.validate)(auth_controller_1.checkEmailExistsSchema), auth_controller_1.checkEmailExists);
router.post('/guest', rateLimiter_1.authLimiter, auth_controller_1.guestLogin);
if (env_1.env.GOOGLE_CLIENT_ID && env_1.env.GOOGLE_CLIENT_SECRET) {
    router.get('/google/web', passport_1.default.authenticate('google', { scope: ['profile', 'email'], session: false }));
    router.get('/google/web/callback', passport_1.default.authenticate('google', { session: false, failureRedirect: '/login' }), auth_controller_1.googleCallback);
}
exports.default = router;
