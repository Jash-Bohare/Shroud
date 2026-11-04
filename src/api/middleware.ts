import { timingSafeEqual } from "node:crypto";
import { NextFunction, Request, Response } from "express";
import { ShroudError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";

function tokensMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Validates the Authorization: Bearer <token> header against the configured DASHBOARD_TOKEN.
 */
export function createAuthMiddleware(expectedToken: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Health endpoint is public
    if (req.path === "/health" || req.path === "/api/health") {
      return next();
    }

    let token = "";
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.slice(7).trim();
    } else if (typeof req.query.token === "string") {
      token = req.query.token.trim();
    }

    if (!token || !expectedToken || !tokensMatch(token, expectedToken)) {
      res.status(401).json({
        error: {
          code: "UNAUTHORIZED",
          message: "Missing or invalid dashboard authorization token"
        }
      });
      return;
    }

    next();
  };
}

/**
 * Standard error handling middleware for Shroud REST API.
 */
export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof ShroudError) {
    logger.warn({ code: err.code, status: err.status, message: err.message }, "API error handled");
    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details
      }
    });
    return;
  }

  logger.error({ err: err.message, stack: err.stack }, "Unhandled internal error in API");
  res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: err.message || "An unexpected internal error occurred"
    }
  });
}

