"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AiProviderAuthError = exports.AiProviderQuotaError = void 0;
class AiProviderQuotaError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AiProviderQuotaError';
    }
}
exports.AiProviderQuotaError = AiProviderQuotaError;
class AiProviderAuthError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AiProviderAuthError';
    }
}
exports.AiProviderAuthError = AiProviderAuthError;
