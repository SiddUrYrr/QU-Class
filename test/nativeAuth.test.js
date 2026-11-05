const assert = require('assert');
const {
  normalizeEmail,
  validEmail,
  validatePassword,
  createResetToken,
  hashResetToken,
} = require('../src/auth');

assert.strictEqual(normalizeEmail('  Student@Example.COM '), 'student@example.com');
assert.strictEqual(validEmail('student@example.com'), true);
assert.strictEqual(validEmail('not-an-email'), false);
assert.ok(validatePassword('short'));
assert.ok(validatePassword('letters-only-password'));
assert.strictEqual(validatePassword('ClassQU2026'), '');

const token = createResetToken();
assert.strictEqual(token.length, 64);
assert.notStrictEqual(hashResetToken(token), token);
assert.strictEqual(hashResetToken(token), hashResetToken(token));
assert.notStrictEqual(hashResetToken(token), hashResetToken(createResetToken()));

console.log('ALL NATIVE AUTH HELPER TESTS PASSED');
