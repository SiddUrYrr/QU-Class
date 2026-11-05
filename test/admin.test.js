/**
 * Admin dashboard & API tests (Phases 20, 21, 22, and User Management).
 *   node test/admin.test.js
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const bcrypt = require('bcryptjs');

// Ensure isolated testing
const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qattend-admin-test-'));
const tmpDbFile = path.join(tmpDbDir, 'db.json');
process.env.DB_FILE = tmpDbFile;
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAILS = 'admin@example.com,super@college.edu';
process.env.SESSION_SECRET = 'test-session-secret-admin';

const db = require('../src/db');
const app = require('../src/server');

let server;
let baseUrl;

async function startServer() {
  await db.init();
  return new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

function stopServer() {
  return new Promise((resolve) => server.close(resolve));
}

async function apiRequest(method, endpoint, body = null, cookie = '') {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  const res = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie');
  let retCookie = cookie;
  if (setCookie) {
    retCookie = setCookie.split(';')[0];
  }
  let json = null;
  const text = await res.text();
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, json, text, cookie: retCookie };
}

async function run() {
  console.log('=== ADMIN DASHBOARD & HEALTH TESTS ===\n');

  // Test 1: safeAdminUser never leaks sensitive fields and includes isSuspended
  const mockUser = {
    id: 'usr123',
    email: 'student@example.com',
    passwordHash: '$2a$10$abcdefghijklmnopqrstuvwxyz123456',
    qumsPasswordEncrypted: 'sensitive_encrypted_password',
    qumsSessionPath: '/tmp/test-session.json',
    qumsQid: 'Q12345',
    studentName: 'TEST STUDENT',
    qumsYearSem: 'SEM 5',
    telegramChatId: '987654321',
    telegramLinkCode: 'secret_code',
    isAdmin: false,
    isSuspended: false,
    createdAt: new Date().toISOString(),
    attendanceLastCheckedAt: new Date().toISOString(),
    assignmentLastCheckedAt: null,
  };

  const safe = db.safeAdminUser(mockUser, []);
  assert.strictEqual(safe.id, 'usr123');
  assert.strictEqual(safe.studentName, 'TEST STUDENT');
  assert.strictEqual(safe.qumsYearSem, 'SEM 5');
  assert.strictEqual(safe.qumsQid, 'Q12345');
  assert.strictEqual(safe.email, 'student@example.com');
  assert.strictEqual(safe.telegramConnected, true);
  assert.strictEqual(safe.sessionExpired, false);
  assert.strictEqual(safe.isSuspended, false);
  assert.strictEqual(safe.assignmentLastCheckedAt, '');

  // Sensitive fields must NOT exist on safeAdminUser
  assert.strictEqual(safe.passwordHash, undefined, 'passwordHash must not leak');
  assert.strictEqual(safe.qumsPasswordEncrypted, undefined, 'qumsPasswordEncrypted must not leak');
  assert.strictEqual(safe.telegramChatId, undefined, 'telegramChatId must not leak');
  assert.strictEqual(safe.telegramLinkCode, undefined, 'telegramLinkCode must not leak');
  console.log('PASS  1. safeAdminUser removes all passwords, tokens, and hashes & includes isSuspended');

  // Test 2: applyAdminFilters
  const mockRows = [
    { studentName: 'Alice Smith', email: 'alice@uni.edu', qumsQid: 'Q1001', qumsConnected: true, sessionExpired: false, telegramConnected: true, isSuspended: false },
    { studentName: 'Bob Jones', email: 'bob@uni.edu', qumsQid: 'Q1002', qumsConnected: true, sessionExpired: true, telegramConnected: false, isSuspended: false },
    { studentName: 'Charlie Brown', email: 'charlie@uni.edu', qumsQid: 'Q1003', qumsConnected: false, sessionExpired: false, telegramConnected: false, isSuspended: true },
  ];

  const searchRes = db.applyAdminFilters(mockRows, { search: 'alice' });
  assert.strictEqual(searchRes.length, 1);
  assert.strictEqual(searchRes[0].studentName, 'Alice Smith');

  const qidRes = db.applyAdminFilters(mockRows, { search: 'Q1002' });
  assert.strictEqual(qidRes.length, 1);
  assert.strictEqual(qidRes[0].studentName, 'Bob Jones');

  const filterExpired = db.applyAdminFilters(mockRows, { filter: 'session_expired' });
  assert.strictEqual(filterExpired.length, 1);
  assert.strictEqual(filterExpired[0].studentName, 'Bob Jones');

  const filterConnected = db.applyAdminFilters(mockRows, { filter: 'qums_connected' });
  assert.strictEqual(filterConnected.length, 2);

  const filterTg = db.applyAdminFilters(mockRows, { filter: 'telegram_connected' });
  assert.strictEqual(filterTg.length, 1);
  assert.strictEqual(filterTg[0].studentName, 'Alice Smith');

  const filterSuspended = db.applyAdminFilters(mockRows, { filter: 'suspended' });
  assert.strictEqual(filterSuspended.length, 1);
  assert.strictEqual(filterSuspended[0].studentName, 'Charlie Brown');
  console.log('PASS  2. applyAdminFilters handles search (name, email, QID) and suspended filter');

  // Test 3: admin.html exists and contains necessary elements
  const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
  assert.ok(adminHtml.includes('id="statTotalUsers"'), 'Total users stat element present');
  assert.ok(adminHtml.includes('id="statQumsConnected"'), 'QUMS connected stat element present');
  assert.ok(adminHtml.includes('id="statSessionExpired"'), 'Session expired stat element present');
  assert.ok(adminHtml.includes('id="statTelegramConnected"'), 'Telegram connected stat element present');
  assert.ok(adminHtml.includes('id="statSuspended"'), 'Suspended users stat element present');
  assert.ok(adminHtml.includes('id="healthDbBadge"'), 'Database health element present');
  assert.ok(adminHtml.includes('id="healthTgBadge"'), 'Telegram health element present');
  assert.ok(adminHtml.includes('id="healthWatcherBadge"'), 'Watcher health element present');
  assert.ok(adminHtml.includes('id="healthAssignmentBadge"'), 'Assignment watcher health element present');
  assert.ok(adminHtml.includes('id="searchInput"'), 'Search input element present');
  assert.ok(adminHtml.includes('id="filterSelect"'), 'Filter dropdown present');
  assert.ok(adminHtml.includes('value="suspended"'), 'Suspended filter option present');
  assert.ok(adminHtml.includes('btn-action'), 'Action button class present');
  assert.ok(adminHtml.includes('btn-suspend'), 'Suspend button class present');
  assert.ok(adminHtml.includes('btn-delete'), 'Delete button class present');
  assert.ok(adminHtml.includes('Not synced yet'), 'Not synced yet fallback present');
  console.log('PASS  3. public/admin.html contains all required UI components and action buttons');

  // Test 4: Database user suspension and deletion
  await db.init();
  const testUser = await db.createUser({
    email: 'user-ops@example.com',
    passwordHash: 'hash123',
  });
  assert.strictEqual(testUser.isSuspended, false, 'Default user should not be suspended');

  await db.setUserSuspended(testUser.id, true);
  const fetchedSuspended = await db.getUserById(testUser.id);
  assert.strictEqual(fetchedSuspended.isSuspended, true, 'User should be suspended in DB');

  await db.setUserSuspended(testUser.id, false);
  const fetchedUnsuspended = await db.getUserById(testUser.id);
  assert.strictEqual(fetchedUnsuspended.isSuspended, false, 'User suspension should be lifted in DB');

  await db.deleteUser(testUser.id);
  const fetchedDeleted = await db.getUserById(testUser.id);
  assert.strictEqual(fetchedDeleted, null, 'User should be deleted from DB');
  console.log('PASS  5. db.setUserSuspended and db.deleteUser modify and remove records in database');

  // Test 6: API endpoints for admin suspend and delete
  await startServer();
  try {
    const passwordHash = await bcrypt.hash('secret123', 10);

    // Create an Admin user (email matches ADMIN_EMAILS)
    const adminUser = await db.createUser({
      email: 'admin@example.com',
      passwordHash,
      isAdmin: true,
    });

    // Create a Normal target student
    const studentUser = await db.createUser({
      email: 'student-target@example.com',
      passwordHash,
    });

    // Login as Admin
    const adminLogin = await apiRequest('POST', '/api/login', {
      email: 'admin@example.com',
      password: 'secret123',
    });
    assert.strictEqual(adminLogin.status, 200, 'Admin login should succeed');
    const adminCookie = adminLogin.cookie;

    // Login as Student
    const studentLogin = await apiRequest('POST', '/api/login', {
      email: 'student-target@example.com',
      password: 'secret123',
    });
    assert.strictEqual(studentLogin.status, 200, 'Student login should succeed');
    const studentCookie = studentLogin.cookie;

    // Non-admin cannot call suspend API
    const unauthorizedSuspend = await apiRequest(
      'POST',
      `/api/admin/users/${studentUser.id}/suspend`,
      { suspended: true },
      studentCookie
    );
    assert.strictEqual(unauthorizedSuspend.status, 403, 'Normal user blocked from admin suspend endpoint');

    // Admin cannot suspend self
    const selfSuspend = await apiRequest(
      'POST',
      `/api/admin/users/${adminUser.id}/suspend`,
      { suspended: true },
      adminCookie
    );
    assert.strictEqual(selfSuspend.status, 400, 'Admin cannot suspend self');

    // Admin suspends student
    const suspendRes = await apiRequest(
      'POST',
      `/api/admin/users/${studentUser.id}/suspend`,
      { suspended: true },
      adminCookie
    );
    assert.strictEqual(suspendRes.status, 200, 'Admin suspend student succeeds');
    assert.strictEqual(suspendRes.json.isSuspended, true);

    // Verify DB state
    const dbStudent = await db.getUserById(studentUser.id);
    assert.strictEqual(dbStudent.isSuspended, true, 'Student is suspended in database');

    // Suspended student calling /api/me gets 403 ACCOUNT_SUSPENDED
    const meRes = await apiRequest('GET', '/api/me', null, studentCookie);
    assert.strictEqual(meRes.status, 403, 'Suspended user blocked from /api/me');
    assert.strictEqual(meRes.json.code, 'ACCOUNT_SUSPENDED');

    // Suspended student trying to log in gets 403 ACCOUNT_SUSPENDED
    const reloginRes = await apiRequest('POST', '/api/login', {
      email: 'student-target@example.com',
      password: 'secret123',
    });
    assert.strictEqual(reloginRes.status, 403, 'Suspended user blocked from login');
    assert.strictEqual(reloginRes.json.code, 'ACCOUNT_SUSPENDED');

    // Admin un-suspends student
    const unsuspendRes = await apiRequest(
      'POST',
      `/api/admin/users/${studentUser.id}/suspend`,
      { suspended: false },
      adminCookie
    );
    assert.strictEqual(unsuspendRes.status, 200, 'Admin unsuspend student succeeds');
    assert.strictEqual(unsuspendRes.json.isSuspended, false);

    // Admin cannot delete self
    const selfDelete = await apiRequest(
      'POST',
      `/api/admin/users/${adminUser.id}/delete`,
      null,
      adminCookie
    );
    assert.strictEqual(selfDelete.status, 400, 'Admin cannot delete self');

    // Admin deletes student
    const deleteRes = await apiRequest(
      'POST',
      `/api/admin/users/${studentUser.id}/delete`,
      null,
      adminCookie
    );
    assert.strictEqual(deleteRes.status, 200, 'Admin delete student succeeds');

    // Verify deleted in DB
    const studentAfterDelete = await db.getUserById(studentUser.id);
    assert.strictEqual(studentAfterDelete, null, 'Deleted student no longer exists in DB');
    console.log('PASS  6. Admin suspend, unsuspend, delete endpoints enforce authorization and persist in database');

    // Test 7: Admin bulk reconnect notifications (authorization, validation, skipped unlinked, sent linked)
    // 7a. Unauthorized (no cookie) -> 401 or 403
    const unauthBulk = await apiRequest('POST', '/api/admin/users/bulk-reconnect-notify', { userIds: ['any-id'] });
    assert(unauthBulk.status === 401 || unauthBulk.status === 403, 'Unauthorized request rejected');

    // 7b. Non-admin student -> 403
    const normalStudent = await db.createUser({
      email: 'student-regular@example.com',
      passwordHash: await bcrypt.hash('secret123', 10),
      isAdmin: false,
    });
    const regularLogin = await apiRequest('POST', '/api/login', {
      email: 'student-regular@example.com',
      password: 'secret123',
    });
    const regularCookie = regularLogin.cookie;
    const forbiddenBulk = await apiRequest('POST', '/api/admin/users/bulk-reconnect-notify', { userIds: [normalStudent.id] }, regularCookie);
    assert.strictEqual(forbiddenBulk.status, 403, 'Non-admin request rejected with 403');

    // 7c. Validation: empty or non-array userIds
    const invalidBulk = await apiRequest('POST', '/api/admin/users/bulk-reconnect-notify', { userIds: [] }, adminCookie);
    assert.strictEqual(invalidBulk.status, 400, 'Empty userIds array rejected');

    // 7d. Linked vs unlinked users
    const linkedUser = await db.createUser({
      email: 'student-linked@example.com',
      passwordHash: await bcrypt.hash('secret123', 10),
      isAdmin: false,
    });
    await db.setTelegramChatId(linkedUser.id, 999999);

    const unlinkedUser = await db.createUser({
      email: 'student-unlinked@example.com',
      passwordHash: await bcrypt.hash('secret123', 10),
      isAdmin: false,
    });

    const telegram = require('../src/telegram');
    const tgState = globalThis.__qumsTelegramState__;
    if (!tgState || !tgState.bot) {
      telegram.ensureSendOnlyBot();
    }
    const bot = globalThis.__qumsTelegramState__.bot;
    const origBotSendMessage = bot.sendMessage;
    bot.sendMessage = async (chatId, text) => ({
      message_id: 8888,
      chat: { id: chatId },
      text,
    });

    const bulkRes = await apiRequest(
      'POST',
      '/api/admin/users/bulk-reconnect-notify',
      { userIds: [linkedUser.id, unlinkedUser.id] },
      adminCookie
    );
    assert.strictEqual(bulkRes.status, 200, 'Bulk reconnect notify succeeded');
    assert.strictEqual(bulkRes.json.ok, true);
    assert.strictEqual(bulkRes.json.skipped.length, 1, 'Unlinked user must be skipped');
    assert.strictEqual(bulkRes.json.sent.length, 1, 'Linked user must receive notification');
    assert.strictEqual(bulkRes.json.failed.length, 0, 'No failures expected');

    // 7e. Retrying failed recipients
    bot.sendMessage = async () => { throw new Error('Simulated Telegram outage'); };
    const failRes = await apiRequest(
      'POST',
      '/api/admin/users/bulk-reconnect-notify',
      { userIds: [linkedUser.id] },
      adminCookie
    );
    assert.strictEqual(failRes.status, 200);
    assert.strictEqual(failRes.json.failed.length, 1, 'Failed recipient recorded');
    assert.strictEqual(failRes.json.sent.length, 0);

    // Retry only failed recipient after recovering
    bot.sendMessage = async (chatId, text) => ({
      message_id: 8889,
      chat: { id: chatId },
      text,
    });
    const retryRes = await apiRequest(
      'POST',
      '/api/admin/users/bulk-reconnect-notify',
      { userIds: [failRes.json.failed[0].id] },
      adminCookie
    );
    assert.strictEqual(retryRes.status, 200);
    assert.strictEqual(retryRes.json.sent.length, 1, 'Retry successfully sent to previously failed recipient');
    assert.strictEqual(retryRes.json.failed.length, 0);

    bot.sendMessage = origBotSendMessage;
    console.log('PASS  7. Admin bulk reconnect notifications enforce authorization, validate input, correctly skip unlinked accounts, and support retrying failed recipients');
  } finally {
    await stopServer();
    try {
      fs.rmSync(tmpDbDir, { recursive: true, force: true });
    } catch {}
  }

  console.log('\nALL ADMIN TESTS PASSED!');
}

run().catch((err) => {
  console.error('\nADMIN TEST FAILED:', err);
  process.exit(1);
});
