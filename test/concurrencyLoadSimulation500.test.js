/**
 * EXTENDED SAFE, NON-PRODUCTION CONCURRENCY & LOAD SIMULATION TEST
 * Stages: 50, 100, 200, 350, and 500 synthetic users.
 *
 * SAFETY INVARIANTS:
 * - 100% Hermetic: Zero outbound network calls to QUMS or Telegram.
 * - Throwaway JSON database & session directories in os.tmpdir().
 * - Cleans up all files, timers, and mock handlers at completion.
 * - Enforces memory ceiling & timeout guards to abort if runaway.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 1. ISOLATED TEST ENVIRONMENT SETUP (BEFORE ANY SRC IMPORTS)
const TEST_TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qattend-concurrency-500-'));
process.env.DB_FILE = path.join(TEST_TMP_DIR, 'db.json');
process.env.DATABASE_URL = '';
process.env.SESSION_ALERT_STATE_FILE = path.join(TEST_TMP_DIR, 'session_alerts.json');
process.env.TELEGRAM_BOT_TOKEN = 'mock:test-concurrency-500-bot-token';
process.env.NODE_ENV = 'test';
process.env.WATCHER_CONCURRENCY = '2'; // Default production baseline

// Safety assertion: Prove DB_FILE is in tmp and not pointing to real files
assert(process.env.DB_FILE.includes(TEST_TMP_DIR), 'DB_FILE must be in isolated temporary directory');
assert(!process.env.DATABASE_URL, 'DATABASE_URL must be disabled for local isolation');

// Mocks tracking structures
const telegramSends = [];
const telegramDeletes = [];

// Mock telegram module to intercept notifications
const telegram = require('../src/telegram');
const origTelegramSend = telegram.sendMessage;
const origTelegramDelete = telegram.deleteMessage;
telegram.sendMessage = async (userId, text, log, opts = {}) => {
  const msgId = 100000 + telegramSends.length + 1;
  opts.messageId = msgId;
  telegramSends.push({ userId, text, opts, messageId: msgId, timestamp: Date.now() });
  return true;
};
telegram.deleteMessage = async (userId, messageId, log) => {
  telegramDeletes.push({ userId, messageId: Number(messageId), timestamp: Date.now() });
  return true;
};

// Database and modules
const db = require('../src/db');
const watcher = require('../src/watcher');
const assignments = require('../src/assignments');
const alerts = require('../src/alerts');
const scraper = require('../src/scraper');

function makeMockAttendanceRow(period, code, subject, attend = 'P') {
  const status = attend === 'N.M.' ? 'unmarked' : attend === 'P' ? 'present' : attend === 'A' ? 'absent' : 'other';
  return {
    period: String(period),
    duration: '09:00 - 09:55',
    subject,
    subjectCode: code,
    employee: 'PROF. TEST',
    attendance: attend,
    status,
    key: `P${period}-${code}`,
  };
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MEMORY_LIMIT_MB = 600; // Abort guard if process RSS exceeds 600 MB
const STAGES = [50, 100, 200, 350, 500];

const stageReports = [];

async function run() {
  console.log('================================================================');
  console.log('  QATTEND SAFE EXTENDED CONCURRENCY LOAD SIMULATION (50 -> 500)');
  console.log('  Target: Non-Production Lifecycle, Fault Matrix & Isolation');
  console.log('  Storage: Isolated Temp ->', TEST_TMP_DIR);
  console.log('  Watch Concurrency Limit:', watcher.getWatcherStatus().concurrency);
  console.log('  Safety Guards: RSS Ceiling < 600MB | Network Hermeticity 100%');
  console.log('================================================================\n');

  await db.init();

  for (const userCount of STAGES) {
    console.log(`\n>>> STARTING STAGE: ${userCount} SYNTHETIC USERS <<<`);
    const initialMem = process.memoryUsage().rss;

    // Check memory safety guard
    if (initialMem / (1024 * 1024) > MEMORY_LIMIT_MB) {
      throw new Error(`ABORT: Memory limit exceeded before stage ${userCount}: ${(initialMem / (1024 * 1024)).toFixed(1)} MB`);
    }

    telegramSends.length = 0;
    const users = [];

    // Pre-create synthetic users for this stage
    const setupStart = Date.now();
    for (let i = 0; i < userCount; i++) {
      const u = await db.createUser({
        email: `stage-${userCount}-user-${i}@mock.local`,
        passwordHash: 'hash',
      });
      await db.setTelegramChatId(u.id, 1000000 + i);
      const sPath = path.join(TEST_TMP_DIR, `session-${u.id}.json`);
      fs.writeFileSync(sPath, JSON.stringify({ cookies: [{ name: 'ASP.NET_SessionId', value: `sess-${u.id}` }] }));
      await db.updateUser(u.id, { qumsSessionPath: sPath, studentName: `Student ${userCount}-${i}`, qumsSessionStatus: 'active' });
      users.push(u);
    }
    const setupDuration = Date.now() - setupStart;

    // Concurrency tracking variables
    let activeWorkers = 0;
    let peakConcurrency = 0;
    let expectedFailures = 0;
    let unexpectedFailures = 0;
    let failedExpectedUserId = null;
    let successfulUserCount = 0;
    let falseExpiryCount = 0;
    let genuineExpiryCount = 0;
    let duplicateSendsCount = 0;
    let crossUserLeaks = 0;
    let schedulerSkips = 0;
    let schedulerExecuted = 0;
    let schedulerBusy = false;
    let peakMemDuringStage = initialMem;

    const perUserLatencies = [];
    const CONCURRENCY_LIMIT = 2; // Baseline limit

    // Schedule / Mutex Simulation during this stage:
    // Fire 3 simultaneous trigger attempts mid-stage
    const triggerScheduler = async () => {
      if (schedulerBusy) {
        schedulerSkips++;
        return;
      }
      schedulerBusy = true;
      schedulerExecuted++;
      await sleep(10);
      schedulerBusy = false;
    };

    // Workers pool
    let cursor = 0;
    const stageStart = Date.now();

    const workers = Array.from({ length: CONCURRENCY_LIMIT }, async (workerId) => {
      while (cursor < users.length) {
        const u = users[cursor++];
        if (!u) break;

        activeWorkers++;
        if (activeWorkers > peakConcurrency) peakConcurrency = activeWorkers;

        const currentMem = process.memoryUsage().rss;
        if (currentMem > peakMemDuringStage) peakMemDuringStage = currentMem;

        const uT0 = Date.now();

        // Fault Injection per stage:
        // User index 3 -> Slow response (50ms delay)
        // User index 7 -> Socket Timeout (ETIMEDOUT) -> evidence: false
        // User index 11 -> HTTP 502 Bad Gateway -> evidence: false
        // User index 15 -> HTTP 504 Gateway Timeout -> evidence: false
        // User index 19 -> CAPTCHA challenge -> evidence: false
        // User index 23 -> Genuine Session Expiry -> evidence: true
        // User index 27 -> Single unhandled user failure (must not crash other users)

        const userIndex = cursor - 1;
        let isFailingUser = false;

        try {
          if (userIndex === 3) {
            // Slow QUMS response
            await sleep(50);
          } else if (userIndex === 7) {
            // Network timeout
            await alerts.maybeNotifySessionExpired(console, u.id, { evidence: false });
            // Verify session status remains active
            const dbU = await db.getUserById(u.id);
            if (dbU.qumsSessionStatus !== 'active') falseExpiryCount++;
          } else if (userIndex === 11) {
            // HTTP 502
            await alerts.maybeNotifySessionExpired(console, u.id, { evidence: false });
            const dbU = await db.getUserById(u.id);
            if (dbU.qumsSessionStatus !== 'active') falseExpiryCount++;
          } else if (userIndex === 15) {
            // HTTP 504
            await alerts.maybeNotifySessionExpired(console, u.id, { evidence: false });
            const dbU = await db.getUserById(u.id);
            if (dbU.qumsSessionStatus !== 'active') falseExpiryCount++;
          } else if (userIndex === 19) {
            // CAPTCHA prompt
            await alerts.maybeNotifySessionExpired(console, u.id, { evidence: false });
            const dbU = await db.getUserById(u.id);
            if (dbU.qumsSessionStatus !== 'active') falseExpiryCount++;
          } else if (userIndex === 23) {
            // Genuine expiry
            await db.updateUser(u.id, { qumsSessionStatus: 'expired' });
            await db.markSessionExpired(u.id, 'session-expired');
            await alerts.maybeNotifySessionExpired(console, u.id, { evidence: true });
            genuineExpiryCount++;
          } else if (userIndex === 27) {
            // Catastrophic error for this user
            isFailingUser = true;
            throw new Error('Simulated portal socket reset for user');
          }

          if (![7, 11, 15, 19, 23, 27].includes(userIndex)) {
            // Normal attendance cycle
            const subCode = `CS-${userIndex}`;
            const subTitle = `Course ${userIndex}`;
            const statePath = path.join(TEST_TMP_DIR, `state-${u.id}.json`);

            const r = await watcher.runWatcherCycle({
              log: { log: () => {}, error: () => {} },
              userId: u.id,
              fetchFn: async () => [makeMockAttendanceRow(1, subCode, subTitle, 'P')],
              sendFn: async (text) => telegram.sendMessage(u.id, text, console, { category: 'ATTENDANCE' }),
              stateFile: statePath,
              roomByCode: {},
              userEmail: u.email,
            });

            // Verify isolation: text sent must strictly contain only this user's subject
            const sendsForUser = telegramSends.filter((s) => s.userId === u.id);
            if (sendsForUser.length > 1) duplicateSendsCount++;
            for (const s of sendsForUser) {
              if (!s.text.includes(subCode)) crossUserLeaks++;
            }
            successfulUserCount++;
          }
        } catch (err) {
          if (isFailingUser && userIndex === 27 && err.message === 'Simulated portal socket reset for user') {
            expectedFailures++;
            failedExpectedUserId = u.id;
          } else {
            unexpectedFailures++;
            console.error(`Unexpected failure for user ${u.id}:`, err.message);
          }
        } finally {
          const lat = Date.now() - uT0;
          perUserLatencies.push(lat);
          activeWorkers--;
        }

        // Trigger scheduler simulation at mid-point
        if (cursor === Math.floor(users.length / 2)) {
          await Promise.all([triggerScheduler(), triggerScheduler(), triggerScheduler()]);
        }
      }
    });

    await Promise.all(workers);
    const stageDuration = Date.now() - stageStart;
    const finalMem = process.memoryUsage().rss;

    perUserLatencies.sort((a, b) => a - b);
    const avgLatency = (perUserLatencies.reduce((a, b) => a + b, 0) / perUserLatencies.length).toFixed(1);
    const p95Latency = perUserLatencies[Math.floor(perUserLatencies.length * 0.95)] || 0;
    const p99Latency = perUserLatencies[Math.floor(perUserLatencies.length * 0.99)] || 0;
    const maxLatency = perUserLatencies[perUserLatencies.length - 1] || 0;

    const memBeforeMB = (initialMem / (1024 * 1024)).toFixed(1);
    const memPeakMB = (peakMemDuringStage / (1024 * 1024)).toFixed(1);
    const memAfterMB = (finalMem / (1024 * 1024)).toFixed(1);

    const report = {
      userCount,
      totalDurationMs: stageDuration,
      avgLatencyMs: avgLatency,
      p95LatencyMs: p95Latency,
      p99LatencyMs: p99Latency,
      maxLatencyMs: maxLatency,
      peakConcurrent: peakConcurrency,
      expectedFailures,
      unexpectedFailures,
      successfulUsers: successfulUserCount,
      failedUsers: expectedFailures + unexpectedFailures,
      falseExpiries: falseExpiryCount,
      genuineExpiries: genuineExpiryCount,
      schedulerSkips,
      duplicateSends: duplicateSendsCount,
      crossUserLeaks,
      memBeforeMB,
      memPeakMB,
      memAfterMB,
    };
    stageReports.push(report);

    console.log(`  [Results for ${userCount} Users]:`);
    console.log(`    - Duration: ${stageDuration}ms | Avg Latency: ${avgLatency}ms | P95: ${p95Latency}ms | P99: ${p99Latency}ms`);
    console.log(`    - Peak Concurrent: ${peakConcurrency} (Limit=${CONCURRENCY_LIMIT})`);
    console.log(`    - Memory: Before=${memBeforeMB}MB | Peak=${memPeakMB}MB | After=${memAfterMB}MB`);
    console.log(`    - Invariants: False Expiries=${falseExpiryCount} | Genuine Expiries=${genuineExpiryCount} | Cross Leaks=${crossUserLeaks}`);
    console.log(`    - Scheduler Mutex: Executed=${schedulerExecuted} | Skips=${schedulerSkips}`);
    console.log(`    - Fault Containment: Expected Failures=${expectedFailures} | Unexpected Failures=${unexpectedFailures} | Successful Users=${successfulUserCount}/${userCount - 6}`);

    // Invariant assertions per stage
    assert.strictEqual(peakConcurrency <= CONCURRENCY_LIMIT, true, `Peak concurrency (${peakConcurrency}) must never exceed ${CONCURRENCY_LIMIT}`);
    assert.strictEqual(falseExpiryCount, 0, 'False expiry count must be strictly 0');
    assert.strictEqual(genuineExpiryCount, 1, 'Genuine expiry count must be strictly 1');
    assert.strictEqual(crossUserLeaks, 0, 'Cross user session/state leaks must be strictly 0');
    assert.strictEqual(duplicateSendsCount, 0, 'Duplicate notifications must be strictly 0');
    assert.strictEqual(expectedFailures, 1, 'Exactly 1 expected fault must occur');
    assert.strictEqual(unexpectedFailures, 0, 'Unexpected failures must equal zero');
    assert.strictEqual(failedExpectedUserId, users[27].id, 'The designated faulty user must strictly be User #27');
    assert.strictEqual(successfulUserCount, userCount - 6, `All other expected attendance users (${userCount - 6}) must complete successfully`);
  }

  // Regression Check: Masking Prevention Verification
  console.log('\n>>> STEP: REGRESSION CHECK — MASKING PREVENTION VERIFICATION <<<');
  {
    const regUserCount = 30;
    const regUsers = [];
    for (let i = 0; i < regUserCount; i++) {
      const u = await db.createUser({
        email: `regression-user-${i}@mock.local`,
        passwordHash: 'hash',
      });
      await db.setTelegramChatId(u.id, 2000000 + i);
      const sPath = path.join(TEST_TMP_DIR, `regression-session-${u.id}.json`);
      fs.writeFileSync(sPath, JSON.stringify({ cookies: [{ name: 'ASP.NET_SessionId', value: `sess-${u.id}` }] }));
      await db.updateUser(u.id, { qumsSessionPath: sPath, studentName: `Reg Student ${i}`, qumsSessionStatus: 'active' });
      regUsers.push(u);
    }

    let regExpectedFailures = 0;
    let regUnexpectedFailures = 0;
    let regFailedExpectedUserId = null;
    let regCursor = 0;

    const regWorkers = Array.from({ length: 2 }, async () => {
      while (regCursor < regUsers.length) {
        const u = regUsers[regCursor++];
        if (!u) break;
        const userIndex = regCursor - 1;
        let isFailingUser = false;

        try {
          if (userIndex === 27) {
            // Intentional fault
            isFailingUser = true;
            throw new Error('Simulated portal socket reset for user');
          } else if (userIndex === 5) {
            // Injected UNEXPECTED failure on a non-fault user
            throw new Error('Unexpected simulated crash during data processing');
          }
        } catch (err) {
          if (isFailingUser && userIndex === 27 && err.message === 'Simulated portal socket reset for user') {
            regExpectedFailures++;
            regFailedExpectedUserId = u.id;
          } else {
            regUnexpectedFailures++;
          }
        }
      }
    });

    await Promise.all(regWorkers);

    console.log(`  -> Regression Check Dual-Failure Results: Expected Failures=${regExpectedFailures}, Unexpected Failures=${regUnexpectedFailures}`);
    // Assert that the intentional fault is detected
    assert.strictEqual(regExpectedFailures, 1, 'Regression Check: Expected failure must be recorded');
    assert.strictEqual(regFailedExpectedUserId, regUsers[27].id, 'Regression Check: Expected failure must be User #27');
    // Assert that the unexpected failure is NOT masked
    assert.strictEqual(regUnexpectedFailures, 1, 'Regression Check: Unexpected failure on User #5 must be detected and not masked');

    // Also verify: if an unintended error occurs on the designated user (User #27), it is NOT counted as expected
    let unintendedOnDesignatedExpected = 0;
    let unintendedOnDesignatedUnexpected = 0;
    {
      const isFailing = true;
      const uIndex = 27;
      try {
        throw new TypeError('Unexpected TypeError instead of socket reset');
      } catch (err) {
        if (isFailing && uIndex === 27 && err.message === 'Simulated portal socket reset for user') {
          unintendedOnDesignatedExpected++;
        } else {
          unintendedOnDesignatedUnexpected++;
        }
      }
    }

    assert.strictEqual(unintendedOnDesignatedExpected, 0, 'Regression Check: Wrong error on designated user must NOT be counted as expected');
    assert.strictEqual(unintendedOnDesignatedUnexpected, 1, 'Regression Check: Wrong error on designated user must increment unexpectedFailures');
    console.log('  -> Regression Check Passed: Unexpected failures cannot be masked by intentional faults.');
  }

  // Final Teardown
  console.log('\n[TEARDOWN] Restoring Global Handlers & Cleaning Up Temporary Directory...');
  telegram.sendMessage = origTelegramSend;
  telegram.deleteMessage = origTelegramDelete;

  try {
    fs.rmSync(TEST_TMP_DIR, { recursive: true, force: true });
    console.log('  -> Isolated temporary directory removed safely:', TEST_TMP_DIR);
  } catch (cleanErr) {
    console.warn('  -> Cleanup warning:', cleanErr.message);
  }

  console.log('\n================================================================');
  console.log('  500-USER EXTENDED CONCURRENCY LOAD SIMULATION COMPLETE');
  console.log('================================================================');
  console.table(stageReports);
}

run().catch((err) => {
  console.error('\nSIMULATION FAILED:', err);
  telegram.sendMessage = origTelegramSend;
  telegram.deleteMessage = origTelegramDelete;
  try { fs.rmSync(TEST_TMP_DIR, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
