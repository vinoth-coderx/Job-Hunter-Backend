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
exports.Conversation = void 0;
const mongoose_1 = __importStar(require("mongoose"));
const conversationSchema = new mongoose_1.Schema({
    participants: {
        type: [{ type: mongoose_1.Schema.Types.ObjectId, ref: 'User', required: true }],
        validate: {
            validator: (arr) => arr.length === 2,
            message: 'A conversation must have exactly 2 participants',
        },
        index: true,
    },
    application: { type: mongoose_1.Schema.Types.ObjectId, ref: 'AppliedJob', sparse: true },
    job: { type: mongoose_1.Schema.Types.ObjectId, ref: 'Job', sparse: true },
    lastMessage: {
        content: { type: String, maxlength: 2000 },
        sentAt: Date,
        sender: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User' },
    },
    unreadCount: {
        type: Map,
        of: { type: Number, min: 0, default: 0 },
        default: () => new Map(),
    },
    isArchived: { type: Boolean, default: false },
}, { timestamps: true });
conversationSchema.index({ participants: 1, updatedAt: -1 });
exports.Conversation = mongoose_1.default.model('Conversation', conversationSchema);
