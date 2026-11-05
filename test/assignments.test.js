/**
 * ASSIGNMENT monitoring + 7:00 PM IST deadline reminder tests (Phase 5 + 18: 15-17).
 *
 *   node test/assignments.test.js
 *
 * No QUMS / Telegram network: rows + send are injected, DB is a tmp JSON file.
 * Row shapes mirror the verified QUMS GetStudentAssignment fields
 * (AssignmentDetailID, ASSIGNMENT, CLASSSUBJECT, EMPLOYEENAME, DATETO...).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qattend-assign-'));
process.env.DB_FILE = path.join(TMP, 'db.json');
process.env.DATABASE_URL = '';

const db = require('../src/db');
const assignments = require('../src/assignments');

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

/** Normalized assignment row (scraper.normalizeAssignmentRow output shape). */
function mkAssign({ id = 'A1', title, subject, teacher = 'DEEPAK BHATT', deadlineYMD = '2026-09-25' }) {
  return { id, title, subject, teacher, type: 'Assignment', assignedYMD: '2026-09-20', deadlineYMD, ext: '', uploadFlag: 0, source: 'state' };
}

async function cycle(userId, mode, rows, sent, todayYMD) {
  return assignments.runAssignmentCycle({
    log: quiet,
    userId,
    userEmail: `${userId}@example.com`,
    mode,
    rows,
    todayYMD,
    sendFn: async (text) => { sent.push(text); return text; },
  });
}

(async () => {
  await db.init();

  // ---------- A1: schedule config (7:00 PM IST, Asia/Kolkata) ----------
  check('A1 deadline reminder cron = 19:00 daily', assignments.REMINDER_CRON, '0 19 * * *');
  check('A1 timezone = Asia/Kolkata', assignments.TIMEZONE, 'Asia/Kolkata');

  const U1 = 'assign-user-1';
  const java = mkAssign({ id: 'A1', title: 'OOP Assignment', subject: 'Java', deadlineYMD: '2026-09-25' });

  // ---------- A2: new assignment -> exactly 1 notification ----------
  let sent = [];
  let r = await cycle(U1, 'new', [java], sent);
  check('A2 new assignment -> 1 notification', sent.length, 1);
  ok('A2 message header is "New Assignment"', /New Assignment/.test(sent[0] || ''), sent[0]);
  ok('A2 message has the subject', /Subject: Java/.test(sent[0] || ''), sent[0]);
  ok('A2 message has the title', /Assignment: OOP Assignment/.test(sent[0] || ''), sent[0]);
  ok('A2 message has the last date', /Last Date: 25 September 2026/.test(sent[0] || ''), sent[0]);
  ok('A2 message links to the QUMS assignment page', /🔗 Open QUMS: https:\/\/qums\.quantumuniversity\.edu\.in\/Web_StudentAcademic\/Cyborg_StudentAssignment\?id=Assignment/.test(sent[0] || ''), sent[0]);
  check('A2 notified row carries the real assignment id', r.notified[0].key, 'new:A1');

  // ---------- A3: same assignment again -> 0 notifications (no duplicate) ----------
  sent = [];
  await cycle(U1, 'new', [java], sent);
  check('A3 repeat scan -> 0 notifications', sent.length, 0);

  // ---------- A4: a second, genuinely new assignment -> 1 notification ----------
  sent = [];
  const dbms = mkAssign({ id: 'A2', title: 'DBMS Assignment 2', subject: 'DBMS', deadlineYMD: '2026-10-02' });
  await cycle(U1, 'new', [java, dbms], sent);
  check('A4 only the new assignment notifies', sent.length, 1);
  ok('A4 the notification is for the new assignment', /DBMS Assignment 2/.test(sent[0] || ''), sent[0]);

  // ---------- A5: fingerprint dedupe when QUMS gives no unique id ----------
  sent = [];
  const U2 = 'assign-user-2';
  const noId = { ...mkAssign({ id: '', title: 'No-ID Assignment', subject: 'Maths', deadlineYMD: '2026-09-30' }) };
  await cycle(U2, 'new', [noId], sent);
  check('A5 no-id assignment -> 1 notification', sent.length, 1);
  sent = [];
  await cycle(U2, 'new', [{ ...noId }], sent);
  check('A5 same fields again -> 0 notifications (fingerprint dedupe)', sent.length, 0);
  sent = [];
  await cycle(U2, 'new', [{ ...noId, title: 'No-ID Assignment v2' }], sent);
  check('A5 changed title -> new fingerprint -> 1 notification', sent.length, 1);

  // ---------- A6: deadline reminder fires ONLY on the deadline day ----------
  const U3 = 'assign-user-3';
  const dueToday = mkAssign({ id: 'B1', title: 'Today Assignment', subject: 'Java', deadlineYMD: '2026-09-25' });
  const dueTomorrow = mkAssign({ id: 'B2', title: 'Tomorrow Assignment', subject: 'Java', deadlineYMD: '2026-09-26' });
  const pastDue = mkAssign({ id: 'B3', title: 'Old Assignment', subject: 'Java', deadlineYMD: '2026-09-24' });
  const noDeadline = { ...mkAssign({ id: 'B4', title: 'No Deadline', subject: 'Java', deadlineYMD: null }) };

  sent = [];
  r = await cycle(U3, 'reminders', [dueToday, dueTomorrow, pastDue, noDeadline], sent, '2026-09-25');
  check('A6 only the assignment due TODAY is reminded', sent.length, 1);
  ok('A6 reminder header', /Assignment Deadline Reminder/.test(sent[0] || ''), sent[0]);
  ok('A6 reminder names the assignment + subject', /Assignment: Today Assignment/.test(sent[0] || '') && /Subject: Java/.test(sent[0] || ''), sent[0]);
  ok('A6 reminder body copy', /Today is the last date to submit this assignment\./.test(sent[0] || ''), sent[0]);
  check('A6 reminder key is per assignment + deadline date', r.notified[0].key, 'reminder:B1:2026-09-25');

  sent = [];
  await cycle(U3, 'reminders', [dueToday, dueTomorrow, pastDue, noDeadline], sent, '2026-09-25');
  check('A6 second 7 PM run -> exactly ONE reminder ever (no duplicate)', sent.length, 0);

  sent = [];
  await cycle(U3, 'reminders', [dueToday, dueTomorrow, pastDue, noDeadline], sent, '2026-09-23');
  check('A6 a day with no deadline at all -> 0 reminders (no early reminder)', sent.length, 0);

  // ---------- A7: multi-user isolation ----------
  sent = [];
  const UA = 'assign-iso-a';
  const UB = 'assign-iso-b';
  const userARow = mkAssign({ id: 'ISO1', title: 'User A Assignment', subject: 'Networks', deadlineYMD: '2026-09-25' });
  const userBRow = mkAssign({ id: 'ISO2', title: 'User B Assignment', subject: 'DBMS', deadlineYMD: '2026-09-25' });
  await cycle(UA, 'new', [userARow], sent);
  await cycle(UB, 'new', [userBRow], sent);
  check('A7 both users get exactly their own notification', sent.length, 2);
  ok('A7 user A notification is user A only', sent.some((t) => /User A Assignment/.test(t)));
  ok('A7 user B notification is user B only', sent.some((t) => /User B Assignment/.test(t)));
  ok('A7 no message mixes both users', !sent.some((t) => /User A Assignment/.test(t) && /User B Assignment/.test(t)));

  sent = [];
  await cycle(UA, 'new', [userARow], sent);
  check('A7 user A repeat -> 0 (own dedupe state)', sent.length, 0);

  sent = [];
  await cycle(UB, 'new', [userBRow], sent);
  check('A7 user A scan did not mark user B assignments as seen', sent.length, 0);

  // ---------- A8: reminder state is per user (A's reminder never mutes B's) ----------
  const shared = mkAssign({ id: 'SAME1', title: 'Shared Deadline', subject: 'Java', deadlineYMD: '2026-09-25' });
  sent = [];
  await cycle(UA, 'reminders', [shared], sent, '2026-09-25');
  await cycle(UB, 'reminders', [shared], sent, '2026-09-25');
  check('A8 same assignment id -> each user reminded once (2 sends)', sent.length, 2);
  sent = [];
  await cycle(UA, 'reminders', [shared], sent, '2026-09-25');
  check('A8 user A repeat -> 0 (own dedupe state)', sent.length, 0);

  // ---------- A10: REAL live state2 rows (study material) must never notify ----------
  // Captured live from GetStudentAssignment state2:
  //   AssignmentDetailID, Subject, AssignmentExt, Marks, Keywords, References,
  //   EMPLOYEENAME, ASSIGNMENTSUBJECT, CLASSSUBJECT   (no DATETO -> no deadline)
  const scraper = require('../src/scraper');
  const liveRow = {
    AssignmentDetailID: '37370',
    Subject: 'UNIT-1 : CS35302-SM01',
    AssignmentExt: '.pdf',
    Marks: null,
    Keywords: null,
    References: null,
    EMPLOYEENAME: 'DEEPAK BHATT',
    ASSIGNMENTSUBJECT: 'UNIT-1 : CS35302-SM01',
    CLASSSUBJECT: 'Web Technology',
  };
  const normalized = scraper.normalizeAssignmentRow(liveRow, 'state2');
  check('A10 real row -> unique QUMS id kept', normalized.id, '37370');
  check('A10 real row -> title/subject/teacher mapped', [normalized.title, normalized.subject, normalized.teacher], ['UNIT-1 : CS35302-SM01', 'Web Technology', 'DEEPAK BHATT']);
  check('A10 real row -> no deadline field => deadline null (never guessed)', normalized.deadlineYMD, null);
  check('A10 real row -> classified as study material, not an assignment', normalized.type, 'Study Material');
  const U10 = 'assign-live-user';
  sent = [];
  await cycle(U10, 'new', [normalized], sent);
  check('A10 study-material row -> 0 notifications (no false assignment alert)', sent.length, 0);
  sent = [];
  await cycle(U10, 'reminders', [normalized], sent, '2026-09-25');
  check('A10 study-material row -> 0 deadline reminders', sent.length, 0);

  // A real Assignment-type row (state grid) with a real deadline DOES notify once.
  const realAssign = scraper.normalizeAssignmentRow({
    AssignID: 'A-1',
    AssignmentDetailID: '90001',
    ASSIGNMENT: 'UNIT-2 Assignment',
    CLASSSUBJECT: 'Web Technology',
    EMPLOYEENAME: 'DEEPAK BHATT',
    Assignmenttype: 'Assignment',
    DATEFROM: '20/09/2026',
    DATETO: '25/09/2026',
  }, 'state');
  check('A10 real dated row -> deadline parsed day-first', realAssign.deadlineYMD, '2026-09-25');
  sent = [];
  await cycle(U10, 'new', [realAssign], sent);
  check('A10 real dated assignment -> 1 notification', sent.length, 1);
  sent = [];
  await cycle(U10, 'new', [realAssign], sent);
  check('A10 real dated assignment repeat -> 0 (id dedupe)', sent.length, 0);

  const aKeys = (await db.listKnownAssignments(UA)).map((x) => x.key);
  const bKeys = (await db.listKnownAssignments(UB)).map((x) => x.key);
  ok('A9 user A store has own keys', aKeys.includes('new:ISO1') && aKeys.includes('reminder:SAME1:2026-09-25'));
  ok('A9 user B store has own keys', bKeys.includes('new:ISO2') && bKeys.includes('reminder:SAME1:2026-09-25'));
  ok('A9 user A store does NOT contain user B assignment', !aKeys.includes('new:ISO2'));

  console.log(failures ? `\n${failures} ASSIGNMENT TEST(S) FAILED` : '\nALL ASSIGNMENT TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('[x]', err.name || 'Error', err.message);
  process.exit(1);
});
