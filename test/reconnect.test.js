/**
 * QUMS SESSION EXPIRY + RECONNECT tests (Phase 2 + 17 + 18 items 4,5,18).
 *
 *   node test/reconnect.test.js
 *
 * Telegram is stubbed via a module hook (no network, no token) and records
 * exactly which app user each message would have been sent to, so multi-user
 * isolation is asserted on the REAL code path.
 *
 * Covers:
 *   R1  expiry alert copy (English, spec wording) + "🔐 Reconnect QUMS" button URL
 *   R2  alert goes to the EXPIRED user only
 *   R3  per-user cooldown (user A's alert never suppresses user B's)
 *   R4  no credentials / token / email text ever appears in the alert
 *   R5  "✅ QUMS Reconnected" confirmation copy
 *   R6  SessionExpiredError from a monitor cycle triggers exactly that user's alert
 *   R7  user A expired while user B is valid -> user B's monitoring still works
 *   R8  cooldown is cleared after a successful reconnect
 *   R9  missing token / missing user -> no crash, no send
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qattend-reconnect-'));
process.env.DB_FILE = path.join(TMP, 'db.json');
process.env.DATABASE_URL = '';
process.env.SESSION_ALERT_STATE_FILE = path.join(TMP, 'session_alerts.json');
process.env.APP_BASE_URL = 'https://qattend.example.com/';
process.env.PORT = '10000';
delete process.env.RENDER_EXTERNAL_URL;

// ---- telegram stub: captures (userId, text, opts) ----
const telegramSends = [];
const telegramDeletes = [];
let telegramConfigured = true;
let nextMessageId = 1001;
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === './telegram' || id === 'telegram') {
    return {
      isConfigured: () => telegramConfigured,
      sendMessage: async (userId, text, log, opts) => {
        const msgId = nextMessageId++;
        if (opts && typeof opts === 'object') opts.messageId = msgId;
        telegramSends.push({ userId, text, opts: opts || {}, messageId: msgId });
        return true;
      },
      deleteMessage: async (userId, messageId, log) => {
        telegramDeletes.push({ userId, messageId: String(messageId) });
        return true;
      },
      deepLink: () => '',
      getBotUsername: () => 'test_bot',
    };
  }
  return origRequire.apply(this, arguments);
};

const db = require('../src/db');
const alerts = require('../src/alerts');
const watcher = require('../src/watcher');

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
const lastTo = (userId) => telegramSends.filter((s) => s.userId === userId);

function mkRec(date, code, statusRaw) {
  const status = statusRaw === 'P' ? 'present' : statusRaw === 'A' ? 'absent' : 'other';
  return {
    date, day: Number(date.slice(-2)), subjectCode: code, subject: 'Java',
    statusRaw, status, lectures: [{ statusRaw, status, index: 1 }],
    lecturesThatDay: 1, teacher: 'RAJ KUMAR', room: '', key: `${date}-${code}`,
  };
}

(async () => {
  await db.init();

  // ---------- R1: copy + button ----------
  check('R1 base URL normalization (no double slash)', alerts.baseUrl(), 'https://qattend.example.com');
  const button = alerts.reconnectButton();
  check('R1 inline button label', button.inline_keyboard[0][0].text, '🔐 Reconnect QUMS');
  check('R1 inline button opens the reconnect page', button.inline_keyboard[0][0].url, 'https://qattend.example.com/qums-setup?reconnect=1');
  ok('R1 alert title matches the spec', /⚠️ \*QUMS Session Expired\*/.test(alerts.SESSION_EXPIRED_TEXT), alerts.SESSION_EXPIRED_TEXT);
  ok('R1 alert body matches the spec', /Your QUMS session has expired\./.test(alerts.SESSION_EXPIRED_TEXT) && /Please reconnect QUMS to resume attendance and assignment updates\./.test(alerts.SESSION_EXPIRED_TEXT));
  ok('R1 alert carries the Reconnect label', /🔐 Reconnect QUMS/.test(alerts.SESSION_EXPIRED_TEXT), alerts.SESSION_EXPIRED_TEXT);
  ok('R1 reconnected copy matches the spec', /✅ \*QUMS Reconnected\*/.test(alerts.RECONNECTED_TEXT) && /monitoring has resumed\./.test(alerts.RECONNECTED_TEXT));
  ok('R1 no Hindi/Devanagari in the alert', !/[\u0900-\u097F]/.test(alerts.SESSION_EXPIRED_TEXT + alerts.RECONNECTED_TEXT));

  // ---------- R2/R3: sent to the expired user, per-user cooldown ----------
  const U1 = 'reconnect-user-1';
  const U2 = 'reconnect-user-2';
  telegramSends.length = 0;
  check('R2 first expiry alert for user 1 is sent', await alerts.maybeNotifySessionExpired(quiet, U1), true);
  check('R2 alert went to user 1 (and only user 1)', [telegramSends.length, lastTo(U1).length, lastTo(U2).length], [1, 1, 0]);
  check('R2 alert carried the reconnect button', lastTo(U1)[0].opts.replyMarkup.inline_keyboard[0][0].url.includes('/qums-setup?reconnect=1'), true);

  telegramSends.length = 0;
  check('R3 repeat within cooldown -> suppressed', await alerts.maybeNotifySessionExpired(quiet, U1), false);
  check('R3 cooldown did NOT suppress user 2', await alerts.maybeNotifySessionExpired(quiet, U2), true);
  check('R3 second alert went to user 2 only', [telegramSends.length, lastTo(U2).length, lastTo(U1).length], [1, 1, 0]);

  // ---------- R4: nothing sensitive in the message ----------
  const allText = telegramSends.map((s) => s.text).join('\n');
  ok('R4 no password/token/cookie words in the alert', !/password|captcha value|token|cookie|secret/i.test(allText), allText);
  ok('R4 no email address in the alert', !/@/.test(allText), allText);

  // ---------- R5: reconnect confirmation & stale alert deletion ----------
  telegramSends.length = 0;
  telegramDeletes.length = 0;
  check('R5 confirmation sent', await alerts.notifyQumsReconnected(quiet, U1), true);
  check('R5 confirmation went to user 1 only', [lastTo(U1).length, lastTo(U2).length], [1, 0]);
  ok('R5 confirmation copy is the spec text', lastTo(U1)[0].text === alerts.RECONNECTED_TEXT, lastTo(U1)[0].text);
  check('R5 stale session-expired alert deleted from Telegram', telegramDeletes.some((d) => d.userId === U1), true);

  // ---------- R5b: reconnect confirmation auto-deletes after 1 min (tested with short delay) ----------
  telegramSends.length = 0;
  telegramDeletes.length = 0;
  await alerts.notifyQumsReconnected(quiet, U1, { deleteAfterMs: 15 });
  check('R5b reconnect confirmation sent', telegramSends.length, 1);
  const reconnectedMsgId = String(telegramSends[0].messageId);
  await new Promise((r) => setTimeout(r, 35));
  check('R5b reconnect confirmation auto-deleted after delay', telegramDeletes.some((d) => d.userId === U1 && d.messageId === reconnectedMsgId), true);

  // ---------- R8: cooldown cleared after a successful reconnect ----------
  alerts.clearSessionAlert(U1);
  telegramSends.length = 0;
  check('R8 after reconnect, a new expiry alerts immediately', await alerts.maybeNotifySessionExpired(quiet, U1), true);
  check('R8 that alert went to user 1', lastTo(U1).length, 1);

  // ---------- R8b: concurrent expiry alerts never send twice ----------
  telegramSends.length = 0;
  const U3 = 'concurrent-user';
  alerts.clearSessionAlert(U3);
  const results = await Promise.all([
    alerts.maybeNotifySessionExpired(quiet, U3),
    alerts.maybeNotifySessionExpired(quiet, U3),
  ]);
  check('R8b concurrent expiry alerts sent exactly once', results.filter(Boolean).length, 1);
  check('R8b exactly 1 Telegram message sent for concurrent triggers', lastTo(U3).length, 1);

  // ---------- R6/R7: monitor cycles ----------
  const EXPIRED = 'expired-user';
  const VALID = 'valid-user';
  telegramSends.length = 0;
  let threw = false;
  try {
    await watcher.runMonthRegisterCycle({
      log: quiet,
      userId: EXPIRED,
      fetchFn: async () => { const e = new Error('session expired'); e.name = 'SessionExpiredError'; throw e; },
      sendFn: async () => true,
      stateFile: path.join(TMP, 'fast-expired.json'),
    });
  } catch { threw = true; }
  check('R6 SessionExpiredError propagates (scheduler must not swallow it)', threw, true);
  check('R6 exactly one expiry alert was sent', telegramSends.length, 1);
  check('R6 alert went to the EXPIRED user', [lastTo(EXPIRED).length, lastTo(VALID).length], [1, 0]);

  // A valid user's cycle still runs normally (one expired user never blocks others).
  const validSent = [];
  const validResult = await watcher.runMonthRegisterCycle({
    log: quiet,
    userId: VALID,
    fetchFn: async () => [{ year: 2026, month: 9, records: [mkRec('2026-09-22', 'CS35303', 'P')], summary: null }],
    sendFn: async (t) => { validSent.push(t); return t; },
    stateFile: path.join(TMP, 'fast-valid.json'),
  });
  check('R7 valid user baseline ran (no alerts)', [validSent.length, validResult.bootstrap], [0, true]);
  await watcher.runMonthRegisterCycle({
    log: quiet,
    userId: VALID,
    fetchFn: async () => [{ year: 2026, month: 9, records: [mkRec('2026-09-22', 'CS35303', 'A')], summary: null }],
    sendFn: async (t) => { validSent.push(t); return t; },
    stateFile: path.join(TMP, 'fast-valid.json'),
  });
  check('R7 valid user change -> 1 alert despite another user expiring', validSent.length, 1);

  // ---------- R9: unconfigured / unlinked ----------
  telegramConfigured = false;
  telegramSends.length = 0;
  check('R9 no token -> no send, no throw', await alerts.maybeNotifySessionExpired(quiet, U1), false);
  check('R9 nothing was sent', telegramSends.length, 0);
  telegramConfigured = true;
  check('R9 no userId -> skip', await alerts.maybeNotifySessionExpired(quiet, undefined), false);

  // ---------- R10: student-name backfill guards (must never break a request) ----------
  const scraper = require('../src/scraper');
  const noSession = await db.createUser({ email: 'backfill-nosession@local', passwordHash: 'x' });
  check('R10 no QUMS session -> no name, no throw', await scraper.ensureStudentName(noSession.id, quiet), '');
  const missingFile = await db.createUser({ email: 'backfill-missing@local', passwordHash: 'x' });
  await db.updateUser(missingFile.id, { qumsSessionPath: path.join(TMP, 'does-not-exist.json') });
  check('R10 missing session file -> no name, no network attempt', await scraper.ensureStudentName(missingFile.id, quiet), '');
  const already = await db.createUser({ email: 'backfill-already@local', passwordHash: 'x' });
  await db.updateUser(already.id, { studentName: 'TEST STUDENT' });
  check('R10 name already stored -> returned as-is', await scraper.ensureStudentName(already.id, quiet), 'TEST STUDENT');
  check('R10 unknown user -> empty, no throw', await scraper.ensureStudentName('no-such-user', quiet), '');
  check('R10 student name is stored per user (no global)', (await db.getUserById(already.id)).studentName, 'TEST STUDENT');
  ok('R10 other user did NOT inherit the name', !(await db.getUserById(noSession.id)).studentName);

  // ---------- R11: Dynamic QUMS Student Name & Year/Sem (Source of Truth) ----------
  const origFetchProfile = scraper.fetchQumsProfile;
  let simulatedQumsName = 'ALICE SMITH';
  let simulatedQumsYearSem = '3rd Year / 5th Sem';
  scraper.fetchQumsProfile = async () => ({
    studentName: simulatedQumsName,
    yearSem: simulatedQumsYearSem,
  });

  const dynamicUser = await db.createUser({ email: 'dynamic-qums@local', passwordHash: 'x' });
  const fakeSessionPath = path.join(TMP, 'dynamic-session.json');
  fs.writeFileSync(fakeSessionPath, JSON.stringify({ cookies: [] }));
  await db.updateUser(dynamicUser.id, { qumsSessionPath: fakeSessionPath });

  // 1. Initial QUMS profile refresh: QUMS is source of truth
  const r11Initial = await scraper.refreshQumsProfile(dynamicUser.id, quiet, { force: true });
  check('R11 student name fetched directly from QUMS', r11Initial.studentName, 'ALICE SMITH');
  check('R11 yearSem fetched directly from QUMS', r11Initial.yearSem, '3rd Year / 5th Sem');

  // 2. Database student_name is only a cache
  const cachedUser1 = await db.getUserById(dynamicUser.id);
  check('R11 cached student_name in DB updated from QUMS', cachedUser1.studentName, 'ALICE SMITH');
  check('R11 cached qums_year_sem in DB updated from QUMS', cachedUser1.qumsYearSem, '3rd Year / 5th Sem');

  // 3. Name changes on QUMS side -> reconnect/sync updates the cache
  simulatedQumsName = 'ALICE J. SMITH';
  simulatedQumsYearSem = '3rd Year / 6th Sem';
  const r11Updated = await scraper.refreshQumsProfile(dynamicUser.id, quiet, { force: true });
  check('R11 updated student name fetched from QUMS', r11Updated.studentName, 'ALICE J. SMITH');
  check('R11 updated yearSem fetched from QUMS', r11Updated.yearSem, '3rd Year / 6th Sem');

  const cachedUser2 = await db.getUserById(dynamicUser.id);
  check('R11 cache updated when QUMS name changes', cachedUser2.studentName, 'ALICE J. SMITH');
  check('R11 cache updated when QUMS yearSem changes', cachedUser2.qumsYearSem, '3rd Year / 6th Sem');

  scraper.fetchQumsProfile = origFetchProfile;

  // ---------- R12: QUMS Routes Restored in server.js (not 404) ----------
  const serverCode = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  check('R12 /api/qums-login/start route registered', serverCode.includes("app.post('/api/qums-login/start'"), true);
  check('R12 /api/qums-login/submit-captcha route registered', serverCode.includes("app.post('/api/qums-login/submit-captcha'"), true);
  check('R12 /api/qums-reset route registered', serverCode.includes("app.post('/api/qums-reset'"), true);
  check('R12 /api/qums-logout route registered', serverCode.includes("app.post('/api/qums-logout'"), true);

  console.log(failures ? `\n${failures} RECONNECT TEST(S) FAILED` : '\nALL SESSION RECONNECT TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('[x]', err.name || 'Error', err.message);
  process.exit(1);
});
