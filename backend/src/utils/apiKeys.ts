import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { prisma } from '../index';
import logger from './logger';

const KEY_PREFIX = 'zx_';
const BCRYPT_ROUNDS = 10;

export function generateRawApiKey(): string {
  return `${KEY_PREFIX}${crypto.randomBytes(32).toString('hex')}`;
}

export async function createApiKey(
  userId: string,
  name: string,
  expiresInDays?: number
): Promise<string> {
  const rawKey = generateRawApiKey();
  const keyHash = bcrypt.hashSync(rawKey, BCRYPT_ROUNDS);
  const prefix = rawKey.substring(0, 10); // "zx_" + 7 chars for display

  const expiresAt = expiresInDays
    ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
    : undefined;

  await prisma.apiKey.upsert({
    where: { userId_name: { userId, name } },
    update: { keyHash, prefix, isActive: true, expiresAt: expiresAt ?? null, lastUsedAt: null },
    create: { userId, name, keyHash, prefix, isActive: true, expiresAt: expiresAt ?? null },
  });

  return rawKey; // Only returned once, never stored plain-text
}

export async function validateApiKey(rawKey: string): Promise<string | null> {
  if (!rawKey.startsWith(KEY_PREFIX)) return null;

  const prefix = rawKey.substring(0, 10);

  const candidates = await prisma.apiKey.findMany({
    where: { prefix, isActive: true },
  });

  for (const candidate of candidates) {
    if (candidate.expiresAt && candidate.expiresAt < new Date()) continue;

    const match = bcrypt.compareSync(rawKey, candidate.keyHash);
    if (match) {
      await prisma.apiKey.update({
        where: { id: candidate.id },
        data: { lastUsedAt: new Date() },
      });
      return candidate.userId;
    }
  }

  logger.warn(`Invalid API key attempt with prefix: ${prefix}`);
  return null;
}
