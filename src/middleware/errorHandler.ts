import { Request, Response, NextFunction } from "express";
import { ApiError } from "../utils/ApiError";
import { logger } from "../utils/logger";
import { env } from "../config/env";
import { ZodError } from "zod";
import { Error as MongooseError } from "mongoose";
import { AiProviderQuotaError } from "../services/ai/providers";

export const errorHandler = (
  err: Error,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void => {
  let statusCode = 500;
  let message = "Internal server error";
  let details: unknown = undefined;

  if (err instanceof ApiError) {
    statusCode = err.statusCode;
    message = err.message;
    details = err.details;
  } else if (err instanceof AiProviderQuotaError) {
    // Provider-side rate-limit (Gemini/Claude returned 429). User has
    // their own per-day slot, so the bottleneck is the shared free tier.
    // Surface as 429 with a `quota: null` marker so the Flutter client's
    // _maybeThrowQuota path treats it as a daily-limit error instead of
    // a generic 500.
    statusCode = 429;
    message =
      "You’ve reached today’s free limit. Try again tomorrow or upgrade for more generations.";
    details = { quota: null, reason: "global" };
  } else if (err instanceof ZodError) {
    statusCode = 400;
    message = "Validation error";
    details = err.errors;
  } else if (err instanceof MongooseError.ValidationError) {
    statusCode = 400;
    message = "Validation failed";
    details = Object.values(err.errors).map((e) => e.message);
  } else if (err instanceof MongooseError.CastError) {
    statusCode = 400;
    message = `Invalid ${err.path}: ${err.value}`;
  } else if ((err as { code?: number }).code === 11000) {
    statusCode = 409;
    const field = Object.keys(
      (err as { keyValue?: Record<string, unknown> }).keyValue || {},
    )[0];
    message = `Duplicate value for field: ${field}`;
  } else if (err.name === "JsonWebTokenError") {
    statusCode = 401;
    message = "Invalid token";
  } else if (err.name === "TokenExpiredError") {
    statusCode = 401;
    message = "Token expired";
  }

  if (statusCode >= 500) {
    logger.error("Unhandled error", { message: err.message, stack: err.stack });
  } else {
    logger.warn(`${statusCode} ${message}`);
  }

  const safeMessage =
    statusCode >= 500 && env.NODE_ENV === "production"
      ? "Internal server error"
      : message;
  res.status(statusCode).json({
    success: false,
    message: safeMessage,
    ...(details && env.NODE_ENV !== "production" ? { details } : {}),
    ...(env.NODE_ENV !== "production" && statusCode >= 500
      ? { stack: err.stack }
      : {}),
  });
};

export const notFoundHandler = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
};
