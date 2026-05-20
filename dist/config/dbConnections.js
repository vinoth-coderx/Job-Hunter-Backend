"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.areDatabasesReady = exports.getConnectionForMode = exports.getActiveConnection = exports.disconnectAllDatabases = exports.connectAllDatabases = exports.currentRuntimeMode = exports.runWithMode = exports.DEFAULT_RUNTIME_MODE = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const node_async_hooks_1 = require("node:async_hooks");
const env_1 = require("./env");
const logger_1 = require("../utils/logger");
exports.DEFAULT_RUNTIME_MODE = env_1.env.NODE_ENV === 'production' ? 'live' : 'test';
mongoose_1.default.set('strictQuery', true);
let testConn = null;
let liveConn = null;
const modeStorage = new node_async_hooks_1.AsyncLocalStorage();
const runWithMode = (mode, fn) => {
    return modeStorage.run(mode, fn);
};
exports.runWithMode = runWithMode;
const currentRuntimeMode = () => modeStorage.getStore() ?? exports.DEFAULT_RUNTIME_MODE;
exports.currentRuntimeMode = currentRuntimeMode;
const connect = async (uri, label) => {
    const conn = mongoose_1.default.createConnection(uri, {
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
    });
    await conn.asPromise();
    conn.on('disconnected', () => logger_1.logger.warn(`Mongo[${label}] disconnected`));
    conn.on('reconnected', () => logger_1.logger.info(`Mongo[${label}] reconnected`));
    conn.on('error', (err) => logger_1.logger.error(`Mongo[${label}] error`, err));
    logger_1.logger.info(`Mongo[${label}] connected`);
    return conn;
};
const connectAllDatabases = async () => {
    const testUri = env_1.env.MONGODB_URI;
    const liveUri = env_1.env.MONGODB_URI_PROD ?? env_1.env.MONGODB_URI;
    [testConn, liveConn] = await Promise.all([
        connect(testUri, 'test'),
        connect(liveUri, 'live'),
    ]);
    if (testUri === liveUri) {
        logger_1.logger.warn('Mongo: test and live URIs resolve to the same cluster — dual-mode will not isolate data. Set MONGODB_URI_PROD to a separate cluster/db.');
    }
};
exports.connectAllDatabases = connectAllDatabases;
const disconnectAllDatabases = async () => {
    await Promise.all([testConn?.close(), liveConn?.close()]);
    testConn = null;
    liveConn = null;
    logger_1.logger.info('Mongo: all connections closed');
};
exports.disconnectAllDatabases = disconnectAllDatabases;
const getActiveConnection = () => {
    const mode = (0, exports.currentRuntimeMode)();
    const conn = mode === 'live' ? liveConn : testConn;
    if (!conn) {
        throw new Error(`Mongo[${mode}] not connected. Call connectAllDatabases() before reading models.`);
    }
    return conn;
};
exports.getActiveConnection = getActiveConnection;
const getConnectionForMode = (mode) => {
    const conn = mode === 'live' ? liveConn : testConn;
    if (!conn) {
        throw new Error(`Mongo[${mode}] not connected.`);
    }
    return conn;
};
exports.getConnectionForMode = getConnectionForMode;
const areDatabasesReady = () => Boolean(testConn && liveConn);
exports.areDatabasesReady = areDatabasesReady;
