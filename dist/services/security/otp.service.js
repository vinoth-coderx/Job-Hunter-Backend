"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyOtp = exports.issueOtp = void 0;
const crypto_1 = __importDefault(require("crypto"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const Otp_1 = require("../../models/Otp");
const ApiError_1 = require("../../utils/ApiError");
const email_service_1 = require("../notification/email.service");
const logger_1 = require("../../utils/logger");
const mongoose_1 = __importDefault(require("mongoose"));
const OTP_TTL_MS = 10 * 60 * 1000;
const SEND_COOLDOWN_MS = 60 * 1000;
const MAX_SENDS_PER_HOUR = 5;
const generateCode = () => {
    const n = crypto_1.default.randomInt(0, 1_000_000);
    return n.toString().padStart(6, '0');
};
const issueOtp = async (input) => {
    const ident = input.identifier.toLowerCase();
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const lastMinute = new Date(Date.now() - SEND_COOLDOWN_MS);
    const recent = await Otp_1.Otp.find({ identifier: ident, purpose: input.purpose, createdAt: { $gte: oneHourAgo } });
    if (recent.length >= MAX_SENDS_PER_HOUR) {
        throw new ApiError_1.ApiError(429, 'Too many OTP requests. Try again later.');
    }
    if (recent.some((r) => r.createdAt > lastMinute)) {
        throw new ApiError_1.ApiError(429, 'OTP already sent. Please wait a minute before retrying.');
    }
    const code = generateCode();
    const codeHash = await bcryptjs_1.default.hash(code, 10);
    await Otp_1.Otp.create({
        user: input.userId
            ? typeof input.userId === 'string'
                ? new mongoose_1.default.Types.ObjectId(input.userId)
                : input.userId
            : undefined,
        identifier: ident,
        channel: input.channel,
        purpose: input.purpose,
        codeHash,
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
        ip: input.ip,
    });
    if (input.channel === 'email') {
        await (0, email_service_1.sendEmail)({
            to: ident,
            subject: 'Your Job Hunter verification code',
            text: `Your verification code is ${code}. It expires in 10 minutes. If you didn't request this, ignore this email.`,
            html: `<div style="font-family:system-ui;font-size:15px">Your verification code is <b style="font-size:22px;letter-spacing:4px">${code}</b><br/>It expires in 10 minutes.<br/>If you didn't request this, ignore this email.</div>`,
        }).catch((e) => logger_1.logger.warn(`[otp] email send failed: ${e.message}`));
    }
    else if (input.channel === 'phone') {
        logger_1.logger.warn(`[otp] phone channel requested but no SMS gateway configured; code persisted only for ${ident}`);
    }
    return { code };
};
exports.issueOtp = issueOtp;
const verifyOtp = async (input) => {
    const ident = input.identifier.toLowerCase();
    const record = await Otp_1.Otp.findOne({
        identifier: ident,
        purpose: input.purpose,
        consumedAt: { $exists: false },
        expiresAt: { $gt: new Date() },
    })
        .select('+codeHash')
        .sort({ createdAt: -1 });
    if (!record)
        throw new ApiError_1.ApiError(400, 'OTP not found or expired. Request a new one.');
    if (record.attempts >= record.maxAttempts) {
        throw new ApiError_1.ApiError(429, 'Too many attempts. Request a new OTP.');
    }
    const matches = await bcryptjs_1.default.compare(input.code, record.codeHash);
    if (!matches) {
        record.attempts += 1;
        await record.save();
        throw new ApiError_1.ApiError(400, 'Incorrect code.');
    }
    record.consumedAt = new Date();
    await record.save();
    return { ok: true, userId: record.user };
};
exports.verifyOtp = verifyOtp;
