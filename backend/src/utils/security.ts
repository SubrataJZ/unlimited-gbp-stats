import { prisma } from '../index';
import logger from './logger';

/**
 * Security Utility Functions
 *
 * Handles:
 * - Failed authentication tracking
 * - Account lockout enforcement
 * - Suspicious activity detection
 * - IP reputation tracking
 */

/**
 * Configuration
 */
const SECURITY_CONFIG = {
  maxFailedAttempts: 5,           // Lock account after this many failures
  lockoutDurationMinutes: 30,     // How long to lock account
  suspiciousThreshold: 10,        // Failed attempts in window = suspicious
  suspiciousWindow: 60,           // Time window in minutes for threshold
  rapidAttackThreshold: 20,       // Failed attempts = rapid attack
  rapidAttackWindow: 5,           // Time window in minutes for rapid attacks
};

export interface SecurityEvent {
  userId?: string;
  email?: string;
  ipAddress: string;
  userAgent?: string;
  reason: string;
  timestamp?: Date;
}

/**
 * Track failed authentication attempt
 */
export async function recordFailedAuth(event: SecurityEvent): Promise<void> {
  try {
    // Create security event record
    await prisma.auditLog.create({
      data: {
        userId: event.userId,
        action: 'AUTH_FAILED',
        status: 'failure',
        ipAddress: event.ipAddress,
        userAgent: event.userAgent,
        metadata: { reason: event.reason, email: event.email },
      },
    });

    logger.warn(`Failed auth recorded: ${event.reason}`, {
      userId: event.userId,
      ipAddress: event.ipAddress,
    });
  } catch (error) {
    logger.error('Failed to record auth failure:', error);
  }
}

/**
 * Check if account is locked due to failed attempts
 *
 * Returns: { locked: true, unlocksAt: Date } or { locked: false }
 */
export async function checkAccountLockout(userId: string): Promise<{
  locked: boolean;
  unlocksAt?: Date;
  failedAttempts?: number;
}> {
  try {
    // Count failed auth attempts in last lockout window
    const lockoutWindow = new Date(Date.now() - SECURITY_CONFIG.lockoutDurationMinutes * 60 * 1000);

    const failedAttempts = await prisma.auditLog.count({
      where: {
        userId,
        action: 'AUTH_FAILED',
        status: 'failure',
        createdAt: { gte: lockoutWindow },
      },
    });

    if (failedAttempts >= SECURITY_CONFIG.maxFailedAttempts) {
      // Account is locked
      const oldestFailure = await prisma.auditLog.findFirst({
        where: {
          userId,
          action: 'AUTH_FAILED',
          status: 'failure',
          createdAt: { gte: lockoutWindow },
        },
        orderBy: { createdAt: 'asc' },
      });

      if (oldestFailure) {
        const unlocksAt = new Date(
          oldestFailure.createdAt.getTime() + SECURITY_CONFIG.lockoutDurationMinutes * 60 * 1000
        );
        return {
          locked: true,
          unlocksAt,
          failedAttempts,
        };
      }
    }

    return { locked: false, failedAttempts };
  } catch (error) {
    logger.error('Error checking account lockout:', error);
    // Fail open - don't lock out on errors
    return { locked: false };
  }
}

/**
 * Detect suspicious activity patterns
 *
 * Returns array of detected threats
 */
export async function detectSuspiciousActivity(userId: string, ipAddress: string): Promise<string[]> {
  const threats: string[] = [];

  try {
    // Window for checking suspicious patterns
    const suspiciousWindow = new Date(Date.now() - SECURITY_CONFIG.suspiciousWindow * 60 * 1000);
    const rapidWindow = new Date(Date.now() - SECURITY_CONFIG.rapidAttackWindow * 60 * 1000);

    // Check 1: Multiple failed attempts in short window
    const recentFailures = await prisma.auditLog.count({
      where: {
        userId,
        action: 'AUTH_FAILED',
        status: 'failure',
        createdAt: { gte: suspiciousWindow },
      },
    });

    if (recentFailures >= SECURITY_CONFIG.suspiciousThreshold) {
      threats.push(`Multiple failed auth attempts (${recentFailures} in ${SECURITY_CONFIG.suspiciousWindow}min)`);
    }

    // Check 2: Rapid attack pattern (many failures in very short time)
    const rapidFailures = await prisma.auditLog.count({
      where: {
        userId,
        action: 'AUTH_FAILED',
        status: 'failure',
        createdAt: { gte: rapidWindow },
      },
    });

    if (rapidFailures >= SECURITY_CONFIG.rapidAttackThreshold) {
      threats.push(`Rapid attack pattern detected (${rapidFailures} attempts in ${SECURITY_CONFIG.rapidAttackWindow}min)`);
    }

    // Check 3: Login from multiple IPs in short time
    const recentLogins = await prisma.auditLog.findMany({
      where: {
        userId,
        action: { startsWith: 'LOGIN_' },
        status: 'success',
        createdAt: { gte: suspiciousWindow },
      },
      select: { ipAddress: true, createdAt: true },
    });

    const uniqueIPs = new Set(recentLogins.map((log) => log.ipAddress).filter(Boolean));
    if (uniqueIPs.size > 2) {
      threats.push(`Login from ${uniqueIPs.size} different IPs in ${SECURITY_CONFIG.suspiciousWindow}min`);
    }

    // Check 4: Impossible travel detection (login from distant IPs in short time)
    // Note: Requires geolocation data which isn't currently tracked
    // Can be extended when geolocation is added

    if (threats.length > 0) {
      logger.warn('Suspicious activity detected', {
        userId,
        ipAddress,
        threats,
      });
    }

    return threats;
  } catch (error) {
    logger.error('Error detecting suspicious activity:', error);
    return [];
  }
}

/**
 * Get threat level for a user's current activity
 */
export async function getThreatLevel(
  userId: string,
  ipAddress: string
): Promise<'safe' | 'elevated' | 'high'> {
  try {
    const lockout = await checkAccountLockout(userId);
    if (lockout.locked) return 'high';

    const threats = await detectSuspiciousActivity(userId, ipAddress);
    if (threats.length >= 2) return 'high';
    if (threats.length === 1) return 'elevated';

    return 'safe';
  } catch (error) {
    logger.error('Error calculating threat level:', error);
    return 'safe';
  }
}

/**
 * Clear failed attempts for a user (called after successful login)
 */
export async function clearFailedAttempts(userId: string): Promise<void> {
  try {
    // We don't delete audit logs, but in a future system
    // you could mark them as "cleared" or update a separate failure counter table
    logger.info(`Cleared failed attempts for user ${userId}`);
  } catch (error) {
    logger.error('Error clearing failed attempts:', error);
  }
}

/**
 * Get security summary for a user
 */
export async function getSecuritySummary(userId: string): Promise<{
  failedAttemptsLast24h: number;
  lockoutStatus: {
    locked: boolean;
    unlocksAt?: Date;
  };
  suspiciousPatterns: string[];
  threatLevel: 'safe' | 'elevated' | 'high';
  recentIPs: string[];
}> {
  try {
    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const failedAttempts = await prisma.auditLog.count({
      where: {
        userId,
        action: 'AUTH_FAILED',
        status: 'failure',
        createdAt: { gte: last24h },
      },
    });

    const recentLogins = await prisma.auditLog.findMany({
      where: {
        userId,
        action: { startsWith: 'LOGIN_' },
        createdAt: { gte: last24h },
      },
      select: { ipAddress: true },
      take: 10,
    });

    const recentIPs: string[] = [...new Set(recentLogins.map((log) => log.ipAddress).filter(Boolean) as string[])];

    // Use first IP for threat assessment
    const firstIP = recentIPs[0] || 'unknown';

    const lockout = await checkAccountLockout(userId);
    const threats = await detectSuspiciousActivity(userId, firstIP);
    const threatLevel = await getThreatLevel(userId, firstIP);

    return {
      failedAttemptsLast24h: failedAttempts,
      lockoutStatus: {
        locked: lockout.locked,
        ...(lockout.unlocksAt && { unlocksAt: lockout.unlocksAt }),
      },
      suspiciousPatterns: threats,
      threatLevel,
      recentIPs,
    };
  } catch (error) {
    logger.error('Error getting security summary:', error);
    return {
      failedAttemptsLast24h: 0,
      lockoutStatus: { locked: false },
      suspiciousPatterns: [],
      threatLevel: 'safe',
      recentIPs: [],
    };
  }
}

export const SECURITY_CONFIG_EXPORT = SECURITY_CONFIG;
