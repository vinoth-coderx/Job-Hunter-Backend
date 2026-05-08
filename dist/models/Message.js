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
exports.Message = void 0;
const mongoose_1 = __importStar(require("mongoose"));
const messageSchema = new mongoose_1.Schema({
    conversation: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: 'Conversation',
        required: true,
        index: true,
    },
    sender: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    receiver: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: {
        type: String,
        enum: ['text', 'file', 'interview_invite', 'system'],
        default: 'text',
    },
    content: { type: String, required: true, maxlength: 4000 },
    file: {
        url: { type: String, maxlength: 1000 },
        filename: { type: String, maxlength: 200 },
        sizeBytes: { type: Number, min: 0 },
        type: { type: String, maxlength: 100 },
    },
    isRead: { type: Boolean, default: false, index: true },
    readAt: Date,
    sentAt: { type: Date, default: Date.now, index: true },
}, { timestamps: false });
messageSchema.index({ conversation: 1, sentAt: -1 });
messageSchema.index({ sentAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 365 });
exports.Message = mongoose_1.default.model('Message', messageSchema);
