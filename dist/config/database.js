"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.disconnectDatabase = exports.connectDatabase = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const env_1 = require("./env");
const logger_1 = require("../utils/logger");
mongoose_1.default.set('strictQuery', true);
const resolveMongoUri = () => {
    const mode = process.env.RUNTIME_MODE === 'test' ? 'test' : 'live';
    if (mode === 'live') {
        return {
            uri: env_1.env.MONGODB_URI_PROD ?? env_1.env.MONGODB_URI,
            label: 'live',
        };
    }
    return { uri: env_1.env.MONGODB_URI, label: 'test' };
};
const connectDatabase = async () => {
    const { uri, label } = resolveMongoUri();
    try {
        await mongoose_1.default.connect(uri, {
            maxPoolSize: 10,
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
        });
        logger_1.logger.info(`MongoDB connected successfully (${label} cluster)`);
    }
    catch (error) {
        logger_1.logger.error('MongoDB connection error:', error);
        process.exit(1);
    }
};
exports.connectDatabase = connectDatabase;
mongoose_1.default.connection.on('disconnected', () => {
    logger_1.logger.warn('MongoDB disconnected');
});
mongoose_1.default.connection.on('reconnected', () => {
    logger_1.logger.info('MongoDB reconnected');
});
const disconnectDatabase = async () => {
    await mongoose_1.default.disconnect();
    logger_1.logger.info('MongoDB disconnected');
};
exports.disconnectDatabase = disconnectDatabase;
