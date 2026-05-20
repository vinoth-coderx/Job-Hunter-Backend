"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.JobSourceConfig = void 0;
const mongoose_1 = __importStar(require("mongoose"));
const genericSchema = new mongoose_1.Schema({
    endpointUrl: { type: String, required: true },
    httpMethod: { type: String, enum: ['GET', 'POST'], default: 'GET' },
    authHeader: String,
    authValueConfigKey: String,
    authValuePrefix: String,
    requestHeaders: { type: mongoose_1.Schema.Types.Mixed, default: {} },
    requestBody: String,
    responseRootPath: { type: String, required: true },
    fieldMap: {
        title: { type: String, required: true },
        company: { type: String, required: true },
        location: String,
        description: String,
        url: { type: String, required: true },
        externalId: { type: String, required: true },
        salary: String,
        type: String,
        postedAt: String,
    },
    pageParam: String,
    pageCount: { type: Number, default: 1, min: 1, max: 10 },
    rateLimitMs: { type: Number, default: 0, min: 0 },
}, { _id: false });
const jobSourceConfigSchema = new mongoose_1.Schema({
    source: { type: String, required: true, unique: true, index: true },
    label: { type: String, required: true },
    category: { type: String, required: true },
    pricing: {
        type: String,
        enum: ['Free', 'Freemium', 'Paid'],
        default: 'Free',
    },
    type: {
        type: String,
        enum: ['builtin', 'generic'],
        required: true,
    },
    enabled: { type: Boolean, default: true },
    keyConfigKeys: { type: [String], default: [] },
    queries: { type: [String], default: [] },
    locations: { type: [String], default: [] },
    generic: { type: genericSchema, required: false },
    notes: String,
}, { timestamps: true });
exports.JobSourceConfig = mongoose_1.default.models.JobSourceConfig ||
    mongoose_1.default.model('JobSourceConfig', jobSourceConfigSchema);
