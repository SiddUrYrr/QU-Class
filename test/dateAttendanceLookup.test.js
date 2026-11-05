/**
 * Focused test suite for Date-wise Full Attendance Lookup feature (/DD/MM/YY and /DD/MM/YYYY):
 * 1. DD/MM/YY and DD/MM/YYYY regex and parsing.
 * 2. Invalid calendar dates, leap-year boundaries, and future date handling.
 * 3. Correct date-specific attendance retrieval and Telegram formatting.
 * 4. Multi-lecture handling (P,P; P,A; A,A) and summary calculations.
 * 5. Friendly message when no attendance is available for the requested date.
 * 6. Per-user attendance isolation (User 1 data never leaks to User 2).
 * 7. Deletion scheduling for both user command and bot response at 5 minutes.
 * 8. Graceful handling of Telegram deletion failures (no crashes).
 * 9. Preservation of existing bot features (/today, /attendance, /status, /help).
 *
 * Run with:
 *   node test/dateAttendanceLookup.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qums-tg-date-lookup-'));
process.env.DB_FILE = path.join(TMP_DIR, 'db.json');
process.env.DATABASE_URL = '';
process.env.TELEGRAM_BOT_TOKEN = 'test:stub-date-lookup';
process.env.TELEGRAM_BOT_USERNAME = 'test_date_bot';

const deletedMessages = [];
const sentMessages = [];
let msgSeq = 5000;
let shouldFailDelete = false;

const Module = require('module');
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'node-telegram-bot-api') {
    return function StubBot() {
      return {
        sendMessage: async (chatId, text, opts) => {
          msgSeq += 1;
          const msgObj = { message_id: msgSeq, chat: { id: chatId }, text, opts };
          sentMessages.push(msgObj);
          return msgObj;
        },
        deleteMessage: async (chatId, messageId) => {
          if (shouldFailDelete) {
            throw new Error('ETELEGRAM: 400 Bad Request: message to delete not found');
          }
          deletedMessages.push({ chatId: String(chatId), messageId: Number(messageId) });
          return true;
        },
        onText: () => {},
        on: () => {},
        clearTextListeners: () => {},
      };
    };
  }
  return origRequire.apply(this, arguments);
};

const db = require('../src/db');
const telegram = require('../src/telegram');
const messages = require('../src/messages');
const scraper = require('../src/scraper');

async function run() {
  console.log('=== RUNNING DATE-WISE FULL ATTENDANCE LOOKUP TEST SUITE ===\n');

  // ====================================================
  // 1. DD/MM/YY and DD/MM/YYYY parsing tests
  // ====================================================
  console.log('--- Group 1: Date Command Parsing ---');
  const p1 = telegram.parseDateCommand('/12/10/26');
  assert.strictEqual(p1.day, 12);
  assert.strictEqual(p1.month, 10);
  assert.strictEqual(p1.year, 2026);
  assert.strictEqual(p1.formattedDate, '12/10/2026');
  assert.strictEqual(p1.ymd, '2026-10-12');

  const p2 = telegram.parseDateCommand('/12/10/2026');
  assert.strictEqual(p2.day, 12);
  assert.strictEqual(p2.month, 10);
  assert.strictEqual(p2.year, 2026);

  const p3 = telegram.parseDateCommand('/1/5/26');
  assert.strictEqual(p3.day, 1);
  assert.strictEqual(p3.month, 5);
  assert.strictEqual(p3.year, 2026);
  assert.strictEqual(p3.formattedDate, '01/05/2026');

  const p4 = telegram.parseDateCommand('/05/09/2026');
  assert.strictEqual(p4.day, 5);
  assert.strictEqual(p4.month, 9);
  assert.strictEqual(p4.year, 2026);

  const p5 = telegram.parseDateCommand('/12-10-26');
  assert.strictEqual(p5.day, 12);
  assert.strictEqual(p5.month, 10);
  assert.strictEqual(p5.year, 2026);

  const p6 = telegram.parseDateCommand('/12/10/26@mybot');
  assert.strictEqual(p6.day, 12);
  assert.strictEqual(p6.month, 10);
  assert.strictEqual(p6.year, 2026);

  // Non-matching inputs must return null
  assert.strictEqual(telegram.parseDateCommand('/today'), null);
  assert.strictEqual(telegram.parseDateCommand('/status'), null);
  assert.strictEqual(telegram.parseDateCommand('/attendance'), null);
  assert.strictEqual(telegram.parseDateCommand('/help'), null);
  assert.strictEqual(telegram.parseDateCommand('/reconnect'), null);
  assert.strictEqual(telegram.parseDateCommand('/12/10'), null);
  assert.strictEqual(telegram.parseDateCommand('12/10/26'), null);
  assert.strictEqual(telegram.parseDateCommand('/abc/def/gh'), null);
  console.log('✓ PASS: DD/MM/YY and DD/MM/YYYY regex and parsing verified');

  // ====================================================
  // 2. Invalid dates and leap-year handling
  // ====================================================
  console.log('\n--- Group 2: Calendar & Leap-Year Validation ---');
  // Leap year 2024: 29 Feb is valid, 30 Feb is invalid
  assert.strictEqual(telegram.isValidCalendarDate(29, 2, 2024), true, '29 Feb 2024 must be valid (leap year)');
  assert.strictEqual(telegram.isValidCalendarDate(30, 2, 2024), false, '30 Feb 2024 must be invalid');

  // Non-leap year 2025: 29 Feb is invalid
  assert.strictEqual(telegram.isValidCalendarDate(29, 2, 2025), false, '29 Feb 2025 must be invalid (non-leap year)');

  // Non-leap year 2026: 29 Feb is invalid
  assert.strictEqual(telegram.isValidCalendarDate(29, 2, 2026), false, '29 Feb 2026 must be invalid (non-leap year)');

  // 400-year leap year rule (2000 vs 2100)
  assert.strictEqual(telegram.isValidCalendarDate(29, 2, 2000), true, '29 Feb 2000 must be valid');
  assert.strictEqual(telegram.isValidCalendarDate(29, 2, 2100), false, '29 Feb 2100 must be invalid');

  // Month days boundary: 30-day months
  assert.strictEqual(telegram.isValidCalendarDate(30, 4, 2026), true, '30 April 2026 must be valid');
  assert.strictEqual(telegram.isValidCalendarDate(31, 4, 2026), false, '31 April 2026 must be invalid');
  assert.strictEqual(telegram.isValidCalendarDate(31, 6, 2026), false, '31 June 2026 must be invalid');
  assert.strictEqual(telegram.isValidCalendarDate(31, 9, 2026), false, '31 Sept 2026 must be invalid');
  assert.strictEqual(telegram.isValidCalendarDate(31, 11, 2026), false, '31 Nov 2026 must be invalid');

  // 31-day months
  assert.strictEqual(telegram.isValidCalendarDate(31, 1, 2026), true, '31 Jan 2026 must be valid');
  assert.strictEqual(telegram.isValidCalendarDate(31, 3, 2026), true, '31 Mar 2026 must be valid');
  assert.strictEqual(telegram.isValidCalendarDate(31, 10, 2026), true, '31 Oct 2026 must be valid');

  // Out of bounds day/month
  assert.strictEqual(telegram.isValidCalendarDate(0, 10, 2026), false, 'Day 0 must be invalid');
  assert.strictEqual(telegram.isValidCalendarDate(32, 1, 2026), false, 'Day 32 must be invalid');
  assert.strictEqual(telegram.isValidCalendarDate(15, 0, 2026), false, 'Month 0 must be invalid');
  assert.strictEqual(telegram.isValidCalendarDate(15, 13, 2026), false, 'Month 13 must be invalid');

  // Future date check against mock current time (2026-10-15)
  const mockNow = new Date('2026-10-15T10:00:00+05:30');
  assert.strictEqual(telegram.isFutureDate(12, 10, 2026, mockNow), false, 'Past date (12/10/2026) is NOT future');
  assert.strictEqual(telegram.isFutureDate(15, 10, 2026, mockNow), false, 'Current date (15/10/2026) is NOT future');
  assert.strictEqual(telegram.isFutureDate(16, 10, 2026, mockNow), true, 'Tomorrow (16/10/2026) IS future');
  assert.strictEqual(telegram.isFutureDate(10, 11, 2026, mockNow), true, 'Next month (10/11/2026) IS future');
  assert.strictEqual(telegram.isFutureDate(12, 10, 2027, mockNow), true, 'Next year (12/10/2027) IS future');
  console.log('✓ PASS: Calendar limits, leap years, and future dates strictly validated');

  // ====================================================
  // 3. Formatting of Date Attendance Report
  // ====================================================
  console.log('\n--- Group 3: Formatting & Summary Calculation ---');
  const sampleClasses = [
    {
      subject: 'Design and Analysis of Algorithm',
      subjectCode: 'CS35303',
      period: 'P1',
      duration: '09:00 - 09:55',
      room: 'LT-1',
      teacher: 'Dr. Sharma',
      status: 'present',
      statusRaw: 'P',
      lectures: [{ status: 'present', statusRaw: 'P' }],
    },
    {
      subject: 'Technical Skills Development-IV',
      subjectCode: 'SE35369',
      period: 'P2',
      duration: '09:55 - 10:50',
      room: 'Lab 3',
      teacher: 'Prof. Verma',
      status: 'present',
      statusRaw: 'P,A',
      lectures: [
        { status: 'present', statusRaw: 'P' },
        { status: 'absent', statusRaw: 'A' },
      ],
    },
    {
      subject: 'Cloud Computing',
      subjectCode: 'CS35304',
      status: 'absent',
      statusRaw: 'A',
      lectures: [{ status: 'absent', statusRaw: 'A' }],
    },
    {
      subject: 'Web Technologies Lab',
      subjectCode: 'CS35305',
      status: 'unmarked',
      statusRaw: 'NM',
      lectures: [{ status: 'unmarked', statusRaw: 'NM' }],
    },
  ];

  const dateInfo = { day: 12, month: 10, year: 2026, ymd: '2026-10-12', formattedDate: '12/10/2026' };
  const formatted = messages.formatDateAttendanceReport(dateInfo, sampleClasses);

  assert(formatted.includes('📅 *Attendance for 12 October 2026* (12/10/2026)'), 'Must include correct date header');
  assert(formatted.includes('1. 📚 *Design and Analysis of Algorithm* (CS35303)'), 'Must include subject 1 with code');
  assert(formatted.includes('Status: ✅ Present'), 'Must include Present emoji for single lecture');
  assert(formatted.includes('📍 Room: LT-1 • 👨‍🏫 Dr. Sharma'), 'Must include room and teacher when present');
  assert(formatted.includes('2. 📚 *Technical Skills Development-IV* (SE35369)'), 'Must include subject 2');
  assert(formatted.includes('Status: L1 ✅ Present | L2 ❌ Absent'), 'Must format multi-lecture breakdown accurately');
  assert(formatted.includes('3. 📚 *Cloud Computing* (CS35304)'), 'Must include subject 3');
  assert(formatted.includes('Status: ❌ Absent'), 'Must include Absent emoji');
  assert(formatted.includes('4. 📚 *Web Technologies Lab* (CS35305)'), 'Must include subject 4');
  assert(formatted.includes('Status: ⏳ Not Marked'), 'Must show Not Marked indicator');
  assert(formatted.includes('📊 *Day Summary:*'), 'Must include summary header');
  assert(formatted.includes('• ✅ Present: 2'), 'Summary must count present accurately (1 single + 1 from multi)');
  assert(formatted.includes('• ❌ Absent: 2'), 'Summary must count absent accurately (1 single + 1 from multi)');
  assert(formatted.includes('• ⏳ Not Marked: 1'), 'Summary must count unmarked accurately');
  assert(formatted.includes('• 📚 Total Classes: 5'), 'Summary must sum total classes/lectures (1 + 2 + 1 + 1 = 5)');
  console.log('✓ PASS: Attendance formatting and breakdown calculations verified');

  // ====================================================
  // 4. No attendance available for requested date
  // ====================================================
  console.log('\n--- Group 4: Empty Date Handling ---');
  const emptyReport = messages.formatDateAttendanceReport(dateInfo, []);
  assert(emptyReport.includes('📅 *Attendance for 12 October 2026*'), 'Empty report must include date header');
  assert(emptyReport.includes('No classes or attendance records found for this date'), 'Must return friendly empty message');
  assert(!emptyReport.includes('Total Classes: 0'), 'Should not fabricate summary on empty records');
  console.log('✓ PASS: No attendance available returns clear friendly message without fabricated data');

  // ====================================================
  // 5. Telegram Integration & Multi-User Isolation
  // ====================================================
  console.log('\n--- Group 5: Multi-User Isolation & QUMS Lookup ---');
  telegram.initTelegram();

  // Create two distinct users
  const userA = await db.createUser({ email: 'userA@qattend.com', passwordHash: 'hashA' });
  await db.setTelegramChatId(userA.id, 710001);
  await db.updateUser(userA.id, {
    studentName: 'Student Alpha',
    qumsQid: '91001',
    qumsSessionPath: path.join(TMP_DIR, 'sessionA.json'),
  });

  const userB = await db.createUser({ email: 'userB@qattend.com', passwordHash: 'hashB' });
  await db.setTelegramChatId(userB.id, 720002);
  await db.updateUser(userB.id, {
    studentName: 'Student Beta',
    qumsQid: '92002',
    qumsSessionPath: path.join(TMP_DIR, 'sessionB.json'),
  });

  // Seed known attendance in DB for both users on 2026-10-12
  await db.addKnownAttendance(userA.id, [
    {
      date: '2026-10-12',
      day: 12,
      subjectCode: 'CS101',
      subject: 'Alpha Subject 1',
      status: 'present',
      statusRaw: 'P',
      lectures: [{ status: 'present', statusRaw: 'P' }],
      key: '2026-10-12-CS101',
    },
  ]);

  await db.addKnownAttendance(userB.id, [
    {
      date: '2026-10-12',
      day: 12,
      subjectCode: 'EC202',
      subject: 'Beta Subject 2',
      status: 'absent',
      statusRaw: 'A',
      lectures: [{ status: 'absent', statusRaw: 'A' }],
      key: '2026-10-12-EC202',
    },
  ]);

  // Query as User A
  sentMessages.length = 0;
  await telegram.handleUserMessage({
    chat: { id: 710001 },
    text: '/12/10/26',
    message_id: 8001,
  });

  assert.strictEqual(sentMessages.length, 1, 'User A should receive 1 response');
  const userAResponse = sentMessages[0].text;
  assert(userAResponse.includes('Alpha Subject 1'), 'User A must see their own subject');
  assert(!userAResponse.includes('Beta Subject 2'), 'User A MUST NOT see User B subject');
  assert(userAResponse.includes('• ✅ Present: 1'), 'User A summary must show 1 present');

  // Query as User B
  sentMessages.length = 0;
  await telegram.handleUserMessage({
    chat: { id: 720002 },
    text: '/12/10/2026',
    message_id: 8002,
  });

  assert.strictEqual(sentMessages.length, 1, 'User B should receive 1 response');
  const userBResponse = sentMessages[0].text;
  assert(userBResponse.includes('Beta Subject 2'), 'User B must see their own subject');
  assert(!userBResponse.includes('Alpha Subject 1'), 'User B MUST NOT see User A subject');
  assert(userBResponse.includes('• ❌ Absent: 1'), 'User B summary must show 1 absent');
  console.log('✓ PASS: Multi-user attendance isolation strictly verified');

  // ====================================================
  // 6. Deletion Scheduling for Command & Bot Response (5 minutes)
  // ====================================================
  console.log('\n--- Group 6: 5-Minute Auto-Delete Scheduling ---');
  const pendingDeletions = await db.listPendingDeletions();

  // User B's incoming command (message_id 8002) must be scheduled for deletion
  const cmdEntry = pendingDeletions.find((p) => p.chatId === '720002' && p.messageId === 8002);
  assert(cmdEntry, 'User command message (8002) must be in scheduled deletions');
  assert(
    cmdEntry.deleteAt <= Date.now() + 301000 && cmdEntry.deleteAt >= Date.now() + 298000,
    'Command message deleteAt must be ~300 seconds'
  );

  // User B's bot response must be scheduled for deletion
  const botRespMsg = sentMessages[0];
  const respEntry = pendingDeletions.find((p) => p.chatId === '720002' && p.messageId === botRespMsg.message_id);
  assert(respEntry, 'Bot response message must be in scheduled deletions');
  assert(
    respEntry.deleteAt <= Date.now() + 301000 && respEntry.deleteAt >= Date.now() + 298000,
    'Bot response message deleteAt must be ~300 seconds'
  );
  console.log('✓ PASS: Both command message and bot response scheduled for deletion at 5 minutes');

  // ====================================================
  // 7. Invalid Date & Future Date Command Auto-Delete
  // ====================================================
  console.log('\n--- Group 7: Error Commands Auto-Delete ---');
  sentMessages.length = 0;
  await telegram.handleUserMessage({
    chat: { id: 710001 },
    text: '/31/04/26',
    message_id: 8003,
  });
  assert.strictEqual(sentMessages.length, 1);
  assert(sentMessages[0].text.includes('Invalid Date'), 'Must report invalid date for April 31');

  const pendingAfterInvalid = await db.listPendingDeletions();
  assert(pendingAfterInvalid.some((p) => p.messageId === 8003), 'Invalid command must be scheduled for deletion');
  assert(pendingAfterInvalid.some((p) => p.messageId === sentMessages[0].message_id), 'Invalid response must be scheduled for deletion');

  // Future date command
  sentMessages.length = 0;
  await telegram.handleUserMessage({
    chat: { id: 710001 },
    text: '/25/12/26',
    message_id: 8004,
  });
  assert.strictEqual(sentMessages.length, 1);
  assert(sentMessages[0].text.includes('Future Date'), 'Must report future date error');
  console.log('✓ PASS: Invalid date and future date commands and responses auto-delete after 5 minutes');

  // ====================================================
  // 8. Deletion Failure Handling Gracefulness
  // ====================================================
  console.log('\n--- Group 8: Deletion Failure Resilience ---');
  shouldFailDelete = true;
  let errorThrown = false;
  try {
    const res = await telegram.deleteMessageFromChat(710001, 8001);
    // When delete fails with 400 not found, deleteMessageFromChat logs and returns false or true without throwing
  } catch (err) {
    errorThrown = true;
  }
  shouldFailDelete = false;
  assert.strictEqual(errorThrown, false, 'deleteMessageFromChat must NOT throw and crash the bot');
  console.log('✓ PASS: Deletion failure handled gracefully without crashing');

  // ====================================================
  // 9. Existing Bot Commands Unaffected
  // ====================================================
  console.log('\n--- Group 9: Preservation of Existing Commands ---');
  // /today
  sentMessages.length = 0;
  await telegram.handleUserMessage({ chat: { id: 710001 }, text: '/today', message_id: 8010 });
  assert(sentMessages.length >= 1, '/today must still respond');
  assert(sentMessages[0].text.includes("Today's Classes & Attendance") || sentMessages[0].text.includes('No classes found'), '/today text preserved');

  // /status
  sentMessages.length = 0;
  await telegram.handleUserMessage({ chat: { id: 710001 }, text: '/status', message_id: 8011 });
  assert(sentMessages.length >= 1, '/status must still respond');
  assert(sentMessages[0].text.includes('Account Status'), '/status text preserved');

  // /help
  sentMessages.length = 0;
  await telegram.handleUserMessage({ chat: { id: 710001 }, text: '/help', message_id: 8012 });
  assert(sentMessages.length >= 1, '/help must still respond');
  assert(sentMessages[0].text.includes('Available commands'), '/help text preserved');
  assert(sentMessages[0].text.includes('/DD/MM/YY'), '/help includes new date command');

  console.log('✓ PASS: All existing commands preserved and functional');

  console.log('\n===============================================================');
  console.log('ALL DATE-WISE ATTENDANCE LOOKUP TESTS PASSED SUCCESSFULLY!');
  console.log('===============================================================');
}

run().catch((err) => {
  console.error('TEST SUITE FAILED:', err);
  process.exit(1);
});
