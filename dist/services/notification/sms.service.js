"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendOtpSms = exports.sendSms = void 0;
const axios_1 = __importDefault(require("axios"));
const config_service_1 = require("../config/config.service");
const logger_1 = require("../../utils/logger");
const isConfigured = () => !!(0, config_service_1.getAppConfig)('MSG91_AUTH_KEY') &&
    !!(0, config_service_1.getAppConfig)('MSG91_SMS_SENDER_ID') &&
    !!(0, config_service_1.getAppConfig)('MSG91_SMS_TEMPLATE_ID');
const normalisePhone = (raw) => {
    const digits = raw.replace(/[^\d]/g, '');
    if (digits.length === 10)
        return `91${digits}`;
    if (digits.length === 12 && digits.startsWith('91'))
        return digits;
    if (digits.length === 11 && digits.startsWith('0'))
        return `91${digits.slice(1)}`;
    return null;
};
const sendSms = async (input) => {
    if (!isConfigured()) {
        logger_1.logger.debug('SMS gateway not configured — skipping send');
        return false;
    }
    const phone = normalisePhone(input.to);
    if (!phone) {
        logger_1.logger.warn(`[sms] invalid phone, dropping: ${input.to}`);
        return false;
    }
    try {
        await axios_1.default.post('https://control.msg91.com/api/v5/flow/', {
            template_id: (0, config_service_1.getAppConfig)('MSG91_SMS_TEMPLATE_ID'),
            sender: (0, config_service_1.getAppConfig)('MSG91_SMS_SENDER_ID'),
            short_url: '0',
            recipients: [
                {
                    mobiles: phone,
                    ...(input.variables ?? { msg: input.message }),
                },
            ],
        }, {
            timeout: 5000,
            headers: {
                authkey: (0, config_service_1.getAppConfig)('MSG91_AUTH_KEY'),
                'content-type': 'application/json',
            },
        });
        return true;
    }
    catch (err) {
        logger_1.logger.warn(`[sms] gateway send failed: ${err.message}`);
        return false;
    }
};
exports.sendSms = sendSms;
const sendOtpSms = async (phone, code) => (0, exports.sendSms)({
    to: phone,
    message: `Your Job Hunter verification code is ${code}. It expires in 10 minutes.`,
    variables: { otp: code },
});
exports.sendOtpSms = sendOtpSms;
