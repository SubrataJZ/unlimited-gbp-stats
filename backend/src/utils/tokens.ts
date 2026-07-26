import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { prisma } from '../index';

const JWT_SECRET = process.env.JWT_SECRET || '';
const REFRESH_SECRET = process.env.SESSION_SECRET || '';

if (!JWT_SECRET) throw new Error('JWT_SECRET environment variable is required');
if (!REFRESH_SECRET) {
  throw new Error(
    'SESSION_SECRET environment variable is required (set a value different from JWT_SECRET)'
  );
}
if (REFRESH_SECRET === JWT_SECRET) {
  // eslint-disable-next-line no-console
  console.warn(
    '[tokens] SESSION_SECRET equals JWT_SECRET — use distinct secrets so a single leak cannot forge both access and refresh tokens'
  );
}

export interface TokenPayload {
  userId: string;
  email: string;
  type: 'access' | 'refresh';
}

export function signAccessToken(userId: string, email: string): string {
  return jwt.sign(
    { userId, email, type: 'access' } as TokenPayload,
    JWT_SECRET,
    { expiresIn: '15m' }
  );
}

export function signRefreshToken(userId: string, email: string): string {
  return jwt.sign(
    { userId, email, type: 'refresh' } as TokenPayload,
    REFRESH_SECRET,
    { expiresIn: '30d' }
  );
}

export function verifyAccessToken(token: string): TokenPayload {
  return jwt.verify(token, JWT_SECRET) as TokenPayload;
}

export function verifyRefreshToken(token: string): TokenPayload {
  return jwt.verify(token, REFRESH_SECRET) as TokenPayload;
}

export async function issueTokenPair(
  userId: string,
  email: string
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const accessToken = signAccessToken(userId, email);
  const rawRefresh = signRefreshToken(userId, email);

  // Store refresh token in DB (hashed)
  const tokenHash = crypto.createHash('sha256').update(rawRefresh).digest('hex');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

  await prisma.refreshToken.create({
    data: { userId, token: tokenHash, expiresAt },
  });

  return { accessToken, refreshToken: rawRefresh, expiresIn: 900 }; // 15 min
}

export async function rotateRefreshToken(
  rawToken: string
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  const stored = await prisma.refreshToken.findUnique({ where: { token: tokenHash } });

  if (!stored) throw new Error('Refresh token not found');
  if (stored.usedAt) throw new Error('Refresh token already used');
  if (stored.expiresAt < new Date()) throw new Error('Refresh token expired');

  // Mark as used (single-use rotation)
  await prisma.refreshToken.update({
    where: { id: stored.id },
    data: { usedAt: new Date() },
  });

  // Look up user
  const user = await prisma.user.findUnique({
    where: { id: stored.userId },
    select: { id: true, email: true },
  });
  if (!user) throw new Error('User not found');

  return issueTokenPair(user.id, user.email);
}

export async function revokeRefreshToken(rawToken: string): Promise<void> {
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  await prisma.refreshToken.updateMany({
    where: { token: tokenHash },
    data: { usedAt: new Date() },
  });
}

export async function revokeAllRefreshTokens(userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, usedAt: null },
    data: { usedAt: new Date() },
  });
}
