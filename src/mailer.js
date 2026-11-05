/**
 * mailer — legacy email delivery module (retained for backward compatibility).
 *
 * Password-reset delivery uses Resend when configured and reports a safe
 * development fallback when no provider is available.
 */
require('dotenv').config();

const RESEND_FROM_DEFAULT = 'ClassQU <onboarding@resend.dev>';

/** Pure: kaunsa provider active hai? -> 'resend' | 'console' */
function mailerProvider(env = process.env) {
  if (String(env.RESEND_API_KEY || '').trim()) return 'resend';
  return 'console';
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Pure: password-reset email ka content (subject/text/html). */
function buildResetEmail(link) {
  const safeLink = escapeHtml(link);
  return {
    subject: 'ClassQU password reset',
    text: `Your ClassQU password reset link (1 hour valid):\n${link}\n\nIf you did not request this, ignore this email.`,
    html:
      `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:auto;padding:24px;border:1px solid #eee;border-radius:8px;">` +
      `<h2 style="margin:0 0 12px;color:#1a2b4c;">ClassQU</h2>` +
      `<p style="margin:0 0 16px;">Your password reset link is valid for 1 hour:</p>` +
      `<p style="margin:0 0 16px;"><a href="${safeLink}" style="display:inline-block;background:#1a2b4c;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;">Reset password</a></p>` +
      `<p style="margin:0;color:#666;font-size:12px;word-break:break-all;">Link: ${safeLink}</p>` +
      `<p style="margin:12px 0 0;color:#666;font-size:12px;">If you did not request this, ignore this email.</p>` +
      `</div>`,
  };
}

/**
 * Resend API se send. deps.ResendImpl tests ke liye inject hota hai (fake client).
 * SDK v6 return: { data: { id } | null, error: { message } | null } — API error
 * throw NAHI hota SDK me, isliye error object khud handle karte hain.
 */
async function sendViaResend(payload, deps = {}) {
  const apiKey = String(deps.apiKey || process.env.RESEND_API_KEY || '').trim();
  const ResendImpl = deps.ResendImpl || require('resend').Resend;
  const from = deps.from || process.env.RESEND_FROM || RESEND_FROM_DEFAULT;
  const resend = new ResendImpl(apiKey);
  const result = await resend.emails.send({ ...payload, from });
  if (result && result.error) {
    throw new Error(result.error.message || 'Resend send failed');
  }
  return { ok: true, via: 'resend', id: result && result.data ? result.data.id : null };
}

/**
 * Unified send — kabhi THROW nahi karta, hamesha { ok, via, error? } return karta
 * hai. deps: tests ke liye { ResendImpl, from, log }.
 */
async function sendMail({ to, subject, text, html }, deps = {}) {
  const log = deps.log || console;
  const payload = { to, subject, text, html };
  const provider = mailerProvider();
  try {
    if (provider === 'resend') {
      const r = await sendViaResend(payload, deps);
      log.log(`[mailer] reset email sent via Resend -> ${to}`);
      return r;
    }
    log.log('[mailer] koi email provider configured nahi (RESEND_API_KEY) — caller ko bataya.');
    return { ok: false, via: 'console', error: 'no-provider-configured' };
  } catch (err) {
    log.error(`[mailer] send FAILED via ${provider} for ${to}: ${err.message}`);
    return { ok: false, via: provider, error: err.message };
  }
}

module.exports = {
  sendMail,
  sendViaResend,
  mailerProvider,
  buildResetEmail,
  RESEND_FROM_DEFAULT,
};
