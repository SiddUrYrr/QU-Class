/**
 * Tests for the QUMS scraper (v2, API-first) + calculator.
 *
 *   node test/parser.test.js
 *
 * Covers:
 *   1. mapAttendanceRow — raw portal API rows -> app subject shape (exact counts)
 *   2. looksLikeLoginHtml — session-expiry detection
 *   3. analyzeSubject/analyzeAttendance — exact-count mode + estimated fallback
 *   4. parseTimetableInPage + getTodaySubjects — DOM parsing (simulated grid)
 *
 * Uses only Playwright's bundled Chromium — no QUMS credentials needed.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---- hermetic test isolation (MUST run before any ../src require) ----
// src/scraper.js calls dotenv.config(), which would otherwise load the
// developer's real .env (real DATABASE_URL) and make this suite hit a live
// PostgreSQL database. Tests must never depend on the local .env or real data.
process.env.DB_FILE = process.env.DB_FILE || path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qattend-parser-')), 'db.json');
process.env.DATABASE_URL = '';

const { chromium } = require('playwright');

const scraperPath = path.join(__dirname, '..', 'src', 'scraper.js');
const scraper = require(scraperPath);

let failures = 0;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
  if (!pass) failures++;
}

/** Extract a top-level `function name() {...}` from the source (closing brace at column 0).
 * NOTE: scraper.js ke andar PURANA single-user scraper line-commented pada hai —
 * isliye `//`-prefixed matches SKIP karo aur sirf ACTIVE (uncommented) copy uthao. */
function extractFunction(src, name) {
  const sig = `function ${name}() {`;
  let start = -1;
  let idx = src.indexOf(sig);
  while (idx !== -1) {
    const lineStart = src.lastIndexOf('\n', idx) + 1;
    const linePrefix = src.slice(lineStart, idx).trim();
    if (!linePrefix.startsWith('//')) {
      start = idx; // active (uncommented) definition mili
      break;
    }
    idx = src.indexOf(sig, idx + 1);
  }
  if (start === -1) throw new Error(`${name} not found in ${scraperPath}`);
  const end = src.indexOf('\n}', start);
  if (end === -1) throw new Error(`closing brace of ${name} not found`);
  return src.slice(start, end + 2);
}

(async () => {
  // ---- 1. mapAttendanceRow: raw API row -> app shape ----
  const mapped = scraper.mapAttendanceRow({
    Subject: 'Operating Systems',
    SubjectCode: 'CS203',
    SubjectCredit: '4',
    Percentage: '92.5',
    Toper: '98',
    YearSem: '5',
    DateFrom: '01/07/2026',
    DateTo: '10/09/2026',
    TotalLecture: '40',
    TotalPresent: '37',
    TotalAbsent: '3',
    TotalLeave: '0',
  });
  check('map: subject/code', [mapped.subject, mapped.subjectCode], ['Operating Systems', 'CS203']);
  check('map: percentage + exact counts', [mapped.percentage, mapped.totalClasses, mapped.attended], [92.5, 40, 37]);
  check('map: percentageExact recomputed', mapped.percentageExact, 92.5);
  check('map: extra fields', [mapped.topAttendance, mapped.totalAbsent, mapped.yearSem], ['98', 3, '5']);

  const mappedPartial = scraper.mapAttendanceRow({ Subject: 'X', SubjectCode: 'X1', Percentage: '68' });
  check('map: missing counts -> undefined, no percentageExact', [mappedPartial.totalClasses, mappedPartial.percentageExact], [undefined, undefined]);

  // ---- 2. login-page detection ----
  check('login html: login form without RegID', scraper.looksLikeLoginHtml('<html><title>Login</title><input type="password"></html>'), true);
  check('login html: real dashboard passes', scraper.looksLikeLoginHtml('<title>QUMS | Cyborg-ERP</title><script>var RegID = \'8938\'</script>'), false);

  // ---- 3. calculator: exact vs estimated ----
  const { analyzeSubject, analyzeAttendance } = require(path.join(__dirname, '..', 'src', 'calculator.js'));

  const exact68 = analyzeSubject({ subject: 'DS', subjectCode: 'CS201', percentage: 68, totalClasses: 40, attended: 27 });
  check('exact 68%: status + needed', [exact68.status, exact68.classesNeeded, exact68.countSource], ['below-75', 12, 'exact']);
  check('exact 68%: guidance uses real counts', exact68.guidance.includes('27/40 attended'), true);
  check('exact 68%: no "approx" wording', exact68.guidance.includes('approx'), false);

  const exact92 = analyzeSubject({ subject: 'OS', subjectCode: 'CS203', percentage: 92.5, totalClasses: 40, attended: 37 });
  check('exact 92.5%: canSkip', [exact92.status, exact92.canSkip], ['ok', 9]);

  const estimated68 = analyzeSubject({ subject: 'DB', subjectCode: 'DB1', percentage: 68 });
  check('estimated 68%: falls back to 40-class assumption', [estimated68.countSource, estimated68.attendedEstimate], ['estimated', 27]);

  const belowNoZero = analyzeSubject({ subject: 'X', subjectCode: 'X1', percentage: 74, totalClasses: 40, attended: 30 });
  check('edge 74%: never "0 classes needed"', belowNoZero.classesNeeded >= 1, true);

  const analysis = analyzeAttendance([
    { subject: 'DS', subjectCode: 'CS201', percentage: 68, totalClasses: 40, attended: 27 },
    { subject: 'OS', subjectCode: 'CS203', percentage: 92.5, totalClasses: 40, attended: 37 },
  ]);
  check('analysis: summary counts', [analysis.summary.totalSubjects, analysis.summary.below75], [2, 1]);
  check('analysis: weighted overall', [analysis.overall.attended, analysis.overall.total, analysis.overall.percentage], [64, 80, 80]);
  check('analysis: period passthrough', analyzeAttendance([{ subject: 'A', subjectCode: 'A1', percentage: 80, periodSummary: { dateFrom: '01/07/2026', dateTo: '10/09/2026', overallPercentage: 80 } }]).period.dateTo, '10/09/2026');
  const exactPortalAnalysis = analyzeAttendance([{ subject: 'A', subjectCode: 'A1', percentage: 78.46, periodSummary: { dateFrom: '01/07/2026', dateTo: '10/09/2026', overallPercentage: 78.46, overallPercentageRaw: '78.46' } }]);
  check('analysis: exact portal overall percentage used without round-off', [exactPortalAnalysis.overall.percentage, exactPortalAnalysis.overall.percentageRaw], [78.46, '78.46']);

  // ---- 4. timetable DOM parsing (simulated) ----
  const SIMULATED_TIMETABLE = `
    <table id="tt">
      <tr><th>Day</th><th>Period 1</th><th>Period 2</th><th>Period 3</th></tr>
      <tr><td>Monday</td><td>OS(CS203) (L-201), Dr. Sharma</td><td>DS(CS201) (L-202), Prof. Verma</td><td></td></tr>
      <tr><td>Tuesday</td><td>DBMS(CS204) (L-203), Dr. Rao</td><td></td><td>OS(CS203) (L-201), Dr. Sharma</td></tr>
      <tr><td>Wednesday</td><td></td><td>DS(CS201) (L-202), Prof. Verma</td><td>DBMS(CS204) (L-203), Dr. Rao</td></tr>
    </table>`;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent(SIMULATED_TIMETABLE);
  await page.addScriptTag({ content: extractFunction(scraperSrcRef(), 'parseTimetableInPage') });
  const timetable = await page.evaluate(() => parseTimetableInPage());
  await browser.close();

  check('timetable days', timetable && timetable.days.length, 3);
  const monday = timetable.days.find((d) => d.day === 'Monday');
  check('Monday P1 text', monday && monday.periods[0].text, 'OS(CS203) (L-201), Dr. Sharma');

  const tuesday = new Date('2026-09-08T10:00:00'); // a Tuesday
  const todays = scraper.getTodaySubjects(timetable, tuesday);
  check('Tuesday subjects count (empty cells filtered)', todays.length, 2);
  check('Tuesday P1 subject/code', [todays[0].subject, todays[0].subjectCode], ['DBMS', 'CS204']);
  check('Tuesday P3 subject/code', [todays[1].subject, todays[1].subjectCode], ['OS', 'CS203']);

  // ---- 5. watcher: pendingNotifications + message format ----
  const watcher = require(path.join(__dirname, '..', 'src', 'watcher.js'));

  const todayRows = [
    { period: 'P1', duration: '08:55-09:50', subject: 'Robotic Industry 4.0', subjectCode: 'MT3015', employee: 'ANKUR JAIN', attendance: 'N.M.', status: 'unmarked', key: 'P1-MT3015' },
    { period: 'P2', duration: '09:55-10:50', subject: 'DSA', subjectCode: 'CS35303', employee: 'DR. RAO', attendance: 'P', status: 'present', key: 'P2-CS35303' },
    { period: 'P3', duration: '10:55-11:50', subject: 'Cloud', subjectCode: 'CS35304', employee: 'PROF. M', attendance: 'A', status: 'absent', key: 'P3-CS35304' },
  ];

  check('watcher: N.M. ignored, P/A notified', watcher.pendingNotifications(todayRows, []).map((r) => r.key), ['P2-CS35303', 'P3-CS35304']);
  check('watcher: already-notified keys skipped', watcher.pendingNotifications(todayRows, ['P2-CS35303']).map((r) => r.key), ['P3-CS35304']);
  check('watcher: in-batch duplicate keys deduped', watcher.pendingNotifications([todayRows[1], todayRows[1]], []).length, 1);

  const msg = watcher.buildUpdateMessage(todayRows[1]);
  check('watcher: message header + date', msg.startsWith('📌 *Attendance Update* — '), true);
  check('watcher: teacher line', msg.includes('Teacher: DR. RAO'), true);
  check('watcher: subject line', msg.includes('Subject: DSA (CS35303)'), true);
  check('watcher: period line', msg.includes('Period: P2 (09:55-10:50)'), true);
  check('watcher: marked-you-as present', msg.includes('DR. RAO marked you as: ✅ Present'), true);
  check('watcher: marked-you-as absent', watcher.buildUpdateMessage(todayRows[2]).includes('PROF. M marked you as: ❌ Absent'), true);

  // messages module: morning schedule
  const { formatMorningSchedule } = require(path.join(__dirname, '..', 'src', 'messages.js'));
  const sched = formatMorningSchedule([
    { period: 'P2', duration: '09:55-10:50', subject: 'DSA', subjectCode: 'CS35303', employee: 'DR. RAO' },
    { period: 'P3', duration: '10:50-11:45', subject: 'Cloud', subjectCode: 'CS35304', employee: 'PROF. M' },
  ]);
  check('schedule: header', sched.includes("Today's Classes"), true);
  check('schedule: entry 1', sched.includes('1. *P2* (09:55-10:50)') && sched.includes('DSA (CS35303) — DR. RAO'), true);
  check('schedule: empty day', formatMorningSchedule([]).includes('No classes are scheduled today'), true);

  // crypto: AES-256-GCM roundtrip (wrong key -> null)
  const { encryptSecret, decryptSecret } = require(path.join(__dirname, '..', 'src', 'crypto.js'));
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key-for-unit-tests';
  const enc = encryptSecret('my-qums-password-123');
  check('crypto: roundtrip', decryptSecret(enc), 'my-qums-password-123');
  check('crypto: ciphertext differs from plaintext', enc.includes('my-qums-password-123'), false);
  process.env.ENCRYPTION_KEY = 'a-completely-different-key';
  check('crypto: wrong key -> null', decryptSecret(enc), null);
  process.env.ENCRYPTION_KEY = 'test-key-for-unit-tests';

  // status normalization lives in scraper.js — sanity via exported helper
  check('scraper: N.M. -> unmarked', scraper.normalizeAttendanceValue('N.M.'), 'unmarked');
  check('scraper: P -> present', scraper.normalizeAttendanceValue('P'), 'present');
  check('scraper: PRESENT -> present', scraper.normalizeAttendanceValue('PRESENT'), 'present');
  check('scraper: A -> absent', scraper.normalizeAttendanceValue('A'), 'absent');
  check('scraper: ABSENT -> absent', scraper.normalizeAttendanceValue('ABSENT'), 'absent');
  check('scraper: empty -> unmarked', scraper.normalizeAttendanceValue(''), 'unmarked');

  check('watcher: college-hours window', [watcher.isWithinCollegeHours(8.5), watcher.isWithinCollegeHours(12), watcher.isWithinCollegeHours(7.9), watcher.isWithinCollegeHours(17.5)], [true, true, false, false]);

  // ---- Task 1: mergeScheduleWithRoom (pure) ----
  const scraperMod = require(path.join(__dirname, '..', 'src', 'scraper.js'));
  const todaysRows = [
    { period: 'P2', duration: '09:55 - 10:50', subject: 'Robotic Industry 4.0', subjectCode: 'MT3015', employee: 'ANKUR JAIN', attendance: 'P', status: 'present', key: 'P2-MT3015' },
    { period: 'P4', duration: '11:45 - 12:40', subject: 'Cloud Computing', subjectCode: 'CS35304', employee: 'HEMLATA', attendance: 'N.M.', status: 'unmarked', key: 'P4-CS35304' },
  ];
  const ttPeriods = [
    { period: 'P2', duration: '09:55-10:50', subject: 'Robotics', subjectCode: 'MT3015', room: 'L-201', teacher: 'WRONG-SOURCE-TEACHER' },
    { period: 'P4', duration: '11:45-12:40', subject: 'Cloud', subjectCode: 'CS35304', room: 'L-305', teacher: 'HEMLATA' },
    { period: 'P5', duration: '13:35-14:30', subject: 'ML', subjectCode: 'CS35364', room: 'L-401', teacher: 'X' },
  ];
  const merged = scraperMod.mergeScheduleWithRoom(todaysRows, ttPeriods);
  check('merge: row count', merged.length, 2);
  check('merge: teacher Today\'s Attendance se', merged[0].teacher, 'ANKUR JAIN');
  check('merge: room timetable se (subjectCode match)', merged[0].room, 'L-201');
  check('merge: N.M. row ka room bhi merge', merged[1].room, 'L-305');
  check('merge: attendance/status preserved', [merged[0].attendance, merged[0].status], ['P', 'present']);
  const mergedNoMatch = scraperMod.mergeScheduleWithRoom([todaysRows[0]], [{ period: 'P9', subjectCode: 'XX99', room: 'R' }]);
  check('merge: no match -> room null', mergedNoMatch[0].room, null);
  const mergedPeriodFallback = scraperMod.mergeScheduleWithRoom(
    [todaysRows[0]],
    [{ period: 'P2', subjectCode: 'DIFFERENT', room: 'FALLBACK-ROOM' }]
  );
  check('merge: period fallback match', mergedPeriodFallback[0].room, 'FALLBACK-ROOM');

  // ---- Task 2: weekly schedule cache (upsert/fresh/clear) ----
  const dbMod = require(path.join(__dirname, '..', 'src', 'db.js'));
  const TUID = 'unit-test-weekly-user';
  await dbMod.clearWeeklySchedule(TUID); // clean slate
  check('cache: empty -> not fresh', (await dbMod.getWeeklySchedule(TUID, 3)).fresh, false);
  await dbMod.upsertWeeklySchedule(TUID, 3, [
    { period: 'P2', subject: 'DSA', subjectCode: 'CS35303', teacher: 'RAO', room: 'L-202' },
    { period: 'P3', subject: 'Cloud', subjectCode: 'CS35304', teacher: 'MEHRA', room: 'L-204' },
  ]);
  const cached = await dbMod.getWeeklySchedule(TUID, 3);
  check('cache: after upsert -> fresh', cached.fresh, true);
  check('cache: rows shape', [cached.rows[0].period, cached.rows[0].teacher, cached.rows[0].room], ['P2', 'RAO', 'L-202']);
  // upsert same period -> update (no duplicate)
  await dbMod.upsertWeeklySchedule(TUID, 3, [{ period: 'P2', subject: 'DSA', subjectCode: 'CS35303', teacher: 'RAO-2', room: 'L-209' }]);
  check('cache: upsert dedupe by period', (await dbMod.getWeeklySchedule(TUID, 3)).rows.length, 2);
  check('cache: updated teacher', (await dbMod.getWeeklySchedule(TUID, 3)).rows[0].teacher, 'RAO-2');
  // stale simulation: 8 din aage jao -> fresh false
  const realNow = Date.now;
  // eslint-disable-next-line no-global-assign
  Date.now = () => realNow() + 8 * 24 * 60 * 60 * 1000;
  check('cache: 8 din baad stale', (await dbMod.getWeeklySchedule(TUID, 3)).fresh, false);
  // eslint-disable-next-line no-global-assign
  Date.now = realNow;
  await dbMod.clearWeeklySchedule(TUID); // cleanup
  check('cache: clear -> not fresh', (await dbMod.getWeeklySchedule(TUID, 3)).fresh, false);

  // merged rows ka morning-message format (room + teacher dono dikhen)
  const mergedSched = formatMorningSchedule(merged);
  check('morning(merged): room line', mergedSched.includes('Room: L-201'), true);
  check('morning(merged): teacher line', mergedSched.includes('ANKUR JAIN'), true);
  check('morning(merged): duration line', mergedSched.includes('09:55 - 10:50'), true);

  // ---- 6. LIVE timetable layout (jqGrid) + Month Register parsing ----
  // Live QUMS jqGrid: period headers ek ALAG table (ui-jqgrid-htable) me hote
  // hain, aur data rows me pehla cell row-number hota hai (day = 2nd cell).
  const LIVE_JQGRID = `
    <div>
      <table class="ui-jqgrid-htable ui-common-table">
        <tr><th></th><th>Days/Period</th><th>(P1)09:00 - 09:55</th><th>(P2)09:55 - 10:50</th></tr>
      </table>
      <table id="jqgrdTimeTable" class="ui-jqgrid-btable ui-common-table">
        <tr><td></td><td></td><td></td><td></td></tr>
        <tr><td>1</td><td>Monday</td><td>Scala for Data Science - Tools and Techniques(CS35365) (A-010),BHANU PARTAP</td><td></td></tr>
        <tr><td>2</td><td>Tuesday</td><td></td><td>DSA(CS35303) (A-004),RAJ KUMAR</td></tr>
      </table>
    </div>`;
  const browser2 = await chromium.launch({ headless: true });
  const page2 = await browser2.newPage();
  await page2.setContent(LIVE_JQGRID);
  await page2.addScriptTag({ content: extractFunction(scraperSrcRef(), 'parseTimetableInPage') });
  const liveTimetable = await page2.evaluate(() => parseTimetableInPage());
  await browser2.close();

  check('live grid: 2 days parsed (empty jqGrid row skipped)', liveTimetable && liveTimetable.days.length, 2);
  const liveMonday = liveTimetable.days.find((d) => d.day === 'Monday');
  check('live grid: period label from htable', liveMonday && liveMonday.periods[0].period, '(P1)09:00 - 09:55');
  check('live grid: Monday cell text', liveMonday && liveMonday.periods[0].text.includes('CS35365'), true);

  const mondayDate = new Date('2026-09-14T10:00:00'); // a Monday
  const mondayPeriods = scraper.getTimetableForDate(liveTimetable, mondayDate);
  check('live grid: getTimetableForDate count', mondayPeriods.length, 1);
  check('live grid: subject/code/teacher/room',
    [mondayPeriods[0].subjectCode, mondayPeriods[0].teacher, mondayPeriods[0].room],
    ['CS35365', 'BHANU PARTAP', 'A-010']);
  check('live grid: duration from period label', mondayPeriods[0].duration, '09:00 - 09:55');
  const tuesdayPeriods = scraper.getTimetableForDate(liveTimetable, new Date('2026-09-15T10:00:00'));
  check('live grid: Tuesday code+teacher', [tuesdayPeriods[0].subjectCode, tuesdayPeriods[0].teacher], ['CS35303', 'RAJ KUMAR']);
  check('timetable for date string (YYYY-MM-DD)', scraper.getTimetableForDate(liveTimetable, '2026-09-15').length, 1);
  check('timetable for date string (DD/MM/YYYY)', scraper.getTimetableForDate(liveTimetable, '15/09/2026').length, 1);

  check('subject label parse (month register)', scraper.parseSubjectLabel('CS35303 (Design and Analysis of Algorithm (S))'),
    { subjectCode: 'CS35303', subject: 'Design and Analysis of Algorithm' });

  const expanded = scraper.expandMonthRegisterRows(
    [{ Subject: 'CS35365 (Scala for Data Science (L))', 7: 'A', 8: 'P,P', 30: 'N' }],
    { year: 2026, month: 9 }
  );
  check('month register: expand count (N skipped, P,P merged)', expanded.length, 2);
  check('month register: keys (ek alert per subject/day)', expanded.map((r) => r.key),
    ['2026-09-07-CS35365', '2026-09-08-CS35365']);
  check('month register: statuses', expanded.map((r) => r.status), ['absent', 'present']);
  check('month register: lectures breakdown', expanded[1].lectures.map((l) => l.statusRaw).join(','), 'P,P');
  check('month register: empty state -> []', scraper.expandMonthRegisterRows([], { year: 2026, month: 9 }).length, 0);

  check('month: pending diff (1 known skipped)',
    watcher.pendingMonthNotifications(expanded, [{ key: '2026-09-07-CS35365' }]).map((r) => r.key),
    ['2026-09-08-CS35365']);
  check('month: old multi-lecture keys migrate to group key',
    watcher.pendingMonthNotifications(expanded, [{ key: '2026-09-08-CS35365#1' }]).map((r) => r.key),
    ['2026-09-07-CS35365']);
  check('month: unmarked never pending', watcher.pendingMonthNotifications([{ key: 'x', status: 'unmarked' }], []).length, 0);
  check('month: in-batch dup deduped', watcher.pendingMonthNotifications([expanded[0], expanded[0]], []).length, 1);

  const backMsg = watcher.buildBackdatedMessage({ ...expanded[0], teacher: 'BHANU PARTAP' });
  check('month: message header (English spec format)', backMsg.startsWith('📌 *Attendance Update*'), true);
  check('month: real class date line (NOT the notify date)', backMsg.includes('Class Date: 7 September 2026'), true);
  check('month: subject line', backMsg.includes('Subject: Scala for Data Science'), true);
  check('month: absent status emoji', backMsg.includes('Status: ❌ Absent'), true);
  check('month: backdated explanation line', backMsg.includes('QUMS attendance was updated for a previous class.'), true);
  const multiMsg = watcher.buildBackdatedMessage(expanded[1]);
  check('month: multi-lecture status line', multiMsg.includes('Status: L1 ✅ Present | L2 ✅ Present'), true);

  // ---- 7. Telegram module: HTML formatting + deep-link DB roundtrip ----
  const telegram = require(path.join(__dirname, '..', 'src', 'telegram.js'));
  const db = require(path.join(__dirname, '..', 'src', 'db.js'));
  check('tg: html bold+italic+escape', telegram.toTelegramHtml('*Bold* and _Ital_ <ok>'), '<b>Bold</b> and <i>Ital</i> &lt;ok&gt;');
  check('tg: plain text untouched', telegram.toTelegramHtml('📌 Attendance Update'), '📌 Attendance Update');
  check('tg: isConfigured matches token presence', telegram.isConfigured(), Boolean(process.env.TELEGRAM_BOT_TOKEN));

  // deep-link DB roundtrip — throwaway user (test ke baad delete, real data clean)
  const dummy = await db.createUser({ email: 'tg-link-test@local', passwordHash: 'x' });
  const code = await db.telegramLinkCodeFor(dummy.id);
  check('tg: link code generated', typeof code === 'string' && code.length === 12, true);
  const byCode = await db.getUserByTelegramLinkCode(code);
  check('tg: lookup by code', byCode && byCode.id, dummy.id);
  check('tg: unknown code -> null', await db.getUserByTelegramLinkCode('deadbeefdead'), null);
  await db.setTelegramChatId(dummy.id, '555000111');
  const byChat = await db.getUserByTelegramChatId('555000111');
  check('tg: chatId saved + chat lookup', byChat && byChat.id, dummy.id);
  check('tg: deepLink format', telegram.deepLink(code), `https://t.me/${telegram.BOT_USERNAME}?start=${code}`);
  check('tg: code stable (regenerate same)', await db.telegramLinkCodeFor(dummy.id), code);
  await db.deleteUser(dummy.id);
  check('tg: throwaway user removed', await db.getUserByTelegramLinkCode(code), null);
  check('tg: sendMessage without bot/link -> false (no crash)', await telegram.sendMessage('nonexistent-user', 'x'), false);

  // ---- 8b. qums-login-web: HEADLESS captcha relay exports (koi visible window nahi) ----
  const qumsLogin = require(path.join(__dirname, '..', 'src', 'qums-login-web.js'));
  check('qums-login: exports present', ['startQumsLogin', 'submitQumsCaptcha', 'completeQumsSetup', 'hasPendingLogin', 'disposePending'].every((k) => typeof qumsLogin[k] === 'function'), true);
  check('qums-login: start creds-optional signature (userId, credsOverride?, log?)', qumsLogin.startQumsLogin.length >= 1 && qumsLogin.startQumsLogin.length <= 3, true);

  // ---- 8. parseTimetableCell (Part 2) + morning room format ----
  const cellA = scraper.parseTimetableCell('Design and Analysis of Algorithm (CS35303) (A-004),RAJ KUMAR');
  check('cell: normal room', [cellA.subject, cellA.subjectCode, cellA.room, cellA.teacher],
    ['Design and Analysis of Algorithm', 'CS35303', 'A-004', 'RAJ KUMAR']);
  const cellB = scraper.parseTimetableCell('Design and Analysis of Algorithm Lab(CS35363) (E-202)(B),RAJ KUMAR');
  check('cell: double-paren room joined', [cellB.subjectCode, cellB.room], ['CS35363', 'E-202B']);
  const cellC = scraper.parseTimetableCell('R Programming(CS3026/CS30364) (A-102),TEACHER NAME');
  check('cell: slash-code + room', [cellC.subjectCode, cellC.room, cellC.teacher], ['CS3026/CS30364', 'A-102', 'TEACHER NAME']);
  const cellD = scraper.parseTimetableCell('Robotic Industry 4.0(MT3015) (A-010),ANKUR JAIN');
  check('cell: simple', [cellD.subject, cellD.subjectCode, cellD.room, cellD.teacher],
    ['Robotic Industry 4.0', 'MT3015', 'A-010', 'ANKUR JAIN']);
  check('roomForRecord: cross-match', scraper.roomForRecord(liveTimetable, { date: '2026-09-14', subjectCode: 'CS35365' }), 'A-010');
  check('roomForRecord: no match -> empty', scraper.roomForRecord(liveTimetable, { date: '2026-09-14', subjectCode: 'XX99999' }), '');
  check('watcher msg: room line present', watcher.buildUpdateMessage({ ...todayRows[1], room: 'A-004' }).includes('Room: A-004'), true);
  check('watcher msg: no room -> no room line', watcher.buildUpdateMessage(todayRows[1]).includes('Room:'), false);
  check('backdated msg: no room in spec format (room intentionally omitted)', watcher.buildBackdatedMessage({ ...expanded[0], teacher: 'BHANU PARTAP', room: 'A-004' }).includes('Room:'), false);

  // ---- 8c. multi-subject cell + API-first timetable (FillStudentTimeTable) ----
  const friEntries = scraper.parseTimetableCellEntries(
    'E-Commerce(BB3015) (F-204),RAVI KUMAR-Basics of Intellectual Property Rights(BB30306) (F-201),POOJA KOHLI-Customer Relationship Management(BB3002/BB30205) (F-206),FARAH JOHRI-Legal Fundamental for Engineers: Communication Skills(BB30305) (F-210),SONIA VERMA'
  );
  check('multi-cell: 4 entries', friEntries.length, 4);
  check('multi-cell: codes', friEntries.map((e) => e.subjectCode), ['BB3015', 'BB30306', 'BB3002/BB30205', 'BB30305']);
  check('multi-cell: rooms', friEntries.map((e) => e.room), ['F-204', 'F-201', 'F-206', 'F-210']);
  check('multi-cell: teachers', friEntries.map((e) => e.teacher), ['RAVI KUMAR', 'POOJA KOHLI', 'FARAH JOHRI', 'SONIA VERMA']);
  check('multi-cell: hyphen-subject NOT split', scraper.parseTimetableCellEntries('Mini Project - III(CS35378) (A-213),ABHISHEK KUMAR').length, 1);
  check('cell: parseTimetableCell = first entry (compat)', scraper.parseTimetableCell('E-Commerce(BB3015) (F-204),RAVI KUMAR-Basics of Intellectual Property Rights(BB30306) (F-201),POOJA KOHLI').subjectCode, 'BB3015');

  const apiTt = scraper.parseTimetableApiState([
    { 'Days/Period': 'Monday', '(P1)09:00 - 09:55': 'Design and Analysis of Algorithm (CS35303) (A-004),RAJ KUMAR', '(P2)09:55 - 10:50': null },
    { 'Days/Period': 'Thrusday', '(P1)09:00 - 09:55': null, '(P2)09:55 - 10:50': 'Scala for Data Science - Tools and Techniques(CS35365) (A-203),BHANU PARTAP' },
  ]);
  check('api-tt: days (Thrusday typo included)', apiTt.days.map((d) => d.day), ['Monday', 'Thrusday']);
  check('api-tt: monday rooms (null cell filtered)', scraper.getTimetableForDate(apiTt, new Date('2026-09-14')).map((p) => p.room), ['A-004']);
  check('api-tt: thrusday room via weekday match', scraper.getTimetableForDate(apiTt, '17/09/2026')[0].room, 'A-203');

  const ttMorning = formatMorningSchedule([
    { period: '(P1)09:00 - 09:55', duration: '09:00 - 09:55', subject: 'Design and Analysis of Algorithm', subjectCode: 'CS35303', room: 'A-004', teacher: 'RAJ KUMAR', raw: 'x' },
  ]);
  check('morning: timetable room shown', ttMorning.includes('🕐 *09:00 - 09:55* — Design and Analysis of Algorithm (CS35303)') && ttMorning.includes('Room: A-004 • RAJ KUMAR'), true);
  check('morning: room missing -> teacher only', formatMorningSchedule([
    { period: '(P1)09:00 - 09:55', duration: '09:00 - 09:55', subject: 'X', subjectCode: 'XC1', room: '', teacher: 'T1', raw: 'x' },
  ]).includes('    T1'), true);

  // morning schedule: empty duration auto-resolves to class time from period
  const autoDurMorning = formatMorningSchedule([
    { period: 'P1', duration: '', subject: 'Design and Analysis of Algorithm', subjectCode: 'CS35303', room: 'A-004', teacher: 'RAJ KUMAR' },
    { period: 'P2', duration: '', subject: 'Scala for Data Science', subjectCode: 'CS35365', room: 'A-010', teacher: 'BHANU PARTAP' },
  ]);
  check('morning: empty duration auto-resolves P1 time', autoDurMorning.includes('🕐 *09:00 - 09:55* — Design and Analysis of Algorithm'), true);
  check('morning: empty duration auto-resolves P2 time', autoDurMorning.includes('🕐 *09:55 - 10:50* — Scala for Data Science'), true);

  // mergeScheduleWithRoom: pulls duration from timetable when live row has empty duration
  const liveRowsWithoutDur = [
    { period: 'P1', duration: '', subject: 'Robotics', subjectCode: 'MT3015', employee: 'ANKUR', attendance: 'N.M.', status: 'unmarked' },
  ];
  const ttWithDur = [
    { period: '(P1)09:00 - 09:55', duration: '09:00 - 09:55', subjectCode: 'MT3015', room: 'A-101', teacher: 'ANKUR' },
  ];
  const mergedWithDur = scraperMod.mergeScheduleWithRoom(liveRowsWithoutDur, ttWithDur);
  check('merge: duration populated from timetable match', mergedWithDur[0].duration, '09:00 - 09:55');

  // ---- 9b. mailer (forgot-password legacy: Resend -> console) ----
  const mailer = require(path.join(__dirname, '..', 'src', 'mailer.js'));
  {
    // env save/restore — baaki tests ka env na bigde
    const saved = {};
    for (const k of ['RESEND_API_KEY', 'RESEND_FROM']) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    try {
      check('mailer: console mode jab kuch configured nahi', mailer.mailerProvider(), 'console');

      process.env.RESEND_API_KEY = 're_test_key_123';
      check('mailer: resend provider RESEND_API_KEY pe priority leta hai', mailer.mailerProvider(), 'resend');

      const content = mailer.buildResetEmail('https://app.example/reset?token=abc123');
      check('mailer: subject me password reset', content.subject.includes('password reset'), true);
      check('mailer: link text me', content.text.includes('/reset?token=abc123'), true);
      check('mailer: link html (anchor + raw) me', content.html.includes('href="https://app.example/reset?token=abc123"'), true);
      check('mailer: 1-hour validity bataya', content.text.includes('1 hour valid'), true);

      // sendMail -> Resend (fake SDK client inject kiya — koi network nahi)
      let captured = { created: 0 };
      class FakeResend {
        constructor(apiKey) {
          captured.key = apiKey;
          captured.created += 1;
        }
        // eslint-disable-next-line class-methods-use-this
        get emails() {
          return {
            send: async (p) => {
              captured.payload = p;
              return { data: { id: 'em_123' }, error: null };
            },
          };
        }
      }
      const sent = await mailer.sendMail({ to: 'student@example.com', ...content }, { ResendImpl: FakeResend, from: 'Test <test@x.dev>' });
      check('mailer: resend send ok', [sent.ok, sent.via], [true, 'resend']);
      check('mailer: API key SDK ko di (server log me kabhi nahi)', captured.key, 're_test_key_123');
      check('mailer: from override respected', captured.payload.from, 'Test <test@x.dev>');
      check('mailer: to/subject/text/html payload me', [captured.payload.to, captured.payload.subject === content.subject], ['student@example.com', true]);

      // SDK-style API error ({ data: null, error }) -> ok:false, no throw
      class FailingResend {
        // eslint-disable-next-line class-methods-use-this
        get emails() {
          return { send: async () => ({ data: null, error: { message: 'domain not verified' } }) };
        }
      }
      const failed = await mailer.sendMail({ to: 'student@example.com', ...content }, { ResendImpl: FailingResend });
      check('mailer: resend API error -> ok:false + via:resend', [failed.ok, failed.via, failed.error], [false, 'resend', 'domain not verified']);
    } finally {
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  }

  // ---- 9. scheduler cron (8:30 AM morning schedule; daily 9 PM summary removed) ----
  const { MORNING_CRON, TIMEZONE: SCHED_TZ } = require(path.join(__dirname, '..', 'src', 'scheduler.js'));
  check('scheduler: morning cron = 8:30 AM IST', [MORNING_CRON, SCHED_TZ], ['30 8 * * *', 'Asia/Kolkata']);
  check('scheduler: 9 PM summary cron removed', 'SUMMARY_CRON' in require(path.join(__dirname, '..', 'src', 'scheduler.js')), false);

  // ---- 10. assignment deadline reminder cron (7:00 PM IST, Part 7) ----
  const assignmentsMod = require(path.join(__dirname, '..', 'src', 'assignments.js'));
  check('assignments: reminder cron = 7:00 PM IST', [assignmentsMod.REMINDER_CRON, assignmentsMod.TIMEZONE], ['0 19 * * *', 'Asia/Kolkata']);

  // ---- 11. QUMS date parsing (Part 5 — real portal date shapes) ----
  check('qums date: YYYY-MM-DD', scraper.qumsDateToYMD('2026-09-25 00:00:00'), '2026-09-25');
  check('qums date: DD/MM/YYYY', scraper.qumsDateToYMD('25/09/2026'), '2026-09-25');
  check('qums date: DD-MM-YYYY', scraper.qumsDateToYMD('25-09-2026'), '2026-09-25');
  check('qums date: DD MMM YYYY', scraper.qumsDateToYMD('25 Sep 2026'), '2026-09-25');
  check('qums date: garbage -> null (never guess)', scraper.qumsDateToYMD('n/a'), null);
  check('qums date: empty -> null', scraper.qumsDateToYMD(''), null);

  // ---- 12. assignment row normalization (Part 5 — real QUMS fields) ----
  const rawAssign = {
    AssignmentDetailID: 42400,
    ASSIGNMENT: 'OOP Assignment',
    ASSIGNMENTSUBJECT: 'OOP Assignment',
    CLASSSUBJECT: 'Java',
    EMPLOYEENAME: 'DEEPAK BHATT',
    Assignmenttype: 'Assignment',
    DATEFROM: '22/09/2026',
    DATETO: '25/09/2026',
    AssignmentExt: '.pdf',
    UploadFlag: 1,
  };
  const na = scraper.normalizeAssignmentRow(rawAssign, 'state');
  check('assignment: id from AssignmentDetailID', na.id, '42400');
  check('assignment: title', na.title, 'OOP Assignment');
  check('assignment: subject from CLASSSUBJECT', na.subject, 'Java');
  check('assignment: teacher from EMPLOYEENAME', na.teacher, 'DEEPAK BHATT');
  check('assignment: deadline from DATETO', na.deadlineYMD, '2026-09-25');
  check('assignment: assigned date from DATEFROM', na.assignedYMD, '2026-09-22');

  // no unique id -> stable fingerprint from real fields (Part 6)
  const noId = scraper.normalizeAssignmentRow({ ...rawAssign, AssignmentDetailID: '', AssignID: '' }, 'state');
  const fp1 = assignmentsMod.assignmentFingerprint(noId);
  const fp2 = assignmentsMod.assignmentFingerprint(scraper.normalizeAssignmentRow({ ...rawAssign, AssignmentDetailID: '', AssignID: '' }, 'state'));
  check('assignment: fingerprint stable across fetches', fp1, fp2);
  check('assignment: fingerprint is non-empty', fp1.length > 0, true);
  check('assignment: key uses QUMS id when present', assignmentsMod.assignmentKey(na), 'new:42400');

  // ---- 13. new-assignment detection + dedupe (Parts 5/6) ----
  const knownA = ['new:42400'];
  check('assignments: first sighting pending', assignmentsMod.pendingNewAssignments([na], []).length, 1);
  check('assignments: duplicate suppressed (same id)', assignmentsMod.pendingNewAssignments([na], knownA).length, 0);
  check('assignments: no title never notified', assignmentsMod.pendingNewAssignments([{ id: 'x', title: '' }], []).length, 0);
  check('assignments: study material w/o deadline skipped', assignmentsMod.pendingNewAssignments([{ id: 'x', title: 'Notes', type: 'Study Material' }], []).length, 0);
  check('assignments: in-batch dup deduped', assignmentsMod.pendingNewAssignments([na, na], []).length, 1);

  // ---- 14. deadline reminder logic (Part 7) ----
  check('reminders: deadline today -> 1', assignmentsMod.pendingDeadlineReminders([na], [], '2026-09-25').length, 1);
  check('reminders: deadline NOT today -> 0', assignmentsMod.pendingDeadlineReminders([na], [], '2026-09-24').length, 0);
  check('reminders: earlier day never reminds', assignmentsMod.pendingDeadlineReminders([na], [], '2026-09-20').length, 0);
  check('reminders: already reminded -> 0', assignmentsMod.pendingDeadlineReminders([na], [assignmentsMod.reminderKey(na, '2026-09-25')], '2026-09-25').length, 0);
  check('reminders: no deadline -> never reminds', assignmentsMod.pendingDeadlineReminders([{ id: 'y', title: 'T', type: 'Assignment' }], [], '2026-09-25').length, 0);
  check('reminders: one reminder per assignment per date (in-batch)', assignmentsMod.pendingDeadlineReminders([na, na], [], '2026-09-25').length, 1);

  // ---- 15. new-assignment + reminder Telegram texts (spec format) ----
  const newMsg = require(path.join(__dirname, '..', 'src', 'messages.js')).formatNewAssignment(na);
  check('assignment msg: header', newMsg.startsWith('📚 *New Assignment*'), true);
  check('assignment msg: subject/assignment', newMsg.includes('Subject: Java') && newMsg.includes('Assignment: OOP Assignment'), true);
  check('assignment msg: last date full format', newMsg.includes('Last Date: 25 September 2026'), true);
  check('assignment msg: labeled QUMS link', newMsg.includes('🔗 Open QUMS: https://qums.quantumuniversity.edu.in/'), true);
  const remMsg = require(path.join(__dirname, '..', 'src', 'messages.js')).formatAssignmentDeadlineReminder(na);
  check('reminder msg: header', remMsg.startsWith('⚠️ *Assignment Deadline Reminder*'), true);
  check('reminder msg: deadline-day wording', remMsg.includes('Today is the last date to submit this assignment.'), true);

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('TEST RUNNER ERROR:', err.message);
  process.exit(1);
});

function scraperSrcRef() {
  return require('fs').readFileSync(scraperPath, 'utf8');
}
