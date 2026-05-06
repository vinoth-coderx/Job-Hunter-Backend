"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaseScraper = void 0;
const axios_1 = __importDefault(require("axios"));
const logger_1 = require("../../utils/logger");
const env_1 = require("../../config/env");
const redis_1 = require("../../config/redis");
class BaseScraper {
    runFailureCount = 0;
    static MAX_FAILURES_PER_RUN = 2;
    resetForNewRun() {
        this.runFailureCount = 0;
    }
    async isCooldown() {
        const v = await redis_1.redis.get(`scraper:cooldown:${this.source}`);
        if (v) {
            logger_1.logger.debug(`[${this.source}] in cooldown — skipping (${v})`);
            return true;
        }
        return this.runFailureCount >= BaseScraper.MAX_FAILURES_PER_RUN;
    }
    async setCooldown(reason, seconds) {
        await redis_1.redis.setex(`scraper:cooldown:${this.source}`, seconds, reason);
        logger_1.logger.warn(`[${this.source}] cooldown set: ${reason} for ${seconds}s — will retry after`);
    }
    async handleAxiosError(err, context) {
        this.runFailureCount += 1;
        if (axios_1.default.isAxiosError(err)) {
            const ae = err;
            const status = ae.response?.status;
            const data = ae.response?.data;
            const apiMsg = typeof data === 'object' && data && 'message' in data
                ? String(data.message)
                : typeof data === 'string'
                    ? data.slice(0, 200)
                    : ae.message;
            logger_1.logger.warn(`[${this.source}] ${context} → ${status || 'NETWORK'}: ${apiMsg}`);
            if (status === 401 || status === 403) {
                await this.setCooldown(`auth/quota error ${status}`, 60 * 60);
                return;
            }
            if (status === 429) {
                await this.setCooldown('rate limited', 15 * 60);
                return;
            }
            if (!status && (ae.code === 'ECONNABORTED' || ae.code === 'ETIMEDOUT')) {
                await this.setCooldown('timeout', 5 * 60);
                return;
            }
            return;
        }
        logger_1.logger.warn(`[${this.source}] ${context} → ${err.message}`);
    }
    isWithinFreshness(date) {
        const cutoff = new Date(Date.now() - env_1.env.JOB_FRESHNESS_DAYS * 24 * 60 * 60 * 1000);
        return date >= cutoff;
    }
    log(msg, meta) {
        logger_1.logger.info(`[${this.source}] ${msg}`, meta);
    }
    logError(msg, err) {
        logger_1.logger.error(`[${this.source}] ${msg}`, err);
    }
    normalizeJobType(raw) {
        if (!raw)
            return 'unknown';
        const r = raw.toLowerCase();
        if (r.includes('full'))
            return 'full-time';
        if (r.includes('part'))
            return 'part-time';
        if (r.includes('contract'))
            return 'contract';
        if (r.includes('intern'))
            return 'internship';
        if (r.includes('temp'))
            return 'temporary';
        return 'unknown';
    }
    normalizeRemote(loc, desc) {
        const text = `${loc || ''} ${desc || ''}`.toLowerCase();
        if (text.includes('remote') || text.includes('work from home'))
            return 'remote';
        if (text.includes('hybrid'))
            return 'hybrid';
        if (text.includes('onsite') || text.includes('on-site') || text.includes('in office'))
            return 'onsite';
        return 'unknown';
    }
    extractSkills(description) {
        const skillKeywords = [
            'javascript', 'typescript', 'python', 'java', 'c++', 'c#', 'go', 'rust',
            'react', 'angular', 'vue', 'svelte', 'next.js', 'nuxt',
            'node.js', 'express', 'fastify', 'nest.js', 'django', 'flask', 'fastapi',
            'spring', 'laravel', 'rails',
            'aws', 'gcp', 'azure', 'docker', 'kubernetes', 'terraform',
            'mongodb', 'postgresql', 'mysql', 'redis', 'elasticsearch',
            'kafka', 'rabbitmq', 'graphql', 'rest', 'grpc',
            'flutter', 'react native', 'android', 'ios', 'swift', 'kotlin',
            'machine learning', 'ai', 'tensorflow', 'pytorch', 'data science',
            'devops', 'ci/cd', 'jenkins', 'github actions',
        ];
        const lower = description.toLowerCase();
        return skillKeywords.filter((s) => lower.includes(s));
    }
}
exports.BaseScraper = BaseScraper;
