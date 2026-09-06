import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { prisma } from '../index';
import { issueTokenPair, revokeAllRefreshTokens } from '../utils/tokens';
import { resolveOrgId } from './intel.service';
import { sendPasswordResetEmail, sendWelcomeEmail } from './mailer.service';
import { ValidationError, ConflictError, AuthenticationError } from '../utils/errors';
import logger from '../utils/logger';

const BCRYPT_ROUNDS = 12;
const MIN_PASSWORD_LENGTH = 8;
const RESET_TOKEN_TTL_MIN = 30;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A real bcrypt hash to compare against when the account doesn't exist or has no
// password, so login timing doesn't reveal which emails are registered.
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer-not-a-real-password', BCRYPT_ROUNDS);

export function normalizeEmail(email: unknown): string {
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    throw new ValidationError('A valid email address is required');
  }
  return email.trim().toLowerCase();
}

export function assertPasswordStrength(password: unknown): string {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (password.length > 200) {
    throw new ValidationError('Password is too long');
  }
  return password;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

type AuthResult = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: { id: string; email: string; name: string | null };
};

async function issueFor(user: { id: string; email: string; name: string | null }): Promise<AuthResult> {
  const { accessToken, refreshToken, expiresIn } = await issueTokenPair(user.id, user.email);
  return { accessToken, refreshToken, expiresIn, user: { id: user.id, email: user.email, name: user.name } };
}

/**
 * Create a password account. If an account already exists for this email:
 *  - Google-only (no passwordHash): attach the password to it (account linking).
 *  - already has a password: 409, tell them to sign in / reset instead.
 */
export async function registerWithPassword(input: {
  email: unknown;
  password: unknown;
  name?: unknown;
}): Promise<AuthResult> {
  const email = normalizeEmail(input.email);
  const password = assertPasswordStrength(input.password);
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 120) || null : null;

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const existing = await prisma.user.findUnique({ where: { email } });

  let user;
  if (existing) {
    if (existing.passwordHash) {
      throw new ConflictError('An account with this email already exists. Sign in instead.');
    }
    // Google-linked account gaining a password — email already proven via Google.
    user = await prisma.user.update({
      where: { id: existing.id },
      data: {
        passwordHash,
        name: existing.name || name,
        lastLoginAt: new Date(),
        emailVerifiedAt: existing.emailVerifiedAt ?? new Date(),
      },
    });
    logger.info(`Password added to existing Google account ${user.id}`);
  } else {
    user = await prisma.user.create({
      data: { email, name, passwordHash, lastLoginAt: new Date() },
    });
    logger.info(`New password account ${user.id}`);
  }

  // Make the workspace exist now so plan/role gating has something to read.
  await resolveOrgId(user.id);

  // Non-blocking welcome (also serves as soft verification later).
  sendWelcomeEmail(user.email, user.name).catch(() => {});

  return issueFor(user);
}

export async function loginWithPassword(input: {
  email: unknown;
  password: unknown;
}): Promise<AuthResult> {
  const email = normalizeEmail(input.email);
  const password = typeof input.password === 'string' ? input.password : '';

  const user = await prisma.user.findUnique({ where: { email } });

  // Constant-ish work whether or not the user exists / has a password, so the
  // response time doesn't reveal which accounts are real.
  const ok = await bcrypt.compare(password, user?.passwordHash || DUMMY_HASH);

  if (!user || !user.passwordHash || !ok) {
    throw new AuthenticationError('Incorrect email or password');
  }

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await resolveOrgId(user.id);
  return issueFor(user);
}

/**
 * Start a reset. Always resolves the same way (caller returns 200 regardless) so
 * this can't be used to probe which emails have accounts. Returns whether an
 * email was actually queued, for logging/tests only.
 */
export async function requestPasswordReset(rawEmail: unknown, frontendUrl: string): Promise<{ emailed: boolean }> {
  let email: string;
  try {
    email = normalizeEmail(rawEmail);
  } catch {
    return { emailed: false };
  }

  const account = await prisma.user.findUnique({ where: { email } });
  if (!account) {
    logger.info(`Password reset requested for unknown email ${email} — no-op`);
    return { emailed: false };
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MIN * 60 * 1000);

  // Invalidate any earlier outstanding tokens for this user, then store the new one.
  await prisma.$transaction([
    prisma.passwordReset.updateMany({
      where: { userId: account.id, usedAt: null },
      data: { usedAt: new Date() },
    }),
    prisma.passwordReset.create({
      data: { userId: account.id, tokenHash: sha256(token), expiresAt },
    }),
  ]);

  const resetUrl = `${frontendUrl.replace(/\/+$/, '')}/reset-password?token=${token}`;
  const res = await sendPasswordResetEmail(account.email, resetUrl, RESET_TOKEN_TTL_MIN);
  return { emailed: res.sent };
}

/** Complete a reset: validate the one-time token, set the new password. */
export async function resetPassword(input: { token: unknown; password: unknown }): Promise<void> {
  const token = typeof input.token === 'string' ? input.token : '';
  const password = assertPasswordStrength(input.password);
  if (!token) throw new ValidationError('Reset token is required');

  const record = await prisma.passwordReset.findUnique({ where: { tokenHash: sha256(token) } });
  if (!record || record.usedAt || record.expiresAt < new Date()) {
    throw new AuthenticationError('This reset link is invalid or has expired. Request a new one.');
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await prisma.$transaction([
    prisma.passwordReset.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    prisma.user.update({
      where: { id: record.userId },
      data: { passwordHash, emailVerifiedAt: new Date() },
    }),
  ]);
  // Every existing session is now suspect — force re-login everywhere.
  await revokeAllRefreshTokens(record.userId);
  logger.info(`Password reset completed for user ${record.userId}`);
}

/** Signed-in password change: verify the current password first. */
export async function changePassword(userId: string, input: {
  currentPassword: unknown;
  newPassword: unknown;
}): Promise<void> {
  const newPassword = assertPasswordStrength(input.newPassword);
  const current = typeof input.currentPassword === 'string' ? input.currentPassword : '';

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AuthenticationError('Account not found');

  if (user.passwordHash) {
    const ok = await bcrypt.compare(current, user.passwordHash);
    if (!ok) throw new AuthenticationError('Current password is incorrect');
  }
  // If the account had no password (Google-only), this sets one for the first time.

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
  await revokeAllRefreshTokens(userId);
  logger.info(`Password changed for user ${userId}`);
}

export const _internals = { RESET_TOKEN_TTL_MIN, MIN_PASSWORD_LENGTH, sha256 };
