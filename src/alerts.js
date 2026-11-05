/**
 * Telegram alerts for operational problems (QUMS session expiry).
 *
 * Contract:
 *   - sent ONLY when Telegram is configured AND that user linked their account
 *     (telegramChatId) — otherwise silently skipped, never a crash;
 *   - at most ONE alert per REAL expiry event, per user. The state lives in
 *     PostgreSQL (session_expiry_state) so a Render/Supabase restart cannot
 *     re-send it; the cooldown is per user, never global;
 *   - the alert carries a single inline button "🔄 Reconnect QUMS" that opens
 *     {APP_BASE_URL}/qums-setup?reconnect=1 (production host from env, never
 *     localhost). The user solves the QUMS captcha manually — ClassQU never
 *     bypasses or automates it, and no credential/session data goes to Telegram;
 *   - a successful reconnect clears the state, so a LATER expiry alerts again.
 */
require('dotenv').config();
const { isConfigured, sendMessage, deleteMessage, scheduleAutoDelete } = require('./telegram');
const db = require('./db');

const COOLDOWN_MS = db.SESSION_ALERT_COOLDOWN_MS;
// In-flight mutex per user to prevent concurrent duplicate session-expiry alerts
const alertInFlight = new Set();

/** Public base URL (same resolution order as server.js — Render-safe, HTTPS compliant). */
function baseUrl() {
  const explicit = String(process.env.APP_BASE_URL || '').trim();
  const render = String(process.env.RENDER_EXTERNAL_URL || '').trim();
  const fallback = 'https://qattend.onrender.com';
  return (explicit || render || fallback).replace(/\/+$/, '');
}

/** Reconnect page (GET) — the existing authenticated QUMS setup page. */
function reconnectUrl() {
  const base = baseUrl();
  // Telegram Bot API strictly requires HTTPS URLs for inline keyboard buttons
  const secureBase = /^https:\/\//i.test(base) ? base : 'https://qattend.onrender.com';
  return `${secureBase}/qums-setup?reconnect=1`;
}

// ---- exact user-facing copy (English only; single source of truth) ----
const SESSION_EXPIRED_TEXT = [
  '⚠️ *QUMS Session Expired*',
  '',
  'Your QUMS session has expired. Please reconnect QUMS to resume attendance and assignment updates.',
  '',
  '🔐 Reconnect QUMS',
].join('\n');

const RECONNECTED_TEXT = [
  '✅ *QUMS Reconnected*',
  '',
  'Your QUMS session has been restored. Attendance and assignment monitoring has resumed.',
].join('\n');

/** Inline keyboard with the Reconnect button. */
function reconnectButton(canTelegramReconnect = false) {
  const url = reconnectUrl();
  if (canTelegramReconnect) {
    return {
      inline_keyboard: [
        [
          { text: '🔄 Reconnect QUMS', callback_data: 'qums_start_reconnect' },
          { text: '🔐 Dashboard', url },
        ],
      ],
    };
  }
  return {
    inline_keyboard: [[{ text: '🔐 Reconnect QUMS', url }]],
  };
}

/**
 * Delete previous session-expired alert from Telegram chat.
 * Requirement: Reconnect hone ke baad session expired wala massage delete krdo.
 */
async function deleteSessionExpiredAlert(userId, log = console) {
  try {
    if (!userId) return false;
    const state = await db.getSessionExpiryState(userId);
    let messageId = state?.telegramMessageId;
    if (!messageId) {
      const notifs = await db.recentNotifications(20).catch(() => []);
      const match = (notifs || []).find((n) => n.userId === userId && n.kind === 'session_expired' && n.meta && n.meta.messageId);
      if (match) messageId = match.meta.messageId;
    }
    if (messageId) {
      let deleted = false;
      if (typeof deleteMessage === 'function') {
        const res = await deleteMessage(userId, messageId, log).catch(() => false);
        deleted = Boolean(res);
      }
      if (deleted) {
        await db.clearSessionExpiryTelegramMessage(userId).catch(() => {});
        log.log(`[alerts] 🗑️ Session-expired message ${messageId} deleted for user=${userId}.`);
        return true;
      }
      log.log(`[alerts] ⚠️ Session-expired message ${messageId} deletion failed or skipped for user=${userId}.`);
      return false;
    }
    return false;
  } catch (err) {
    log.log(`[alerts] deleteSessionExpiredAlert warning: ${err.message}`);
    return false;
  }
}

/**
 * Send the session-expired Telegram alert to ONE user — but only if:
 *   1. Telegram is configured (token present), and
 *   2. that user has linked their Telegram (telegramChatId), and
 *   3. no alert was already sent for THIS expiry event.
 *
 * State is persisted in PostgreSQL (session_expiry_state) — restart-safe — and
 * is always per user, so one user's expiry can never silence another's.
 * `evidence` should only be set when the portal really returned a login page
 * (SessionExpiredError). Network failures must call this with evidence=false,
 * which records the error but sends nothing.
 */
async function maybeNotifySessionExpired(log = console, userId, { evidence = true, isManualAdminAlert = false } = {}) {
  try {
    const logger = (log && typeof log.log === 'function') ? log : console;
    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      const diag = typeof userId === 'object' && userId !== null ? JSON.stringify(userId) : String(userId);
      const errMsg = `[alerts] maybeNotifySessionExpired rejected invalid userId (${typeof userId}): ${diag}`;
      if (typeof logger.error === 'function') logger.error(errMsg);
      else logger.log(errMsg);
      return false;
    }
    if (!evidence) {
      // Temporary QUMS outage: record it, never alert (avoids Telegram spam).
      await db.touchUserSync(userId, { error: 'qums-unreachable' }).catch(() => {});
      logger.log(`[alerts] user=${userId} QUMS unreachable — not treated as expiry, no alert sent.`);
      return false;
    }

    if (alertInFlight.has(userId)) {
      log.log(`[alerts] user=${userId} expiry alert already in flight — skip duplicate send.`);
      return false;
    }
    alertInFlight.add(userId);

    try {
      // Reliable expiry evidence: mark the event if this is a new one.
      const before = await db.getSessionExpiryState(userId);
      const isNewEvent = !before || !before.expiredAt || before.resolvedAt;
      if (isNewEvent) await db.markSessionExpired(userId, 'session-expired');
      const state = await db.getSessionExpiryState(userId);
      if (!isManualAdminAlert && state && state.lastAlertAt && Date.now() - state.lastAlertAt < COOLDOWN_MS) {
        log.log(`[alerts] user=${userId} expiry alert already sent for this event — skip.`);
        return false;
      }
      if (!isConfigured()) {
        log.log('[alerts] Telegram not configured (TELEGRAM_BOT_TOKEN missing) — expiry alert skipped.');
        return false;
      }

      // Check whether user has Telegram and credentials saved for Telegram reconnect button
      const user = await db.getUserById(userId);
      const savedEncrypted = user && (user.qumsPasswordEncrypted || (await db.getQumsEncryptedPassword(userId)));
      const canTelegramReconnect = Boolean(user && user.telegramChatId && user.qumsQid && savedEncrypted);

      // CRITICAL: Background watcher must NEVER automatically launch Chromium or call startTelegramCaptchaReconnect().
      // Instead, we attach an interactive reconnect action/button and wait for the USER to explicitly initiate reconnect.
      const sendOpts = {
        replyMarkup: reconnectButton(canTelegramReconnect),
        category: 'ALERT',
        autoDelete: false,
      };
      const sent = await sendMessage(userId, SESSION_EXPIRED_TEXT, log, sendOpts);
      if (!sent) {
        log.log('[alerts] user has not linked Telegram — expiry alert skipped (the next cycle retries).');
        return false;
      }
      const messageId = sendOpts.messageId || null;
      await db.recordSessionExpiryAlert(userId, messageId);
      await db.recordNotification(userId, 'session_expired', { messageId }, log).catch(() => {});
      log.log(`[alerts] 📲 session-expiry alert sent user=${userId} (msgId=${messageId || 'n/a'}, Reconnect button attached).`);
      return true;
    } finally {
      alertInFlight.delete(userId);
    }
  } catch (err) {
    log.error(`[alerts] session-expiry alert failed: ${err.message}`);
    return false;
  }
}

const RECONNECT_DELETE_DELAY_MS = Number(process.env.RECONNECT_DELETE_DELAY_MS || 5 * 60 * 1000); // 5 minutes default

/**
 * Schedule a Telegram message to be deleted after a specified delay (default: 5 min).
 */
function scheduleMessageDeletion(userId, messageId, delayMs = RECONNECT_DELETE_DELAY_MS, log = console) {
  if (!userId || !messageId) return null;
  if (typeof scheduleAutoDelete === 'function') {
    db.getUserById(userId).then((user) => {
      if (user && user.telegramChatId) {
        scheduleAutoDelete(user.telegramChatId, messageId, delayMs, log);
      }
    }).catch(() => {});
  }
  const timer = setTimeout(async () => {
    try {
      if (typeof deleteMessage === 'function') {
        await deleteMessage(userId, messageId, log).catch(() => {});
        log.log(`[alerts] 🗑️ Reconnect confirmation message ${messageId} auto-deleted after 1 min for user=${userId}.`);
      }
    } catch (err) {
      log.log(`[alerts] auto-delete reconnect message warning: ${err.message}`);
    }
  }, Math.max(0, delayMs));

  if (timer && typeof timer.unref === 'function') {
    timer.unref();
  }
  return timer;
}

/**
 * "✅ QUMS Reconnected" confirmation — sent only after a SUCCESSFUL manual
 * reconnect (the user solved the captcha themselves). Never sent on failure.
 * Deletes any pending "Session Expired" alert message from Telegram,
 * and schedules the reconnect message itself to be deleted after 1 minute.
 */
async function notifyQumsReconnected(log = console, userId, opts = {}) {
  try {
    if (!userId) return false;
    // Reconnect hone ke baad session expired wala message delete krdo
    await deleteSessionExpiredAlert(userId, log);
    await db.clearSessionExpiry(userId);
    if (!isConfigured()) return false;
    const delayMs = opts && opts.deleteAfterMs !== undefined ? Number(opts.deleteAfterMs) : RECONNECT_DELETE_DELAY_MS;
    const sendOpts = {
      category: 'TEMPORARY',
      delayMs,
    };
    const sent = await sendMessage(userId, RECONNECTED_TEXT, log, sendOpts);
    if (sent) {
      const messageId = sendOpts.messageId || null;
      await db.recordNotification(userId, 'qums_reconnected', { messageId }, log).catch(() => {});
      log.log(`[alerts] 📲 QUMS reconnected confirmation sent user=${userId} (msgId=${messageId || 'n/a'}).`);
      // Requirement: Reconnect wala massage fir 1 min ke baad wo v delete ho jaye
      if (messageId) {
        scheduleMessageDeletion(userId, messageId, delayMs, log);
      }
    }
    return Boolean(sent);
  } catch (err) {
    log.error(`[alerts] reconnect confirmation failed: ${err.message}`);
    return false;
  }
}

/**
 * Clear one user's session-expiry state and delete stale Telegram alert — called
 * after a SUCCESSFUL reconnect so a later expiry alerts again.
 */
async function clearSessionAlert(userId, log = console) {
  try {
    await deleteSessionExpiredAlert(userId, log);
    await db.clearSessionExpiry(userId);
  } catch { /* clearing must never block the reconnect flow */ }
}

module.exports = {
  maybeNotifySessionExpired,
  notifyQumsReconnected,
  deleteSessionExpiredAlert,
  scheduleMessageDeletion,
  clearSessionAlert,
  reconnectUrl,
  reconnectButton,
  baseUrl,
  SESSION_EXPIRED_TEXT,
  RECONNECTED_TEXT,
  COOLDOWN_MS,
  RECONNECT_DELETE_DELAY_MS,
};
