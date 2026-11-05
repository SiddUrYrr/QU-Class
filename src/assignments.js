/**
 * Assignment notifications (Parts 5/6/7) — MULTI-USER.
 *
 * Data source (verified live against the QUMS portal):
 *   POST /Web_StudentAcademic/GetStudentAssignment { RegID }
 *     -> { state, state2 } (see src/scraper.js scrapeAssignments)
 *
 * 1) NEW-ASSIGNMENT notifications (Part 5/6):
 *    - every ASSIGNMENT_INTERVAL_MINUTES (default 30), all users with a linked
 *      QUMS session
 *    - dedupe fingerprint (Part 6) is user-scoped and stored in the existing DB
 *      (known_assignments, same JSONB pattern as known_attendance)
 *    - mark-before-send + rollback on failure — duplicates IMPOSSIBLE
 *      (same contract as the month-register backdated loop in watcher.js)
 *
 * 2) DEADLINE reminders (Part 7):
 *    - cron at 19:00 IST (Asia/Kolkata) — ONE reminder per assignment whose
 *      QUMS deadline (DATETO) is TODAY
 *    - reminder fingerprint: reminder:<id|fp>:<deadlineYMD> — once per
 *      assignment per deadline date; reminders on earlier days never happen
 *      because the check only matches deadline === today (IST)
 *
 * Standalone:
 *   node src/assignments.js --now        -> one real pass, all users
 *   node src/assignments.js --test       -> simulated cycles, DRY-RUN
 */
require('dotenv').config();
// --test must never touch the real data/db.json — isolate it BEFORE requiring db.
if (process.argv.includes('--test') && !process.env.DB_FILE) {
  const os = require('os');
  process.env.DB_FILE = require('path').join(os.tmpdir(), `qums-assign-test-${Date.now()}.json`);
}
const fs = require('fs');
const cron = require('node-cron');
const db = require('./db');
const { scrapeAssignments, qumsDateToYMD } = require('./scraper');
const { sendMessage, deleteMessage } = require('./telegram');
const { formatNewAssignment, formatAssignmentDeadlineReminder } = require('./messages');
const { maybeNotifySessionExpired } = require('./alerts');

const TIMEZONE = 'Asia/Kolkata';
const REMINDER_CRON = '0 19 * * *'; // 7:00 PM IST, every day
const ASSIGNMENT_INTERVAL_MINUTES = Number(process.env.ASSIGNMENT_INTERVAL_MINUTES || 30);

/** Assignment types the QUMS page treats as teacher-published work. */
const ASSIGNMENT_TYPES = new Set([
  'assignment',
  'quiz',
  'class test',
  'internal',
  'open book/practical write-up',
]);

const istNow = () => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hhmm: `${get('hour')}:${get('minute')}` };
};

/**
 * Stable fingerprint from the ACTUAL assignment fields (Part 6) — used when
 * QUMS gives no unique AssignmentDetailID. Only real fields go in.
 */
function assignmentFingerprint(a) {
  return [a.title, a.subject, a.deadlineYMD || '', a.assignedYMD || '', a.ext || '']
    .map((s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase())
    .join('|');
}

/** Dedupe identity for one assignment row. */
function assignmentKey(a) {
  return a.id ? `new:${a.id}` : `new:${assignmentFingerprint(a)}`;
}

/** One reminder per assignment per deadline date. */
function reminderKey(a, deadlineYMD) {
  return `reminder:${a.id || assignmentFingerprint(a)}:${deadlineYMD}`;
}

/**
 * Pure: which rows deserve a "New Assignment" notification?
 * - must have a title
 * - type must be a teacher-published assignment type, OR the row carries a
 *   real deadline (a dated row means an assignment was actually set)
 * - not already notified for this user (knownAssignments keys)
 * - in-batch duplicates deduped
 */
function pendingNewAssignments(rows, knownKeys) {
  const seen = new Set();
  const known = new Set(knownKeys || []);
  const out = [];
  for (const a of rows || []) {
    if (!a || !a.title) continue;
    const typeOk =
      ASSIGNMENT_TYPES.has(String(a.type || '').toLowerCase()) ||
      Boolean(a.deadlineYMD);
    if (!typeOk) continue;
    const key = assignmentKey(a);
    if (known.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...a, key });
  }
  return out;
}

/**
 * Pure: rows whose QUMS deadline (DATETO) equals the given IST date (default:
 * today) AND that have not already received their reminder.
 * No deadline on the row -> NEVER reminded (we do not guess deadlines).
 */
function pendingDeadlineReminders(rows, knownKeys, todayYMD = istNow().date) {
  const known = new Set(knownKeys || []);
  const seen = new Set();
  const out = [];
  for (const a of rows || []) {
    if (!a || !a.title) continue;
    const dYMD = a.deadlineYMD || qumsDateToYMD(a.deadlineRaw);
    if (!dYMD || dYMD !== todayYMD) continue; // not today -> nothing (no guessing)
    const key = reminderKey(a, dYMD);
    if (known.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...a, key, deadlineYMD: dYMD });
  }
  return out;
}

/**
 * One assignment cycle for ONE user (injectable fetch/send for tests).
 * mode: 'new' (new-assignment notifications) | 'reminders' (deadline day).
 */
async function runAssignmentCycle(opts = {}) {
  const log = opts.log || console;
  const userId = opts.userId;
  if (!userId) throw new Error('runAssignmentCycle: userId required');
  const mode = opts.mode || 'new';
  const fetchFn = opts.fetchFn || ((u) => scrapeAssignments({ sessionPath: u.qumsSessionPath }));
  const defaultSendFn = async (text, sendOptions = {}) => {
    // Assignment notifications disabled by default per user request (enable via ENABLE_ASSIGNMENTS=true)
    if (process.env.ENABLE_ASSIGNMENTS !== 'true') {
      log.log(`[assignments] notification suppressed for user=${userId} (assignment notifications currently disabled)`);
      return { ok: true, suppressed: true };
    }
    const sOpts = { category: 'ASSIGNMENT', ...sendOptions };
    const ok = await sendMessage(userId, text, log, sOpts);
    if (sendOptions && sOpts.messageId) {
      sendOptions.messageId = sOpts.messageId;
    }
    return { ok, messageId: sOpts.messageId };
  };
  const sendFn = opts.sendFn || defaultSendFn;
  const deleteFn = opts.deleteFn || ((msgId) => deleteMessage(userId, msgId, log));
  const todayYMD = opts.todayYMD || istNow().date;

  const knownRecords = await db.listKnownAssignments(userId);
  const knownKeys = knownRecords.map((r) => r.key).filter(Boolean);
  const rows = opts.rows || (await fetchFn(opts.user));

  // Issue 5, Rule E: Check for resolved / uploaded assignments to delete their Telegram notification
  // Keep notifications visible while pending/unuploaded; when confirmed upload (uploadFlag === 1),
  // delete only corresponding notification message(s).
  if (rows && rows.length && knownRecords && knownRecords.length) {
    for (const rec of knownRecords) {
      if (!rec.telegramMessageId) continue;
      const matchingRow = rows.find((r) => {
        if (!r) return false;
        if (rec.assignmentId && r.id && String(rec.assignmentId) === String(r.id)) return true;
        if (rec.key === assignmentKey(r)) return true;
        if (rec.title && r.title && rec.title.toLowerCase() === r.title.toLowerCase() && (!rec.subject || !r.subject || rec.subject.toLowerCase() === r.subject.toLowerCase())) return true;
        return false;
      });

      if (matchingRow && (matchingRow.uploadFlag === 1 || matchingRow.isUploaded === true)) {
        try {
          await deleteFn(rec.telegramMessageId);
          log.log(`[assignment] user=${userId} deleted notification for uploaded assignment ${rec.key} (msgId=${rec.telegramMessageId})`);
          await db.updateKnownAssignmentMessageId(userId, rec.key, null);
          rec.telegramMessageId = null;
        } catch (delErr) {
          log.error(`[assignment] failed to delete notification for uploaded assignment ${rec.key}: ${delErr.message}`);
        }
      }
    }
  }

  const pending =
    mode === 'reminders'
      ? pendingDeadlineReminders(rows, knownKeys, todayYMD)
      : pendingNewAssignments(rows, knownKeys);

  const sent = [];
  for (const a of pending) {
    const text = mode === 'reminders' ? formatAssignmentDeadlineReminder(a) : formatNewAssignment(a);
    // Mark-before-send: mark BEFORE the send; rollback on failure so the next
    // cycle retries — a duplicate can never go out (same as watcher.js).
    await db.addKnownAssignments(userId, [{ key: a.key, kind: mode, assignmentId: a.id || '', title: a.title, subject: a.subject, deadline: a.deadlineYMD || '' }]);
    try {
      if (opts.dryRun) {
        log.log(`[assignments] (dry-run) would send to ${opts.userEmail || 'user'}:\n${text}\n`);
      } else {
        const sendOptions = {};
        const sendRes = await sendFn(text, sendOptions);
        const sentMsgId = (sendRes && typeof sendRes === 'object' && sendRes.messageId) || sendOptions.messageId;
        if (sentMsgId) {
          await db.updateKnownAssignmentMessageId(userId, a.key, sentMsgId);
        }
        log.log(`[telegram] user=${userId} notification sent kind=${mode === 'reminders' ? 'assignment_deadline' : 'assignment_new'}`);
        log.log(`[assignment] user=${userId} sent ${mode}: ${a.key} — ${a.title}`);
        await db.recordNotification(userId, mode === 'reminders' ? 'assignment_deadline' : 'assignment_new', { subject: a.subject }, log);
      }
      sent.push({ key: a.key, title: a.title, subject: a.subject, deadline: a.deadlineYMD || '' });
    } catch (err) {
      await db.removeKnownAssignment(userId, a.key); // rollback -> retry next cycle
      log.error(`[assignments] send FAILED for ${a.key}: ${err.message} — will retry next cycle`);
    }
  }
  return { mode, total: rows.length, notified: sent };
}

/** One pass over ALL users with a linked QUMS session. */
async function runAssignmentPass(log = console, { mode = 'new', dryRun = false } = {}) {
  const allUsers = (await db.allUsers()).filter((u) => u.qumsSessionPath);
  const users = [];
  for (const user of allUsers) {
    if (user.qumsSessionStatus === 'expired') {
      const state = await db.getSessionExpiryState(user.id).catch(() => null);
      if (!state || !state.lastAlertAt) {
        await maybeNotifySessionExpired(log, user.id, { evidence: true }).catch(() => {});
      }
      log.log(`[Watcher] Skipping user ${user.id}: QUMS session unavailable.`);
      continue;
    }
    await db.ensureSessionOnDisk(user).catch(() => {});
    if (!user.qumsSessionPath || !fs.existsSync(user.qumsSessionPath)) {
      log.log(`[Watcher] Skipping user ${user.id}: QUMS session unavailable.`);
      continue;
    }
    users.push(user);
  }
  if (!users.length) {
    log.log('[assignments] no user has a linked QUMS session — pass skip.');
    return { users: 0 };
  }
  log.log(`[assignments] ${mode} pass started for ${users.length} user(s)...`);
  if (mode === 'reminders') assignmentStatus.lastReminderAt = new Date().toISOString();
  else assignmentStatus.lastNewAt = new Date().toISOString();
  assignmentStatus.lastUsers = users.length;
  let notified = 0;
  for (const user of users) {
    try {
      const startedAt = Date.now();
      // eslint-disable-next-line no-await-in-loop
      const r = await runAssignmentCycle({
        log,
        userId: user.id,
        userEmail: user.email,
        user,
        mode,
        dryRun,
        fetchFn: (u) => scrapeAssignments({ sessionPath: u.qumsSessionPath }),
      });
      notified += (r.notified || []).length;
      await db.clearSessionExpiry(user.id, { maxExpiredAt: startedAt }).catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      await db.touchUserSync(user.id, { assignment: true, error: '' });
      log.log(`[assignment] user=${user.id} checked assignments (mode=${mode}, found=${(r.notified || []).length})`);
    } catch (err) {
      log.error(`[assignment] user=${user.id} pass FAILED: ${err.name || 'Error'}: ${err.message}`);
      if (err.name === 'SessionExpiredError') {
        await db.updateUser(user.id, { qumsSessionStatus: 'expired' }).catch(() => {});
        // eslint-disable-next-line no-await-in-loop
        await maybeNotifySessionExpired(log, user.id, { evidence: true });
      } else {
        // Temporary outage: never treated as session expiry (no Telegram spam).
        // eslint-disable-next-line no-await-in-loop
        await maybeNotifySessionExpired(log, user.id, { evidence: false });
      }
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => setTimeout(res, 500)); // stagger users
  }
  log.log(`[assignments] ${mode} pass done: ${notified} notification(s).`);
  return { users: users.length, notified };
}

/** Arm the 7:00 PM IST deadline-reminder cron + the new-assignment polling loop. */
/** Real worker status for the admin System Health panel (no fakes). */
const assignmentStatus = { armed: false, lastNewAt: null, lastReminderAt: null, lastUsers: 0, lastError: '' };
function getAssignmentStatus() { return { ...assignmentStatus }; }

function startAssignmentWatcher(log = console) {
  assignmentStatus.armed = true;
  const reminderTask = cron.schedule(REMINDER_CRON, () => {
    if (process.env.ENABLE_ASSIGNMENTS === 'true') {
      runAssignmentPass(log, { mode: 'reminders' });
    } else {
      log.log('[assignments] deadline reminder skipped (assignment notifications currently disabled)');
    }
  }, { timezone: TIMEZONE });

  const minutes = ASSIGNMENT_INTERVAL_MINUTES;
  let busy = false;
  const pollTask = cron.schedule(`*/${Math.max(1, minutes)} * * * *`, async () => {
    if (busy) return;
    busy = true;
    try {
      if (process.env.ENABLE_ASSIGNMENTS === 'true') {
        await runAssignmentPass(log, { mode: 'new' });
      }
    } catch (err) {
      assignmentStatus.lastError = err.message;
      log.error(`[assignments] new-assignment pass failed: ${err.name || 'Error'}: ${err.message}`);
    } finally {
      busy = false;
    }
  }, { timezone: TIMEZONE });

  log.log(`[assignments] armed — new-assignment check every ${minutes} min + deadline reminders "${REMINDER_CRON}" (${TIMEZONE})`);
  return [reminderTask, pollTask];
}

module.exports = {
  startAssignmentWatcher,
  getAssignmentStatus,
  runAssignmentCycle,
  runAssignmentPass,
  pendingNewAssignments,
  pendingDeadlineReminders,
  assignmentKey,
  assignmentFingerprint,
  reminderKey,
  istNow,
  ASSIGNMENT_TYPES,
  ASSIGNMENT_INTERVAL_MINUTES,
  REMINDER_CRON,
  TIMEZONE,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  (async () => {
    if (args.includes('--test')) {
      console.log('=== ASSIGNMENT SIMULATION (dry-run, isolated temp DB) ===');
      const rows = [
        { id: 'A1', title: 'OOP Assignment', subject: 'Java', teacher: 'DEEPAK BHATT', type: 'Assignment', assignedYMD: '2026-09-24', deadlineYMD: '2026-09-25', source: 'state' },
      ];
      const cyc = (mode, todayYMD) => runAssignmentCycle({
        userId: 'assignment-test-dummy',
        mode,
        rows,
        dryRun: true,
        todayYMD,
        fetchFn: async () => rows,
        sendFn: async () => true,
      });
      console.log('--- cycle 1 (new) ---'); await cyc('new');
      console.log('--- cycle 2 (new, same rows -> must be empty) ---'); await cyc('new');
      console.log('--- reminder on deadline day 2026-09-25 ---'); await cyc('reminders', '2026-09-25');
      console.log('--- reminder AGAIN (must be empty) ---'); await cyc('reminders', '2026-09-25');
      console.log('Expected: ONE new-assignment notification + ONE reminder only.');
      process.exit(0);
    }
    await runAssignmentPass(console, { mode: args.includes('--reminders') ? 'reminders' : 'new' });
    process.exit(0);
  })().catch((err) => {
    console.error(`[x] ${err.name || 'Error'}: ${err.message}`);
    process.exit(1);
  });
}
