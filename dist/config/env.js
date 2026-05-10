"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.env = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
const zod_1 = require("zod");
dotenv_1.default.config();
const envSchema = zod_1.z.object({
    NODE_ENV: zod_1.z.enum(['development', 'production', 'test']).default('development'),
    PORT: zod_1.z.string().default('5000').transform(Number),
    CLIENT_URL: zod_1.z.string().default('http://localhost:3000'),
    MONGODB_URI: zod_1.z.string(),
    REDIS_HOST: zod_1.z.string().default('localhost'),
    REDIS_PORT: zod_1.z.string().default('6379').transform(Number),
    REDIS_USERNAME: zod_1.z.string().optional(),
    REDIS_PASSWORD: zod_1.z.string().optional(),
    REDIS_TLS: zod_1.z.string().default('auto'),
    JWT_SECRET: zod_1.z.string().min(32),
    JWT_REFRESH_SECRET: zod_1.z.string().min(32),
    ADZUNA_APP_ID: zod_1.z.string().optional(),
    ADZUNA_APP_KEY: zod_1.z.string().optional(),
    SERPAPI_KEY: zod_1.z.string().optional(),
    RAPIDAPI_KEY: zod_1.z.string().optional(),
    THEIRSTACK_API_KEY: zod_1.z.string().optional(),
    ANTHROPIC_API_KEY: zod_1.z.string().optional(),
    CRON_ENABLED: zod_1.z.string().default('true').transform((v) => v === 'true'),
    SMTP_USER: zod_1.z.string().optional(),
    SMTP_PASS: zod_1.z.string().optional(),
    RAZORPAY_KEY_ID: zod_1.z.string().optional(),
    RAZORPAY_KEY_SECRET: zod_1.z.string().optional(),
    RAZORPAY_WEBHOOK_SECRET: zod_1.z.string().optional(),
    RAZORPAY_TEST_KEY_ID: zod_1.z.string().optional(),
    RAZORPAY_TEST_KEY_SECRET: zod_1.z.string().optional(),
    RAZORPAY_TEST_WEBHOOK_SECRET: zod_1.z.string().optional(),
    STRIPE_SECRET_KEY: zod_1.z.string().optional(),
    STRIPE_WEBHOOK_SECRET: zod_1.z.string().optional(),
    FIREBASE_SERVICE_ACCOUNT_PATH: zod_1.z.string().optional(),
    FIREBASE_PROJECT_ID: zod_1.z.string().optional(),
    CLOUDINARY_CLOUD_NAME: zod_1.z.string().optional(),
    CLOUDINARY_API_KEY: zod_1.z.string().optional(),
    CLOUDINARY_API_SECRET: zod_1.z.string().optional(),
});
const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
    console.error('Invalid environment variables:', parsed.error.format());
    throw new Error('Invalid environment configuration');
}
exports.env = parsed.data;
