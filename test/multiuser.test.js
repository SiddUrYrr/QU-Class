/**
 * 15A–15K — MULTI-USER Telegram ISOLATION tests (end-to-end via the real watcher).
 *
 *   node test/multiuser.test.js                                (phase 1)
 *   node test/multiuser.test.js --phase2 <stateFileA> <stateFileB>
 *
 * Koi network / QUMS / Telegram credential use NAHI hota — fetchFn/sendFn
 * inject hote hain aur dedupe state os.tmpdir() me jaati hai (real data/ dir
 * ko kabhi touch nahi karta).
 *
 * Phase 1 (ek hi process):
 *   - Baseline (15G): initial scan — sab N.M. -> ZERO sends (koi purana
 *     attendance spam nahi)
 *   - Test A (15A/15H): User A ka P2 N.M.->P change -> SIRF user A ko 1 message;
 *     User B ko KUCH nahi (dono ka same subject/period/code — 15D scenario)
 *   - Test B: User B ka P2 N.M.->A change -> SIRF user B ko 1 message; User A
 *     ko KUCH nahi
 *   - Test C: same data dobara poll -> koi naya send nahi (dedupe)
 *   - Unit (15D/15E): eventKey status include karta hai; P->A flip = NAYA
 *     event; legacy key (bina status) bhi suppress karta hai
 *
 * Phase 2 (child process = ASLI server RESTART simulation, Test D):
 *   - naya Node process, watcher module dobara load, WAHI persisted state
 *     files -> same data poll pe ZERO naye sends
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// ---- hermetic test isolation (MUST run before any ../src require) ----
// src/watcher.js pulls in dotenv + db, so without this the suite could hit the
// developer's real PostgreSQL (local .env) instead of a throwaway JSON store.
process.env.DB_FILE = process.env.DB_FILE || path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qattend-multiuser-')), 'db.json');
process.env.DATABASE_URL = '';

const watcher = require('../src/watcher');

let failures = 0;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
  if (!pass) failures += 1;
}

const quiet = { log: () => {}, error: () => {} };

/** Scraper-shaped row (aaj ke "Today's Attendance" API ka analog). */
function mkRow(period, code, subject, employee, attend) {
  const status = attend === 'N.M.' ? 'unmarked' : attend === 'P' ? 'present' : attend === 'A' ? 'absent' : 'other';
  return {
    period,
    duration: '09:55-10:50',
    subject,
    subjectCode: code,
    employee,
    attendance: attend,
    status,
    key: `${period}-${code}`,
  };
}

/**
 * 15D ka EXACT scenario: user A aur user B DONO ke paas P2 me CS30201 hai —
 * par user A ko P mila, user B ko A. Events completely independent hone chahiye.
 */
function rowsFor(p2Attend) {
  return [
    mkRow('P1', 'CS10101', 'Mathematics', 'DR. IYER', 'N.M.'),
    mkRow('P2', 'CS30201', 'Data Structures', 'DR. SHARMA', p2Attend),
    mkRow('P3', 'CS40404', 'Operating Systems', 'PROF. RAO', 'N.M.'),
  ];
}

function runCycle(stateFile, rows, capture) {
  return watcher.runWatcherCycle({
    log: quiet,
    userId: 'test-user',
    force: true, // college-hours check bypass (test kabhi bhi chale)
    stateFile, // PER-USER state file — data/notified_periods/<userId>.json ka analog
    fetchFn: async () => rows, // YE user ka QUMS attendance
    sendFn: async (text) => {
      capture.push(text); // YE user ke telegramChatId pe jaane wala message
      return text;
    },
  });
}

// ---------------------------------------------------------------------------
// Phase 2 — ASLI restart simulation (Test D): naya process, same persisted state.
// ---------------------------------------------------------------------------
if (process.argv[2] === '--phase2') {
  const stateA = process.argv[3];
  const stateB = process.argv[4];
  (async () => {
    const sentA = [];
    const sentB = [];
    check('phase2: state file A survived restart', fs.existsSync(stateA), true);
    check('phase2: state file B survived restart', fs.existsSync(stateB), true);
    await runCycle(stateA, rowsFor('P'), sentA);
    await runCycle(stateB, rowsFor('A'), sentB);
    check('Test D (restart): user A -> no duplicate', sentA.length, 0);
    check('Test D (restart): user B -> no duplicate', sentB.length, 0);
    console.log(failures === 0 ? 'PHASE2_OK' : 'PHASE2_FAILED');
    process.exit(failures === 0 ? 0 : 1);
  })().catch((err) => {
    console.error('PHASE2_FAILED:', err.message);
    process.exit(1);
  });
} else {
  (async () => {
    // ---- 15D unit checks: event key + legacy compat ----
    const rowP = mkRow('P2', 'CS30201', 'Data Structures', 'DR. SHARMA', 'P');
    const rowA = mkRow('P2', 'CS30201', 'Data Structures', 'DR. SHARMA', 'A');
    check('15D: event key = period+code+status', watcher.eventKeyFor(rowP), 'P2-CS30201:present');
    check('15D: same key different status = DIFFERENT events', watcher.eventKeyFor(rowA), 'P2-CS30201:absent');
    check('15D: repeat same event -> suppressed', watcher.pendingNotifications([rowP], ['P2-CS30201:present']).length, 0);
    check('15D: status flip P->A -> NEW event', watcher.pendingNotifications([rowA], ['P2-CS30201:present']).length, 1);
    check('15D: legacy key (bina status) bhi suppress karta hai', watcher.pendingNotifications([rowP], ['P2-CS30201']).length, 0);
    check('15E: N.M. ignored (empty pending from all-N.M. rows)', watcher.pendingNotifications(rowsFor('N.M.'), []).map((r) => r.key), []);

    // ---- per-user state files (data/notified_periods/<userId>.json analog) ----
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qums-multiuser-'));
    const stateA = path.join(tmp, 'user_A.json');
    const stateB = path.join(tmp, 'user_B.json');

    // ---- Baseline (15G): initial scan, sab N.M. -> koi send nahi ----
    const sentA = [];
    const sentB = [];
    await runCycle(stateA, rowsFor('N.M.'), sentA);
    await runCycle(stateB, rowsFor('N.M.'), sentB);
    check('15G baseline: user A -> 0 messages', sentA.length, 0);
    check('15G baseline: user B -> 0 messages', sentB.length, 0);

    // ---- Test A (15A/15E/15H): user A ka P2 mark hua -> SIRF A ko message ----
    await runCycle(stateA, rowsFor('P'), sentA); // A: QUMS ne P2 mark kiya
    await runCycle(stateB, rowsFor('N.M.'), sentB); // B: kuch nahi badla
    check('Test A: user A -> exactly 1 message', sentA.length, 1);
    check(
      'Test A: message = Data Structures / CS30201 / P2 / Present',
      sentA[0].includes('Attendance Update') && sentA[0].includes('Data Structures (CS30201)') && sentA[0].includes('Period: P2') && sentA[0].includes('Present'),
      true
    );
    check('Test A: user B -> NOTHING', sentB.length, 0);

    // ---- Test B (15H): user B ka P2 mark hua -> SIRF B ko message ----
    await runCycle(stateA, rowsFor('P'), sentA); // A: unchanged
    await runCycle(stateB, rowsFor('A'), sentB); // B: QUMS ne P2 mark kiya
    check('Test B: user A -> abhi bhi sirf 1 (kuch naya nahi)', sentA.length, 1);
    check('Test B: user B -> exactly 1 message', sentB.length, 1);
    check('Test B: message = Absent (B ka apna event)', sentB[0].includes('CS30201') && sentB[0].includes('Absent'), true);

    // ---- Test C (15H): same data dobara -> dedupe, zero naye sends ----
    await runCycle(stateA, rowsFor('P'), sentA);
    await runCycle(stateB, rowsFor('A'), sentB);
    check('Test C: user A -> no duplicate on re-poll', sentA.length, 1);
    check('Test C: user B -> no duplicate on re-poll', sentB.length, 1);

    // ---- Test D (15H): RESTART — naya child process, wahi persisted state ----
    const out = execFileSync(process.execPath, [__filename, '--phase2', stateA, stateB], {
      encoding: 'utf8',
    });
    console.log(
      out
        .trim()
        .split('\n')
        .filter((l) => l.startsWith('PASS') || l.startsWith('FAIL') || l.includes('PHASE2'))
        .join('\n')
    );
    check('Test D: fresh process -> PHASE2_OK (no duplicates)', out.includes('PHASE2_OK'), true);

    console.log(failures === 0 ? '\nALL MULTI-USER ISOLATION TESTS PASSED' : `\n${failures} test(s) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  })().catch((err) => {
    console.error('[x]', err.name || 'Error', '-', err.message);
    process.exit(1);
  });
}
