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
exports.TeamInvite = void 0;
const mongoose_1 = __importStar(require("mongoose"));
const inviteSchema = new mongoose_1.Schema({
    hirerProfile: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: 'HirerProfile',
        required: true,
        index: true,
    },
    invitedBy: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', required: true },
    email: {
        type: String,
        required: true,
        lowercase: true,
        trim: true,
        maxlength: 200,
        index: true,
    },
    role: {
        type: String,
        enum: ['admin', 'recruiter', 'interviewer'],
        default: 'recruiter',
    },
    token: { type: String, required: true, unique: true, index: true },
    status: {
        type: String,
        enum: ['pending', 'accepted', 'revoked', 'expired'],
        default: 'pending',
        index: true,
    },
    expiresAt: { type: Date, required: true },
    acceptedAt: Date,
    acceptedBy: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
inviteSchema.index({ hirerProfile: 1, email: 1, status: 1 }, {
    unique: true,
    partialFilterExpression: { status: 'pending' },
});
inviteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
exports.TeamInvite = mongoose_1.default.model('TeamInvite', inviteSchema);
