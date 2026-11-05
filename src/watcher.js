/**
 * Real-time per-class Telegram watcher — MULTI-USER.
 *
 * TWO polling loops chalte hain:
 *
 * 1) TODAY'S ATTENDANCE (fast loop):
 *   - every WATCH_INTERVAL_MINUTES (default 5), but ONLY during college hours
 *     (08:30–17:00 IST)
 *   - for EVERY registered user with a linked QUMS session, the watcher polls
 *     TODAY's periods using that user's own session file
 *   - a period goes from "N.M." (not marked) to P/A when the teacher marks it;
 *     on first sighting the user gets a Telegram alert (teacher + subject +
 *     period + date + marked-you-as), sent TO THE USER'S OWN Telegram chat
 *   - per-user dedupe state: data/notified_periods/<userId>.json
 *     (event key = period + subjectCode + STATUS — `P2-CS30201:present`;
 *      userId scoping file se aata hai, date scope file ke andar `state[date]` se)
 *     -> duplicates NEVER go out (state marked BEFORE send; rollback on failure)
 *     -> legacy keys (`P2-CS30201`, bina status) bhi suppress karte hain —
 *        upgrade/restart ke baad koi duplicate alert NAHI (Test D safe)
 *
 * 2) MONTH REGISTER (backdated loop):
 *   - every MONTH_REGISTER_INTERVAL_MINUTES (default 10 — user ko near-real-time
 *     updates chahiye; backdated marking bhi jaldi pakdi jaati hai)
 *   - POST /Web_StudentAcademic/GetMonthRegister { RegID, Month } se current
 *     month ke saare MARKED records (P/A/L) aate hain
 *   - jo record db "known_attendance" me nahi hai => naya (backdated) marking
 *     => Telegram alert: "{Teacher} ne {Date} ko {Subject} ({Code}) ka
 *        attendance mark kiya / Status: ✅/❌"
 *   - teacher Month Register API me NAHI hota -> timetable cross-match
 *     (sirf tab jab pending notifications hon — browser launch bachane ke liye)
 *   - FIRST run bootstrap: poora current month silently seed hota hai (koi
 *     alert-storm nahi); uske baad sirf naye (backdated) records alert karte hain
 *   - dup-guard: college hours ke andar aaj ke marks fast loop (5 min) se aate
 *     hain, month loop unhe skip karta hai; bahar hours (evening) aaj ke naye
 *     marks month loop hi turant alert karta hai
 *
 * Sends user ke APNE Telegram chat pe jaate hain (deep-link se linked —
 * src/telegram.js). Link na ho to sends silently skip hote hain.
 *
 * IMPORTANT: polling only works while the server runs (see README limitations).
 *
 * Standalone:
 *   node src/watcher.js --test          -> simulated cycles, DRY-RUN (no real send)
 *   node src/watcher.js --test --send   -> simulated cycles with REAL Telegram send
 *   node src/watcher.js --now [--force] -> one real cycle now for all users
 *   node src/watcher.js --month-test [--send] -> month-register simulation
 *   node src/watcher.js --month-now     -> one real month-register pass now
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./db');
const {
  scrapeTodaysAttendance,
  scrapeMonthRegister,
  scrapeMonthRegisterRange,
  scrapeTimetable,
  getTimetableForDate,
  teacherForRecord,
  roomForRecord,
} = require('./scraper');
const { sendMessage } = require('./telegram');
const { formatAttendanceUpdate, formatBackdatedUpdate, dateLabelIST } = require('./messages');
const { maybeNotifySessionExpired } = require('./alerts');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PER_USER_STATE_DIR = path.join(DATA_DIR, 'notified_periods');
const LEGACY_STATE_FILE = path.join(DATA_DIR, 'notified_periods.json');
const TEST_STATE_FILE = path.join(DATA_DIR, 'notified_periods.test.json');

const COLLEGE_START_HOUR = 8.5; // 08:30 IST
const COLLEGE_END_HOUR = 17; // 17:00 IST

function stateFileFor(userId) {
  return path.join(PER_USER_STATE_DIR, `${userId}.json`);
}

/**
 * 15D — user-scoped ATTENDANCE EVENT key (fast loop).
 * userId scoping: har user ka APNA state file (data/notified_periods/<userId>.json)
 * — kabhi koi global map nahi. Event identity: period + subjectCode + STATUS,
 * e.g. `P2-CS30201:present` vs `P2-CS30201:absent` = alag events (N.M.->P aur
 * P->A status-correction dono "attendance change" hain). Date scope state file
 * ke andar `state[date]` se aata hai.
 */
function eventKeyFor(row) {
  return `${row.key}:${row.status || 'marked'}`;
}

/** Current IST time parts: { date 'YYYY-MM-DD', hourDecimal, hhmm } */
function istNow(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(d);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
  const hour = Number(get('hour')) % 24; // some Node versions render midnight as "24"
  const minute = Number(get('minute'));
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour,
    minute,
    hourDecimal: hour + minute / 60,
    hhmm: `${String(hour).padStart(2, '0')}:${get('minute')}`,
  };
}

function isWithinCollegeHours(hourDecimal) {
  return hourDecimal >= COLLEGE_START_HOUR && hourDecimal < COLLEGE_END_HOUR;
}

function loadState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

// Timetable cache (60 min TTL) — room enrichment + teacher cross-match ke liye.
// Har pass pe headless browser launch mehenga hota hai, isliye cache rakhte hain.
const TIMETABLE_TTL_MS = 60 * 60 * 1000;
const timetableCache = new Map(); // userId -> { at, timetable }

async function getTimetableCached(userId, sessionPath, log = console) {
  const hit = timetableCache.get(userId);
  if (hit && Date.now() - hit.at < TIMETABLE_TTL_MS) return hit.timetable;
  try {
    const timetable = await scrapeTimetable({ sessionPath });
    timetableCache.set(userId, { at: Date.now(), timetable });
    return timetable;
  } catch (err) {
    log.log(`[watcher] timetable refresh fail (${err.name}: ${err.message}) — ${hit ? 'stale cache use kar rahe hain' : 'room/teacher enrichment is cycle me skip'}`);
    return hit ? hit.timetable : null;
  }
}

/** aaj ke timetable periods se subjectCode -> room map */
function roomMapFromPeriods(periods) {
  const map = {};
  for (const p of periods || []) {
    if (p.subjectCode && !(p.subjectCode in map)) map[p.subjectCode] = p.room || '';
  }
  return map;
}

/**
 * Pure: which rows need a notification? (marked + not already notified + deduped in-batch)
 * 15D/15E: event key me STATUS bhi hai. Purane state files ke LEGACY keys
 * (`P2-CS30201`, bina status) bhi suppress karte hain — server restart/upgrade
 * ke baad already-notified period ka duplicate alert KABHI nahi jaayega.
 */
function pendingNotifications(rows, notifiedKeys) {
  const seen = new Set(notifiedKeys || []);
  const out = [];
  for (const row of rows || []) {
    if (!row || row.status === 'unmarked') continue;
    if (!row.key) continue;
    const eventKey = eventKeyFor(row);
    if (seen.has(eventKey) || seen.has(row.key)) continue; // row.key = legacy key (bina status)
    seen.add(eventKey); // also dedupes duplicates inside one fetch
    out.push(row);
  }
  return out;
}

/**
 * Evidence-based failure classification for watcher cycles.
 * Only a real login-page response (SessionExpiredError) may trigger the
 * user-facing reconnect alert; a temporary QUMS outage must stay silent
 * (no Telegram spam) — requirement: never treat a timeout as expiry.
 */
async function handleCycleError(log, userId, err) {
  if (err && err.name === 'SessionExpiredError') {
    await db.updateUser(userId, { qumsSessionStatus: 'expired' }).catch(() => {});
    await maybeNotifySessionExpired(log, userId, { evidence: true });
    return;
  }
  const net = require('./scraper').isNetworkError(err) || err.name === 'QumsUnreachableError';
  await maybeNotifySessionExpired(log, userId, { evidence: false });
  log.log(`[watcher] user=${userId} ${net ? 'QUMS unreachable (temporary)' : 'scrape error'}: ${err.name || 'Error'}: ${err.message} — retrying next cycle, no expiry alert.`);
}

function buildUpdateMessage(row, dateLabel = dateLabelIST()) {
  return formatAttendanceUpdate(row, dateLabel);
}

/**
 * One watcher cycle for ONE user: fetch today's rows (that user's session),
 * diff against their notified state, send alerts to THEIR number.
 */
async function runWatcherCycle(opts = {}) {
  const log = opts.log || console;
  const fetchFn = opts.fetchFn || scrapeTodaysAttendance;
  const sendFn = opts.sendFn || ((text) => sendMessage(opts.userId, text, log, { category: 'ATTENDANCE' }));
  const stateFile = opts.stateFile || LEGACY_STATE_FILE;
  const force = !!opts.force;

  const now = istNow();
  if (!force && !isWithinCollegeHours(now.hourDecimal)) {
    return { skipped: true, reason: 'outside-college-hours', at: now.hhmm };
  }

  const user = opts.userId ? await db.getUserById(opts.userId) : null;
  const monitoringStartedDate = user
    ? (user.monitoringStartedDate || (user.monitoringStartedAt ? db.getIstDateString(user.monitoringStartedAt) : ''))
    : '';

  if (monitoringStartedDate && now.date < monitoringStartedDate) {
    return { skipped: true, reason: 'before-monitoring-start-date', at: now.hhmm };
  }

  let rows;
  try {
    rows = await fetchFn();
  } catch (err) {
    await handleCycleError(log, opts.userId, err);
    throw err;
  }

  // Room enrichment: aaj ke timetable periods se subjectCode -> room
  if (opts.roomByCode) {
    rows = rows.map((r) => ({ ...r, room: opts.roomByCode[r.subjectCode] || '' }));
  }

  const state = loadState(stateFile);
  const notified = state[now.date] || [];
  const pending = pendingNotifications(rows, notified);
  if (pending.length) {
    log.log(`[Watcher] Attendance change detected for user: ${opts.userId || '?'}`);
  }

  log.log(
    `[watcher] ${now.hhmm} IST${opts.userEmail ? ` (${opts.userEmail})` : ''} — ${rows.length} periods aaj, ${pending.length} naye marked.`
  );

  const sent = [];
  for (const row of pending) {
    const text = buildUpdateMessage(row);
    const eventKey = eventKeyFor(row);
    const qid = (user && user.qumsQid) || '';
    const alreadyNotified = await db.hasAttendanceBeenNotified(opts.userId, {
      qid,
      classDate: now.date,
      subjectCode: row.subjectCode,
      status: row.status,
    });
    if (alreadyNotified) {
      if (!notified.includes(eventKey)) {
        notified.push(eventKey);
        state[now.date] = notified;
        saveState(state, stateFile);
      }
      const knownRec = {
        key: `${now.date}-${row.subjectCode}`,
        date: now.date,
        subjectCode: row.subjectCode,
        subject: row.subject,
        status: row.status,
        statusRaw: row.status === 'present' ? 'P' : (row.status === 'absent' ? 'A' : row.status),
        period: row.period,
        room: row.room || '',
      };
      await db.upsertKnownAttendance(opts.userId, [knownRec]).catch(() => {});
      if (row.subjectCode) {
        await db.saveAttendanceRecord(opts.userId, qid, knownRec).catch(() => {});
      }
      continue;
    }

    const dedupeKey = `attendance_fast:${qid}:${now.date}:${row.subjectCode}:${row.period}:${row.status}`;
    const isNew = await db.tryRecordNotificationLog(opts.userId, 'attendance_class', dedupeKey, {
      qid,
      classDate: now.date,
      subjectCode: row.subjectCode,
      period: row.period,
      status: row.status,
    });
    if (!isNew) {
      if (!notified.includes(eventKey)) {
        notified.push(eventKey);
        state[now.date] = notified;
        saveState(state, stateFile);
      }
      const knownRec = {
        key: `${now.date}-${row.subjectCode}`,
        date: now.date,
        subjectCode: row.subjectCode,
        subject: row.subject,
        status: row.status,
        statusRaw: row.status === 'present' ? 'P' : (row.status === 'absent' ? 'A' : row.status),
        period: row.period,
        room: row.room || '',
      };
      await db.upsertKnownAttendance(opts.userId, [knownRec]).catch(() => {});
      if (row.subjectCode) {
        await db.saveAttendanceRecord(opts.userId, qid, knownRec).catch(() => {});
      }
      continue;
    }

    // Mark as notified BEFORE sending — guarantees no duplicates even if the
    // process dies mid-send. On failure we roll back so the next cycle retries.
    notified.push(eventKey);
    state[now.date] = notified;
    saveState(state, stateFile);
    try {
      if (opts.dryRun) {
        log.log(`[watcher] (dry-run) would send to ${opts.userEmail || 'user'}:\n${text}\n`);
      } else {
        await sendFn(text);
        log.log(`[telegram] user=${opts.userId || '?'} notification sent kind=attendance_class`);
        log.log(`[watcher] 📲 sent: ${row.key} (${row.status}) — ${row.subject}`);
        // Persistent audit/analytics row (never blocks delivery).
        await db.recordNotification(opts.userId, 'attendance_class', { subject: row.subject }, log);
      }
      const knownRec = {
        key: `${now.date}-${row.subjectCode}`,
        date: now.date,
        subjectCode: row.subjectCode,
        subject: row.subject,
        status: row.status,
        statusRaw: row.status === 'present' ? 'P' : (row.status === 'absent' ? 'A' : row.status),
        period: row.period,
        room: row.room || '',
      };
      await db.upsertKnownAttendance(opts.userId, [knownRec]).catch(() => {});
      if (row.subjectCode) {
        await db.saveAttendanceRecord(opts.userId, qid, knownRec).catch(() => {});
      }
      sent.push({ key: row.key, status: row.status, subject: row.subject });
    } catch (err) {
      await db.deleteNotificationLog(opts.userId, dedupeKey);
      state[now.date] = (state[now.date] || []).filter((k) => k !== eventKey);
      saveState(state, stateFile);
      log.error(`[watcher] send FAILED for ${row.key}: ${err.message} — next cycle me retry hoga`);
    }
  }

  return { skipped: false, date: now.date, totalPeriods: rows.length, notified: sent };
}

/** One full watcher pass over ALL users with a linked QUMS session. */
async function runWatcherPass(log = console) {
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
    log.log('[watcher] koi user ka QUMS session linked nahi — pass skip.');
    return { users: 0 };
  }
  log.log(`[watcher] pass started for ${users.length} user(s) (concurrency=${WATCH_CONCURRENCY})...`);
  watcherStatus.fastLastRunAt = new Date().toISOString();
  watcherStatus.fastLastUsers = users.length;
  const results = [];
  for (const user of users) {
    log.log(`[Watcher] Checking user: ${user.id}`); // 15C/15I — userId POORE loop me carry hota hai
    try {
      const startedAt = Date.now();
      // eslint-disable-next-line no-await-in-loop
      const timetable = await getTimetableCached(user.id, user.qumsSessionPath, log);
      const roomByCode = timetable ? roomMapFromPeriods(getTimetableForDate(timetable, new Date())) : null;
      const r = await runWatcherCycle({
        log,
        userId: user.id,
        fetchFn: () => scrapeTodaysAttendance({ sessionPath: user.qumsSessionPath }),
        sendFn: (text) => sendMessage(user.id, text, log, { category: 'ATTENDANCE' }),
        stateFile: stateFileFor(user.id),
        roomByCode,
        userEmail: user.email,
      });
      if (!r || !r.skipped) {
        await db.clearSessionExpiry(user.id, { maxExpiredAt: startedAt }).catch(() => {});
      }
      await db.touchUserSync(user.id, { attendance: true, error: '' });
      log.log(`[attendance] user=${user.id} checked today's attendance`);
      results.push({ email: user.email, ...r });
    } catch (err) {
      log.error(`[attendance] user=${user.id} pass failed: ${err.message}`);
      watcherStatus.fastLastError = err.message;
      results.push({ email: user.email, error: err.message });
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 500)); // stagger users — portal load kam
  }
  return { users: users.length, results };
}

// ---------------------------------------------------------------------------
// MONTH REGISTER loop — backdated attendance (dedupe via db known_attendance)
// ---------------------------------------------------------------------------

const MONTH_REGISTER_INTERVAL_MINUTES = Number(process.env.MONTH_REGISTER_INTERVAL_MINUTES) || 10;

/**
 * TIERED Month Register monitoring (efficient, but nothing is silently missed).
 *
 *   Tier 1 — CURRENT month   : every cycle (MONTH_REGISTER_INTERVAL_MINUTES)
 *   Tier 2 — PREVIOUS month  : every MONTH_REGISTER_RECENT_EVERY_CYCLES cycles
 *   Tier 3 — OLDER months    : months 2..MONTH_REGISTER_MONTHS_BACK, every
 *                              MONTH_REGISTER_OLDER_EVERY_HOURS hours
 *
 * MONTH_REGISTER_MONTHS_BACK is the TOTAL number of previous months that stay
 * under monitoring (default 5 => the whole running semester is covered).
 * 0 = current month only (minimal portal load).
 *
 * Rationale: a teacher editing a recent class is the common case, so the newest
 * months are checked often; older months are still covered on a slow cadence,
 * which is what prevents a delayed update from being missed entirely. All
 * requests stay sequential (see scrapeMonthRegisterRange) and the tier clock is
 * a single scheduler-level state file — per-user attendance state lives in the
 * database and stays untouched by this cadence.
 */
const MONTH_REGISTER_MONTHS_BACK = Math.min(11, Math.max(0, Number(process.env.MONTH_REGISTER_MONTHS_BACK ?? 5) || 0));
const MONTH_REGISTER_RECENT_EVERY_CYCLES = Math.max(1, Number(process.env.MONTH_REGISTER_RECENT_EVERY_CYCLES) || 2);
const MONTH_REGISTER_OLDER_EVERY_HOURS = Math.max(1, Number(process.env.MONTH_REGISTER_OLDER_EVERY_HOURS) || 6);
const MONTH_REGISTER_TIER_STATE_FILE = process.env.MONTH_REGISTER_TIER_STATE_FILE
  ? path.resolve(process.env.MONTH_REGISTER_TIER_STATE_FILE)
  : path.join(DATA_DIR, 'month_register_tier_state.json');

/** Shift a civil month by delta months (handles the year boundary). */
function shiftMonth(year, month, delta) {
  let m = Number(month) + Number(delta);
  let y = Number(year);
  while (m < 1) { m += 12; y -= 1; }
  while (m > 12) { m -= 12; y += 1; }
  return { year: y, month: m };
}

/**
 * Pure: which months should this cycle scan? Returns { months, state } where
 * `state` is the next tier-clock value to persist. No I/O — unit testable.
 */
function monthsToScanNow(now, state = {}, opts = {}) {
  const back = opts.monthsBack != null ? opts.monthsBack : MONTH_REGISTER_MONTHS_BACK;
  const recentEvery = opts.recentEveryCycles != null ? opts.recentEveryCycles : MONTH_REGISTER_RECENT_EVERY_CYCLES;
  const olderEveryMs = (opts.olderEveryHours != null ? opts.olderEveryHours : MONTH_REGISTER_OLDER_EVERY_HOURS) * 60 * 60 * 1000;
  const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
  const [y, m] = String(now.date || '').split('-').map(Number);
  const year = y || new Date(nowMs).getUTCFullYear();
  const month = m || 1;

  const cycle = Number(state.cycle || 0);
  const months = [shiftMonth(year, month, 0)]; // Tier 1 — always
  const next = { cycle: cycle + 1, olderAt: Number(state.olderAt || 0) };

  if (back >= 1 && cycle % recentEvery === 0) months.push(shiftMonth(year, month, -1)); // Tier 2
  if (back >= 2 && nowMs - next.olderAt >= olderEveryMs) {
    // Tier 3 fires -> do a FULL historical sweep (current + every monitored month),
    // so the pass that walks older months never skips the previous one.
    if (back >= 1 && !months.some((m) => m.month === shiftMonth(year, month, -1).month)) months.push(shiftMonth(year, month, -1));
    for (let i = 2; i <= back; i++) months.push(shiftMonth(year, month, -i));
    next.olderAt = nowMs;
  }
  return { months, state: next };
}

function loadTierState() {
  return loadState(MONTH_REGISTER_TIER_STATE_FILE);
}
function saveTierState(state) {
  saveState(state, MONTH_REGISTER_TIER_STATE_FILE);
}

/**
 * Status signature of a month-register record — the ACTUAL portal value.
 *
 * `statusRaw` is the literal cell text (e.g. `P`, `A`, `L`, `P,A` for two
 * lectures in one day); `status` is the normalized label of the first lecture.
 * Comparing this string is what makes Absent -> Present / Present -> Absent
 * detectable. Nothing is guessed: only values the portal returned are used.
 */
function statusSignature(rec) {
  if (!rec) return '';
  const raw = rec.statusRaw != null && String(rec.statusRaw).trim() !== '' ? String(rec.statusRaw) : String(rec.status || '');
  return raw.toUpperCase().replace(/\s+/g, '');
}

/**
 * Pure: diff the month-register records against the user's stored state.
 *
 * Returns { pending, reseed }:
 *   pending -> records that deserve a Telegram alert:
 *                (a) NEW record (key never seen)  -> new Present OR new Absent
 *                (b) CHANGED record (same key, different status signature)
 *                    e.g. Absent -> Present, Present -> Absent
 *              Unchanged record (same key + same status) -> NOT pending.
 *   reseed  -> records already stored but with NO status signature (legacy
 *              entries written before status-aware dedupe existed). These are
 *              silently refreshed so that the NEXT real change alerts once —
 *              an upgrade never produces a backlog alert storm.
 *
 * Legacy per-lecture keys (`date-CODE#1`) are migrated to the group key so
 * an already-notified record can never re-alert after an upgrade.
 */
function monthRegisterDiff(records, knownRecords) {
  const byKey = new Map();
  for (const r of knownRecords || []) {
    if (!r || !r.key) continue;
    byKey.set(r.key, r);
    const hash = r.key.indexOf('#');
    if (hash !== -1 && !byKey.has(r.key.slice(0, hash))) byKey.set(r.key.slice(0, hash), r); // migration
  }
  const seen = new Set();
  const pending = [];
  const reseed = [];
  for (const rec of records || []) {
    if (!rec || rec.status === 'unmarked') continue; // N / empty = not marked
    if (!rec.key || seen.has(rec.key)) continue; // in-batch dedupe
    seen.add(rec.key);
    const prev = byKey.get(rec.key);
    if (!prev) {
      pending.push(rec); // (a) brand-new (backdated) marking
      continue;
    }
    const prevSig = statusSignature(prev);
    if (!prevSig) {
      reseed.push(rec); // legacy entry without a status -> silent refresh
      continue;
    }
    if (prevSig !== statusSignature(rec)) pending.push(rec); // (b) status change
  }
  return { pending, reseed };
}

/**
 * Backwards-compatible wrapper: only the alert-worthy records.
 *  `date-CODE#1` ko group key `date-CODE` me migrate karta hai)
 */
function pendingMonthNotifications(records, knownRecords) {
  return monthRegisterDiff(records, knownRecords).pending;
}

/** Backdated alert message (spec format) — messages.formatBackdatedUpdate. */
function buildBackdatedMessage(rec, prev = null) {
  return formatBackdatedUpdate(rec, prev);
}

/**
 * One month-register cycle for ONE user: fetch the configured months (that
 * user's session), diff against their db known_attendance, send alerts to
 * THEIR own Telegram chat. First run (known empty) -> bootstrap seed, NO alerts.
 *
 * Multi-month (Phase 4): opts.fetchFn may return
 *   - a single { year, month, records, summary } (kept for backwards compat), or
 *   - an array of those — the watcher then checks every requested month
 *     sequentially (see scrapeMonthRegisterRange / MONTH_REGISTER_MONTHS_BACK).
 * Records carry a civil date in `key`, so months can never collide.
 */
async function runMonthRegisterCycle(opts = {}) {
  const log = opts.log || console;
  const sendFn = opts.sendFn || ((text) => sendMessage(opts.userId, text, log, { category: 'ATTENDANCE' }));
  const userId = opts.userId;
  if (!userId) throw new Error('runMonthRegisterCycle: userId required');

  const user = await db.getUserById(userId);
  const monitoringStartedDate = user
    ? (user.monitoringStartedDate || (user.monitoringStartedAt ? db.getIstDateString(user.monitoringStartedAt) : ''))
    : '';
  const qid = (user && user.qumsQid) || '';

  let fetched;
  try {
    fetched = await opts.fetchFn();
  } catch (err) {
    await handleCycleError(log, userId, err);
    throw err;
  }

  const months = (Array.isArray(fetched) ? fetched : [fetched]).filter(Boolean);
  const records = months.flatMap((m) => (m.records || []).filter((r) => r.status !== 'unmarked'));
  const known = await db.listKnownAttendance(userId);
  const diff = monthRegisterDiff(records, known);
  let pending = diff.pending;

  // ABSOLUTE RULE FOR OLD ATTENDANCE:
  // If class_date < monitoring_started_date -> NEVER send an attendance notification.
  // Setup date itself and later dates (class_date >= monitoring_started_date) are monitored.
  const eligiblePending = [];
  const olderToSilentlyStore = [];
  for (const rec of pending) {
    if (monitoringStartedDate && rec.date < monitoringStartedDate) {
      olderToSilentlyStore.push(rec);
    } else {
      eligiblePending.push(rec);
    }
  }

  // Any older or newly discovered historical records must be saved silently
  // into known attendance & attendance_records so they don't trigger diffs in future cycles
  if (olderToSilentlyStore.length) {
    await db.upsertKnownAttendance(userId, olderToSilentlyStore);
    for (const r of olderToSilentlyStore) {
      if (r.date && r.subjectCode) {
        await db.saveAttendanceRecord(userId, qid, r);
      }
    }
  }

  pending = eligiblePending;

  // Dup-alert guard: college hours ke ANDAR aaj ke marks FAST loop (5 min)
  // handle karta hai — month loop unhe skip karta hai (double alert na ho).
  // Bahar hours (evening/raat) fast loop soya hota hai, to month loop hi aaj
  // ke naye marks alert karta hai — par sirf wo jo fast loop ne din me pehle
  // alert na kar chuka ho (notified_periods se cross-check).
  const todayIst = opts.now ? opts.now : istNow();
  const inHours = opts.inHours !== undefined ? opts.inHours : isWithinCollegeHours(todayIst.hourDecimal);
  const fastNotifiedCodes = new Set(
    (loadState(stateFileFor(userId))[todayIst.date] || []).map(
      // fast-loop event key ab `P2-CODE:status` format me hai — cross-check ke
      // liye sirf subjectCode chahiye (legacy keys me :status nahi hota, no-op)
      (k) => k.split('-').slice(1).join('-').split(':')[0]
    )
  );
  pending = pending.filter((rec) => {
    if (opts.includeToday || opts.force) return true;
    if (rec.date !== todayIst.date) return true; // backdated — hamesha eligible
    if (inHours) return false; // fast loop ki zimmedari
    return !fastNotifiedCodes.has(rec.subjectCode);
  });

  // First run bootstrap: poore month ko silently seed karo — varna pehli
  // cycle me mahine bhar ke purane marks ki alert-storm chali jayegi.
  // NOTE: baseline scan par purane records alert NAHI karte; uske baad har
  // naya / badla (status-transition) record alert karta hai.
  const bootstrap = !known.length && records.length > 0;
  if (bootstrap) {
    pending = [];
    await db.upsertKnownAttendance(userId, records);
    for (const r of records) {
      if (r.date && r.subjectCode) {
        await db.saveAttendanceRecord(userId, qid, r);
      }
    }
  }

  if (pending.length) {
    log.log(`[Watcher] Attendance change detected for user: ${userId}`);
  }

  const monthLabel = months.map((m) => `${m.year}-${String(m.month).padStart(2, '0')}`).join(', ') || '—';
  log.log(
    `[watcher] month-register [${monthLabel}]${opts.userEmail ? ` (${opts.userEmail})` : ''} — ${records.length} marked records, ${pending.length} naye/badle${bootstrap ? ' (BOOTSTRAP seed, koi alert nahi)' : ''}.`
  );

  // Teacher + Room cross-match sirf tab (browser launch mehengi hai)
  if (pending.length && opts.timetableFn) {
    try {
      const timetable = await opts.timetableFn();
      pending = pending.map((rec) => ({
        ...rec,
        teacher: rec.teacher || teacherForRecord(timetable, rec),
        room: rec.room || roomForRecord(timetable, rec),
      }));
    } catch (err) {
      log.log(`[watcher] timetable cross-match fail (${err.name}: ${err.message}) — teacher/room bina hi alert jayega.`);
    }
  }

  // Legacy entries without a stored status: refresh silently (no alert), so the
  // very next real change is detected exactly once.
  if (diff.reseed.length) await db.upsertKnownAttendance(userId, diff.reseed);

  const knownByKey = new Map((await db.listKnownAttendance(userId)).filter((r) => r && r.key).map((r) => [r.key, r]));

  const sent = [];
  for (const rec of pending) {
    const prevEntry = knownByKey.get(rec.key) || null;
    const prevStatus = prevEntry ? (prevEntry.statusRaw || prevEntry.status || 'N') : 'N';
    const nextStatus = rec.statusRaw || rec.status || 'present';

    const alreadyNotified = await db.hasAttendanceBeenNotified(userId, {
      qid,
      classDate: rec.date,
      subjectCode: rec.subjectCode,
      status: nextStatus,
      prevStatus,
    });
    if (alreadyNotified) {
      await db.upsertKnownAttendance(userId, [rec]);
      if (rec.date && rec.subjectCode) {
        await db.saveAttendanceRecord(userId, qid, rec);
      }
      continue;
    }

    // PostgreSQL persistent deduplication scoped per user
    const dedupeKey = `attendance_month:${qid}:${rec.date}:${rec.subjectCode}:${prevStatus}->${nextStatus}`;
    const isNew = await db.tryRecordNotificationLog(userId, prevEntry ? 'attendance_changed' : 'attendance_backdated', dedupeKey, {
      qid,
      classDate: rec.date,
      subjectCode: rec.subjectCode,
      subject: rec.subject,
      prevStatus,
      newStatus: nextStatus,
    });

    if (!isNew) {
      await db.upsertKnownAttendance(userId, [rec]);
      if (rec.date && rec.subjectCode) {
        await db.saveAttendanceRecord(userId, qid, rec);
      }
      continue;
    }

    const text = buildBackdatedMessage(rec, prevEntry);
    await db.upsertKnownAttendance(userId, [rec]);
    if (rec.date && rec.subjectCode) {
      await db.saveAttendanceRecord(userId, qid, rec);
    }

    try {
      if (opts.dryRun) {
        log.log(`[watcher] (dry-run) would send to ${opts.userEmail || 'user'}:\n${text}\n`);
      } else {
        await sendFn(text);
        log.log(`[telegram] user=${userId} notification sent kind=${prevEntry ? 'attendance_changed' : 'attendance_backdated'}`);
        log.log(`[watcher] 📲 sent backdated (${prevEntry ? 'changed' : 'new'}): ${rec.key} (${rec.status}) — ${rec.subjectCode}${rec.teacher ? ` / ${rec.teacher}` : ''}`);
        await db.recordNotification(userId, prevEntry ? 'attendance_changed' : 'attendance_backdated', { subject: rec.subject, classDate: rec.date }, log);
      }
      sent.push({
        key: rec.key,
        kind: prevEntry ? 'changed' : 'new',
        previousStatus: prevEntry ? statusSignature(prevEntry) : null,
        status: rec.status,
        statusRaw: rec.statusRaw,
        date: rec.date,
        subjectCode: rec.subjectCode,
      });
    } catch (err) {
      await db.deleteNotificationLog(userId, dedupeKey);
      // Rollback restores the PREVIOUS state (or removes a brand-new entry) so
      // the next cycle retries the same alert exactly once.
      if (prevEntry) await db.upsertKnownAttendance(userId, [prevEntry]);
      else await db.removeKnownAttendance(userId, rec.key);
      log.error(`[watcher] send FAILED for ${rec.key}: ${err.message} — next cycle me retry hoga`);
    }
  }

  if (bootstrap) await db.upsertKnownAttendance(userId, records);

  const first = months[0] || {};
  return {
    skipped: false,
    bootstrap,
    year: first.year,
    month: first.month,
    months: months.map((m) => `${m.year}-${String(m.month).padStart(2, '0')}`),
    totalMarked: records.length,
    notified: sent,
  };
}

/**
 * Task 3 — IMMEDIATE BASELINE (naye/re-setup user ke liye):
 * QUMS setup complete hote hi ye ek baar chalta hai:
 *   - aaj ke MARKED periods (P/A) ko fast-loop dedupe state
 *     (data/notified_periods/<userId>.json) me seed kar deta hai
 *   - N.M. (not-marked) periods ko KAHIN nahi daala — unpe aage teacher mark
 *     kare to alert NORMALLY aayega (usi din, agle cycle ka wait nahi)
 * Isse already-marked periods ka alert-storm nahi hota, aur month-register
 * loop ka apna bootstrap bhi intact rehta hai (pehli baar poora month silently
 * seed hota hai — wahi correct behaviour hai).
 */
async function runBaselineForUser(userId, log = console) {
  const user = await db.getUserById(userId);
  if (!user || !user.qumsSessionPath) {
    return { skipped: true, reason: 'qums-session-missing' };
  }
  const rows = await scrapeTodaysAttendance({ sessionPath: user.qumsSessionPath });
  const marked = rows.filter((r) => r.status !== 'unmarked');
  const now = istNow();

  const state = loadState(stateFileFor(userId));
  const todayKeys = state[now.date] || [];
  let seededFast = 0;
  for (const r of marked) {
    // eventKey (status ke saath) seed karo; legacy key pehle se ho to bhi seed
    // (dono formats suppress karte hain — koi duplicate alert nahi)
    const eventKey = eventKeyFor(r);
    if (!todayKeys.includes(eventKey) && !todayKeys.includes(r.key)) {
      todayKeys.push(eventKey);
      seededFast += 1;
    }
  }
  state[now.date] = todayKeys;
  saveState(state, stateFileFor(userId));

  log.log(
    `[watcher] baseline ${user.email}: ${rows.length} periods aaj, ${marked.length} already-marked -> fast-loop seeded (${seededFast} naye keys). N.M. periods ke alerts normal rahenge.`
  );
  return { skipped: false, totalPeriods: rows.length, marked: marked.length, seededFast };
}

/** One full month-register pass over ALL users with a linked QUMS session. */
async function runMonthRegisterPass(log = console, opts = {}) {
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
    log.log('[watcher] month-register: koi user ka QUMS session linked nahi — pass skip.');
    return { users: 0 };
  }

  // TIERED schedule — decided ONCE per pass (same months for every user, so the
  // portal sees a predictable, small number of requests).
  let months;
  if (Array.isArray(opts.months) && opts.months.length) {
    months = opts.months; // explicit override (tests / manual scan)
  } else {
    const prev = loadTierState();
    const plan = monthsToScanNow(istNow(), prev, {
      monthsBack: opts.monthsBack != null ? opts.monthsBack : undefined,
      recentEveryCycles: opts.recentEveryCycles,
      olderEveryHours: opts.olderEveryHours,
    });
    months = plan.months;
    if (!opts.dryRun) saveTierState(plan.state); // tier clock only advances on real passes
  }
  const monthKeys = months.map((m) => `${m.year}-${String(m.month).padStart(2, '0')}`);
  watcherStatus.monthLastRunAt = new Date().toISOString();
  watcherStatus.monthLastMonths = monthKeys;
  log.log(
    `[watcher] month-register pass started for ${users.length} user(s) — tiered scan: [${monthKeys.join(', ')}]` +
      (opts.dryRun ? ' (dry-run: tier clock unchanged)' : '')
  );

  const results = [];
  for (const user of users) {
    log.log(`[Watcher] Checking user: ${user.id}`); // 15C/15I — userId POORE loop me carry hota hai
    try {
      const startedAt = Date.now();
      // eslint-disable-next-line no-await-in-loop
      const r = await runMonthRegisterCycle({
        log,
        userId: user.id,
        userEmail: user.email,
        dryRun: !!opts.dryRun,
        fetchFn: () => scrapeMonthRegisterRange({ sessionPath: user.qumsSessionPath, months }),
        timetableFn: () => getTimetableCached(user.id, user.qumsSessionPath, log),
        sendFn: (text) => sendMessage(user.id, text, log, { category: 'ATTENDANCE' }),
      });
      await db.clearSessionExpiry(user.id, { maxExpiredAt: startedAt }).catch(() => {});
      await db.touchUserSync(user.id, { attendance: true, error: '' });
      log.log(`[attendance] user=${user.id} checked month register [${monthKeys.join(',')}]`);
      results.push({ email: user.email, ...r });
    } catch (err) {
      log.error(`[attendance] user=${user.id} month-register failed: ${err.message}`);
      watcherStatus.monthLastError = err.message;
      results.push({ email: user.email, error: err.message });
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 500)); // stagger users — portal load kam
  }
  return { users: users.length, months: monthKeys, results };
}

/** Arm the month-register (backdated) loop — startWatcher ke saath chalta hai. */
function startMonthRegisterWatcher(log = console) {
  const minutes = MONTH_REGISTER_INTERVAL_MINUTES;
  log.log(
    `[watcher] month-register loop armed — every ${minutes} min | tiers: current month every cycle, previous month every ${MONTH_REGISTER_RECENT_EVERY_CYCLES} cycles, ` +
      `months 2..${MONTH_REGISTER_MONTHS_BACK} every ${MONTH_REGISTER_OLDER_EVERY_HOURS}h (all users, sequential requests)`
  );
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await runMonthRegisterPass(log);
    } catch (err) {
      log.error(`[watcher] month-register pass failed: ${err.name || 'Error'}: ${err.message}`);
    } finally {
      busy = false;
    }
  }, minutes * 60 * 1000);
  return timer;
}

/** Arm the continuous multi-user watcher (called from server.js). */
/** Real worker status for the admin System Health panel (no fakes). */
const watcherStatus = {
  armed: false,
  fastLastRunAt: null,
  fastLastUsers: 0,
  fastLastError: '',
  monthLastRunAt: null,
  monthLastMonths: [],
  monthLastError: '',
};
function getWatcherStatus() { return { ...watcherStatus, concurrency: WATCH_CONCURRENCY }; }

/**
 * Bounded concurrency helper: at most `limit` users are scraped at a time, so a
 * large user base can never open unlimited Playwright sessions at once.
 */
async function mapWithConcurrency(items, limit, fn) {
  const list = items || [];
  const size = Math.max(1, Math.min(Number(limit) || 1, list.length || 1));
  let cursor = 0;
  const workers = Array.from({ length: size }, async () => {
    while (cursor < list.length) {
      const idx = cursor;
      cursor += 1;
      // eslint-disable-next-line no-await-in-loop
      await fn(list[idx], idx);
    }
  });
  await Promise.all(workers);
}

/** How many users may be scraped in parallel (default 2, never unlimited). */
const WATCH_CONCURRENCY = Math.max(1, Number(process.env.WATCHER_CONCURRENCY || 2));

function startWatcher(log = console) {
  const minutes = Number(process.env.WATCH_INTERVAL_MINUTES) || 5;
  watcherStatus.armed = true;
  log.log(`[watcher] armed — every ${minutes} min, college hours 08:30-17:00 IST, all registered users (concurrency=${WATCH_CONCURRENCY})`);
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return; // previous pass still running — skip this tick
    busy = true;
    try {
      const now = istNow();
      if (isWithinCollegeHours(now.hourDecimal)) {
        await runWatcherPass(log);
      } else {
        log.log(`[watcher] ${now.hhmm} IST — outside college hours, pass skip.`);
      }
    } catch (err) {
      log.error(`[watcher] pass failed: ${err.name || 'Error'}: ${err.message}`);
    } finally {
      busy = false;
    }
  }, minutes * 60 * 1000);

  // Part 5/6 — new-assignment notifications: separate loop (30 min default),
  // armed together with the watcher so the scheduler stays untouched.
  const assignments = require('./assignments');
  const assignmentTimers = assignments.startAssignmentWatcher(log);

  // BACKDATED (Month Register) loop — tiered historical scanning. This MUST be
  // armed here: without it the backdated-attendance feature silently never runs
  // in the deployed server (previously it was only reachable via the manual CLI).
  const monthTimer = startMonthRegisterWatcher(log);

  return [timer, monthTimer, ...assignmentTimers];
}

// ---------------------------------------------------------------------------
// --test harness: simulated schedule. P1 stays N.M., P2 gets marked after the
// first poll, P3 is pre-seeded as ALREADY notified — proves dedupe end-to-end.
// Dry-run by default (--send for real Telegram).
if (require.main === module) {
  const args = process.argv.slice(2);
  const realSend = args.includes('--send');
  const isNow = args.includes('--now');
  const force = args.includes('--force');

  (async () => {
    if (args.includes('--test')) {
      const virtual = [
        { Period: 'P1', Duration: '08:55-09:50', subject: 'Robotic Industry 4.0', SubjectCode: 'MT3015', Employeename: 'ANKUR JAIN', Attend: 'N.M.' },
        { Period: 'P2', Duration: '09:55-10:50', subject: 'Design and Analysis of Algorithm', SubjectCode: 'CS35303', Employeename: 'DR. R K RAO', Attend: 'N.M.' },
        { Period: 'P3', Duration: '10:55-11:50', subject: 'Foundation of Cloud Computing', SubjectCode: 'CS35304', Employeename: 'PROF. MEHRA', Attend: 'P' },
      ];
      const now = istNow();
      saveState({ [now.date]: ['P3-CS35304'] }, TEST_STATE_FILE);

      let pollCount = 0;
      const fetchFn = async () => {
        pollCount += 1;
        if (pollCount >= 2) virtual[1].Attend = 'P'; // teacher marks P2 after cycle 1
        // map exactly like the real scraper does (row -> {status, key, ...})
        return virtual.map((r) => {
          const raw = String(r.Attend || '').trim();
          return {
            period: r.Period,
            duration: r.Duration,
            subject: r.subject,
            subjectCode: r.SubjectCode,
            employee: r.Employeename,
            attendance: r.Attend,
            // N.M./empty -> 'unmarked' (koi alert nahi), P*/PRESENT -> present, A*/ABSENT -> absent
            status: !raw || raw.toUpperCase() === 'N.M.' ? 'unmarked' : raw.toUpperCase().includes('P') ? 'present' : raw.toUpperCase().includes('A') ? 'absent' : 'other',
            key: `${r.Period}-${r.SubjectCode}`,
          };
        });
      };
      const sendFn = async (text) => {
        if (!realSend) {
          console.log(`[watcher] (dry-run) would send:\n${text}\n`);
          return text;
        }
        // 15J NOTE — TEST-ONLY target: ye SIMULATED data hai (kisi real user ka
        // QUMS attendance NAHI), isliye manual-testing convenience ke liye
        // deterministic pehla linked user use hota hai. REAL watcher pass
        // (runWatcherPass / runMonthRegisterPass) me aisa koi global pick NAHI
        // hai — har alert uske apne userId -> telegramChatId pe hi jaata hai.
        const linked = db
          .allUsers()
          .filter((u) => u.telegramChatId)
          .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
        const realUser = linked[0] || (await db.allUsers())[0];
        if (!realUser) throw new Error('Koi registered user nahi — pehle /register karo.');
        console.log(`[watcher] (TEST) simulated alert -> test target user: ${realUser.email} (test-only, real loop me aisa nahi)`);
        return sendMessage(realUser.id, text, console, { category: 'ATTENDANCE' });
      };

      console.log(`=== WATCHER TEST (3 simulated cycles, ${realSend ? 'REAL Telegram send' : 'DRY-RUN'}) ===`);
      for (let i = 1; i <= 3; i++) {
        console.log(`--- cycle ${i} ---`);
        // eslint-disable-next-line no-await-in-loop
        const r = await runWatcherCycle({ fetchFn, sendFn, stateFile: TEST_STATE_FILE, force: true, dryRun: !realSend });
        console.log(`   result: ${JSON.stringify((r.notified || []).map((n) => n.key))}\n`);
      }
      console.log('Expected: cycle 1 -> [] (sab N.M., P3 already notified); cycle 2 -> [P2-CS35303]; cycle 3 -> [] (duplicate block).');
      process.exit(0);
    }

    if (isNow) {
      const r = await runWatcherPass();
      console.log(`[watcher] pass result: ${JSON.stringify(r).slice(0, 500)}`);
      process.exit(0);
    }

    // ---- month-register: simulation (--month-test) / one real pass (--month-now) ----
    if (args.includes('--month-test')) {
      const users = (await db.allUsers()).filter((u) => u.qumsSessionPath);
      if (!users.length) {
        console.error('[x] koi registered user with QUMS session nahi — pehle web dashboard se QUMS link karo.');
        process.exit(1);
      }
      const user = users[0];
      console.log(`=== MONTH REGISTER TEST (${realSend ? 'REAL send' : 'DRY-RUN'}) — user ${user.email} ===`);
      let cycle = 0;
      const mkRec = (date, code, subject, statusRaw, teacher) => ({
        date,
        day: Number(date.slice(-2)),
        subjectCode: code,
        subject,
        statusRaw,
        status: statusRaw === 'P' ? 'present' : statusRaw === 'A' ? 'absent' : 'other',
        teacher: teacher || '',
        lectureIndex: null,
        lecturesThatDay: 1,
        key: `${date}-${code}`,
      });
      let virtual = [
        mkRec('2026-09-10', 'CS35303', 'Design and Analysis of Algorithm', 'P', 'RAJ KUMAR'),
        mkRec('2026-09-12', 'CS35365', 'Scala for Data Science', 'A', 'BHANU PARTAP'),
      ];
      const fetchFn = async () => {
        cycle += 1;
        if (cycle >= 2) {
          // cycle 2: teacher marks ek NAYA backdated record (12 Sep ko DSA)
          virtual = [...virtual, mkRec('2026-09-11', 'CS35304', 'Foundation of Cloud Computing', 'P', 'PROF. MEHRA')];
        }
        return { year: 2026, month: 9, records: virtual, summary: null };
      };
      const sendFn = async (text) => {
        if (!realSend) {
          console.log(`[watcher] (dry-run) would send:\n${text}\n`);
          return text;
        }
        if (!user.telegramChatId) {
          throw new Error('This user has no linked Telegram chat — connect Telegram from the dashboard, or run without --send for a dry run.');
        }
        return sendMessage(user.id, text, console, { category: 'ATTENDANCE' });
      };
      const cycleOpts = {
        log: console,
        userId: 'month-test-dummy', // real user ka known_attendance pollute na ho
        userEmail: user.email + ' (TEST)',
        fetchFn,
        timetableFn: async () => ({ days: [] }), // simulated timetable (teacher pre-set)
        sendFn,
      };
      for (let i = 1; i <= 3; i++) {
        console.log(`--- month cycle ${i} ---`);
        // eslint-disable-next-line no-await-in-loop
        const r = await runMonthRegisterCycle(cycleOpts);
        console.log(`   notified: ${JSON.stringify((r.notified || []).map((n) => n.key))}\n`);
      }
      console.log('Expected: cycle 1 -> [] (BOOTSTRAP seed, no alerts), cycle 2 -> [2026-09-11-CS35304]');
      console.log('(naya backdated record), cycle 3 -> [] (duplicate block).');
      process.exit(0);
    }

    if (args.includes('--month-now')) {
      const r = await runMonthRegisterPass(console, { dryRun: args.includes('--dry') });
      console.log(`[watcher] month-register pass result: ${JSON.stringify(r).slice(0, 800)}`);
      process.exit(0);
    }

    startWatcher();
    console.log('[watcher] running. Ctrl+C to stop.');
  })().catch((err) => {
    console.error(`[x] ${err.name || 'Error'}: ${err.message}`);
    if (err.hint) console.error(`    hint: ${err.hint}`);
    process.exit(1);
  });
}

module.exports = {
  startWatcher,
  getWatcherStatus,
  mapWithConcurrency,
  startMonthRegisterWatcher,
  runWatcherCycle,
  runWatcherPass,
  runMonthRegisterCycle,
  runMonthRegisterPass,
  runBaselineForUser,
  pendingNotifications,
  pendingMonthNotifications,
  monthRegisterDiff,
  statusSignature,
  eventKeyFor,
  buildUpdateMessage,
  buildBackdatedMessage,
  MONTH_REGISTER_INTERVAL_MINUTES,
  MONTH_REGISTER_MONTHS_BACK,
  MONTH_REGISTER_RECENT_EVERY_CYCLES,
  MONTH_REGISTER_OLDER_EVERY_HOURS,
  MONTH_REGISTER_TIER_STATE_FILE,
  monthsToScanNow,
  shiftMonth,
  loadTierState,
  saveTierState,
  istNow,
  isWithinCollegeHours,
  stateFileFor,
  loadState,
  saveState,
  handleCycleError,
  COLLEGE_START_HOUR,
  COLLEGE_END_HOUR,
};
