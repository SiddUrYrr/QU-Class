/**
 * BACKDATED (Month Register) ATTENDANCE tests — the core acceptance criteria.
 *
 *   node test/backdated.test.js
 *   node test/backdated.test.js --phase2   (child process: "restart" dedupe check)
 *
 * No QUMS / Telegram network is used: the Month Register rows are injected and
 * sends are captured in an array. The DB + state live in os.tmpdir(), so the
 * real data/ directory is never touched.
 *
 * Covers (Phase 4 + Phase 18 items 8-14, 18):
 *   B1  first scan = BASELINE        -> 0 alerts, state seeded
 *   B2  unchanged record             -> 0 alerts (no repeat)
 *   B3  Absent -> Present            -> exactly 1 alert, message shows CLASS DATE
 *   B4  same state re-scanned        -> 0 alerts (dedupe)
 *   B5  22 Sep Absent -> Present later (spec TEST CASE) -> ONE notification only
 *   B6  Present -> Absent            -> 1 alert
 *   B7  NEW Present / NEW Absent     -> 1 alert each
 *   B8  duplicate prevention after "restart" (fresh process, same DB)
 *   B9  multi-user isolation (A's records never touch B's state)
 *   B10 month-by-month scan (current + previous month) detects previous-month change
 *   B11 legacy state entry without status -> silent reseed, no storm
 *   B12 unit: statusSignature / monthRegisterDiff identity rules
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TMP = process.env.BACKDATED_TEST_TMP || fs.mkdtempSync(path.join(os.tmpdir(), 'qattend-backdated-'));
process.env.BACKDATED_TEST_TMP = TMP;
process.env.DB_FILE = process.env.DB_FILE || path.join(TMP, 'db.json');
process.env.DATABASE_URL = '';
process.env.SESSION_ALERT_STATE_FILE = path.join(TMP, 'session_alerts.json');

const db = require('../src/db');
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

/** Month-register record exactly like scraper.expandMonthRegisterRows emits. */
function mkRec(date, code, subject, statusRaw, teacher = 'RAJ KUMAR') {
  const status = statusRaw === 'P' ? 'present' : statusRaw === 'A' ? 'absent' : 'other';
  return {
    date,
    day: Number(date.slice(-2)),
    subjectCode: code,
    subject,
    statusRaw,
    status,
    lectures: [{ statusRaw, status, index: 1 }],
    lecturesThatDay: 1,
    lectureIndex: null,
    teacher,
    room: '',
    key: `${date}-${code}`,
  };
}

/** One injected month-register cycle; returns the cycle result. */
async function cycle(userId, months, sent) {
  return watcher.runMonthRegisterCycle({
    log: quiet,
    userId,
    userEmail: `${userId}@example.com`,
    fetchFn: async () => months,
    sendFn: async (text) => { sent.push(text); return text; },
    stateFile: path.join(TMP, `fast-${userId}.json`),
  });
}

// ---- child process mode: fresh watcher module + same DB (restart simulation) ----
if (process.argv[2] === '--phase2') {
  (async () => {
    await db.init();
    const sent = [];
    const months = [{ year: 2026, month: 9, records: [mkRec('2026-09-22', 'CS35303', 'Java', 'P')], summary: null }];
    const r = await cycle('b8-restart-user', months, sent);
    console.log(`PHASE2_SENT=${sent.length} pending=${(r.notified || []).length}`);
    process.exit(0);
  })().catch((e) => {
    console.error('[x]', e.message);
    process.exit(1);
  });
} else {
  runMain();
}

async function runMain() {
  await db.init();
  const USER_A = 'backdated-user-a';
  const USER_B = 'backdated-user-b';

  // ---------- B1: first scan = baseline, no alerts ----------
  let sent = [];
  const sept1 = [
    mkRec('2026-09-10', 'CS35303', 'Java', 'A'),
    mkRec('2026-09-12', 'CS35365', 'Scala for Data Science', 'A'),
  ];
  let r = await cycle(USER_A, [{ year: 2026, month: 9, records: sept1, summary: null }], sent);
  check('B1 baseline scan -> 0 alerts', sent.length, 0);
  check('B1 result flagged bootstrap', r.bootstrap, true);
  check('B1 state seeded (2 records)', (await db.listKnownAttendance(USER_A)).length, 2);

  // ---------- B2: unchanged -> 0 alerts ----------
  sent = [];
  await cycle(USER_A, [{ year: 2026, month: 9, records: sept1, summary: null }], sent);
  check('B2 unchanged records -> 0 alerts', sent.length, 0);

  // ---------- B3: Absent -> Present -> 1 alert with the CLASS DATE ----------
  sent = [];
  const sept2 = [mkRec('2026-09-10', 'CS35303', 'Java', 'A'), mkRec('2026-09-12', 'CS35365', 'Scala for Data Science', 'P')];
  r = await cycle(USER_A, [{ year: 2026, month: 9, records: sept2, summary: null }], sent);
  check('B3 Absent -> Present -> exactly 1 alert', sent.length, 1);
  ok('B3 message shows the CLASS DATE (12 Sep 2026)', /Class Date: 12 September 2026/.test(sent[0] || ''), sent[0]);
  ok('B3 message shows Status: Present', /Current Status: [^\n]*Present/.test(sent[0] || ''), sent[0]);
  ok('B3 changed-record header is the spec "📌 Attendance Updated"', /📌 \*Attendance Updated\*/.test(sent[0] || ''), sent[0]);
  ok('B3 message includes the subject code', /Code: CS35365/.test(sent[0] || ''), sent[0]);
  ok('B3 message explains the backdated update', /QUMS attendance was updated for a previous class\./.test(sent[0] || ''), sent[0]);
  ok('B3 message shows the Absent -> Present transition', /Previous Status: [^\n]*Absent/.test(sent[0] || ''), sent[0]);
  ok('B3 message shows the subject', /Subject: Scala for Data Science/.test(sent[0] || ''), sent[0]);
  check('B3 notified key carries the real class date', r.notified[0].date, '2026-09-12');

  // ---------- B4: same state again -> 0 alerts ----------
  sent = [];
  await cycle(USER_A, [{ year: 2026, month: 9, records: sept2, summary: null }], sent);
  check('B4 repeat scan -> 0 alerts (dedupe)', sent.length, 0);

  // ---------- B5: spec TEST CASE — 22 Sep Absent, updated to Present later ----------
  sent = [];
  const SPEC_USER = 'b5-spec-user';
  const specInitial = [mkRec('2026-09-22', 'CS35303', 'Java', 'A')];
  await cycle(SPEC_USER, [{ year: 2026, month: 9, records: specInitial, summary: null }], sent); // baseline
  check('B5 initial scan (22 Sep Absent) -> 0 alerts', sent.length, 0);

  sent = [];
  const specUpdated = [mkRec('2026-09-22', 'CS35303', 'Java', 'P')]; // teacher updates it on 24 Sep
  r = await cycle(SPEC_USER, [{ year: 2026, month: 9, records: specUpdated, summary: null }], sent);
  check('B5 after teacher update -> ONE notification', sent.length, 1);
  ok('B5 notification says Class Date: 22 September 2026', /Class Date: 22 September 2026/.test(sent[0] || ''), sent[0]);
  ok('B5 changed-record header is "📌 Attendance Updated"', /📌 \*Attendance Updated\*/.test(sent[0] || ''), sent[0]);
  ok('B5 shows Previous Status: Absent', /Previous Status: [^\n]*Absent/.test(sent[0] || ''), sent[0]);
  ok('B5 shows Current Status: Present', /Current Status: [^\n]*Present/.test(sent[0] || ''), sent[0]);
  ok('B5 notification does NOT claim 24 September', !/24 September/.test(sent[0] || ''), sent[0]);
  check('B5 notified kind = changed', r.notified[0].kind, 'changed');
  check('B5 previous status recorded in the result', r.notified[0].previousStatus, 'A');

  sent = [];
  await cycle(SPEC_USER, [{ year: 2026, month: 9, records: specUpdated, summary: null }], sent);
  check('B5 next scan -> NO additional notification', sent.length, 0);

  // ---------- B6: Present -> Absent ----------
  sent = [];
  const flip = [mkRec('2026-09-22', 'CS35303', 'Java', 'A')];
  await cycle(SPEC_USER, [{ year: 2026, month: 9, records: flip, summary: null }], sent);
  check('B6 Present -> Absent -> 1 alert', sent.length, 1);
  ok('B6 message says Absent for the same class date', /Current Status: [^\n]*Absent/.test(sent[0] || '') && /22 September 2026/.test(sent[0] || ''), sent[0]);
  ok('B6 message shows the reverse transition (Previous Present -> Current Absent)', /Previous Status: [^\n]*Present/.test(sent[0] || '') && /Current Status: [^\n]*Absent/.test(sent[0] || ''), sent[0]);
  sent = [];
  await cycle(SPEC_USER, [{ year: 2026, month: 9, records: flip, summary: null }], sent);
  check('B6 repeat -> 0 alerts', sent.length, 0);

  // ---------- B7: brand-new Present + brand-new Absent ----------
  sent = [];
  const withNew = [
    mkRec('2026-09-22', 'CS35303', 'Java', 'A'),
    mkRec('2026-09-18', 'CS35304', 'Cloud Computing', 'P'),
    mkRec('2026-09-19', 'CS35305', 'Maths', 'A'),
  ];
  await cycle(SPEC_USER, [{ year: 2026, month: 9, records: withNew, summary: null }], sent);
  check('B7 two new records -> 2 alerts', sent.length, 2);
  ok('B7 one alert is the new Present record', sent.some((t) => /18 September 2026/.test(t) && /Present/.test(t)), JSON.stringify(sent));
  ok('B7 one alert is the new Absent record', sent.some((t) => /19 September 2026/.test(t) && /Absent/.test(t)), JSON.stringify(sent));
  ok('B7 brand-new records use the "📌 Attendance Update" header', sent.every((t) => /📌 \*Attendance Update\*/.test(t)), JSON.stringify(sent));
  ok('B7 brand-new records have NO Previous Status line', sent.every((t) => !/Previous Status/.test(t)), JSON.stringify(sent));
  sent = [];
  await cycle(SPEC_USER, [{ year: 2026, month: 9, records: withNew, summary: null }], sent);
  check('B7 repeat -> 0 alerts', sent.length, 0);

  // ---------- B8: "restart" (fresh process, same DB) -> no duplicate ----------
  // A dedicated user is baselined here, then re-scanned by the child process.
  const RESTART_USER = 'b8-restart-user';
  await cycle(RESTART_USER, [{ year: 2026, month: 9, records: [mkRec('2026-09-22', 'CS35303', 'Java', 'P')], summary: null }], []);
  const out = execFileSync(process.execPath, [__filename, '--phase2'], {
    env: { ...process.env, DB_FILE: process.env.DB_FILE, BACKDATED_TEST_TMP: TMP },
    encoding: 'utf8',
  });
  ok('B8 restart -> 0 duplicate sends', /PHASE2_SENT=0/.test(out), out.trim());

  // ---------- B9: multi-user isolation ----------
  sent = [];
  await cycle(USER_B, [{ year: 2026, month: 9, records: [mkRec('2026-09-22', 'CS35303', 'Java', 'P')], summary: null }], sent);
  check('B9 user B first scan -> 0 alerts (own baseline)', sent.length, 0);
  sent = [];
  await cycle(USER_B, [{ year: 2026, month: 9, records: [mkRec('2026-09-22', 'CS35303', 'Java', 'A')], summary: null }], sent);
  check('B9 user B Present -> Absent -> 1 alert', sent.length, 1);
  const aState = await db.listKnownAttendance(USER_A);
  const bState = await db.listKnownAttendance(USER_B);
  ok('B9 user A state unchanged by user B', aState.some((x) => x.key === '2026-09-12-CS35365' && x.status === 'present'));
  ok('B9 user B state independent (22 Sep Absent)', bState.some((x) => x.key === '2026-09-22-CS35303' && x.status === 'absent'));
  ok('B9 user A never received user B record', !aState.some((x) => x.key === '2026-09-22-CS35303'));

  // ---------- B10: month-by-month scan (current + previous month) ----------
  sent = [];
  const RANGE_USER = 'range-user';
  const august = { year: 2026, month: 8, records: [mkRec('2026-08-28', 'CS35303', 'Java', 'A')], summary: null };
  await cycle(RANGE_USER, [august, { year: 2026, month: 9, records: [], summary: null }], sent);
  check('B10 multi-month baseline -> 0 alerts', sent.length, 0);

  sent = [];
  const augustChanged = { year: 2026, month: 8, records: [mkRec('2026-08-28', 'CS35303', 'Java', 'P')], summary: null };
  r = await cycle(RANGE_USER, [augustChanged, { year: 2026, month: 9, records: [], summary: null }], sent);
  check('B10 previous-month change detected -> 1 alert', sent.length, 1);
  ok('B10 previous-month alert keeps the August class date', /28 August 2026/.test(sent[0] || ''), sent[0]);
  check('B10 cycle reports both months scanned', r.months, ['2026-08', '2026-09']);

  // ---------- B11: legacy entry without status -> silent reseed ----------
  sent = [];
  const LEGACY_USER = 'legacy-user';
  await db.addKnownAttendance(LEGACY_USER, [{ key: '2026-09-22-CS35303', date: '2026-09-22', subjectCode: 'CS35303', subject: 'Java' }]);
  await cycle(LEGACY_USER, [{ year: 2026, month: 9, records: [mkRec('2026-09-22', 'CS35303', 'Java', 'A')], summary: null }], sent);
  check('B11 legacy entry -> silent reseed, 0 alerts', sent.length, 0);
  const legacyState = await db.listKnownAttendance(LEGACY_USER);
  ok('B11 legacy entry refreshed with a real status', legacyState.some((x) => x.key === '2026-09-22-CS35303' && x.status === 'absent'));
  sent = [];
  await cycle(LEGACY_USER, [{ year: 2026, month: 9, records: [mkRec('2026-09-22', 'CS35303', 'Java', 'P')], summary: null }], sent);
  check('B11 after reseed, a real change alerts once', sent.length, 1);

  // ---------- B12: unit-level identity rules ----------
  check('B12 statusSignature uses the portal value', watcher.statusSignature(mkRec('2026-09-22', 'X1', 'Y', 'P')), 'P');
  check('B12 new record is pending', watcher.monthRegisterDiff([mkRec('2026-09-22', 'X1', 'Y', 'P')], []).pending.length, 1);
  check('B12 same record same status is NOT pending', watcher.monthRegisterDiff([mkRec('2026-09-22', 'X1', 'Y', 'P')], [mkRec('2026-09-22', 'X1', 'Y', 'P')]).pending.length, 0);
  check('B12 changed status IS pending', watcher.monthRegisterDiff([mkRec('2026-09-22', 'X1', 'Y', 'P')], [mkRec('2026-09-22', 'X1', 'Y', 'A')]).pending.length, 1);
  check('B12 unmarked (N) is never pending', watcher.monthRegisterDiff([{ ...mkRec('2026-09-22', 'X1', 'Y', 'P'), status: 'unmarked' }], []).pending.length, 0);
  check('B12 legacy per-lecture key migration suppresses old key', watcher.monthRegisterDiff([mkRec('2026-09-22', 'X1', 'Y', 'P')], [{ key: '2026-09-22-X1#1', statusRaw: 'P' }]).pending.length, 0);

  // ---------- B13: REAL portal shape (captured live) + per-lecture flip ----------
  const scraper = require('../src/scraper');
  // Exactly the shape the live GetMonthRegister returned:
  //   [{ "Subject": "CS35303 (Design and Analysis of Algorithm (S))", "1":"P", ..., "30":"N" }]
  const realRows = [
    { Subject: 'CS35303 (Design and Analysis of Algorithm (S))', 1: 'P', 2: 'P', 3: 'N', 22: 'P', 30: 'N' },
    { Subject: 'SE35369 (Technical Skills Development-IV (S))', 1: 'P,P', 2: 'N', 22: 'A' },
  ];
  const parsed = scraper.expandMonthRegisterRows(realRows, { year: 2026, month: 9 });
  check('B13 real shape -> records parsed (3 marks + 2 marks)', parsed.length, 5);
  check('B13 subject code parsed from the real label', parsed[0].subjectCode, 'CS35303');
  check('B13 subject name parsed from the real label (section marker stripped)', parsed[0].subject, 'Design and Analysis of Algorithm');
  check('B13 N cells are skipped', parsed.filter((r) => r.day === 3 || r.day === 30).length, 0);
  const pp = parsed.find((r) => r.statusRaw === 'P,P');
  check('B13 "P,P" -> two lectures on the same day', [pp.lecturesThatDay, pp.lectures.length], [2, 2]);
  check('B13 record key = date + subjectCode (unique per subject/day)', pp.key, '2026-09-01-SE35369');
  check('B13 every record key is unique (no collision)', parsed.length === new Set(parsed.map((r) => r.key)).size, true);

  // Per-lecture transition: stored "P,P" -> live "P,A" must alert ONCE with per-lecture detail.
  const PP_USER = 'pp-lecture-user';
  await db.addKnownAttendance(PP_USER, [pp]);
  sent = [];
  const ppChanged = scraper.expandMonthRegisterRows(
    [{ Subject: 'SE35369 (Technical Skills Development-IV (S))', 1: 'P,A' }],
    { year: 2026, month: 9 }
  );
  r = await cycle(PP_USER, [{ year: 2026, month: 9, records: ppChanged, summary: null }], sent);
  check('B13 per-lecture change (P,P -> P,A) -> 1 alert', sent.length, 1);
  ok('B13 per-lecture previous status line', /Previous Status: L1 [^\n]*Present \| L2 [^\n]*Present/.test(sent[0] || ''), sent[0]);
  ok('B13 per-lecture current status line', /Current Status: L1 [^\n]*Present \| L2 [^\n]*Absent/.test(sent[0] || ''), sent[0]);
  sent = [];
  await cycle(PP_USER, [{ year: 2026, month: 9, records: ppChanged, summary: null }], sent);
  check('B13 per-lecture repeat -> 0 alerts', sent.length, 0);

  // ---------- B14: tiered historical scanning plan ----------
  const now = { date: '2026-09-27' };
  const BASE = 1_700_000_000_000; // realistic epoch ms so tier intervals are meaningful
  const tierOpts = { monthsBack: 5, recentEveryCycles: 2, olderEveryHours: 6, nowMs: BASE };
  const c0 = watcher.monthsToScanNow(now, {}, tierOpts);
  check('B14 cycle 1 -> current month is always scanned first', [c0.months[0].year, c0.months[0].month], [2026, 9]);
  check('B14 cycle 1 -> previous month included (tier 2)', c0.months.some((m) => m.month === 8), true);
  check('B14 cycle 1 -> full sweep on a cold tier clock (current + 5 previous)', c0.months.length, 6);
  const c1 = watcher.monthsToScanNow(now, c0.state, tierOpts);
  check('B14 next cycle -> current month only (recent/older not due yet)', c1.months.length, 1);
  const c2 = watcher.monthsToScanNow(now, c1.state, tierOpts);
  check('B14 3rd cycle -> current + previous again', c2.months.map((m) => m.month), [9, 8]);
  const c3 = watcher.monthsToScanNow(now, c2.state, { ...tierOpts, nowMs: BASE + 6 * 3600 * 1000 + 1000 });
  check('B14 older months re-scanned after the interval (nothing silently missed)', c3.months.length, 6);
  check('B14 full sweep always includes the previous month', c3.months.map((m) => m.month), [9, 8, 7, 6, 5, 4]);
  const c0off = watcher.monthsToScanNow(now, {}, { monthsBack: 0, recentEveryCycles: 2, olderEveryHours: 6, nowMs: BASE });
  check('B14 monthsBack=0 -> current month only (minimal load)', c0off.months.length, 1);
  const cJan = watcher.monthsToScanNow({ date: '2027-01-05' }, {}, { monthsBack: 2, recentEveryCycles: 1, olderEveryHours: 1, nowMs: BASE });
  check('B14 year boundary handled (Jan -> Dec/Nov of previous year)', cJan.months.map((m) => `${m.year}-${m.month}`), ['2027-1', '2026-12', '2026-11']);
  check('B14 shiftMonth handles negative deltas', watcher.shiftMonth(2026, 1, -1), { year: 2025, month: 12 });

  // ---------- B15: startWatcher() MUST actually arm the backdated loop ----------
  // Regression guard: startMonthRegisterWatcher() was previously defined but
  // never called, so the whole backdated feature could never run in production.
  const armed = [];
  const armedLog = { log: (m) => armed.push(String(m)), error: (m) => armed.push(String(m)) };
  const handles = watcher.startWatcher(armedLog);
  ok('B15 startWatcher arms the fast per-class loop', armed.some((l) => /\[watcher\] armed — every \d+ min, college hours/.test(l)), armed.join(' | '));
  ok('B15 startWatcher arms the backdated month-register loop', armed.some((l) => /month-register loop armed/.test(l)), armed.join(' | '));
  ok('B15 the armed backdated loop logs the tiered cadence', armed.some((l) => /tiers: current month every cycle/.test(l)), armed.join(' | '));
  ok('B15 assignment watcher still armed exactly once', armed.filter((l) => /\[assignments\] armed/.test(l)).length === 1, armed.join(' | '));
  // Stop everything so this test process can exit (Timeout + cron task shapes).
  for (const h of handles || []) {
    if (h && typeof h.stop === 'function') h.stop();
    else if (h) clearInterval(h);
  }

  console.log(failures ? `\n${failures} BACKDATED TEST(S) FAILED` : '\nALL BACKDATED ATTENDANCE TESTS PASSED');
  process.exit(failures ? 1 : 0);
}
