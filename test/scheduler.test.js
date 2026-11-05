/**
 * Morning schedule (8:30 AM IST) — timing + reliability tests.
 *
 *   node test/scheduler.test.js
 *
 * Koi network / QUMS / Telegram use NAHI hota: db tmp JSON store me jaata hai,
 * Telegram + alerts stub hote hain, aur QUMS scrape `fetchFn` inject se aata hai.
 *
 * Covers (issue: "subh ka time table 8:30 AM par aana chahiye"):
 *   S1  config: cron '30 8 * * *' (8:30 AM) + Asia/Kolkata + IST timestamp helper
 *   S2  08:30 run  -> per active user exactly 1 message + per-day marker set
 *   S3  same din dobara run -> 0 messages (1/user/day dedupe, duplicates nahi)
 *   S4  force (manual `--now --morning`) -> dobara bhejta hai
 *   S5  12:00 (late recovered) run -> skip; force se hi jaata hai
 *   S6  boot catch-up 08:45 -> aaj ka miss hua timetable bhej deta hai (1 baar)
 *   S7  catch-up 12:00 / 08:00 -> window ke bahar, koi send nahi
 *   S8  send fail (Telegram unlinked) -> marker set NAHI -> agla run retry karta hai
 *   S9  "restart" (naya process, wahi marker file) -> koi duplicate send nahi
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Child process (S9) ko SAME tmp dir chahiye — isliye inherited env respect karo.
const TMP_DIR = process.env.SCHED_TEST_TMP || fs.mkdtempSync(path.join(os.tmpdir(), 'qums-sched-'));
process.env.SCHED_TEST_TMP = TMP_DIR;
process.env.DB_FILE = process.env.DB_FILE || path.join(TMP_DIR, 'db.json');
process.env.DATABASE_URL = ''; // JSON store (test isolation)
process.env.MORNING_STATE_FILE = process.env.MORNING_STATE_FILE || path.join(TMP_DIR, 'morning_state.json');
delete process.env.MORNING_CRON; // default 8:30 wala path test karo
delete process.env.MORNING_PREWARM_CRON; // default 08:15 pre-warm

// IST helper: 08:30 IST == 03:00 UTC (same date).
const IST = (iso) => new Date(iso);

// ---- stubs: no QUMS scrape, no Telegram network ----
const sends = []; // { userId, text }
const failForUserIds = new Set();
const ROWS = [
  { period: '(P1)09:00 - 09:55', duration: '09:00 - 09:55', subject: 'Design and Analysis of Algorithm', subjectCode: 'CS35303', room: 'A-004', teacher: 'RAJ KUMAR', raw: 'x' },
];

// ---- spies: node-cron schedule() calls (cron options assert karne ke liye) ----
const cronCalls = [];

const Module = require('module');
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'node-cron') {
    const real = origRequire.apply(this, arguments);
    return {
      ...real,
      schedule: (expression, fn, options) => {
        cronCalls.push({ expression, options });
        return real.schedule(expression, fn, options);
      },
    };
  }
  if (id === './scraper' || id === 'scraper') {
    return { getTodaysScheduleWithRoom: async () => ROWS, scrapeTodaysAttendance: async () => [], scrapeMonthRegister: async () => [] };
  }
  if (id === './telegram' || id === 'telegram') {
    return {
      isConfigured: () => true,
      sendMessage: async (userId, text) => {
        sends.push({ userId, text });
        return !failForUserIds.has(userId);
      },
      deepLink: () => '',
      getBotUsername: () => 'test_bot',
    };
  }
  if (id === './alerts' || id === 'alerts') {
    return { maybeNotifySessionExpired: async () => false };
  }
  return origRequire.apply(this, arguments);
};

const db = require('../src/db');
const scheduler = require('../src/scheduler');

let failures = 0;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
  if (!pass) failures += 1;
}

const logs = [];
const quiet = { log: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) };
const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(process.env.MORNING_STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
};
const sentToId = (userId) => sends.filter((s) => s.userId === userId).length;


// ---- child process mode: "restart" simulate (same marker file) ----
if (process.argv[2] === '--phase2') {
  (async () => {
    await db.init();
    sends.length = 0;
    await scheduler.runMorningScheduleJob(quiet, {
      now: IST(process.argv[3]),
      sleepMs: 0,
      fetchFn: async () => ROWS,
      stateFile: process.env.MORNING_STATE_FILE,
    });
    console.log(`PHASE2_SENT=${sends.length}`);
    process.exit(0);
  })().catch((e) => {
    console.error('[x]', e.message);
    process.exit(1);
  });
} else {
  (async () => {
    await db.init();
    const sessionA = path.join(TMP_DIR, 'a.json');
    const sessionB = path.join(TMP_DIR, 'b.json');
    fs.writeFileSync(sessionA, '{}');
    fs.writeFileSync(sessionB, '{}');
    const uA = await db.createUser({ email: 'a@example.com', passwordHash: 'x' });
    await db.updateUser(uA.id, { studentName: 'TEST STUDENT', qumsSessionPath: sessionA });
    const uB = await db.createUser({ email: 'b@example.com', passwordHash: 'x' });
    await db.updateUser(uB.id, { studentName: 'ASHA VERMA', qumsSessionPath: sessionB });

    const opts = (iso) => ({ now: IST(iso), sleepMs: 0, fetchFn: async () => ROWS, stateFile: process.env.MORNING_STATE_FILE });

    // ---- S1: config (8:30 AM IST) ----
    check('S1 cron = 8:30 AM daily', scheduler.MORNING_CRON, '30 8 * * *');
    check('S1 timezone = Asia/Kolkata (IST)', scheduler.TIMEZONE, 'Asia/Kolkata');
    check('S1 late-skip limit = 11:00 IST', scheduler.MORNING_LATE_SKIP_HOUR, 11);
    check('S1 pre-warm cron = 08:15 IST daily', scheduler.MORNING_PREWARM_CRON, '15 8 * * *');
    const at = scheduler.istParts(IST('2026-09-24T03:00:00.000Z'));
    check('S1 08:30 IST detection + stamp', [at.ymd, at.hour, at.minute, at.stamp], ['2026-09-24', 8, 30, '2026-09-24 08:30:00 IST']);

    // ---- S1b: cron arm hone par 8:30 + IST + missed-run recovery ----
    const tasks = scheduler.startScheduler(quiet);
    check(
      'S1b cron: 8:30 AM IST + recoverMissedExecutions=true',
      { expr: cronCalls[0].expression, tz: cronCalls[0].options.timezone, recover: cronCalls[0].options.recoverMissedExecutions },
      { expr: '30 8 * * *', tz: 'Asia/Kolkata', recover: true }
    );
    check('S1b armed log me 8:30 + recovery', logs.some((l) => l.includes('8:30 AM IST') && l.includes('recovery ON')), true);
    check(
      'S1b pre-warm cron: 08:15 IST + recovery',
      { expr: cronCalls[1].expression, tz: cronCalls[1].options.timezone, recover: cronCalls[1].options.recoverMissedExecutions },
      { expr: '15 8 * * *', tz: 'Asia/Kolkata', recover: true }
    );
    tasks.forEach((t) => t && typeof t.stop === 'function' && t.stop()); // test process me cron band rakho

    // ---- S2: 08:30 run -> per user exactly 1 message ----
    sends.length = 0;
    let r = await scheduler.runMorningScheduleJob(quiet, opts('2026-09-24T03:00:05.000Z'));
    check('S2 08:30 run -> 2/2 sent', [r.sent, r.total], [2, 2]);
    check('S2 per user exactly 1 message', [sentToId(uA.id), sentToId(uB.id)], [1, 1]);
    const msgA = (sends.find((s) => s.userId === uA.id) || {}).text || '';
    check('S2 message = aaj ki class + room', /09:00 - 09:55/.test(msgA) && /A-004/.test(msgA), true);
    check('S2 marker: dono users 2026-09-24', [readState()[uA.id], readState()[uB.id]], ['2026-09-24', '2026-09-24']);

    // ---- S3: same din dobara run -> 0 (1/user/day) ----
    sends.length = 0;
    r = await scheduler.runMorningScheduleJob(quiet, opts('2026-09-24T03:20:00.000Z'));
    check('S3 same day re-run -> 0 sends', [r.sent, sends.length], [0, 0]);
    check('S3 log me dedupe skip', logs.some((l) => l.includes('already bhej diya gaya hai')), true);

    // ---- S4: force (manual `--now --morning` / dashboard) -> dobara ----
    sends.length = 0;
    r = await scheduler.runMorningScheduleJob(quiet, { ...opts('2026-09-24T03:30:00.000Z'), force: true });
    check('S4 force -> 2 sends', [r.sent, sends.length], [2, 2]);

    // ---- S5: late (recovered) run 12:00 IST -> skip ----
    sends.length = 0;
    r = await scheduler.runMorningScheduleJob(quiet, opts('2026-09-25T06:30:00.000Z')); // 12:00 IST
    check('S5 12:00 IST late run -> 0 sends (stale timetable nahi)', [r.sent, r.late, sends.length], [0, true, 0]);
    sends.length = 0;
    r = await scheduler.runMorningScheduleJob(quiet, { ...opts('2026-09-25T06:30:00.000Z'), force: true });
    check('S5 force 12:00 IST -> sends (manual override)', [r.sent, sends.length], [2, 2]);

    // ---- S6: boot catch-up 08:45 IST -> aaj ka miss hua timetable ----
    sends.length = 0;
    r = await scheduler.catchUpMorningSchedule(quiet, opts('2026-09-26T03:15:00.000Z')); // 08:45 IST
    check('S6 catch-up 08:45 -> 2 sends', [r.sent, sends.length], [2, 2]);
    check('S6 catch-up marker set', readState()[uA.id], '2026-09-26');
    sends.length = 0;
    r = await scheduler.catchUpMorningSchedule(quiet, opts('2026-09-26T03:20:00.000Z'));
    check('S6 catch-up dobara (same day) -> 0 sends', [r.sent, sends.length], [0, 0]);

    // ---- S7: catch-up window ke bahar ----
    sends.length = 0;
    r = await scheduler.catchUpMorningSchedule(quiet, opts('2026-09-27T06:30:00.000Z')); // 12:00 IST
    check('S7 catch-up 12:00 IST -> skipped, 0 sends', [r.skipped, sends.length], [true, 0]);
    r = await scheduler.catchUpMorningSchedule(quiet, opts('2026-09-28T02:30:00.000Z')); // 08:00 IST
    check('S7 catch-up 08:00 IST (8:30 se pehle) -> skipped, 0 sends', [r.skipped, sends.length], [true, 0]);

    // ---- S8: send fail (Telegram unlinked) -> marker set nahi -> retry ----
    failForUserIds.add(uB.id);
    sends.length = 0;
    r = await scheduler.runMorningScheduleJob(quiet, opts('2026-09-29T03:00:00.000Z'));
    check('S8 unlinked user -> 1 sent, 2 attempts', [r.sent, sends.length], [1, 2]);
    check('S8 sent user ka marker aaj ka set hua', readState()[uA.id], '2026-09-29');
    check('S8 failed user ka marker aaj ka NAHI hai (retry pending)', readState()[uB.id] !== '2026-09-29', true);
    failForUserIds.clear();
    sends.length = 0;
    r = await scheduler.runMorningScheduleJob(quiet, opts('2026-09-29T03:05:00.000Z'));
    check('S8 retry -> sirf failed user ko gaya', [r.sent, sends.length], [1, 1]);
    check('S8 retry kisi aur ko duplicate nahi', sentToId(uA.id), 0);
    check('S8 retry ke baad failed user ka marker bhi set', readState()[uB.id], '2026-09-29');

    // ---- S9: restart (naya process, wahi marker) -> duplicate nahi ----
    const day30 = '2026-09-30T03:00:00.000Z';
    sends.length = 0;
    await scheduler.runMorningScheduleJob(quiet, opts(day30));
    check('S9 parent run -> 2 sends', sends.length, 2);
    const childOut = execFileSync(process.execPath, [__filename, '--phase2', day30], {
      encoding: 'utf8',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    check('S9 restart ke baad 0 duplicate sends', /PHASE2_SENT=0/.test(childOut), true);

    // ---- S10: 08:15 pre-warm (sirf cache build, koi message nahi) ----
    let fetches = 0;
    const countFetch = async () => {
      fetches += 1;
      return ROWS;
    };
    sends.length = 0;
    r = await scheduler.prewarmMorningSchedule(quiet, { now: IST('2026-10-01T02:45:00.000Z'), sleepMs: 0, fetchFn: countFetch }); // 08:15 IST
    check('S10 prewarm -> dono users ka cache build, 0 messages', [r.built, fetches, sends.length], [2, 2, 0]);
    check('S10 prewarm ne marker nahi chhua (8:30 wala send pending)', readState()[uA.id] !== '2026-10-01', true);

    // warm cache -> pre-warm koi naya scrape nahi karta
    await db.upsertWeeklySchedule(uA.id, IST('2026-10-01T02:45:00.000Z').getDay(), ROWS);
    fetches = 0;
    r = await scheduler.prewarmMorningSchedule(quiet, { now: IST('2026-10-01T02:50:00.000Z'), sleepMs: 0, fetchFn: countFetch });
    check('S10 warm cache wale user ka koi naya scrape nahi', [r.built, fetches], [1, 1]);

    // ---- S11: concurrent morning job runs -> exactly 1 execution (no duplicate messages) ----
    const dayOct2 = '2026-10-02T03:00:00.000Z';
    sends.length = 0;
    const [c1, c2] = await Promise.all([
      scheduler.runMorningScheduleJob(quiet, opts(dayOct2)),
      scheduler.runMorningScheduleJob(quiet, opts(dayOct2)),
    ]);
    check('S11 concurrent runs -> exactly 2 sends for 2 users (not 4)', sends.length, 2);
    check('S11 one run succeeds and concurrent run skips', [c1.sent, c2.sent].sort(), [0, 2]);

    console.log(failures === 0 ? '\nALL MORNING SCHEDULE TESTS PASSED' : `\n${failures} MORNING SCHEDULE TEST(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  })().catch((err) => {
    console.error('[x]', err.name || 'Error', '-', err.message);
    process.exit(1);
  });
}
