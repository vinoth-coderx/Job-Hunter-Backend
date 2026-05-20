"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.writeAudit = void 0;
const AuditLog_1 = require("../../models/AuditLog");
const logger_1 = require("../../utils/logger");
const mongoose_1 = __importDefault(require("mongoose"));
const headerString = (val) => {
    if (Array.isArray(val))
        return val[0];
    if (typeof val === 'string')
        return val;
    return undefined;
};
const writeAudit = async (input) => {
    try {
        const ip = input.req ? input.req.ip ?? headerString(input.req.headers['x-forwarded-for']) : undefined;
        const userAgent = input.req ? headerString(input.req.headers['user-agent']) : undefined;
        const doc = await AuditLog_1.AuditLog.create({
            actor: input.actor?.id
                ? typeof input.actor.id === 'string'
                    ? new mongoose_1.default.Types.ObjectId(input.actor.id)
                    : input.actor.id
                : undefined,
            actorType: input.actorType,
            actorEmail: input.actor?.email,
            category: input.category,
            action: input.action,
            target: input.target
                ? {
                    type: input.target.type,
                    id: input.target.id
                        ? typeof input.target.id === 'string'
                            ? new mongoose_1.default.Types.ObjectId(input.target.id)
                            : input.target.id
                        : undefined,
                    label: input.target.label,
                }
                : undefined,
            metadata: input.metadata,
            ip,
            userAgent,
            outcome: input.outcome ?? 'success',
        });
        return doc;
    }
    catch (err) {
        logger_1.logger.error(`[audit] write failed: ${err.message}`);
        return null;
    }
};
exports.writeAudit = writeAudit;
