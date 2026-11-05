/**
 * AES-256-GCM encryption for QUMS passwords at rest.
 * Key: ENCRYPTION_KEY env var (koi bhi lambi random string) -> 32-byte key
 * derived via scrypt, so length/format pe strict dependency nahi.
 *
 * Generate:  node -e "console.log(require('crypto').randomBytes(24).toString('base64'))"
 */
require('dotenv').config();
const crypto = require('crypto');

const SALT = 'qums-attendance-bot-v1';

function getKey() {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) {
    throw new Error(
      'ENCRYPTION_KEY missing in .env — generate: node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'base64\'))"'
    );
  }
  return crypto.scryptSync(secret, SALT, 32);
}

/** plain -> base64(iv.tag.ciphertext) */
function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

/** base64(iv.tag.ciphertext) -> plain (galat key pe null) */
function decryptSecret(encoded) {
  try {
    const buf = Buffer.from(String(encoded), 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null; // wrong key / tampered
  }
}

module.exports = { encryptSecret, decryptSecret };
