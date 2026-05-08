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
exports.JobView = void 0;
const mongoose_1 = __importStar(require("mongoose"));
const jobViewSchema = new mongoose_1.Schema({
    job: { type: mongoose_1.Schema.Types.ObjectId, ref: 'Job', required: true, index: true },
    user: { type: mongoose_1.Schema.Types.ObjectId, ref: 'User', index: true, sparse: true },
    deviceId: { type: String, index: true, sparse: true, maxlength: 200 },
    viewedAt: { type: Date, default: Date.now, index: true },
}, { timestamps: false });
jobViewSchema.index({ viewedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });
jobViewSchema.index({ job: 1, user: 1, viewedAt: -1 });
exports.JobView = mongoose_1.default.model('JobView', jobViewSchema);
