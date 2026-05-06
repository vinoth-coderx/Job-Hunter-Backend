"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.notFoundHandler = exports.errorHandler = void 0;
const ApiError_1 = require("../utils/ApiError");
const logger_1 = require("../utils/logger");
const env_1 = require("../config/env");
const zod_1 = require("zod");
const mongoose_1 = require("mongoose");
const errorHandler = (err, _req, res, _next) => {
    let statusCode = 500;
    let message = 'Internal server error';
    let details = undefined;
    if (err instanceof ApiError_1.ApiError) {
        statusCode = err.statusCode;
        message = err.message;
        details = err.details;
    }
    else if (err instanceof zod_1.ZodError) {
        statusCode = 400;
        message = 'Validation error';
        details = err.errors;
    }
    else if (err instanceof mongoose_1.Error.ValidationError) {
        statusCode = 400;
        message = 'Validation failed';
        details = Object.values(err.errors).map((e) => e.message);
    }
    else if (err instanceof mongoose_1.Error.CastError) {
        statusCode = 400;
        message = `Invalid ${err.path}: ${err.value}`;
    }
    else if (err.code === 11000) {
        statusCode = 409;
        const field = Object.keys(err.keyValue || {})[0];
        message = `Duplicate value for field: ${field}`;
    }
    else if (err.name === 'JsonWebTokenError') {
        statusCode = 401;
        message = 'Invalid token';
    }
    else if (err.name === 'TokenExpiredError') {
        statusCode = 401;
        message = 'Token expired';
    }
    if (statusCode >= 500) {
        logger_1.logger.error('Unhandled error', { message: err.message, stack: err.stack });
    }
    else {
        logger_1.logger.warn(`${statusCode} ${message}`);
    }
    const safeMessage = statusCode >= 500 && env_1.env.NODE_ENV === 'production' ? 'Internal server error' : message;
    res.status(statusCode).json({
        success: false,
        message: safeMessage,
        ...(details && env_1.env.NODE_ENV !== 'production' ? { details } : {}),
        ...(env_1.env.NODE_ENV !== 'production' && statusCode >= 500 ? { stack: err.stack } : {}),
    });
};
exports.errorHandler = errorHandler;
const notFoundHandler = (req, _res, next) => {
    next(ApiError_1.ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
};
exports.notFoundHandler = notFoundHandler;
