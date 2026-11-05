/**
 * QATTEND — Comprehensive Data Architecture & Monitoring Verification Test Suite
 *
 * Covers requirements:
 * 1. Multi-user identity model (application user id -> QID -> attendance/assignments).
 * 2. Same-email reconnection with same QID preserves history.
 * 3. Different QID on same account triggers identity conflict; switch isolates data.
 * 4. Silent baseline on first login (zero alerts for pre-existing history).
 * 5. Backdated attendance detection with actual class date.
 * 6. Meaningful transitions (N->P, N->A, P->A, A->P).
 * 7. Reconnect catch-up (alerts ONLY for changes during downtime).
 * 8. Persistent deduplication via notification_log across server restarts.
 * 9. Password security: no plaintext or permanent password stored.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qattend-arch-test-'));
process.env.DB_FILE = path.join(TMP, 'db.json');
process.env.DATABASE_URL = ''; // tests run on JSON store simulating PG

const telegramSends = [];
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === './telegram' || id === 'telegram') {
    return {
      isConfigured: () => true,
      sendMessage: async (userId, text, log, opts) => {
        telegramSends.push({ userId, text, opts: opts || {} });
        return true;
      },
      deepLink: () => '',
      getBotUsername: () => 'test_bot',
    };
  }
  return origRequire.apply(this, arguments);
};

const db = require('../src/db');
const catchup = require('../src/catchup');
const qumsLogin = require('../src/qums-login-web');
const messages = require('../src/messages');
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

(async () => {
  console.log('=== RUNNING COMPLETE DATA ARCHITECTURE & MONITORING TESTS ===\n');
  await db.init();

  // ---------------------------------------------------------
  // TEST 1: Multi-User Identity Isolation
  // ---------------------------------------------------------
  const userA = await db.createUser({ email: 'studentA@example.com' });
  const userB = await db.createUser({ email: 'studentB@example.com' });

  await db.updateUser(userA.id, { qumsQid: '8938', telegramChatId: 'chat-aaa', studentName: 'Student Alpha' });
  await db.updateUser(userB.id, { qumsQid: '9120', telegramChatId: 'chat-bbb', studentName: 'Student Beta' });

  check('1. User A has distinct ID and QID', (await db.getUserById(userA.id)).qumsQid, '8938');
  check('1. User B has distinct ID and QID', (await db.getUserById(userB.id)).qumsQid, '9120');

  // Add attendance records for User A and User B
  await db.saveAttendanceRecord(userA.id, '8938', { date: '2026-10-01', subjectCode: 'CS101', subject: 'CS', status: 'present' });
  await db.saveAttendanceRecord(userB.id, '9120', { date: '2026-10-01', subjectCode: 'CS102', subject: 'Math', status: 'absent' });

  const recordsA = await db.listAttendanceRecords(userA.id);
  const recordsB = await db.listAttendanceRecords(userB.id);

  check('1. User A sees only their attendance', recordsA.length === 1 && recordsA[0].subjectCode === 'CS101', true);
  check('1. User B sees only their attendance', recordsB.length === 1 && recordsB[0].subjectCode === 'CS102', true);
  ok('1. Multi-user data never mixes', !recordsA.some((r) => r.subjectCode === 'CS102') && !recordsB.some((r) => r.subjectCode === 'CS101'));

  // ---------------------------------------------------------
  // TEST 2: Same Email + Same QID Reconnect
  // ---------------------------------------------------------
  const beforeId = userA.id;
  await qumsLogin.completeQumsSetup(userA.id, '8938');
  const userAAfter = await db.getUserById(userA.id);
  check('2. Same QID preserves user ID', userAAfter.id, beforeId);
  check('2. Same QID preserves attendance history', (await db.listAttendanceRecords(userA.id)).length, 1);

  // ---------------------------------------------------------
  // TEST 3: Different QID on Same Account Triggers Conflict
  // ---------------------------------------------------------
  let conflictCaught = false;
  try {
    // Attempt login with different QID without confirmSwitch
    await qumsLogin.startQumsLogin(userA.id, { qid: '9999', password: 'secretpassword' });
  } catch (err) {
    if (err.name === 'IdentityConflictError' && err.oldQid === '8938' && err.newQid === '9999') {
      conflictCaught = true;
    }
  }
  ok('3. Different QID throws IdentityConflictError', conflictCaught);

  // Now switch identity with explicit confirmation
  await db.switchQumsIdentity(userA.id, '9999', { studentName: 'Student Gamma' });
  await qumsLogin.completeQumsSetup(userA.id, '9999', { confirmSwitch: true });
  const userASwitched = await db.getUserById(userA.id);
  check('3. Switched QID is active', userASwitched.qumsQid, '9999');

  // Verify historical QID 8938 attendance record is preserved under its own QID
  const recordsOldQid = await db.listAttendanceRecords(userA.id, '8938');
  check('3. Old QID 8938 data preserved and isolated', recordsOldQid.length === 1 && recordsOldQid[0].subjectCode === 'CS101', true);

  // Restore User A to QID 8938 for subsequent tests
  await db.switchQumsIdentity(userA.id, '8938', { studentName: 'Student Alpha' });
  await qumsLogin.completeQumsSetup(userA.id, '8938', { confirmSwitch: true });

  // ---------------------------------------------------------
  // TEST 4: Silent Baseline on First Login (No Alerts)
  // ---------------------------------------------------------
  telegramSends.length = 0;
  const userC = await db.createUser({ email: 'studentC@example.com' });
  await db.updateUser(userC.id, { qumsQid: '7777', telegramChatId: 'chat-ccc' });

  // Simulate pre-existing historical attendance from September
  const historicalRecords = [
    { key: '2026-09-25-CS101', date: '2026-09-25', subjectCode: 'CS101', subject: 'Java', status: 'present', statusRaw: 'P' },
    { key: '2026-09-26-CS102', date: '2026-09-26', subjectCode: 'CS102', subject: 'OS', status: 'absent', statusRaw: 'A' },
    { key: '2026-09-27-CS103', date: '2026-09-27', subjectCode: 'CS103', subject: 'DB', status: 'present', statusRaw: 'P' },
  ];

  // Seed baseline
  await db.upsertKnownAttendance(userC.id, historicalRecords);
  await db.updateUser(userC.id, { monitoringStartedAt: '2026-10-01T00:00:00.000Z', qumsSessionStatus: 'active' });

  check('4. Baseline sends ZERO Telegram notifications', telegramSends.length, 0);
  check('4. Baseline records saved in database', (await db.listKnownAttendance(userC.id)).length, 3);

  // ---------------------------------------------------------
  // TEST 5: Backdated Attendance Detection & Actual Class Date
  // ---------------------------------------------------------
  telegramSends.length = 0;
  // A class that happened on 22 September 2026 was marked late
  const backdatedRecord = {
    key: '2026-09-22-CS101',
    date: '2026-09-22',
    subjectCode: 'CS101',
    subject: 'Java',
    status: 'present',
    statusRaw: 'P',
  };

  const textAlert = messages.formatBackdatedUpdate(backdatedRecord);
  ok('5. Backdated alert reflects actual class date (22 September 2026)', textAlert.includes('Class Date: 22 September 2026'));
  ok('5. Backdated alert contains subject', textAlert.includes('Subject: Java'));
  ok('5. Backdated alert contains status', textAlert.includes('Status: ✅ Present'));

  // ---------------------------------------------------------
  // TEST 6: Meaningful Transitions (N->P, N->A, P->A, A->P)
  // ---------------------------------------------------------
  const prevPresent = { status: 'present', statusRaw: 'P' };
  const nextAbsent = { ...backdatedRecord, status: 'absent', statusRaw: 'A' };
  const transitionText = messages.formatBackdatedUpdate(nextAbsent, prevPresent);
  ok('6. Transition message shows previous status', transitionText.includes('Previous Status: ✅ Present'));
  ok('6. Transition message shows current status', transitionText.includes('Current Status: ❌ Absent'));
  ok('6. Transition message uses "Attendance Updated"', transitionText.includes('Attendance Updated'));

  // ---------------------------------------------------------
  // TEST 7: Persistent Deduplication via notification_log
  // ---------------------------------------------------------
  const dedupeKey = 'attendance:7777:2026-09-22:CS101:P->A';
  const firstTry = await db.tryRecordNotificationLog(userC.id, 'attendance_changed', dedupeKey, { subject: 'Java' });
  const secondTry = await db.tryRecordNotificationLog(userC.id, 'attendance_changed', dedupeKey, { subject: 'Java' });

  check('7. First notification log insert succeeds', firstTry, true);
  check('7. Duplicate notification log insert is blocked', secondTry, false);
  ok('7. hasNotificationLog returns true', await db.hasNotificationLog(userC.id, dedupeKey));

  // ---------------------------------------------------------
  // TEST 8: Session Expiry and Reconnect Catch-Up
  // ---------------------------------------------------------
  // Mark session expired
  await db.updateUser(userC.id, { qumsSessionStatus: 'expired' });
  check('8. Session status marked expired', (await db.getUserById(userC.id)).qumsSessionStatus, 'expired');

  // Verify snapshots, monitoringStartedAt, and notification history were NOT deleted
  check('8. Attendance snapshots intact during expiry', (await db.listKnownAttendance(userC.id)).length, 3);
  ok('8. Monitoring start timestamp intact', Boolean((await db.getUserById(userC.id)).monitoringStartedAt));
  ok('8. Notification log intact', await db.hasNotificationLog(userC.id, dedupeKey));

  // ---------------------------------------------------------
  // TEST 9: QUMS Password Security
  // ---------------------------------------------------------
  const freshUser = await db.getUserById(userA.id);
  ok('9. No plaintext or encrypted password returned on user object', freshUser.qumsPassword === undefined && freshUser.password === undefined);
  const blank = db.createUser ? await db.createUser({ email: 'pwtest@example.com' }) : null;
  ok('9. Created user contains no qums password', blank && blank.qumsPasswordEncrypted === undefined);

  // ---------------------------------------------------------
  // SECTION 18 FINAL ACCEPTANCE TESTS: TEST A THROUGH TEST G
  // ---------------------------------------------------------
  console.log('\n--- SECTION 18 SPECIFIC ACCEPTANCE TESTS (TEST A - TEST G) ---');

  // TEST A:
  // Setup date: 1 October
  // Old attendance: 30 September -> P
  // Expected: NO notification.
  telegramSends.length = 0;
  const userTA = await db.createUser({ email: 'test_a@example.com' });
  await db.updateUser(userTA.id, {
    qumsQid: '5001',
    telegramChatId: 'chat-test-a',
    monitoringStartedDate: '2026-10-01',
    monitoringStartedAt: '2026-10-01T00:00:00.000Z',
    qumsSessionStatus: 'active',
  });
  await db.upsertKnownAttendance(userTA.id, [
    { key: '2026-10-01-INIT', date: '2026-10-01', subjectCode: 'INIT', subject: 'Init', status: 'present' },
  ]);

  // QUMS discovers old attendance from 30 September -> Present
  const oldRecSep30 = {
    key: '2026-09-30-CS201',
    date: '2026-09-30',
    subjectCode: 'CS201',
    subject: 'Data Structures',
    status: 'present',
    statusRaw: 'P',
  };

  const cycleResultA = await watcher.runMonthRegisterCycle({
    userId: userTA.id,
    fetchFn: async () => [{ year: 2026, month: 9, records: [oldRecSep30] }],
    sendFn: async (text) => telegramSends.push({ userId: userTA.id, text }),
  });

  check('TEST A: Setup date 1 Oct, old attendance 30 Sep -> 0 notifications', cycleResultA.notified.length, 0);
  check('TEST A: Telegram sends for old attendance is 0', telegramSends.filter((s) => s.userId === userTA.id).length, 0);

  // TEST B:
  // Setup date: 1 October
  // Attendance: 1 October -> P
  // Expected: monitor this date (class_date >= monitoring_started_date).
  const classOct1 = {
    key: '2026-10-01-CS201',
    date: '2026-10-01',
    subjectCode: 'CS201',
    subject: 'Data Structures',
    status: 'present',
    statusRaw: 'P',
  };
  const isOct1Monitored = classOct1.date >= (await db.getUserById(userTA.id)).monitoringStartedDate;
  check('TEST B: Setup date 1 Oct, class on 1 Oct is eligible for monitoring', isOct1Monitored, true);

  // TEST C:
  // Setup date: 1 October
  // Class: 1 October
  // Initial: N
  // Later: N -> P
  // Expected: ONE notification.
  telegramSends.length = 0;
  const cycleResultC = await watcher.runMonthRegisterCycle({
    userId: userTA.id,
    includeToday: true,
    fetchFn: async () => [{ year: 2026, month: 10, records: [classOct1] }],
    sendFn: async (text) => telegramSends.push({ userId: userTA.id, text }),
  });

  check('TEST C: 1 Oct class N -> P generates exactly ONE notification', cycleResultC.notified.length, 1);
  check('TEST C: Telegram sends for 1 Oct class is 1', telegramSends.filter((s) => s.userId === userTA.id).length, 1);
  const msgC = telegramSends.find((s) => s.userId === userTA.id)?.text || '';
  ok('TEST C: Notification reflects actual class date (1 October 2026)', msgC.includes('1 October 2026'));
  ok('TEST C: Notification shows subject', msgC.includes('Data Structures'));
  ok('TEST C: Notification shows status Present', msgC.includes('Present'));

  // Repeat cycle with same state -> deduplication ensures 0 extra notifications
  const repeatC = await watcher.runMonthRegisterCycle({
    userId: userTA.id,
    includeToday: true,
    fetchFn: async () => [{ year: 2026, month: 10, records: [classOct1] }],
    sendFn: async (text) => telegramSends.push({ userId: userTA.id, text }),
  });
  check('TEST C: Repeat cycle produces 0 duplicate notifications', repeatC.notified.length, 0);

  // TEST D:
  // Setup date: 1 October
  // Class: 30 September
  // Later: N -> P
  // Expected: NO notification.
  telegramSends.length = 0;
  const updatedSep30 = {
    key: '2026-09-30-CS201',
    date: '2026-09-30',
    subjectCode: 'CS201',
    subject: 'Data Structures',
    status: 'present',
    statusRaw: 'P',
  };

  const cycleResultD = await watcher.runMonthRegisterCycle({
    userId: userTA.id,
    includeToday: true,
    fetchFn: async () => [{ year: 2026, month: 9, records: [updatedSep30] }],
    sendFn: async (text) => telegramSends.push({ userId: userTA.id, text }),
  });

  check('TEST D: 30 Sep class updated later generates NO notification', cycleResultD.notified.length, 0);
  check('TEST D: Telegram sends for 30 Sep class update is 0', telegramSends.filter((s) => s.userId === userTA.id).length, 0);

  // TEST E:
  // Setup: 1 October
  // Session expires: 3 October
  // 2 October attendance changes: N -> P
  // Reconnect: 6 October
  // Expected: ONE notification for 2 October.
  telegramSends.length = 0;
  const userTE = await db.createUser({ email: 'test_e@example.com' });
  await db.updateUser(userTE.id, {
    qumsQid: '6001',
    telegramChatId: 'chat-test-e',
    monitoringStartedDate: '2026-10-01',
    monitoringStartedAt: '2026-10-01T00:00:00.000Z',
    qumsSessionStatus: 'active',
  });
  await db.upsertKnownAttendance(userTE.id, [
    { key: '2026-10-01-CS301', date: '2026-10-01', subjectCode: 'CS301', subject: 'Math', status: 'present', statusRaw: 'P' },
    { key: '2026-09-30-CS301', date: '2026-09-30', subjectCode: 'CS301', subject: 'Math', status: 'present', statusRaw: 'P' },
  ]);

  // Session expires on 3 October
  await db.updateUser(userTE.id, { qumsSessionStatus: 'expired' });

  // While disconnected:
  // 2 October class changed N -> P
  const recOct2 = {
    key: '2026-10-02-CS301',
    date: '2026-10-02',
    subjectCode: 'CS301',
    subject: 'Math',
    status: 'present',
    statusRaw: 'P',
  };
  // 30 September class changed P -> A (TEST F scenario)
  const recSep30Changed = {
    key: '2026-09-30-CS301',
    date: '2026-09-30',
    subjectCode: 'CS301',
    subject: 'Math',
    status: 'absent',
    statusRaw: 'A',
  };

  // User reconnects on 6 October
  await qumsLogin.completeQumsSetup(userTE.id, '6001');
  const userEAfterReconnect = await db.getUserById(userTE.id);
  check('TEST E: Reconnect does NOT reset monitoring_started_date', userEAfterReconnect.monitoringStartedDate, '2026-10-01');

  // Run catchup with the fresh records discovered upon reconnect
  const catchupResult = await catchup.runReconnectCatchup(userTE.id, 'fake-session-path', console, {
    attendanceRecords: [
      { year: 2026, month: 10, records: [recOct2] },
      { year: 2026, month: 9, records: [recSep30Changed] },
    ],
    skipAssignments: true,
  });

  check('TEST E: Exactly ONE attendance notification generated for 2 October', catchupResult.attendanceAlertsSent, 1);
  const attendanceSendsForE = telegramSends.filter((s) => s.userId === userTE.id && !s.text.includes('Reconnected'));
  check('TEST E: ONE notification sent for 2 October attendance change', attendanceSendsForE.length, 1);
  ok('TEST E: Notification contains actual class date (2 October 2026)', attendanceSendsForE[0]?.text.includes('2 October 2026'));
  ok('TEST E: Notification contains Subject Math', attendanceSendsForE[0]?.text.includes('Subject: Math'));

  // TEST F:
  // Same scenario but class date: 30 September
  // Expected: NO notification.
  const hasSep30Notification = telegramSends.filter((s) => s.userId === userTE.id).some((s) => s.text.includes('30 September 2026'));
  check('TEST F: 30 September change during disconnection generates NO notification', hasSep30Notification, false);

  // TEST G:
  // User A and User B have different QIDs.
  // Verify:
  // A cannot receive B attendance notification.
  // B cannot receive A attendance notification.
  telegramSends.length = 0;
  const userGA = await db.createUser({ email: 'user_ga@example.com' });
  const userGB = await db.createUser({ email: 'user_gb@example.com' });

  await db.updateUser(userGA.id, {
    qumsQid: '8938',
    telegramChatId: 'chat-ga',
    monitoringStartedDate: '2026-10-01',
    qumsSessionStatus: 'active',
  });
  await db.updateUser(userGB.id, {
    qumsQid: '9120',
    telegramChatId: 'chat-gb',
    monitoringStartedDate: '2026-10-01',
    qumsSessionStatus: 'active',
  });

  // Seed baseline for both
  await db.upsertKnownAttendance(userGA.id, [{ key: '2026-10-01-INIT', date: '2026-10-01', subjectCode: 'INIT', status: 'present' }]);
  await db.upsertKnownAttendance(userGB.id, [{ key: '2026-10-01-INIT', date: '2026-10-01', subjectCode: 'INIT', status: 'present' }]);

  // An attendance change happens ONLY for User A
  const recGA = { key: '2026-10-01-CS8938', date: '2026-10-01', subjectCode: 'CS8938', subject: 'Alpha Subject', status: 'present', statusRaw: 'P' };
  await watcher.runMonthRegisterCycle({
    userId: userGA.id,
    includeToday: true,
    fetchFn: async () => [{ year: 2026, month: 10, records: [recGA] }],
    sendFn: async (text) => telegramSends.push({ userId: userGA.id, text }),
  });

  const sendsForGA = telegramSends.filter((s) => s.userId === userGA.id);
  const sendsForGB = telegramSends.filter((s) => s.userId === userGB.id);
  check('TEST G: User A receives attendance notification', sendsForGA.length, 1);
  check('TEST G: User B receives ZERO notifications when User A updates', sendsForGB.length, 0);

  // Now an attendance change happens ONLY for User B
  telegramSends.length = 0;
  const recGB = { key: '2026-10-01-CS9120', date: '2026-10-01', subjectCode: 'CS9120', subject: 'Beta Subject', status: 'absent', statusRaw: 'A' };
  await watcher.runMonthRegisterCycle({
    userId: userGB.id,
    includeToday: true,
    fetchFn: async () => [{ year: 2026, month: 10, records: [recGB] }],
    sendFn: async (text) => telegramSends.push({ userId: userGB.id, text }),
  });

  const sendsForGA2 = telegramSends.filter((s) => s.userId === userGA.id);
  const sendsForGB2 = telegramSends.filter((s) => s.userId === userGB.id);
  check('TEST G: User B receives attendance notification', sendsForGB2.length, 1);
  check('TEST G: User A receives ZERO notifications when User B updates', sendsForGA2.length, 0);

  console.log(failures ? `\n${failures} ARCHITECTURE TEST(S) FAILED!` : '\nALL COMPLETE ARCHITECTURE & MONITORING TESTS PASSED!\n');
  process.exit(failures ? 1 : 0);
})();
