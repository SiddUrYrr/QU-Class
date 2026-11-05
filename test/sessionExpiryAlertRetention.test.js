/**
 * Regression Test: Session Expiry Alert Retention and Telegram Lifecycle
 * test/sessionExpiryAlertRetention.test.js
 *
 * Verifies:
 * 1. Expiry alerts are NOT scheduled for 60-second auto-deletion (retained in chat).
 * 2. Deduplication & 12-hour cooldown prevent duplicate alert loops.
 * 3. Reconnect flow deletes the specific session-expired alert from Telegram chat.
 * 4. Telegram API failures during message deletion are handled gracefully without crashing or false confirmations.
 * 5. Already-deleted messages ("message not found") are handled safely.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qums-alert-retention-'));
process.env.DB_FILE = path.join(TMP_DIR, 'db.json');
process.env.DATABASE_URL = '';
process.env.TELEGRAM_BOT_TOKEN = 'test:stub-retention';
process.env.TELEGRAM_BOT_USERNAME = 'test_retention_bot';

const deletedMessages = [];
const sentMessages = [];
let msgSeq = 2000;
let shouldFailDelete = false;
let deleteFailureReason = '';

// Mock node-telegram-bot-api
const Module = require('module');
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'node-telegram-bot-api') {
    return function StubBot() {
      return {
        sendMessage: async (chatId, text, opts) => {
          msgSeq += 1;
          const msgObj = { message_id: msgSeq, chat: { id: chatId }, text, opts };
          sentMessages.push(msgObj);
          return msgObj;
        },
        deleteMessage: async (chatId, messageId) => {
          if (shouldFailDelete) {
            const err = new Error(deleteFailureReason || 'ETELEGRAM: Network connection reset');
            throw err;
          }
          deletedMessages.push({ chatId: String(chatId), messageId: Number(messageId) });
          return true;
        },
        onText: () => {},
        on: () => {},
        clearTextListeners: () => {},
      };
    };
  }
  return origRequire.apply(this, arguments);
};

const db = require('../src/db');
const telegram = require('../src/telegram');
const alerts = require('../src/alerts');

async function run() {
  console.log('=== RUNNING SESSION EXPIRY ALERT RETENTION & RECOVERY TESTS ===\n');
  await db.init();

  const user = await db.createUser({
    email: 'student.alert@example.com',
    passwordHash: 'dummyhash',
  });
  await db.updateUser(user.id, {
    telegramChatId: 'chat_student_alert',
    qumsQid: 'Q10001',
    qumsPasswordEncrypted: 'encpass123',
    qumsSessionStatus: 'active',
  });

  // --- TEST 1: Expiry alert retention (NOT auto-deleted after 60s) ---
  sentMessages.length = 0;
  deletedMessages.length = 0;

  const notified = await alerts.maybeNotifySessionExpired(console, user.id, { evidence: true });
  assert.strictEqual(notified, true, 'Alert should be sent');
  assert.strictEqual(sentMessages.length, 1, 'Exactly one Telegram alert sent');
  const alertMsg = sentMessages[0];
  assert(alertMsg.text.includes('QUMS Session Expired'), 'Message text must mention QUMS Session Expired');
  assert(alertMsg.opts && alertMsg.opts.reply_markup, 'Message must have reconnect reply_markup button');

  // Verify DB pending deletions does NOT contain this message
  const pendingDeletions = await db.listPendingDeletions();
  const alertInPending = (pendingDeletions || []).find((p) => p.messageId === alertMsg.message_id);
  assert.strictEqual(alertInPending, undefined, 'Expiry alert must NOT be scheduled in pending deletions');
  console.log('PASS  1. Expiry alert is retained in Telegram (exempt from 60s auto-delete)');

  // --- TEST 2: Deduplication and cooldown prevents duplicate-alert loop ---
  const secondNotify = await alerts.maybeNotifySessionExpired(console, user.id, { evidence: true });
  assert.strictEqual(secondNotify, false, 'Second notification within cooldown must return false');
  assert.strictEqual(sentMessages.length, 1, 'No additional duplicate message sent');
  console.log('PASS  2. Cooldown and deduplication prevent duplicate alert sends');

  // --- TEST 3: Telegram deletion failure handled gracefully ---
  shouldFailDelete = true;
  deleteFailureReason = 'ETELEGRAM: 502 Bad Gateway (Telegram API down)';

  // Attempt delete via deleteSessionExpiredAlert
  const deleteResult = await alerts.deleteSessionExpiredAlert(user.id, console);
  assert.strictEqual(deleteResult, false, 'deleteSessionExpiredAlert must return false when API fails');

  // State in DB must retain the messageId for retry
  const stateAfterFail = await db.getSessionExpiryState(user.id);
  assert.strictEqual(String(stateAfterFail.telegramMessageId), String(alertMsg.message_id), 'Message ID must not be cleared on deletion failure');
  console.log('PASS  3. Telegram API deletion failure is handled safely without corrupting DB state');

  // --- TEST 4: Already-deleted messages ("message not found") handled safely ---
  shouldFailDelete = true;
  deleteFailureReason = 'Bad Request: message to delete not found';

  // deleteMessageFromChat treats "message not found" as successfully cleaned
  const deletedOrNotFound = await telegram.deleteMessage(user.id, alertMsg.message_id, console);
  assert.strictEqual(deletedOrNotFound, true, 'Already-deleted message treated as resolved');
  console.log('PASS  4. Pre-deleted / missing message errors handled safely as resolved');

  // --- TEST 5: Successful reconnection cleanup deletes the correct expiry message ---
  shouldFailDelete = false;
  deletedMessages.length = 0;
  sentMessages.length = 0;

  const reconnected = await alerts.notifyQumsReconnected(console, user.id);
  assert.strictEqual(reconnected, true, 'notifyQumsReconnected must succeed');

  // Old alert deleted
  assert(
    deletedMessages.some((d) => d.messageId === alertMsg.message_id),
    'Old session-expired message must be deleted upon reconnection'
  );

  // State cleared
  const stateAfterReconnect = await db.getSessionExpiryState(user.id);
  assert.strictEqual(stateAfterReconnect.telegramMessageId, null, 'telegramMessageId in state must be cleared');
  assert.strictEqual(stateAfterReconnect.expiredAt, null, 'expiredAt in state must be cleared');
  assert(stateAfterReconnect.resolvedAt > 0, 'resolvedAt in state must be recorded');

  // Reconnected confirmation message sent and scheduled for 1-minute auto-delete
  const reconnectMsg = sentMessages.find((m) => m.text.includes('QUMS Reconnected'));
  assert(reconnectMsg, 'Confirmation reconnected message must be sent');
  const pendingAfterReconnect = await db.listPendingDeletions();
  const reconnectInPending = (pendingAfterReconnect || []).find((p) => p.messageId === reconnectMsg.message_id);
  assert(reconnectInPending, 'Reconnect confirmation message MUST be scheduled for 1-minute auto-deletion');
  console.log('PASS  5. Reconnection cleanup deletes old expiry alert and schedules temporary confirmation deletion');

  console.log('\nALL ALERT RETENTION & RECOVERY TESTS PASSED SUCCESSFULLY!');
}

run().catch((err) => {
  console.error('TEST FAILURE:', err);
  process.exit(1);
}).finally(() => {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {}
});
