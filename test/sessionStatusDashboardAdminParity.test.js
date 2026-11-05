/**
 * Regression Test: Admin and Student Dashboard Status Parity
 * test/sessionStatusDashboardAdminParity.test.js
 *
 * Verifies:
 * 1. Confirmed expiry appears consistently in Admin (/api/admin/users) and Student (/api/me).
 * 2. Confirmed successful recovery clears stale expiry state and produces consistent 'active' status.
 * 3. Missing local session file alone does NOT mark a user expired.
 * 4. Setup-pending state remains consistent across both endpoints.
 * 5. Sensitive credentials, passwords, and session tokens are never leaked to clients.
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

// Use isolated temporary database
const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qattend-parity-test-'));
const tmpDbFile = path.join(tmpDbDir, 'db.json');
process.env.DB_FILE = tmpDbFile;
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAILS = 'admin@example.com';
process.env.SESSION_SECRET = 'test-session-secret-parity';

const db = require('../src/db');
const app = require('../src/server');

const bcrypt = require('bcryptjs');
const testPasswordHash = bcrypt.hashSync('password123', 8);

let server;
let baseUrl;

async function startServer() {
  await db.init();
  return new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
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
  return { status: res.status, json, text, cookie: retCookie };
}

async function runTests() {
  console.log('=== RUNNING SESSION STATUS DASHBOARD / ADMIN PARITY TESTS ===\n');
  await startServer();

  try {
    // 1. Setup Admin user and login
    const adminUser = await db.createUser({
      email: 'admin@example.com',
      passwordHash: testPasswordHash,
      isAdmin: true,
    });

    const adminLoginRes = await apiRequest('POST', '/api/login', {
      email: 'admin@example.com',
      password: 'password123',
    });
    assert.strictEqual(adminLoginRes.status, 200, 'Admin login should succeed');
    const adminCookie = adminLoginRes.cookie;

    // 2. Setup Student 1 (Active session with disk file)
    const sessionDir = path.join(tmpDbDir, 'sessions');
    fs.mkdirSync(sessionDir, { recursive: true });
    const s1File = path.join(sessionDir, 'student1.json');
    fs.writeFileSync(s1File, JSON.stringify({ cookies: ['sid=123'] }));

    const student1 = await db.createUser({
      email: 'student1@example.com',
      passwordHash: testPasswordHash,
    });
    const s1SessionJson = JSON.stringify({ cookies: [{ name: 'sid', value: '123' }] });
    await db.saveUserSessionData(student1.id, s1SessionJson);
    await db.updateUser(student1.id, {
      studentName: 'Student One',
      qumsQid: 'Q1001',
      qumsSessionPath: s1File,
      qumsSessionStatus: 'active',
    });
    const s1LoginRes = await apiRequest('POST', '/api/login', {
      email: 'student1@example.com',
      password: 'password123',
    });
    const s1Cookie = s1LoginRes.cookie;

    // --- TEST 1: Initial active session status parity ---
    const s1MeRes = await apiRequest('GET', '/api/me', null, s1Cookie);
    assert.strictEqual(s1MeRes.status, 200);
    assert.strictEqual(s1MeRes.json.qumsConfigured, true, 'Student 1 qumsConfigured must be true');
    assert.strictEqual(s1MeRes.json.qumsSessionStatus, 'active', 'Student 1 qumsSessionStatus must be active');

    const adminUsersRes1 = await apiRequest('GET', '/api/admin/users', null, adminCookie);
    const adminS1 = adminUsersRes1.json.users.find((u) => u.id === student1.id);
    assert(adminS1, 'Student 1 must appear in admin users list');
    assert.strictEqual(adminS1.sessionExpired, false, 'Admin must report sessionExpired=false');
    assert.strictEqual(adminS1.qumsConnected, true, 'Admin must report qumsConnected=true');
    assert.strictEqual(adminS1.qumsSessionStatus, 'active', 'Admin must report qumsSessionStatus=active');
    console.log('PASS  1. Active session reports consistent "active" status in /api/me and /api/admin/users');

    // --- TEST 2: Confirmed expiry parity ---
    await db.markSessionExpired(student1.id, 'session-expired');

    const s1MeExpired = await apiRequest('GET', '/api/me', null, s1Cookie);
    assert.strictEqual(s1MeExpired.json.qumsSessionStatus, 'expired', '/api/me must report expired');
    assert.strictEqual(s1MeExpired.json.qumsConfigured, true, '/api/me must keep qumsConfigured=true so user can reconnect');

    const adminUsersRes2 = await apiRequest('GET', '/api/admin/users', null, adminCookie);
    const adminS1Expired = adminUsersRes2.json.users.find((u) => u.id === student1.id);
    assert.strictEqual(adminS1Expired.sessionExpired, true, 'Admin must report sessionExpired=true');
    assert.strictEqual(adminS1Expired.qumsSessionStatus, 'expired', 'Admin must report qumsSessionStatus=expired');
    console.log('PASS  2. Confirmed expiry appears consistently in /api/me and /api/admin/users');

    // --- TEST 3: Confirmed successful recovery clears stale expiry state ---
    await db.clearSessionExpiry(student1.id);

    const s1MeRecovered = await apiRequest('GET', '/api/me', null, s1Cookie);
    assert.strictEqual(s1MeRecovered.json.qumsSessionStatus, 'active', '/api/me must return to active');

    const adminUsersRes3 = await apiRequest('GET', '/api/admin/users', null, adminCookie);
    const adminS1Recovered = adminUsersRes3.json.users.find((u) => u.id === student1.id);
    assert.strictEqual(adminS1Recovered.sessionExpired, false, 'Admin sessionExpired must be cleared');
    assert.strictEqual(adminS1Recovered.qumsSessionStatus, 'active', 'Admin qumsSessionStatus must be active');
    console.log('PASS  3. Confirmed recovery clears expiry and synchronizes both dashboards to "active"');

    // --- TEST 4: Missing local session file alone does not mark user expired ---
    const s2Canonical = db.sessionPathFor(student1.id);
    // Remove local file
    if (fs.existsSync(s1File)) fs.unlinkSync(s1File);
    if (fs.existsSync(s2Canonical)) fs.unlinkSync(s2Canonical);

    // Give student1 valid encrypted session data in DB
    const plainSession = JSON.stringify({ cookies: ['sid=recovered'] });
    const encodedData = db.saveUserSessionData ? db.saveUserSessionData(student1.id, plainSession) : null;
    await db.updateUser(student1.id, { qumsSessionPath: s2Canonical, qumsSessionData: encodedData });

    // Ensure user status in DB is active
    await db.updateUser(student1.id, { qumsSessionStatus: 'active' });

    const s1MeRestored = await apiRequest('GET', '/api/me', null, s1Cookie);
    assert.strictEqual(s1MeRestored.json.qumsSessionStatus, 'active', 'Missing disk file must NOT mark user expired');
    assert.strictEqual(s1MeRestored.json.qumsConfigured, true, 'qumsConfigured must be true because DB has session');

    const adminUsersRes4 = await apiRequest('GET', '/api/admin/users', null, adminCookie);
    const adminS1Restored = adminUsersRes4.json.users.find((u) => u.id === student1.id);
    assert.strictEqual(adminS1Restored.sessionExpired, false, 'Admin must NOT report sessionExpired=true on missing file');
    assert.strictEqual(adminS1Restored.qumsSessionStatus, 'active', 'Admin qumsSessionStatus must remain active');
    console.log('PASS  4. Missing local file on ephemeral disk alone does not mark user expired');

    // --- TEST 5: Setup-pending user parity ---
    const student2 = await db.createUser({
      email: 'student2@example.com',
      passwordHash: testPasswordHash,
      studentName: 'Student Two',
      qumsSessionPath: null,
      qumsSessionData: null,
      qumsSessionStatus: null,
    });
    const s2LoginRes = await apiRequest('POST', '/api/login', {
      email: 'student2@example.com',
      password: 'password123',
    });
    const s2Cookie = s2LoginRes.cookie;

    const s2Me = await apiRequest('GET', '/api/me', null, s2Cookie);
    assert.strictEqual(s2Me.json.qumsConfigured, false, 'Not setup student must have qumsConfigured=false');
    assert.strictEqual(s2Me.json.qumsSessionStatus, 'not_setup', 'Not setup student must have qumsSessionStatus=not_setup');

    const adminUsersRes5 = await apiRequest('GET', '/api/admin/users', null, adminCookie);
    const adminS2 = adminUsersRes5.json.users.find((u) => u.id === student2.id);
    assert.strictEqual(adminS2.sessionExpired, false);
    assert.strictEqual(adminS2.qumsConnected, false);
    assert.strictEqual(adminS2.qumsSessionStatus, 'not_setup');
    console.log('PASS  5. Setup-pending user is consistent in both dashboards');

    // --- TEST 6: Sensitive credential isolation ---
    assert.strictEqual(s1MeRes.json.passwordHash, undefined, 'passwordHash must not leak in /api/me');
    assert.strictEqual(s1MeRes.json.qumsSessionData, undefined, 'qumsSessionData must not leak in /api/me');
    assert.strictEqual(adminS1.passwordHash, undefined, 'passwordHash must not leak in /api/admin/users');
    assert.strictEqual(adminS1.qumsSessionData, undefined, 'qumsSessionData must not leak in /api/admin/users');
    console.log('PASS  6. Sensitive credentials and session data are never exposed');

    console.log('\nALL PARITY TESTS PASSED SUCCESSFULLY!');
  } finally {
    await stopServer();
    try {
      fs.rmSync(tmpDbDir, { recursive: true, force: true });
    } catch {}
  }
}

runTests().catch((err) => {
  console.error('TEST FAILURE:', err);
  process.exit(1);
});
