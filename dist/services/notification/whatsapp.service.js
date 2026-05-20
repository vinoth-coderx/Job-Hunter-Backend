"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendJobAlertWhatsApp = void 0;
const axios_1 = __importDefault(require("axios"));
const config_service_1 = require("../config/config.service");
const logger_1 = require("../../utils/logger");
const TEMPLATE_PARAMS = 3;
const isConfigured = () => !!(0, config_service_1.getAppConfig)('MSG91_AUTH_KEY') &&
    !!(0, config_service_1.getAppConfig)('MSG91_WHATSAPP_NUMBER') &&
    !!(0, config_service_1.getAppConfig)('MSG91_WHATSAPP_TEMPLATE');
const sendJobAlertWhatsApp = async (params) => {
    if (!isConfigured()) {
        logger_1.logger.debug('MSG91 not configured — skipping WhatsApp alert');
        return;
    }
    if (!params.phone)
        return;
    if (params.jobs.length === 0)
        return;
    const phone = normalisePhone(params.phone);
    if (!phone)
        return;
    const top = params.jobs[0];
    const body = {
        integrated_number: (0, config_service_1.getAppConfig)('MSG91_WHATSAPP_NUMBER'),
        content_type: 'template',
        payload: {
            messaging_product: 'whatsapp',
            type: 'template',
            template: {
                name: (0, config_service_1.getAppConfig)('MSG91_WHATSAPP_TEMPLATE'),
                language: { code: 'en_US', policy: 'deterministic' },
                namespace: (0, config_service_1.getAppConfig)('MSG91_WHATSAPP_NAMESPACE') ?? undefined,
                to_and_components: [
                    {
                        to: [phone],
                        components: {
                            body_1: {
                                type: 'text',
                                value: clip(params.fullName, 60),
                            },
                            body_2: {
                                type: 'text',
                                value: clip(`${top.title} @ ${top.company}`, 100),
                            },
                            body_3: {
                                type: 'text',
                                value: clip(top.url, 200),
                            },
                        },
                    },
                ],
            },
        },
    };
    if (Object.keys(body.payload).length === 0) {
        logger_1.logger.warn('WhatsApp payload is empty — skipping');
        return;
    }
    void TEMPLATE_PARAMS;
    try {
        await axios_1.default.post('https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/', body, {
            timeout: 12_000,
            headers: {
                authkey: (0, config_service_1.getAppConfig)('MSG91_AUTH_KEY') ?? '',
                'Content-Type': 'application/json',
            },
        });
    }
    catch (err) {
        if (axios_1.default.isAxiosError(err)) {
            logger_1.logger.warn(`WhatsApp send failed (${err.response?.status}): ${JSON.stringify(err.response?.data)}`);
        }
        else {
            logger_1.logger.warn(`WhatsApp send failed: ${err.message}`);
        }
    }
};
exports.sendJobAlertWhatsApp = sendJobAlertWhatsApp;
const normalisePhone = (raw) => {
    const cleaned = raw.replace(/[^\d+]/g, '');
    if (cleaned.startsWith('+'))
        return cleaned.length >= 10 ? cleaned : null;
    if (cleaned.length === 10)
        return `+91${cleaned}`;
    if (cleaned.length === 12 && cleaned.startsWith('91'))
        return `+${cleaned}`;
    return null;
};
const clip = (s, max) => s.length <= max ? s : `${s.slice(0, max - 1)}…`;
