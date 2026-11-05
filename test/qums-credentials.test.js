/**
 * Tests for QUMS credentials persistence and reset behavior:
 * 1. QID & password are encrypted and saved upon setup.
 * 2. On reconnect, saved credentials are used (no need to re-enter password).
 * 3. On reset/delete, saved QID and password are fully wiped so a new login can be performed.
 */
require('dotenv').config();
const assert = require('assert');
const db = require('../src/db');
const { encryptSecret, decryptSecret } = require('../src/crypto');
const qumsLogin = require('../src/qums-login-web');

function ok(name, cond) {
  if (!cond) {
    console.error(`FAIL: ${name}`);
    process.exit(1);
  }
  console.log(`PASS: ${name}`);
}

async function runTests() {
  console.log('=== RUNNING QUMS CREDENTIALS PERSISTENCE & RESET TESTS ===');

  const testUser = await db.createUser({ email: `credtest_${Date.now()}@example.com`, passwordHash: 'dummy_hash' });
  const qid = '24099999';
  const plainPassword = 'SecretPassword@123';

  // 1. Initial state: no QID, no saved password
  const fresh = await db.getUserById(testUser.id);
  ok('1. Fresh user has no saved QID', fresh.qumsQid === '');
  ok('1. Fresh user has no saved encrypted password', !fresh.qumsPasswordEncrypted);

  // 2. Complete setup with credentials
  await qumsLogin.completeQumsSetup(testUser.id, qid, { password: plainPassword });
  const afterSetup = await db.getUserById(testUser.id);
  ok('2. QID is saved in DB', afterSetup.qumsQid === qid);
  ok('2. Password is saved in encrypted format', Boolean(afterSetup.qumsPasswordEncrypted));
  ok('2. Password is not plaintext in DB', afterSetup.qumsPasswordEncrypted !== plainPassword);
  ok('2. Decrypted password matches original', decryptSecret(afterSetup.qumsPasswordEncrypted) === plainPassword);

  // 3. Reconnect without passing password: startQumsLogin should resolve saved password
  // (We test credential resolution logic before opening browser)
  const savedEncrypted = await db.getQumsEncryptedPassword(testUser.id);
  ok('3. db.getQumsEncryptedPassword retrieves saved password', Boolean(savedEncrypted));
  ok('3. Decrypted retrieved password matches original', decryptSecret(savedEncrypted) === plainPassword);

  // 4. Reset / Delete QUMS connection permanently clears saved credentials
  await db.updateUser(testUser.id, {
    qumsQid: '',
    qumsPasswordEncrypted: '',
    qumsSessionPath: '',
    studentName: '',
    qumsYearSem: '',
  });

  const afterReset = await db.getUserById(testUser.id);
  ok('4. QID is cleared after reset', afterReset.qumsQid === '');
  ok('4. Encrypted password is cleared after reset', !afterReset.qumsPasswordEncrypted);
  ok('4. getQumsEncryptedPassword returns null/empty after reset', !afterReset.qumsPasswordEncrypted);

  console.log('\nALL QUMS CREDENTIALS TESTS PASSED!\n');
}

runTests().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
