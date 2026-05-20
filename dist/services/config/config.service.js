"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listAppConfig = exports.clearAppConfigCache = exports.deleteAppConfig = exports.setAppConfig = exports.getRuntimeMode = exports.isAppConfigPreloaded = exports.requireAppConfig = exports.getAppConfig = exports.preloadAppConfig = void 0;
const AppConfig_1 = require("../../models/AppConfig");
const aesCrypto_1 = require("../../utils/aesCrypto");
const logger_1 = require("../../utils/logger");
const dbConnections_1 = require("../../config/dbConnections");
const caches = {
    test: new Map(),
    live: new Map(),
};
const preloaded = { test: false, live: false };
const resolveFromEnv = (key) => {
    const fromEnv = process.env[key];
    return fromEnv && fromEnv.length > 0 ? fromEnv : null;
};
const decryptOrNull = (key, blob) => {
    if (!blob)
        return null;
    try {
        return (0, aesCrypto_1.decryptSecret)(blob);
    }
    catch (err) {
        logger_1.logger.warn(`AppConfig: decrypt failed for "${key}"`, err);
        return null;
    }
};
const pickSlot = (row, key) => {
    if (row.isSecret) {
        return (decryptOrNull(key, row.valueEncrypted) ??
            decryptOrNull(key, row.liveValueEncrypted) ??
            decryptOrNull(key, row.testValueEncrypted));
    }
    return row.value ?? row.liveValue ?? row.testValue ?? null;
};
const preloadMode = async (mode) => {
    const conn = (0, dbConnections_1.getConnectionForMode)(mode);
    const Model = conn.models.AppConfig ?? conn.model('AppConfig', AppConfig_1.AppConfig.schema);
    const rows = (await Model.find({})
        .select('+valueEncrypted +testValueEncrypted +liveValueEncrypted')
        .lean());
    const cache = caches[mode];
    cache.clear();
    for (const row of rows) {
        cache.set(row.key, pickSlot(row, row.key));
    }
    preloaded[mode] = true;
    logger_1.logger.info(`AppConfig[${mode}]: preloaded ${cache.size} key(s)`);
};
const preloadAppConfig = async () => {
    await Promise.allSettled([preloadMode('test'), preloadMode('live')]);
};
exports.preloadAppConfig = preloadAppConfig;
const getAppConfig = (key) => {
    const mode = (0, dbConnections_1.currentRuntimeMode)();
    const cache = caches[mode];
    if (cache.has(key))
        return cache.get(key) ?? null;
    return resolveFromEnv(key);
};
exports.getAppConfig = getAppConfig;
const requireAppConfig = (key) => {
    const v = (0, exports.getAppConfig)(key);
    if (!v) {
        throw new Error(`Missing required config key "${key}". Set it in the admin panel or as an env var.`);
    }
    return v;
};
exports.requireAppConfig = requireAppConfig;
const isAppConfigPreloaded = () => preloaded.test || preloaded.live;
exports.isAppConfigPreloaded = isAppConfigPreloaded;
const getRuntimeMode = () => (0, dbConnections_1.currentRuntimeMode)();
exports.getRuntimeMode = getRuntimeMode;
const setAppConfig = async (args) => {
    const update = {
        category: args.category,
        isSecret: args.isSecret,
        notes: args.notes,
        updatedBy: args.updatedBy,
    };
    if (args.isSecret) {
        update.valueEncrypted = (0, aesCrypto_1.encryptSecret)(args.value);
        update.value = undefined;
    }
    else {
        update.value = args.value;
        update.valueEncrypted = undefined;
    }
    const unset = {
        testValue: '',
        testValueEncrypted: '',
        liveValue: '',
        liveValueEncrypted: '',
    };
    await AppConfig_1.AppConfig.findOneAndUpdate({ key: args.key }, { $set: update, $unset: unset }, { upsert: true, new: true, setDefaultsOnInsert: true });
    const mode = (0, dbConnections_1.currentRuntimeMode)();
    caches[mode].set(args.key, args.value);
};
exports.setAppConfig = setAppConfig;
const deleteAppConfig = async (key) => {
    await AppConfig_1.AppConfig.deleteOne({ key });
    const mode = (0, dbConnections_1.currentRuntimeMode)();
    caches[mode].delete(key);
};
exports.deleteAppConfig = deleteAppConfig;
const clearAppConfigCache = async () => {
    await (0, exports.preloadAppConfig)();
};
exports.clearAppConfigCache = clearAppConfigCache;
const previewOf = (raw, isSecret) => {
    if (!raw)
        return null;
    if (!isSecret)
        return raw;
    return raw.length <= 4 ? '*'.repeat(raw.length) : `••••${raw.slice(-4)}`;
};
const listAppConfig = async () => {
    const rows = await AppConfig_1.AppConfig.find({})
        .select('+valueEncrypted +testValueEncrypted +liveValueEncrypted')
        .lean();
    return rows.map((row) => {
        const plain = pickSlot(row, row.key);
        return {
            key: row.key,
            category: row.category,
            isSecret: row.isSecret,
            hasValue: Boolean(plain),
            preview: previewOf(plain, row.isSecret),
            notes: row.notes,
            updatedAt: row.updatedAt,
        };
    });
};
exports.listAppConfig = listAppConfig;
