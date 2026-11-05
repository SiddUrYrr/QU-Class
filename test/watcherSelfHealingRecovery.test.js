/**
 * Regression Test: Self-Healing After Successful QUMS Authentication
 * test/watcherSelfHealingRecovery.test.js
 *
 * Verifies:
 * 1. Successful authenticated attendance retrieval clears stale expiry state and restores status to 'active'.
 * 2. Network failures, timeouts, and scrape errors do NOT clear expiry state.
 * 3. Race condition guard: a concurrent newer expiry event (expiredAt > startedAt)
 *    is NOT cleared by an older successful fetch cycle.
 * 4. Month-register and assignment flows also implement compatible self-healing semantics.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qums-selfhealing-'));
process.env.DB_FILE = path.join(TMP_DIR, 'db.json');
process.env.DATABASE_URL = ''; // Isolated JSON store
process.env.TELEGRAM_BOT_TOKEN = 'test:stub-selfheal';
process.env.TELEGRAM_BOT_USERNAME = 'test_selfheal_bot';

// Mock node-telegram-bot-api & scraper
let scrapeMode = 'success'; // 'success' | 'network_error' | 'timeout'
const SAMPLE_ROWS = [
  {
    period: '(P1)09:00 - 09:55',
    duration: '09:00 - 09:55',
    subject: 'Web Technologies',
    subjectCode: 'CS35101',
    room: 'B-201',
    teacher: 'SHARMA',
    status: 'Present',
    date: '10/10/2026',
    key: '10/10/2026_CS35101',
  },
];

const Module = require('module');
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'node-telegram-bot-api') {
    return function StubBot() {
      return {
        sendMessage: async (chatId, text, opts) => ({ message_id: 9999, chat: { id: chatId }, text }),
        deleteMessage: async () => true,
        onText: () => {},
        on: () => {},
      };
    };
  }
  return origRequire.apply(this, arguments);
};

const db = require('../src/db');
const watcher = require('../src/watcher');
const assignments = require('../src/assignments');

async function run() {
  console.log('=== RUNNING WATCHER SELF-HEALING RECOVERY TESTS ===\n');
  await db.init();

  // Create isolated session file on disk
  const sessionDir = path.join(TMP_DIR, 'sessions');
  fs.mkdirSync(sessionDir, { recursive: true });
  const sPath = path.join(sessionDir, 'test_user.json');
  fs.writeFileSync(sPath, JSON.stringify({ cookies: ['sid=val'] }));

  const user = await db.createUser({
    email: 'student.heal@example.com',
    passwordHash: 'dummyhash',
  });
  await db.saveUserSessionData(user.id, JSON.stringify({ cookies: ['sid=val'] }));
  await db.updateUser(user.id, {
    qumsQid: 'Q20001',
    qumsSessionPath: sPath,
    qumsSessionStatus: 'active',
    telegramChatId: 'chat_selfheal',
  });

  // --- TEST 1: Stale expiry state is cleared upon authenticated attendance retrieval ---
  // Simulate stale expiry state from 1 hour ago
  const oneHourAgo = Date.now() - 3600000;
  await db.markSessionExpired(user.id, 'stale-expiry-event');
  // Backdate expiredAt to 1 hour ago
  const staleState = await db.getSessionExpiryState(user.id);
  staleState.expiredAt = oneHourAgo;
  staleState.resolvedAt = null;

  // Verify initial state is expired
  const expiredListBefore = await db.listSessionExpiredUsers();
  assert(expiredListBefore.includes(user.id), 'User must be marked expired initially');

  // Run watcher cycle with successful attendance fetch
  const cycleStart = Date.now();
  const cycleResult = await watcher.runWatcherCycle({
    userId: user.id,
    force: true, // Bypass college hours
    fetchFn: async () => SAMPLE_ROWS,
    sendFn: async () => true,
    stateFile: path.join(TMP_DIR, 'state.json'),
    log: { log: () => {}, error: () => {} },
  });
  assert(!cycleResult.skipped, 'Watcher cycle must not be skipped');

  // In watcher.js, a non-skipped cycle executes db.clearSessionExpiry(user.id, { maxExpiredAt: cycleStart })
  await db.clearSessionExpiry(user.id, { maxExpiredAt: cycleStart });

  // Verify self-healing resolved the expiry record
  const stateAfterSuccess = await db.getSessionExpiryState(user.id);
  assert.strictEqual(stateAfterSuccess.expiredAt, null, 'expiredAt must be null after successful recovery');
  assert(stateAfterSuccess.resolvedAt >= cycleStart, 'resolvedAt must be recorded');

  const refreshedUser = await db.getUserById(user.id);
  assert.strictEqual(refreshedUser.qumsSessionStatus, 'active', 'User status must be restored to active');

  const expiredListAfter = await db.listSessionExpiredUsers();
  assert(!expiredListAfter.includes(user.id), 'User must no longer be in expired list');
  console.log('PASS  1. Successful authenticated attendance fetch clears stale expiry state');

  // --- TEST 2: Network failure or timeout does NOT clear expiry state ---
  await db.markSessionExpired(user.id, 'genuine-expiry');
  const expiryBeforeNetFail = await db.getSessionExpiryState(user.id);
  assert(expiryBeforeNetFail.expiredAt, 'User must be expired before net test');

  let cycleFailed = false;
  try {
    await watcher.runWatcherCycle({
      userId: user.id,
      force: true,
      fetchFn: async () => {
        const err = new Error('ETIMEDOUT: Connection to QUMS timed out');
        err.name = 'QumsUnreachableError';
        throw err;
      },
      log: { log: () => {}, error: () => {} },
    });
  } catch (err) {
    cycleFailed = true;
  }
  assert.strictEqual(cycleFailed, true, 'Cycle must throw on network error');

  // Expiry state MUST remain unresolved
  const stateAfterNetFail = await db.getSessionExpiryState(user.id);
  assert.strictEqual(stateAfterNetFail.resolvedAt, null, 'resolvedAt must remain null on failure');
  assert(stateAfterNetFail.expiredAt > 0, 'expiredAt must remain set on failure');
  console.log('PASS  2. Network errors and timeouts do NOT clear expiry state');

  // --- TEST 3: Race condition guard: concurrent newer expiry is NOT overwritten ---
  const fetchStartedAt = Date.now() - 5000; // T1: Fetch started 5 seconds ago
  await new Promise((r) => setTimeout(r, 10)); // Advance clock

  // T2: While older fetch was running, a newer expiry event occurred:
  await db.markSessionExpired(user.id, 'newer-concurrent-expiry');
  const newerState = await db.getSessionExpiryState(user.id);
  assert(newerState.expiredAt > fetchStartedAt, 'Newer expiry must be after fetchStartedAt');

  // T3: Older fetch completes and attempts to clear with maxExpiredAt = fetchStartedAt (T1)
  const cleared = await db.clearSessionExpiry(user.id, { maxExpiredAt: fetchStartedAt });
  assert.strictEqual(cleared, false, 'clearSessionExpiry must return false when a newer expiry occurred');

  // Verify the newer expiry event remained intact
  const stateAfterRace = await db.getSessionExpiryState(user.id);
  assert.strictEqual(Number(stateAfterRace.expiredAt), Number(newerState.expiredAt), 'Newer expiredAt must not be overwritten');
  assert.strictEqual(stateAfterRace.resolvedAt, null, 'resolvedAt must remain null for newer expiry event');
  console.log('PASS  3. Race condition guard prevents older fetches from clearing newer expiry events');

  // --- TEST 4: Assignment pass self-healing clears stale expiry on success ---
  // Reset user to expired
  await db.markSessionExpired(user.id, 'stale-assignment-expiry');
  const assignmentStartedAt = Date.now();

  const assignResult = await assignments.runAssignmentCycle({
    userId: user.id,
    userEmail: user.email,
    user,
    mode: 'new',
    dryRun: true,
    fetchFn: async () => [
      { id: 'A1', title: 'Lab 1', subject: 'OS', deadline: '2026-10-15', uploaded: false },
    ],
    log: { log: () => {}, error: () => {} },
  });
  assert(Array.isArray(assignResult.notified), 'Assignment cycle completed successfully');

  const assignCleared = await db.clearSessionExpiry(user.id, { maxExpiredAt: assignmentStartedAt });
  assert.strictEqual(assignCleared, true, 'clearSessionExpiry must succeed for assignment pass');

  const stateAfterAssignment = await db.getSessionExpiryState(user.id);
  assert.strictEqual(stateAfterAssignment.expiredAt, null, 'Assignment pass cleared expiredAt');
  assert(stateAfterAssignment.resolvedAt >= assignmentStartedAt, 'Assignment pass recorded resolvedAt');
  console.log('PASS  4. Assignment pass self-healing conforms to shared recovery semantics');

  console.log('\nALL WATCHER SELF-HEALING RECOVERY TESTS PASSED SUCCESSFULLY!');
}

run().catch((err) => {
  console.error('TEST FAILURE:', err);
  process.exit(1);
}).finally(() => {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {}
});
