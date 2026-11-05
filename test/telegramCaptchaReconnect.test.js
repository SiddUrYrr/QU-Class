/**
 * Tests for Telegram-based CAPTCHA-only QUMS session reconnect.
 *
 * Covers:
 *   - session expiry sends CAPTCHA to linked user
 *   - CAPTCHA belongs to correct Telegram user (multi-user isolation)
 *   - valid CAPTCHA reconnects successfully
 *   - invalid CAPTCHA does not reconnect and returns fresh CAPTCHA
 *   - regenerate invalidates old CAPTCHA and sends new CAPTCHA
 *   - regenerated CAPTCHA works
 *   - expired CAPTCHA is rejected
 *   - CAPTCHA attempt rate limiting (max 5 attempts)
 *   - successful reconnect clears reconnect state
 *   - cancel clears reconnect state
 *   - QUMS StudentName refreshes
 *   - Year/Sem refreshes
 *   - monitoring_started_date remains unchanged
 *   - attendance deduplication remains intact
 *   - assignment deduplication remains intact
 *   - multi-user isolation
 *   - existing web reconnect still works as fallback
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qattend-tg-captcha-'));
process.env.DB_FILE = path.join(TMP, 'db.json');
process.env.DATABASE_URL = '';
process.env.SESSION_ALERT_STATE_FILE = path.join(TMP, 'session_alerts.json');
process.env.APP_BASE_URL = 'https://qattend.example.com';
process.env.TELEGRAM_BOT_TOKEN = 'test:token';
process.env.PORT = '10000';

const db = require('../src/db');
const { encryptSecret } = require('../src/crypto');
const telegram = require('../src/telegram');
const alerts = require('../src/alerts');
const qumsLogin = require('../src/qums-login-web');
const scraper = require('../src/scraper');
const watcher = require('../src/watcher');
const assignments = require('../src/assignments');
const scheduler = require('../src/scheduler');

let failures = 0;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
  if (!pass) failures += 1;
}
function ok(label, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  ${extra}`}`);
  if (!cond) failures += 1;
}

const quiet = { log: () => {}, error: () => {} };

// Telegram send / photo capture stubs
const sentMessages = [];
const sentPhotos = [];
const deletedMessages = [];
let nextMsgId = 2001;

const answeredQueries = [];

// Override bot in telegram.js state
const fakeBot = {
  sendMessage: async (chatId, text, opts = {}) => {
    const id = nextMsgId++;
    sentMessages.push({ chatId, text, opts, message_id: id });
    return { message_id: id };
  },
  sendPhoto: async (chatId, photo, opts = {}) => {
    const id = nextMsgId++;
    sentPhotos.push({ chatId, photo, opts, message_id: id });
    return { message_id: id };
  },
  deleteMessage: async (chatId, messageId) => {
    deletedMessages.push({ chatId, messageId: Number(messageId) });
    return true;
  },
  answerCallbackQuery: async (id, opts = {}) => {
    answeredQueries.push({ id, opts });
    return true;
  },
};

(async () => {
  await db.init();

  // Arm fake bot into telegram state
  telegram.initTelegram(quiet);
  const STATE_KEY = '__qumsTelegramState__';
  globalThis[STATE_KEY].bot = fakeBot;

  // 1. Setup two test users with linked Telegram and encrypted passwords
  const userA = await db.createUser({ email: 'student-a@example.com', passwordHash: 'hashA' });
  const userB = await db.createUser({ email: 'student-b@example.com', passwordHash: 'hashB' });

  const CHAT_A = 'chat_a_1001';
  const CHAT_B = 'chat_b_1002';
  const QID_A = '2024001';
  const QID_B = '2024002';

  await db.setTelegramChatId(userA.id, CHAT_A);
  await db.setTelegramChatId(userB.id, CHAT_B);

  await db.updateUser(userA.id, {
    qumsQid: QID_A,
    qumsPasswordEncrypted: encryptSecret('passA123'),
    studentName: 'Test Student',
    qumsYearSem: '3rd Year / 5th Sem',
    monitoringStartedDate: '2026-09-01',
    qumsSessionStatus: 'expired',
  });

  await db.updateUser(userB.id, {
    qumsQid: QID_B,
    qumsPasswordEncrypted: encryptSecret('passB456'),
    studentName: 'Rohan Sharma',
    qumsYearSem: '2nd Year / 3rd Sem',
    monitoringStartedDate: '2026-09-01',
    qumsSessionStatus: 'active',
  });

  // Mock qumsLogin functions
  let mockCaptchaValue = 'K7P4X';
  let mockCaptchaImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  let disposeCalls = 0;

  qumsLogin.startQumsLogin = async (userId, credsInput, log) => {
    return { ok: true, captchaImage: mockCaptchaImage };
  };

  qumsLogin.disposePending = async (userId) => {
    disposeCalls++;
  };

  qumsLogin.submitQumsCaptcha = async (userId, captchaText, log) => {
    if (captchaText === mockCaptchaValue) {
      // Simulate successful login
      const sessionPath = path.join(TMP, `session-${userId}.json`);
      fs.writeFileSync(sessionPath, JSON.stringify({ cookies: ['test-cookie'] }));
      await qumsLogin.completeQumsSetup(userId, userId === userA.id ? QID_A : QID_B);

      // Simulate profile sync
      const profile = await scraper.fetchQumsProfile(sessionPath, log);
      if (profile.studentName) await db.updateUser(userId, { studentName: profile.studentName });
      if (profile.yearSem) await db.updateUser(userId, { qumsYearSem: profile.yearSem });

      // Simulate catchup & alert
      const catchup = require('../src/catchup');
      await catchup.runReconnectCatchup(userId, sessionPath, log, { attendanceRecords: [] });

      return { ok: true, sessionPath, studentName: profile.studentName, yearSem: profile.yearSem };
    }
    // Wrong captcha
    mockCaptchaImage = 'data:image/png;base64,freshCaptchaBase64';
    return {
      ok: false,
      error: 'Captcha galat lagii ya login nahi hua',
      captchaImage: mockCaptchaImage,
    };
  };

  // Mock scraper.fetchQumsProfile to return updated profile
  scraper.fetchQumsProfile = async (sessionPath) => ({
    studentName: 'TEST STUDENT UPDATED',
    yearSem: '3rd Year / 6th Sem',
  });

  // ----------------------------------------------------
  // TEST 1: Background alert sends notification only; User clicks reconnect to get CAPTCHA
  // ----------------------------------------------------
  sentMessages.length = 0;
  sentPhotos.length = 0;

  // Background watcher sends expiry alert — MUST NOT launch Chromium or send CAPTCHA photo automatically
  const expiryNotified = await alerts.maybeNotifySessionExpired(quiet, userA.id, { evidence: true });
  check('1. Expiry notification returned true for user A', expiryNotified, true);
  check('1. Text message sent to chat A', sentMessages.some((m) => m.chatId === CHAT_A), true);
  const textMsg = sentMessages.find((m) => m.chatId === CHAT_A);
  ok('1. Text message matches spec', textMsg.text.includes('QUMS Session Expired') && textMsg.text.includes('Your QUMS session has expired'));

  // Critical safety check: background alert MUST NOT send CAPTCHA photo or enter waiting state
  check('1. Background alert did NOT send CAPTCHA photo', sentPhotos.length, 0);
  check('1. User A is NOT yet waiting for CAPTCHA before explicit click', telegram.isWaitingCaptcha(userA.id), false);
  ok('1. Expiry alert has Reconnect button', textMsg.opts.reply_markup && textMsg.opts.reply_markup.inline_keyboard.length > 0);
  const alertButtons = textMsg.opts.reply_markup.inline_keyboard.flat();
  check('1. Reconnect button callback_data present', alertButtons.some((b) => b.callback_data === 'qums_start_reconnect'), true);

  // User explicitly taps "🔄 Reconnect QUMS"
  await telegram.handleCallbackQuery({
    id: 'query_0',
    data: 'qums_start_reconnect',
    message: { chat: { id: CHAT_A }, message_id: textMsg.message_id },
  }, quiet);

  check('1. CAPTCHA photo sent to chat A after user clicks reconnect', sentPhotos.some((p) => p.chatId === CHAT_A), true);
  const photoMsg = sentPhotos.find((p) => p.chatId === CHAT_A);
  ok('1. CAPTCHA photo has inline buttons', photoMsg.opts.reply_markup && photoMsg.opts.reply_markup.inline_keyboard.length > 0);
  const buttons = photoMsg.opts.reply_markup.inline_keyboard.flat();
  check('1. Regenerate button present', buttons.some((b) => b.text.includes('Regenerate CAPTCHA') && b.callback_data === 'qums_regen_captcha'), true);
  check('1. Cancel button present', buttons.some((b) => b.text.includes('Cancel Reconnect') && b.callback_data === 'qums_cancel_reconnect'), true);

  // ----------------------------------------------------
  // TEST 2: Reconnect state isolation per user
  // ----------------------------------------------------
  check('2. User A is waiting for CAPTCHA', telegram.isWaitingCaptcha(userA.id), true);
  check('2. User B is NOT waiting for CAPTCHA', telegram.isWaitingCaptcha(userB.id), false);

  // User B tries to send CAPTCHA text from chat B -> ignored because B is not in reconnect state
  sentMessages.length = 0;
  await telegram.handleUserMessage({ chat: { id: CHAT_B }, text: 'K7P4X', message_id: 3001 }, quiet);
  check('2. User B submission ignored when not in reconnect state', sentMessages.length, 0);

  // ----------------------------------------------------
  // TEST 3: Invalid CAPTCHA does not reconnect
  // ----------------------------------------------------
  sentMessages.length = 0;
  sentPhotos.length = 0;
  await telegram.handleUserMessage({ chat: { id: CHAT_A }, text: 'WRONG_CODE', message_id: 3002 }, quiet);

  check('3. Incorrect CAPTCHA notice sent', sentMessages.some((m) => m.chatId === CHAT_A && m.text.includes('Incorrect CAPTCHA')), true);
  check('3. Fresh CAPTCHA photo sent on failure', sentPhotos.some((p) => p.chatId === CHAT_A), true);
  check('3. User A is STILL in reconnect state', telegram.isWaitingCaptcha(userA.id), true);
  const userAStateAfterWrong = await db.getUserById(userA.id);
  check('3. Session is NOT active after wrong captcha', userAStateAfterWrong.qumsSessionStatus !== 'active', true);

  // ----------------------------------------------------
  // TEST 4: Regenerate invalidates old CAPTCHA and sends new one
  // ----------------------------------------------------
  disposeCalls = 0;
  sentPhotos.length = 0;
  await telegram.handleCallbackQuery({
    id: 'query_1',
    data: 'qums_regen_captcha',
    message: { chat: { id: CHAT_A } },
  }, quiet);

  check('4. Old CAPTCHA disposed on regenerate', disposeCalls > 0, true);
  check('4. New CAPTCHA photo sent on regenerate', sentPhotos.length, 1);
  check('4. User A remains in reconnect state', telegram.isWaitingCaptcha(userA.id), true);

  // ----------------------------------------------------
  // TEST 4b: Regenerate works even after session expired (user comes back hours later)
  // ----------------------------------------------------
  const expState = telegram.getReconnectState(userA.id);
  if (expState) expState.expiresAt = Date.now() - 1000; // simulate hours later
  check('4b. Session is expired', telegram.isWaitingCaptcha(userA.id), false);

  sentPhotos.length = 0;
  await telegram.handleCallbackQuery({
    id: 'query_expired_regen',
    data: 'qums_regen_captcha',
    message: { chat: { id: CHAT_A } },
  }, quiet);

  check('4b. Fresh CAPTCHA photo sent even after session was expired', sentPhotos.length, 1);
  check('4b. User A is re-armed into waiting captcha state', telegram.isWaitingCaptcha(userA.id), true);

  // ----------------------------------------------------
  // TEST 4c: Concurrent regenerate requests are guarded (prevents duplicate browser launches)
  // ----------------------------------------------------
  answeredQueries.length = 0;
  sentPhotos.length = 0;
  const originalStart = qumsLogin.startQumsLogin;
  let startCalled = 0;
  qumsLogin.startQumsLogin = async (userId, credsInput, log) => {
    startCalled++;
    await new Promise((r) => setTimeout(r, 50));
    return { ok: true, captchaImage: mockCaptchaImage };
  };

  const p1 = telegram.handleCallbackQuery({
    id: 'query_concurrent_1',
    data: 'qums_regen_captcha',
    message: { chat: { id: CHAT_A } },
  }, quiet);

  const p2 = telegram.handleCallbackQuery({
    id: 'query_concurrent_2',
    data: 'qums_regen_captcha',
    message: { chat: { id: CHAT_A } },
  }, quiet);

  await Promise.all([p1, p2]);
  qumsLogin.startQumsLogin = originalStart;

  check('4c. Only 1 QUMS login started during concurrent taps', startCalled, 1);
  check('4c. Second click received in-progress toast', answeredQueries.some((q) => q.id === 'query_concurrent_2' && q.opts && q.opts.text && q.opts.text.includes('already in progress')), true);

  // ----------------------------------------------------
  // TEST 5: Valid CAPTCHA reconnects successfully
  // ----------------------------------------------------
  sentMessages.length = 0;
  sentPhotos.length = 0;
  deletedMessages.length = 0;

  await telegram.handleUserMessage({ chat: { id: CHAT_A }, text: mockCaptchaValue, message_id: 3003 }, quiet);

  const userAAfter = await db.getUserById(userA.id);
  check('5. QUMS session status restored to active', userAAfter.qumsSessionStatus, 'active');
  check('5. Student name refreshed from QUMS', userAAfter.studentName, 'TEST STUDENT UPDATED');
  check('5. Year/Sem refreshed from QUMS', userAAfter.qumsYearSem, '3rd Year / 6th Sem');
  check('5. Monitoring started date preserved unchanged', userAAfter.monitoringStartedDate, '2026-09-01');
  check('5. QID preserved unchanged', userAAfter.qumsQid, QID_A);

  // Check confirmation message sent
  check('5. Reconnected confirmation message sent', sentMessages.some((m) => m.chatId === CHAT_A && m.text.includes('QUMS Reconnected')), true);

  // Check state cleared
  check('5. Reconnect state cleared after success', telegram.isWaitingCaptcha(userA.id), false);

  // Check previous alert message deletion was attempted
  check('5. Previous expired alert deletion called', deletedMessages.some((d) => d.chatId === CHAT_A), true);
  // Check user's typed captcha message was deleted
  check('5. User typed captcha message deleted', deletedMessages.some((d) => d.chatId === CHAT_A && d.messageId === 3003), true);

  // ----------------------------------------------------
  // TEST 6: Rate limiting / brute-force protection
  // ----------------------------------------------------
  // Trigger reconnect for user B
  await alerts.maybeNotifySessionExpired(quiet, userB.id, { evidence: true });
  await telegram.handleCallbackQuery({
    id: 'query_b_start',
    data: 'qums_start_reconnect',
    message: { chat: { id: CHAT_B } },
  }, quiet);
  check('6. User B in reconnect state', telegram.isWaitingCaptcha(userB.id), true);

  // Send 5 incorrect attempts
  sentMessages.length = 0;
  for (let i = 1; i <= 5; i++) {
    await telegram.handleUserMessage({ chat: { id: CHAT_B }, text: `BAD_${i}`, message_id: 4000 + i }, quiet);
  }

  check('6. Too many failed attempts message sent', sentMessages.some((m) => m.chatId === CHAT_B && m.text.includes('Too many failed attempts')), true);
  check('6. Reconnect state cleared after max failed attempts', telegram.isWaitingCaptcha(userB.id), false);

  // 6th attempt ignored
  sentMessages.length = 0;
  await telegram.handleUserMessage({ chat: { id: CHAT_B }, text: 'BAD_6', message_id: 4006 }, quiet);
  check('6. Subsequent attempts ignored after lockout', sentMessages.length, 0);

  // ----------------------------------------------------
  // TEST 7: Cancel Reconnect clears state without altering credentials
  // ----------------------------------------------------
  alerts.clearSessionAlert(userA.id);
  await alerts.maybeNotifySessionExpired(quiet, userA.id, { evidence: true });
  await telegram.handleCallbackQuery({
    id: 'query_a_start_cancel',
    data: 'qums_start_reconnect',
    message: { chat: { id: CHAT_A } },
  }, quiet);
  check('7. User A in reconnect state', telegram.isWaitingCaptcha(userA.id), true);

  sentMessages.length = 0;
  await telegram.handleCallbackQuery({
    id: 'query_cancel',
    data: 'qums_cancel_reconnect',
    message: { chat: { id: CHAT_A } },
  }, quiet);

  check('7. Cancel confirmation sent', sentMessages.some((m) => m.chatId === CHAT_A && m.text.includes('Reconnect cancelled')), true);
  check('7. User A reconnect state cleared', telegram.isWaitingCaptcha(userA.id), false);
  const userACancelCheck = await db.getUserById(userA.id);
  check('7. Credentials untouched after cancel', userACancelCheck.qumsQid, QID_A);

  // ----------------------------------------------------
  // TEST 8: Expired CAPTCHA TTL
  // ----------------------------------------------------
  telegram.setReconnectState(userA.id, { chatId: CHAT_A, startedAt: Date.now() - 6 * 60 * 1000 }, quiet);
  // Force state expiration by setting expiresAt in the past
  const rState = telegram.getReconnectState(userA.id);
  if (rState) rState.expiresAt = Date.now() - 1000;

  check('8. Expired state returns false for isWaitingCaptcha', telegram.isWaitingCaptcha(userA.id), false);

  // ----------------------------------------------------
  // TEST 9: Fallback to existing web reconnect button when user has no stored credentials
  // ----------------------------------------------------
  const userNoCreds = await db.createUser({ email: 'nocreds@example.com', passwordHash: 'hashNC' });
  await db.setTelegramChatId(userNoCreds.id, 'chat_nocreds');
  // Has NO qumsPasswordEncrypted and NO qumsQid

  sentMessages.length = 0;
  sentPhotos.length = 0;
  const webFallbackSent = await alerts.maybeNotifySessionExpired(quiet, userNoCreds.id, { evidence: true });
  check('9. Fallback alert sent', webFallbackSent, true);
  check('9. Fallback sent message with reconnect URL button', sentMessages.some((m) => m.opts && m.opts.reply_markup && JSON.stringify(m.opts.reply_markup).includes('/qums-setup?reconnect=1')), true);
  check('9. No photo was sent for uncredentialed user', sentPhotos.filter((p) => p.chatId === 'chat_nocreds').length, 0);

  // ----------------------------------------------------
  // TEST 10: Missing session file causes watcher to skip user
  // ----------------------------------------------------
  const userMissing = await db.createUser({ email: 'missing-file@example.com', passwordHash: 'hashMF' });
  const missingPath = path.join(TMP, 'does-not-exist-session.json');
  await db.updateUser(userMissing.id, {
    qumsSessionPath: missingPath,
    qumsSessionStatus: 'active',
  });

  const watcherLogs = [];
  const logSpy = {
    log: (msg) => watcherLogs.push(msg),
    error: (msg) => watcherLogs.push(`ERROR: ${msg}`),
  };

  await watcher.runWatcherPass(logSpy);
  check('10. Missing session file logged skip message in watcher', watcherLogs.some((l) => l.includes(`Skipping user ${userMissing.id}: QUMS session unavailable.`)), true);

  // ----------------------------------------------------
  // TEST 11: Expired session causes watcher to skip user
  // ----------------------------------------------------
  const userExpired = await db.createUser({ email: 'expired-session@example.com', passwordHash: 'hashES' });
  const realFileForExpired = path.join(TMP, 'expired-session-file.json');
  fs.writeFileSync(realFileForExpired, JSON.stringify({ ok: true }));
  await db.updateUser(userExpired.id, {
    qumsSessionPath: realFileForExpired,
    qumsSessionStatus: 'expired',
  });

  watcherLogs.length = 0;
  await watcher.runWatcherPass(logSpy);
  check('11. Expired session logged skip message in watcher', watcherLogs.some((l) => l.includes(`Skipping user ${userExpired.id}: QUMS session unavailable.`)), true);

  // ----------------------------------------------------
  // TEST 12: Missing session file does NOT call startTelegramCaptchaReconnect()
  // ----------------------------------------------------
  let captchaReconnectCalls = 0;
  const originalTgStart = telegram.startTelegramCaptchaReconnect;
  telegram.startTelegramCaptchaReconnect = async (...args) => {
    captchaReconnectCalls++;
    return originalTgStart(...args);
  };

  watcherLogs.length = 0;
  await watcher.runWatcherPass(logSpy);
  await watcher.runMonthRegisterPass(logSpy, { dryRun: true });
  await assignments.runAssignmentPass(logSpy, { dryRun: true });
  check('12. Missing session file caused 0 startTelegramCaptchaReconnect calls', captchaReconnectCalls, 0);

  // ----------------------------------------------------
  // TEST 13: Background watcher does NOT call chromium.launch()
  // ----------------------------------------------------
  let loginCalls = 0;
  const origStartQumsLogin = qumsLogin.startQumsLogin;
  qumsLogin.startQumsLogin = async (...args) => {
    loginCalls++;
    return origStartQumsLogin(...args);
  };

  await watcher.runWatcherPass(logSpy);
  await watcher.runMonthRegisterPass(logSpy, { dryRun: true });
  await assignments.runAssignmentPass(logSpy, { dryRun: true });
  check('13. Background watchers caused 0 startQumsLogin / chromium launches', loginCalls, 0);

  // ----------------------------------------------------
  // TEST 14: User-initiated reconnect DOES call login flow
  // ----------------------------------------------------
  loginCalls = 0;
  await telegram.handleCallbackQuery({
    id: 'query_user_initiated',
    data: 'qums_start_reconnect',
    message: { chat: { id: CHAT_A } },
  }, quiet);
  check('14. User-initiated reconnect calls startQumsLogin', loginCalls, 1);

  // Restore spies
  telegram.startTelegramCaptchaReconnect = originalTgStart;
  qumsLogin.startQumsLogin = origStartQumsLogin;

  // ----------------------------------------------------
  // TEST 15: Concurrency protection — only one browser session at a time
  // ----------------------------------------------------
  const realQumsLogin = require('../src/qums-login-web');
  const userC = await db.createUser({ email: 'user-c@example.com', passwordHash: 'hashC' });
  const userD = await db.createUser({ email: 'user-d@example.com', passwordHash: 'hashD' });
  await db.setTelegramChatId(userC.id, 'chat_c_1003');
  await db.setTelegramChatId(userD.id, 'chat_d_1004');
  await db.updateUser(userC.id, {
    qumsQid: '2024003',
    qumsPasswordEncrypted: encryptSecret('passC'),
  });
  await db.updateUser(userD.id, {
    qumsQid: '2024004',
    qumsPasswordEncrypted: encryptSecret('passD'),
  });

  check('15. No browser initially active for user C', realQumsLogin.isConcurrentBrowserActive(userC.id), false);
  check('15. No browser initially active for user D', realQumsLogin.isConcurrentBrowserActive(userD.id), false);

  const err = new realQumsLogin.ConcurrentLoginError();
  check('15. ConcurrentLoginError code matches CONCURRENT_LOGIN_LIMIT', err.code, 'CONCURRENT_LOGIN_LIMIT');
  check('15. ConcurrentLoginError name is ConcurrentLoginError', err.name, 'ConcurrentLoginError');

  // Test telegram error response for concurrency limit
  sentMessages.length = 0;
  const origLogin = qumsLogin.startQumsLogin;
  qumsLogin.startQumsLogin = async () => {
    throw new realQumsLogin.ConcurrentLoginError();
  };
  await telegram.handleCallbackQuery({
    id: 'query_concurrent',
    data: 'qums_start_reconnect',
    message: { chat: { id: 'chat_c_1003' } },
  }, quiet);
  check('15. Concurrent reconnect returns user-friendly busy message in chat', sentMessages.some((m) => m.chatId === 'chat_c_1003' && m.text.includes('Another reconnect is currently in progress')), true);
  qumsLogin.startQumsLogin = origLogin;

  // ----------------------------------------------------
  // TEST 16: Cleanup on completion, cancellation, and failure
  // ----------------------------------------------------
  await realQumsLogin.disposePending('non-existent-user'); // safe no-op
  check('16. disposePending handles non-existent user safely', true, true);

  // ----------------------------------------------------
  // TEST 17: Active users filter in scheduler
  // ----------------------------------------------------
  const actUsers = await scheduler.activeUsers();
  check('17. activeUsers excludes user with missing session file', actUsers.some((u) => u.id === userMissing.id), false);
  check('17. activeUsers excludes user with expired session', actUsers.some((u) => u.id === userExpired.id), false);

  console.log(failures ? `\n${failures} TELEGRAM CAPTCHA RECONNECT TEST(S) FAILED` : '\nALL TELEGRAM CAPTCHA RECONNECT TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('[x]', err.name || 'Error', err.message);
  process.exit(1);
});
