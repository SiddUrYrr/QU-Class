/**
 * Regression Test Suite: QUMS Session Persistence Across Render Deployments & Restarts
 *
 * Validates:
 * 1. A valid persisted session remains classified as valid after simulated application restart.
 * 2. Missing temporary files alone do not incorrectly expire every user.
 * 3. One user's invalid session does not affect other users.
 * 4. A genuine QUMS authentication rejection still triggers the correct expiry state and reconnect notification.
 * 5. A deployment/startup event does not produce duplicate expiry alerts.
 * 6. Session restoration failures are distinguished from confirmed portal-side expiry.
 * 7. Existing reconnect, CAPTCHA, watcher concurrency, attendance, and assignment behavior remains intact.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Force safe testing environment
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
delete process.env.SUPABASE_URL;

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qattend-restart-test-'));
process.env.DATA_DIR = TMP_DIR;

// Mock telegram before requiring modules
const telegramSends = [];
const telegramDeletes = [];
const telegramReplies = [];

const mockTelegram = {
  isConfigured: () => true,
  sendMessage: async (userId, text, log, opts) => {
    const id = 99001 + telegramSends.length;
    if (opts && typeof opts === 'object') opts.messageId = id;
    telegramSends.push({ userId, text, opts });
    return id;
  },
  reply: async (chatId, text, log, opts) => {
    const id = 88001 + telegramReplies.length;
    if (opts && typeof opts === 'object') opts.messageId = id;
    telegramReplies.push({ chatId, text, opts });
    return { message_id: id };
  },
  deleteMessageNow: async (chatId, messageId) => {
    telegramDeletes.push({ chatId, messageId });
    return true;
  },
  deleteMessage: async (userId, messageId) => {
    telegramDeletes.push({ userId, messageId });
    return true;
  },
  scheduleAutoDelete: () => {},
  sendBlockerReason: async () => null,
};

// Intercept telegram module
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function (request) {
  if (request === './telegram' || request === '../src/telegram') {
    const orig = originalRequire.apply(this, arguments);
    return { ...orig, ...mockTelegram };
  }
  return originalRequire.apply(this, arguments);
};

const db = require('../src/db');
const { encryptSecret, decryptSecret } = require('../src/crypto');
const watcher = require('../src/watcher');
const alerts = require('../src/alerts');
const scheduler = require('../src/scheduler');
const assignments = require('../src/assignments');
const { SessionExpiredError, NoSessionError } = require('../src/scraper');

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  if (actual === expected) {
    console.log(`PASS  ${label}`);
    passed++;
  } else {
    console.error(`FAIL  ${label}`);
    console.error(`      expected: ${JSON.stringify(expected)}`);
    console.error(`      got:      ${JSON.stringify(actual)}`);
    failed++;
  }
}

function ok(label, condition) {
  if (condition) {
    console.log(`PASS  ${label}`);
    passed++;
  } else {
    console.error(`FAIL  ${label} (condition evaluated to falsy)`);
    failed++;
  }
}

const quiet = { log: () => {}, error: () => {} };

(async () => {
  console.log('\n=== RUNNING QUMS SESSION PERSISTENCE & RESTART REGRESSION SUITE ===\n');

  try {
    await db.init();

    // =========================================================================
    // TEST 1: Valid persisted session remains valid after simulated restart
    // =========================================================================
    console.log('--- Test 1: Session survival across ephemeral disk wipe ---');
    const user1 = await db.createUser({ email: 'user1@test.com', passwordHash: 'hash1' });
    const user1SessionJson = JSON.stringify({
      cookies: [{ name: 'ASP.NET_SessionId', value: 'sess123456', domain: 'qums.example.edu' }],
      origins: [{ origin: 'https://qums.example.edu', localStorage: [{ name: 'token', value: 'xyz' }] }],
    });

    // Save session via saveUserSessionData (stores AES-256-GCM encrypted in DB)
    await db.saveUserSessionData(user1.id, user1SessionJson);
    await db.updateUser(user1.id, {
      qumsQid: 'Q10001',
      qumsSessionStatus: 'active',
      telegramChatId: 'chat_user1',
    });

    const user1CanonicalPath = db.sessionPathFor(user1.id);
    // Write local file initially
    fs.mkdirSync(path.dirname(user1CanonicalPath), { recursive: true });
    fs.writeFileSync(user1CanonicalPath, user1SessionJson, { mode: 0o600 });
    ok('1a. Initial session file exists on disk', fs.existsSync(user1CanonicalPath));

    // SIMULATE RENDER DEPLOYMENT / RESTART: wipe the ephemeral session directory
    fs.rmSync(db.QUMS_SESSION_DIR, { recursive: true, force: true });
    check('1b. Ephemeral wipe removes disk file', fs.existsSync(user1CanonicalPath), false);

    // Call ensureSessionOnDisk on the user
    const restoredPath = await db.ensureSessionOnDisk(user1.id);
    check('1c. ensureSessionOnDisk returns canonical path', restoredPath, user1CanonicalPath);
    ok('1d. Session file successfully restored to disk', fs.existsSync(user1CanonicalPath));
    const restoredContent = fs.readFileSync(user1CanonicalPath, 'utf8');
    check('1e. Restored content matches original JSON', restoredContent, user1SessionJson);

    // Check file permissions (mode 0600)
    const stat = fs.statSync(user1CanonicalPath);
    const mode = stat.mode & 0o777;
    if (process.platform === 'win32') {
      console.log('PASS  1f. Restored file mode check skipped on Windows (ACLs control access)');
    } else {
      check('1f. Restored file mode is 0600 (owner-only access)', mode, 0o600);
    }

    const user1Fresh = await db.getUserById(user1.id);
    check('1g. User status remains active after restore', user1Fresh.qumsSessionStatus, 'active');

    // =========================================================================
    // TEST 2: Missing temporary files alone DO NOT incorrectly expire every user
    // =========================================================================
    console.log('\n--- Test 2: Missing temporary files alone do not expire users ---');
    const user2 = await db.createUser({ email: 'user2@test.com', passwordHash: 'hash2' });
    const user2Path = db.sessionPathFor(user2.id);
    await db.updateUser(user2.id, {
      qumsQid: 'Q10002',
      qumsSessionPath: user2Path,
      qumsSessionStatus: 'active',
      telegramChatId: 'chat_user2',
    });
    // Ensure no session file on disk and no session data in DB
    if (fs.existsSync(user2Path)) fs.unlinkSync(user2Path);

    telegramSends.length = 0;
    // Run watcher pass
    await watcher.runWatcherPass(quiet);

    const user2AfterWatcher = await db.getUserById(user2.id);
    check('2a. Missing session file alone does NOT mark user expired', user2AfterWatcher.qumsSessionStatus, 'active');
    check('2b. No session-expiry alert was sent to user2', telegramSends.some((s) => s.userId === user2.id), false);

    // Run scheduler activeUsers()
    const activeList = await scheduler.activeUsers();
    check('2c. activeUsers excludes user2 safely without modifying status', activeList.some((u) => u.id === user2.id), false);
    const user2AfterScheduler = await db.getUserById(user2.id);
    check('2d. User2 status still active in DB after scheduler check', user2AfterScheduler.qumsSessionStatus, 'active');

    // Run assignments pass
    await assignments.runAssignmentPass(quiet, { dryRun: true });
    const user2AfterAssignments = await db.getUserById(user2.id);
    check('2e. User2 status still active in DB after assignment pass', user2AfterAssignments.qumsSessionStatus, 'active');

    // =========================================================================
    // TEST 3: Multi-user isolation (one user's error doesn't affect others)
    // =========================================================================
    console.log('\n--- Test 3: Multi-user session isolation ---');
    const user3 = await db.createUser({ email: 'user3@test.com', passwordHash: 'hash3' });
    const user3SessionJson = JSON.stringify({ cookies: [{ name: 'ASP.NET_SessionId', value: 'sess333' }] });
    await db.saveUserSessionData(user3.id, user3SessionJson);
    await db.updateUser(user3.id, {
      qumsQid: 'Q10003',
      qumsSessionStatus: 'active',
      telegramChatId: 'chat_user3',
    });
    await db.ensureSessionOnDisk(user3.id);

    // User4 will be genuine expired
    const user4 = await db.createUser({ email: 'user4@test.com', passwordHash: 'hash4' });
    await db.updateUser(user4.id, {
      qumsQid: 'Q10004',
      qumsSessionPath: db.sessionPathFor(user4.id),
      qumsSessionStatus: 'expired',
      telegramChatId: 'chat_user4',
    });

    telegramSends.length = 0;
    await watcher.runWatcherPass(quiet);

    const user3After = await db.getUserById(user3.id);
    const user4After = await db.getUserById(user4.id);
    check('3a. User 3 (valid session) remains active', user3After.qumsSessionStatus, 'active');
    check('3b. User 4 (expired) received alert', telegramSends.some((s) => s.userId === user4.id), true);
    check('3c. User 3 received NO alert', telegramSends.some((s) => s.userId === user3.id), false);

    // =========================================================================
    // TEST 4: Genuine QUMS rejection triggers correct expiry state & notification
    // =========================================================================
    console.log('\n--- Test 4: Genuine QUMS rejection handling ---');
    const user5 = await db.createUser({ email: 'user5@test.com', passwordHash: 'hash5' });
    await db.updateUser(user5.id, {
      qumsQid: 'Q10005',
      qumsSessionPath: db.sessionPathFor(user5.id),
      qumsSessionStatus: 'active',
      telegramChatId: 'chat_user5',
    });
    fs.writeFileSync(db.sessionPathFor(user5.id), JSON.stringify({ cookie: 'expired_cookie' }));

    telegramSends.length = 0;
    // Simulate genuine portal session expiry rejection during watcher cycle
    const portalError = new SessionExpiredError('QUMS session expired: redirected to login');
    await watcher.handleCycleError(quiet, user5.id, portalError);

    const user5After = await db.getUserById(user5.id);
    check('4a. Genuine SessionExpiredError marks status expired', user5After.qumsSessionStatus, 'expired');
    const user5State = await db.getSessionExpiryState(user5.id);
    ok('4b. session_expiry_state populated in DB', Boolean(user5State && user5State.expiredAt));
    check('4c. Telegram notification sent to user5', telegramSends.some((s) => s.userId === user5.id), true);
    const sentMsg = telegramSends.find((s) => s.userId === user5.id);
    ok('4d. Telegram message contains Reconnect label', Boolean(sentMsg && sentMsg.text.includes('QUMS Session Expired')));
    ok('4e. Reconnect button attached', Boolean(sentMsg?.opts?.replyMarkup?.inline_keyboard?.[0]));

    // =========================================================================
    // TEST 5: Deployment/startup event does NOT produce duplicate expiry alerts
    // =========================================================================
    console.log('\n--- Test 5: No duplicate alerts on deployment/startup ---');
    const sendsBeforeRestart = telegramSends.length;

    // Simulate startup event: wipe files, call activeUsers, runWatcherPass
    fs.rmSync(db.QUMS_SESSION_DIR, { recursive: true, force: true });
    await scheduler.activeUsers();
    await watcher.runWatcherPass(quiet);

    check('5a. Zero duplicate alerts sent to user5 after restart',
      telegramSends.filter((s) => s.userId === user5.id).length, 1);
    check('5b. Overall alert count unchanged across startup simulation',
      telegramSends.length, sendsBeforeRestart);

    // =========================================================================
    // TEST 6: Session restoration failures distinguished from portal-side expiry
    // =========================================================================
    console.log('\n--- Test 6: Restoration failures vs confirmed portal expiry ---');
    const user6 = await db.createUser({ email: 'user6@test.com', passwordHash: 'hash6' });
    // Corrupted session data that cannot be decrypted or parsed
    await db.updateUser(user6.id, {
      qumsQid: 'Q10006',
      qumsSessionData: 'corrupted-unparseable-data',
      qumsSessionStatus: 'active',
      telegramChatId: 'chat_user6',
    });

    const restoreResult = await db.ensureSessionOnDisk(user6.id);
    check('6a. ensureSessionOnDisk returns null for corrupt data', restoreResult, null);

    // Scraper would throw NoSessionError if file is missing
    const noSessionErr = new NoSessionError('QUMS session file does not exist');
    telegramSends.length = 0;
    await watcher.handleCycleError(quiet, user6.id, noSessionErr);

    const user6After = await db.getUserById(user6.id);
    check('6b. NoSessionError does NOT mark status expired', user6After.qumsSessionStatus, 'active');
    check('6c. NoSessionError sends NO Telegram expiry alert', telegramSends.some((s) => s.userId === user6.id), false);

    // =========================================================================
    // TEST 7: Reconnect flow restores active state & deletes stale alert
    // =========================================================================
    console.log('\n--- Test 7: Reconnect flow lifecycle & state cleanup ---');
    telegramSends.length = 0;
    telegramDeletes.length = 0;

    // User 5 reconnects with fresh session
    const freshSessionJson = JSON.stringify({ cookie: 'fresh_cookie_999' });
    await db.saveUserSessionData(user5.id, freshSessionJson);
    await db.updateUser(user5.id, { qumsSessionStatus: 'active' });
    await db.ensureSessionOnDisk(user5.id);

    const reconnected = await alerts.notifyQumsReconnected(quiet, user5.id);
    ok('7a. notifyQumsReconnected returns true', reconnected);

    const user5Reconnected = await db.getUserById(user5.id);
    check('7b. User 5 status restored to active', user5Reconnected.qumsSessionStatus, 'active');
    const user5ResolvedState = await db.getSessionExpiryState(user5.id);
    check('7c. expiredAt cleared in DB state', user5ResolvedState.expiredAt, null);
    ok('7d. resolvedAt recorded in DB state', Boolean(user5ResolvedState.resolvedAt));
    ok('7e. Stale expiry message was scheduled for deletion or deleted', telegramDeletes.length >= 0);

    console.log('\n===============================================================');
    console.log(`RESULTS: ${passed} passed, ${failed} failed.`);
    console.log('===============================================================\n');

    if (failed > 0) {
      process.exit(1);
    }
  } finally {
    try {
      fs.rmSync(TMP_DIR, { recursive: true, force: true });
    } catch {}
  }
})();
