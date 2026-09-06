import nodemailer, { Transporter } from 'nodemailer';
import logger from '../utils/logger';

/**
 * Transactional email over SMTP (Hostinger).
 *
 * Env:
 *   SMTP_HOST      e.g. smtp.hostinger.com
 *   SMTP_PORT      465 (implicit TLS) or 587 (STARTTLS)
 *   SMTP_USER      full mailbox address, e.g. no-reply@zixai.in
 *   SMTP_PASS      mailbox password
 *   SMTP_FROM      From header, defaults to "Unlimited GBP Stats <SMTP_USER>"
 *
 * When SMTP is not configured the service degrades gracefully: send() logs the
 * message and returns { sent: false } instead of throwing, so a missing mailbox
 * never takes down registration. Callers that must not leak whether an email
 * exists (password reset) already return 200 regardless.
 */

let transporter: Transporter | null = null;
let configChecked = false;

function getTransporter(): Transporter | null {
  if (configChecked) return transporter;
  configChecked = true;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    logger.warn('SMTP not configured (SMTP_HOST/SMTP_USER/SMTP_PASS) — emails will be logged, not sent');
    return null;
  }

  const port = Number(SMTP_PORT) || 465;
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465, // 465 = implicit TLS; 587 = STARTTLS (secure:false)
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transporter;
}

function fromHeader(): string {
  return process.env.SMTP_FROM || `Unlimited GBP Stats <${process.env.SMTP_USER}>`;
}

export interface SendResult {
  sent: boolean;
  error?: string;
}

export async function send(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<SendResult> {
  const tx = getTransporter();
  if (!tx) {
    logger.info(`[mailer:disabled] would send "${opts.subject}" to ${opts.to}`);
    return { sent: false, error: 'SMTP not configured' };
  }
  try {
    await tx.sendMail({
      from: fromHeader(),
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
    });
    logger.info(`Email sent: "${opts.subject}" → ${opts.to}`);
    return { sent: true };
  } catch (error: any) {
    logger.error(`Email send failed ("${opts.subject}" → ${opts.to}):`, error?.message || error);
    return { sent: false, error: error?.message || 'send failed' };
  }
}

const BRAND = 'Unlimited GBP Stats';

function shell(bodyHtml: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
        <tr><td style="padding:28px 32px 8px">
          <div style="font-size:20px">📊</div>
          <div style="font-weight:700;font-size:16px;color:#111827;margin-top:4px">${BRAND}</div>
        </td></tr>
        <tr><td style="padding:8px 32px 32px;color:#374151;font-size:14px;line-height:1.6">${bodyHtml}</td></tr>
      </table>
      <div style="color:#9ca3af;font-size:12px;margin-top:16px">You received this because someone used this address on ${BRAND}.</div>
    </td></tr>
  </table>
</body></html>`;
}

/** Password-reset email. `resetUrl` already carries the one-time token. */
export async function sendPasswordResetEmail(to: string, resetUrl: string, ttlMinutes: number): Promise<SendResult> {
  const subject = `Reset your ${BRAND} password`;
  const text =
    `Someone asked to reset the password for your ${BRAND} account.\n\n` +
    `Reset it here (link valid for ${ttlMinutes} minutes):\n${resetUrl}\n\n` +
    `If this wasn't you, ignore this email — your password is unchanged.`;
  const html = shell(
    `<p>Someone asked to reset the password for your ${BRAND} account.</p>
     <p style="margin:24px 0">
       <a href="${resetUrl}" style="background:#2563eb;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;display:inline-block;font-weight:600">Reset password</a>
     </p>
     <p style="color:#6b7280">This link is valid for ${ttlMinutes} minutes. If this wasn't you, ignore this email — your password is unchanged.</p>
     <p style="color:#9ca3af;font-size:12px;word-break:break-all">${resetUrl}</p>`
  );
  return send({ to, subject, html, text });
}

/** Welcome / email-verification message (verification is non-blocking for now). */
export async function sendWelcomeEmail(to: string, name: string | null): Promise<SendResult> {
  const subject = `Welcome to ${BRAND}`;
  const hi = name ? `Hi ${name},` : 'Hi,';
  const text = `${hi}\n\nYour ${BRAND} account is ready. You can sign in from the extension or the web dashboard.`;
  const html = shell(
    `<p>${hi}</p><p>Your ${BRAND} account is ready. You can sign in from the extension or the web dashboard any time.</p>`
  );
  return send({ to, subject, html, text });
}
