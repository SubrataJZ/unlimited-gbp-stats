import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import logger from './utils/logger';

// Import routes and middleware
import ingestRoutes from './routes/ingest.routes';
import authRoutes from './routes/auth.routes';
import apiKeyRoutes from './routes/api-keys.routes';
import locationsRoutes from './routes/locations.routes';
import aiRoutes from './routes/ai.routes';
import { errorHandler } from './middlewares/error.middleware';

// Load environment variables
dotenv.config();

// Initialize Prisma Client
export const prisma = new PrismaClient({
  log: process.env.LOG_LEVEL === 'debug' ? ['info', 'warn', 'error'] : ['warn', 'error'],
});

// Initialize Express app
const app: Express = express();
const PORT = process.env.PORT || 3001;

/**
 * =========================================
 * SECURITY MIDDLEWARE
 * =========================================
 */

// Helmet.js for HTTP headers security
app.use(helmet());

/**
 * CORS Configuration
 * - Allows requests from the Chrome extension
 * - Also allows frontend requests from specified origins
 * - Credentials are allowed for OAuth flows
 */
app.use(
  cors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      // In development, allow localhost
      // In production, restrict to specific domains
      const allowedOrigins = [
        'http://localhost:3000', // Next.js frontend
        'http://localhost:3001', // Same domain API
        process.env.FRONTEND_URL || 'http://localhost:3000',
        // Chrome extensions bypass CORS but we validate Extension-ID header
      ];

      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Extension-ID'],
  })
);

/**
 * Body Parser & JSON Handling
 */
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(cookieParser());

/**
 * Logging Middleware
 * - Uses Morgan for HTTP request logging
 * - Custom format for better readability
 */
app.use(
  morgan(':method :url :status :response-time ms - :res[content-length]', {
    stream: {
      write: (message: string) => logger.info(message.trim()),
    },
  })
);

/**
 * Rate Limiting Middleware
 * - General API rate limit: 100 requests per 15 minutes per IP
 * - Strict limit on ingestion endpoint: 50 requests per minute (high frequency pushes)
 */
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false,
  skip: (req: Request) => {
    // Skip rate limiting for health checks
    return req.path === '/health';
  },
});

const ingestLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 50, // Allow 50 ingestion requests per minute per API key
  keyGenerator: (req: Request) => {
    // Rate limit by API key instead of IP for ingestion
    return req.headers.authorization || req.ip || 'unknown';
  },
  message: 'Too many ingestion requests, please slow down.',
});

app.use(generalLimiter);

/**
 * =========================================
 * ROUTES
 * =========================================
 */

// Health check endpoint (no auth required)
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// API Routes
app.use('/api/ingest', ingestLimiter, ingestRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/auth', apiKeyRoutes);
app.use('/api/locations', locationsRoutes);
app.use('/api/ai', aiRoutes);

/**
 * =========================================
 * 404 Handler & Error Handling
 * =========================================
 */

// 404 Handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.path,
    method: req.method,
  });
});

// Global error handler (must be last)
app.use(errorHandler);

/**
 * =========================================
 * SERVER INITIALIZATION
 * =========================================
 */

const startServer = async () => {
  try {
    // Test database connection
    await prisma.$queryRaw`SELECT 1`;
    logger.info('✓ Database connection successful');

    // Start Express server
    app.listen(PORT, () => {
      logger.info(`✓ Server running on http://localhost:${PORT}`);
      logger.info(`✓ Node environment: ${process.env.NODE_ENV || 'development'}`);
      logger.info(`✓ Health check: GET /health`);
      logger.info(`✓ Ingest endpoint: POST /api/ingest`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
};

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully...');
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  await prisma.$disconnect();
  process.exit(0);
});

startServer();

export default app;
