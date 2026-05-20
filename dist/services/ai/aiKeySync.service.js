"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncAllProvidersToAppConfig = exports.syncProviderToAppConfig = void 0;
const AiKey_1 = require("../../models/AiKey");
const config_service_1 = require("../config/config.service");
const aesCrypto_1 = require("../../utils/aesCrypto");
const logger_1 = require("../../utils/logger");
const APP_CONFIG_KEY_BY_PROVIDER = {
    gemini: 'GEMINI_API_KEY',
    claude: 'ANTHROPIC_API_KEY',
    groq: 'GROQ_API_KEY',
};
const ALL_PROVIDERS = ['gemini', 'claude', 'groq'];
const syncProviderToAppConfig = async (provider) => {
    const configKey = APP_CONFIG_KEY_BY_PROVIDER[provider];
    try {
        const total = await AiKey_1.AiKey.countDocuments({ provider });
        if (total === 0)
            return;
        const winner = await AiKey_1.AiKey.findOne({ provider, isActive: true })
            .sort({ priority: 1, updatedAt: -1 })
            .select('+apiKeyEncrypted')
            .lean();
        if (!winner) {
            await (0, config_service_1.deleteAppConfig)(configKey);
            return;
        }
        let plain;
        try {
            plain = (0, aesCrypto_1.decryptSecret)(winner.apiKeyEncrypted);
        }
        catch (err) {
            logger_1.logger.warn(`aiKeySync: decrypt failed for ${provider} key ${winner._id.toString()} — skipping AppConfig write`, err);
            return;
        }
        await (0, config_service_1.setAppConfig)({
            key: configKey,
            category: 'ai',
            isSecret: true,
            value: plain,
            notes: `Synced from AiKey "${winner.label}" (auto-managed; edit via /ai page)`,
        });
    }
    catch (err) {
        logger_1.logger.warn(`aiKeySync: failed to sync ${provider} → AppConfig`, err);
    }
};
exports.syncProviderToAppConfig = syncProviderToAppConfig;
const syncAllProvidersToAppConfig = async () => {
    await Promise.all(ALL_PROVIDERS.map(exports.syncProviderToAppConfig));
};
exports.syncAllProvidersToAppConfig = syncAllProvidersToAppConfig;
