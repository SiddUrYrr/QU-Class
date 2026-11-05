/**
 * Regression & Acceptance Test Suite:
 * Timetable Accuracy, UI Handling & Telegram Reconnect Deduplication
 * test/timetableAndReconnectDedupe.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qattend-tt-dedupe-'));
process.env.DB_FILE = path.join(TMP, 'db.json');
process.env.DATABASE_URL = '';
process.env.SESSION_ALERT_STATE_FILE = path.join(TMP, 'session_alerts.json');
process.env.APP_BASE_URL = 'https://qattend.example.com/';
process.env.PORT = '10000';

// ---- Telegram Stub ----
const telegramSends = [];
let nextMessageId = 5001;

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === './telegram' || id === 'telegram') {
    return {
      isConfigured: () => true,
      sendMessage: async (userId, text, log, opts) => {
        const msgId = nextMessageId++;
        telegramSends.push({ userId, text, opts: opts || {}, messageId: msgId });
        return true;
      },
      deleteMessage: async () => true,
      deleteMessageFromChat: async () => true,
      sendBlockerReason: async () => null,
    };
  }
  return origRequire.apply(this, arguments);
};

const db = require('../src/db');
const scraper = require('../src/scraper');
const watcher = require('../src/watcher');
const catchup = require('../src/catchup');

let passedTests = 0;
function pass(desc) {
  passedTests++;
  console.log(`  ✓ PASS: ${desc}`);
}

async function runTests() {
  console.log('\n=== RUNNING TIMETABLE ACCURACY & RECONNECT DEDUPLICATION SUITE ===\n');

  await db.init();

  // --------------------------------------------------------------------------
  // TEST GROUP 1: Timetable Data Parsing & Accuracy
  // --------------------------------------------------------------------------
  console.log('--- Group 1: Timetable Parsing, Weekday Mapping & Chronological Sorting ---');

  // 1.1 Multi-subject cell with commas in subject title
  const complexCell = 'Legal Fundamental for Engineers: Contracts, Taxation and Beyond(LW30201) (F-204),Dr. Jane-Distributed Systems(BB30306) (B-301),Prof. John';
  const parsedEntries = scraper.parseTimetableCellEntries(complexCell);
  assert.strictEqual(parsedEntries.length, 2, 'Should split into exactly 2 courses');
  assert.strictEqual(parsedEntries[0].subject, 'Legal Fundamental for Engineers: Contracts, Taxation and Beyond');
  assert.strictEqual(parsedEntries[0].subjectCode, 'LW30201');
  assert.strictEqual(parsedEntries[0].teacher, 'Dr. Jane');
  assert.strictEqual(parsedEntries[0].room, 'F-204');
  assert.strictEqual(parsedEntries[1].subject, 'Distributed Systems');
  assert.strictEqual(parsedEntries[1].subjectCode, 'BB30306');
  assert.strictEqual(parsedEntries[1].teacher, 'Prof. John');
  assert.strictEqual(parsedEntries[1].room, 'B-301');
  pass('parseTimetableCellEntries correctly preserves commas inside course titles without breaking multi-subject splitting');

  // 1.2 Portal typo weekday normalization ("Thrusday" -> "Thursday")
  const rawTimetableWithTypo = {
    days: [
      {
        day: 'Thrusday',
        periods: [
          {
            period: '(P2)10:00 - 10:55',
            subject: 'Computer Networks',
            subjectCode: 'CS30202',
            room: 'B-101',
            teacher: 'Dr. Alice',
          },
          {
            period: '(P1)09:00 - 09:55',
            subject: 'Web Technologies',
            subjectCode: 'CS30201',
            room: 'B-201',
            teacher: 'Prof. Bob',
          },
        ],
      },
    ],
  };

  const normalized = scraper.formatNormalizedTimetable(rawTimetableWithTypo);
  assert(normalized && normalized.days && normalized.days.length === 6);
  const thuDay = normalized.days.find((d) => d.day === 'Thursday');
  assert(thuDay, 'Should normalize "Thrusday" to "Thursday" and find it');
  assert.strictEqual(thuDay.periods.length, 2);
  // Must be sorted chronologically: P1 (09:00) before P2 (10:00)
  assert.strictEqual(thuDay.periods[0].period, 'P1');
  assert.strictEqual(thuDay.periods[0].rawPeriod, '(P1)09:00 - 09:55');
  assert.strictEqual(thuDay.periods[0].subjectCode, 'CS30201');
  assert.strictEqual(thuDay.periods[0].startTime, '09:00');
  assert.strictEqual(thuDay.periods[0].endTime, '09:55');
  assert.strictEqual(thuDay.periods[1].period, 'P2');
  assert.strictEqual(thuDay.periods[1].rawPeriod, '(P2)10:00 - 10:55');
  assert.strictEqual(thuDay.periods[1].subjectCode, 'CS30202');
  pass('formatNormalizedTimetable fixes "Thrusday" typo and sorts periods chronologically');

  // 1.3 Period time extraction helper
  const parsedTime1 = scraper.parsePeriodTimeInfo('(P3)11:15 - 12:10');
  assert.strictEqual(parsedTime1.periodNumber, 3);
  assert.strictEqual(parsedTime1.startTime, '11:15');
  assert.strictEqual(parsedTime1.endTime, '12:10');
  assert.strictEqual(parsedTime1.duration, '11:15 - 12:10');
  assert.strictEqual(parsedTime1.startTimeMinutes, 11 * 60 + 15);

  const parsedTime12h = scraper.parsePeriodTimeInfo('02:30 PM - 03:25 PM');
  assert.strictEqual(parsedTime12h.startTime, '14:30');
  assert.strictEqual(parsedTime12h.endTime, '15:25');
  assert.strictEqual(parsedTime12h.startTimeMinutes, 14 * 60 + 30);
  pass('parsePeriodTimeInfo handles both 24-hour and 12-hour period headers accurately');

  // 1.4 getTimetableForDate with IST timezone and enrichment
  const fullWeeklyTimetable = {
    days: [
      {
        day: 'Monday',
        periods: [
          { period: '(P1)09:00 - 09:55', subject: 'Operating Systems', subjectCode: 'CS30203', room: 'C-101', teacher: 'Dr. Roy' },
        ],
      },
    ],
  };
  // Monday in UTC might be Sunday/Tuesday depending on offset; testing with date known to be Monday in IST
  const testMondayDate = new Date('2026-10-12T05:00:00Z'); // 10:30 AM IST on Monday Oct 12, 2026
  const monPeriods = scraper.getTimetableForDate(fullWeeklyTimetable, testMondayDate);
  assert.strictEqual(monPeriods.length, 1);
  assert.strictEqual(monPeriods[0].subjectCode, 'CS30203');
  assert.strictEqual(monPeriods[0].room, 'C-101');
  assert.strictEqual(monPeriods[0].startTime, '09:00');
  pass('getTimetableForDate resolves day in Asia/Kolkata timezone and attaches room/time metadata');

  // 1.5 mergeScheduleWithRoom merges todaysRows with timetable
  const todaysRows = [
    { period: 'P1', subject: 'Operating Systems', subjectCode: 'CS30203', attendance: 'Present', status: 'present', key: 'P1-CS30203' },
  ];
  const merged = scraper.mergeScheduleWithRoom(todaysRows, monPeriods);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].room, 'C-101');
  assert.strictEqual(merged[0].teacher, 'Dr. Roy');
  pass('mergeScheduleWithRoom enriches today\'s attendance rows with room and teacher');

  // 1.6 combineTimetableWithLiveAttendance: preserves all scheduled periods even when live attendance only has 1 marked row
  const tuesdayTtPeriods = [
    { period: 'P1', duration: '09:00 - 09:55', subject: 'Design and Analysis of Algorithm', subjectCode: 'CS35303', room: 'A-004', teacher: 'RAJ KUMAR' },
    { period: 'P2', duration: '09:55 - 10:50', subject: 'Tools for Data Science', subjectCode: 'CS35305', room: 'A-102', teacher: 'BHANU PARTAP' },
    { period: 'P3', duration: '10:50 - 11:45', subject: 'Design and Analysis of Algorithm Lab', subjectCode: 'CS35363', room: 'E-202A', teacher: 'RAJ KUMAR' },
    { period: 'P6', duration: '13:35 - 14:30', subject: 'Corporate Communication', subjectCode: 'AE35362', room: 'A-213', teacher: 'RYANSHU SAINI' },
    { period: 'P7', duration: '14:30 - 15:25', subject: 'Technical Skills Development-IV', subjectCode: 'SE35309', room: 'E-203', teacher: 'GURNAM SINGH' },
    { period: 'P8', duration: '15:25 - 16:20', subject: 'Technical Skills Development-IV', subjectCode: 'SE35309', room: 'E-203', teacher: 'GURNAM SINGH' },
  ];
  const liveMorningRows = [
    { period: 'P1', duration: '09:00 - 09:55', subject: 'Design and Analysis of Algorithm', subjectCode: 'CS35303', employee: 'RAJ KUMAR', attendance: 'P', status: 'present', key: 'P1-CS35303' },
  ];
  const combined = scraper.combineTimetableWithLiveAttendance(tuesdayTtPeriods, liveMorningRows);
  assert.strictEqual(combined.length, 6, 'Must preserve all 6 classes scheduled for the day');
  assert.strictEqual(combined[0].status, 'present', 'Period 1 marked as present');
  assert.strictEqual(combined[1].status, 'unmarked', 'Period 2 unmarked');
  assert.strictEqual(combined[4].period, 'P7', 'Period 7 correctly preserved');
  assert.strictEqual(combined[5].period, 'P8', 'Period 8 correctly preserved with same subject code');
  assert.strictEqual(combined[4].room, 'E-203');
  assert.strictEqual(combined[5].room, 'E-203');

  const { formatMorningSchedule, formatTodayAttendanceStatus } = require('../src/messages');
  const morningText = formatMorningSchedule(combined, 'Tue, 13 Oct 2026', 'Karan');
  assert(morningText.includes("🌅 *Today's Classes*"), 'Contains morning header');
  assert(morningText.includes('Room: A-004 • RAJ KUMAR'), 'Contains room and faculty');
  assert(morningText.includes('1. 🕐 *09:00 - 09:55* — Design and Analysis of Algorithm (CS35303)'), 'Period 1 formatted cleanly');
  assert(morningText.includes('6. 🕐 *15:25 - 16:20* — Technical Skills Development-IV (SE35309)'), 'Period 8 formatted cleanly');

  const todayStatusText = formatTodayAttendanceStatus(combined, 'Tue, 13 Oct 2026', 'Karan');
  assert(todayStatusText.includes('✅ *Present*'), 'Shows marked present');
  assert(todayStatusText.includes('⏳ *Not Marked Yet*'), 'Shows remaining unmarked');
  assert(!todayStatusText.includes('(Period (P1)'), 'No ugly duplicated period strings');
  pass('combineTimetableWithLiveAttendance retains all 6 classes and formats beautifully for Telegram');

  // 1.7 Today's Attendance priority: when QUMS GetTodayAttendance has classes,
  // do NOT inject un-scheduled/phantom classes (e.g. P3 Lab) from the weekly timetable
  const actualTodayQumsRows = [
    { period: 'P1', duration: '09:00 - 09:55', subject: 'Design and Analysis of Algorithm', subjectCode: 'CS35303', employee: 'RAJ KUMAR', attendance: 'P', status: 'present', key: 'P1-CS35303' },
    { period: 'P2', duration: '09:55 - 10:50', subject: 'Scala for Data Science - Tools and Techniques', subjectCode: 'CS35305', employee: 'BHANU PARTAP', attendance: 'P', status: 'present', key: 'P2-CS35305' },
    { period: 'P6', duration: '13:35 - 14:30', subject: 'Corporate Communication', subjectCode: 'AE35362', employee: 'RYANSHU SAINI', attendance: 'N.M.', status: 'unmarked', key: 'P6-AE35362' },
    { period: 'P7', duration: '14:30 - 15:25', subject: 'Technical Skills Development-IV', subjectCode: 'SE35309', employee: 'GURNAM SINGH', attendance: 'N.M.', status: 'unmarked', key: 'P7-SE35309' },
    { period: 'P8', duration: '15:25 - 16:20', subject: 'Technical Skills Development-IV', subjectCode: 'SE35309', employee: 'GURNAM SINGH', attendance: 'N.M.', status: 'unmarked', key: 'P8-SE35309' },
  ];
  const mergedActual = scraper.mergeScheduleWithRoom(actualTodayQumsRows, tuesdayTtPeriods);
  assert.strictEqual(mergedActual.length, 5, 'Must have exactly 5 classes (no phantom P3 lab)');
  assert(!mergedActual.some((r) => r.period === 'P3' || r.subjectCode === 'CS35363'), 'P3 Lab must NOT be present in today classes');
  assert.strictEqual(mergedActual[0].room, 'A-004');
  assert.strictEqual(mergedActual[1].room, 'A-102');
  pass('mergeScheduleWithRoom preserves actual today QUMS rows without injecting phantom lab classes');


  // --------------------------------------------------------------------------
  // TEST GROUP 2: Reconnect Attendance Deduplication & Isolation
  // --------------------------------------------------------------------------
  console.log('\n--- Group 2: Reconnect Deduplication, Idempotency & Multi-user Isolation ---');

  // Create isolated users
  const user1 = await db.createUser({ email: 'student1@example.com' });
  await db.updateUser(user1.id, {
    qumsQid: 'QID1001',
    telegramChatId: 'chat_user_1',
    monitoringStartedDate: '2026-10-01',
  });
  const user2 = await db.createUser({ email: 'student2@example.com' });
  await db.updateUser(user2.id, {
    qumsQid: 'QID1002',
    telegramChatId: 'chat_user_2',
    monitoringStartedDate: '2026-10-01',
  });

  const todayStr = db.getIstDateString(new Date());

  // 2.1 Fast loop marks today's class and sends notification
  telegramSends.length = 0;
  const stateFileUser1 = path.join(TMP, 'state_user1.json');

  const fastRowsToday = [
    {
      period: 'P1',
      subject: 'Data Structures',
      subjectCode: 'CS201',
      status: 'present',
      key: 'P1-CS201',
      room: 'A-101',
    },
  ];

  const watcherRes1 = await watcher.runWatcherCycle({
    userId: user1.id,
    userEmail: user1.email,
    force: true,
    stateFile: stateFileUser1,
    fetchFn: async () => fastRowsToday,
  });

  assert.strictEqual(watcherRes1.notified.length, 1, 'Fast loop should notify new marked class');
  assert.strictEqual(telegramSends.length, 1, 'Telegram message sent once');
  assert.strictEqual(telegramSends[0].userId, user1.id);
  pass('Fast loop notified today\'s class and recorded notification');

  // Verify that database snapshots were updated
  const user1Known = await db.listKnownAttendance(user1.id);
  const user1KnownToday = user1Known.find((r) => r.subjectCode === 'CS201');
  assert(user1KnownToday, 'Fast loop must persist marked class to known_attendance in PostgreSQL');
  assert.strictEqual(user1KnownToday.status, 'present');
  pass('Fast loop persisted state to PostgreSQL known_attendance');

  // 2.2 Reconnect catchup runs: MUST NOT send duplicate notification for today's class
  telegramSends.length = 0;
  const catchupRes1 = await catchup.runReconnectCatchup(user1.id, {
    monthFetcher: async () => [
      {
        key: `${todayStr}-CS201`,
        date: todayStr,
        subjectCode: 'CS201',
        subject: 'Data Structures',
        status: 'present',
        statusRaw: 'P',
      },
    ],
  });

  assert.strictEqual(catchupRes1.attendanceAlertsSent, 0, 'Catchup after reconnect must NOT re-notify today\'s already-notified attendance');
  const attSends1 = telegramSends.filter((s) => s.opts && s.opts.category === 'ATTENDANCE');
  assert.strictEqual(attSends1.length, 0, 'Zero Telegram attendance messages sent during reconnect for already-notified class');
  pass('Reconnect catchup correctly suppresses already-notified attendance via persistent idempotency');

  // 2.3 Reprocessing the fast loop cycle again: MUST NOT send duplicate notification
  telegramSends.length = 0;
  const watcherResRepeat = await watcher.runWatcherCycle({
    userId: user1.id,
    userEmail: user1.email,
    force: true,
    stateFile: stateFileUser1,
    fetchFn: async () => fastRowsToday,
  });
  assert.strictEqual(watcherResRepeat.notified.length, 0, 'Reprocessing fast loop must send 0 notifications');
  const attSendsRepeat = telegramSends.filter((s) => s.opts && s.opts.category === 'ATTENDANCE');
  assert.strictEqual(attSendsRepeat.length, 0, 'Zero duplicate notifications on repeat fast loop pass');
  pass('Repeat watcher cycle is fully deduplicated');

  // 2.4 Genuinely new eligible attendance transition after reconnect: MUST notify once
  telegramSends.length = 0;
  const freshRowsWithNewClass = [
    {
      key: `${todayStr}-CS201`,
      date: todayStr,
      subjectCode: 'CS201',
      subject: 'Data Structures',
      status: 'present',
      statusRaw: 'P',
    },
    {
      key: `${todayStr}-CS202`,
      date: todayStr,
      subjectCode: 'CS202',
      subject: 'Algorithms',
      status: 'present',
      statusRaw: 'P',
    },
  ];

  const catchupResNew = await catchup.runReconnectCatchup(user1.id, {
    monthFetcher: async () => freshRowsWithNewClass,
  });

  assert.strictEqual(catchupResNew.attendanceAlertsSent, 1, 'Newly marked class (CS202) must generate exactly 1 alert');
  const attSendsNew = telegramSends.filter((s) => s.opts && s.opts.category === 'ATTENDANCE');
  assert.strictEqual(attSendsNew.length, 1, 'Exactly 1 Telegram message sent for genuinely new class');
  assert(attSendsNew[0].text.includes('CS202') || attSendsNew[0].text.includes('Algorithms'));
  pass('Genuinely new eligible attendance after reconnect notifies exactly once');

  // 2.5 Backdated attendance before monitoringStartedDate: NEVER sends notification
  telegramSends.length = 0;
  const oldPreMonitoringClass = [
    ...freshRowsWithNewClass,
    {
      key: '2026-09-15-HIST101',
      date: '2026-09-15', // Older than monitoringStartedDate ('2026-10-01')
      subjectCode: 'HIST101',
      subject: 'History',
      status: 'present',
      statusRaw: 'P',
    },
  ];

  const catchupResOld = await catchup.runReconnectCatchup(user1.id, {
    monthFetcher: async () => oldPreMonitoringClass,
  });

  assert.strictEqual(catchupResOld.attendanceAlertsSent, 0, 'Classes before monitoringStartedDate must NEVER notify');
  const attSendsOld = telegramSends.filter((s) => s.opts && s.opts.category === 'ATTENDANCE');
  assert.strictEqual(attSendsOld.length, 0, 'Zero notifications for classes before monitoringStartedDate');
  pass('Pre-monitoring start date classes are strictly suppressed from notifications');

  // 2.6 Multi-user isolation: User 2 has the same subject marked; User 1's deduplication must NOT suppress User 2
  telegramSends.length = 0;
  const user2Rows = [
    {
      key: `${todayStr}-CS201`,
      date: todayStr,
      subjectCode: 'CS201',
      subject: 'Data Structures',
      status: 'present',
      statusRaw: 'P',
    },
  ];

  const catchupResUser2 = await catchup.runReconnectCatchup(user2.id, {
    monthFetcher: async () => user2Rows,
  });

  assert.strictEqual(catchupResUser2.attendanceAlertsSent, 1, 'User 2 must receive notification for their class');
  const attSendsUser2 = telegramSends.filter((s) => s.opts && s.opts.category === 'ATTENDANCE');
  assert.strictEqual(attSendsUser2.length, 1, 'User 2 receives exactly 1 notification');
  assert.strictEqual(attSendsUser2[0].userId, user2.id, 'Notification strictly routed to User 2');
  pass('Multi-user isolation: deduplication in User 1 never blocks User 2');

  console.log(`\n===============================================================`);
  console.log(`RESULTS: ${passedTests} passed, 0 failed.`);
  console.log(`===============================================================\n`);
}

runTests().catch((err) => {
  console.error('\n❌ Test failure:', err);
  process.exit(1);
});
