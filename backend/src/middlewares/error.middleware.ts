import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/errors';
import logger from '../utils/logger';

/**
 * Global Error Handler Middleware
 *
 * Purpose:
 * - Catches all errors thrown in route handlers
 * - Formats errors consistently
 * - Logs errors with proper context
 * - Responds with appropriate HTTP status codes
 *
 * @param error Error object (can be AppError or generic Error)
 * @param req Express Request object
 * @param res Express Response object
 * @param next Express NextFunction
 */
export const errorHandler = (
  error: Error | AppError,
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  // Default error response
  let statusCode = 500;
  let message = 'Internal Server Error';
  let isOperational = false;

  // Check if error is an instance of AppError
  if (error instanceof AppError) {
    statusCode = error.statusCode;
    message = error.message;
    isOperational = error.isOperational;
  }

  // Log error with context
  const errorLog = {
    statusCode,
    message,
    path: req.path,
    method: req.method,
    ip: req.ip,
    timestamp: new Date().toISOString(),
    stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
  };

  if (statusCode >= 500) {
    logger.error(`Server Error: ${message}`, errorLog);
  } else {
    logger.warn(`Client Error (${statusCode}): ${message}`, errorLog);
  }

  // Send error response
  res.status(statusCode).json({
    error: {
      message,
      statusCode,
      ...(process.env.NODE_ENV === 'development' && { stack: error.stack }),
    },
  });
};

/**
 * Async Wrapper Middleware
 *
 * Purpose:
 * - Wraps async route handlers to catch unhandled promise rejections
 * - Forwards errors to the global error handler
 *
 * Usage:
 * router.post('/route', asyncHandler(async (req, res) => { ... }))
 *
 * @param fn Async function to wrap
 * @returns Wrapped function that catches errors
 */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
