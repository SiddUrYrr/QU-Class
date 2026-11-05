/**
 * Per-user runtime resolver: DB user -> session file (+ QID for display only).
 *
 * IMPORTANT: the QUMS password is NEVER read from or written to the database.
 * ClassQU only needs the authenticated Playwright session file for monitoring;
 * the password is supplied by the user during each setup/reconnect.
 * The `.env` fallback (single-user/CLI mode) still reads QUMS_QID/QUMS_PASSWORD
 * from the environment so existing local workflows keep working.
 */
require('dotenv').config();
const path = require('path');

const ROOT_SESSION_FILE = path.join(__dirname, '..', 'session_state.json');

/**
 * user (DB row) -> { qid, sessionPath }
 * Throws with a helpful message if the user hasn't completed QUMS setup.
 */
function resolveUserRuntime(user) {
  if (!user) {
    // CLI / legacy fallback — env-based single-user mode.
    const qid = process.env.QUMS_QID;
    const password = process.env.QUMS_PASSWORD;
    if (!qid || !password) {
      const e = new Error('No user session & no .env QUMS credentials.');
      e.name = 'NoSessionError';
      e.hint = 'Register + complete QUMS setup (/register), or set QUMS_QID/QUMS_PASSWORD in .env.';
      throw e;
    }
    return { qid, sessionPath: ROOT_SESSION_FILE };
  }

  let sessionPath = user.qumsSessionPath || '';
  if (user.id) {
    try {
      const db = require('./db');
      if (typeof db.sessionPathFor === 'function') {
        const canonical = db.sessionPathFor(user.id);
        const fs = require('fs');
        if (!fs.existsSync(canonical) && user.qumsSessionData) {
          const plainJson = typeof db.decodeSessionData === 'function' ? db.decodeSessionData(user.qumsSessionData) : null;
          if (plainJson) {
            fs.mkdirSync(path.dirname(canonical), { recursive: true });
            fs.writeFileSync(canonical, plainJson, { mode: 0o600 });
          }
        }
        if (fs.existsSync(canonical) || !sessionPath) {
          sessionPath = canonical;
        }
      }
    } catch {}
  }

  if (!sessionPath || !user.qumsQid) {
    const e = new Error('QUMS setup incomplete for this user.');
    e.name = 'QumsSetupRequired';
    e.hint = 'Open the dashboard → QUMS Setup and complete the QID + captcha login.';
    throw e;
  }
  return { qid: user.qumsQid, sessionPath };
}

module.exports = { resolveUserRuntime, ROOT_SESSION_FILE };

