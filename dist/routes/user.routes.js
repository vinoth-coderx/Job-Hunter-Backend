"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const user_controller_1 = require("../controllers/user.controller");
const resume_controller_1 = require("../controllers/resume.controller");
const avatar_controller_1 = require("../controllers/avatar.controller");
const auth_1 = require("../middleware/auth");
const validate_1 = require("../middleware/validate");
const upload_1 = require("../middleware/upload");
const ApiError_1 = require("../utils/ApiError");
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
router.patch('/profile', (0, validate_1.validate)(user_controller_1.updateProfileSchema), user_controller_1.updateProfile);
router.post('/change-password', (0, validate_1.validate)(user_controller_1.changePasswordSchema), user_controller_1.changePassword);
router.post('/switch-role', (0, validate_1.validate)(user_controller_1.switchRoleSchema), user_controller_1.switchRole);
router.put('/notification-prefs', (0, validate_1.validate)(user_controller_1.notificationPrefsSchema), user_controller_1.updateNotificationPrefs);
const wrapMulter = (mw, maxBytes) => (req, res, next) => {
    mw(req, res, (err) => {
        if (!err)
            return next();
        if (err instanceof multer_1.default.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return next(ApiError_1.ApiError.badRequest(`File too large — max ${Math.round(maxBytes / 1024 / 1024)}MB`));
            }
            return next(ApiError_1.ApiError.badRequest(`Upload error: ${err.message}`));
        }
        return next(err);
    });
};
router.post('/resume', wrapMulter(upload_1.uploadResume, upload_1.RESUME_MAX_SIZE_BYTES), resume_controller_1.uploadResumeHandler);
router.post('/resume/parse', resume_controller_1.parseResumeHandler);
router.get('/resume', resume_controller_1.downloadResumeHandler);
router.get('/resume/meta', resume_controller_1.resumeMetaHandler);
router.delete('/resume', resume_controller_1.deleteResumeHandler);
router.post('/avatar', wrapMulter(upload_1.uploadAvatar, upload_1.AVATAR_MAX_SIZE_BYTES), avatar_controller_1.uploadAvatarHandler);
router.get('/avatar', avatar_controller_1.getAvatarHandler);
router.get('/avatar/:userId', avatar_controller_1.getAvatarHandler);
router.delete('/avatar', avatar_controller_1.deleteAvatarHandler);
router.delete('/account', user_controller_1.deleteAccount);
exports.default = router;
