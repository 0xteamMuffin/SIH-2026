import type { NextFunction, Request, Response } from "express";

export class AppError extends Error {
  constructor(public readonly status: number, message: string, public readonly code = "REQUEST_FAILED") {
    super(message);
  }
}

export function errorHandler(error: unknown, _request: Request, response: Response, _next: NextFunction) {
  const appError = error instanceof AppError ? error : new AppError(500, "Internal server error", "INTERNAL_ERROR");
  response.status(appError.status).json({ error: { code: appError.code, message: appError.message } });
}
