/**
 * Scheduler — MULTI-USER morning job, in IST (Asia/Kolkata):
 *   08:30 IST  morning schedule -> today's classes (time + room + teacher)
 *
 * The daily 9 PM summary was REMOVED by request — the scheduler/background
 * system itself stays (morning schedule + watcher + assignments + deadline
 * reminders all keep running).
 *
 * It iterates every registered user with a linked QUMS session and sends to
 * THEIR OWN Telegram chat (deep-link se linked — src/telegram.js), using THEIR
 * OWN decrypted QUMS credentials + session file. Per-user errors never crash
 * the loop; expired sessions trigger a Telegram alert to that user.
 *
 * 8:30 AM RELIABILITY (kyun ye extra logic hai):
 *   - `recoverMissedExecutions: true` — node-cron ka default false hai, aur tab
 *     agar process 08:30 ke minute me tick hi na kar paaye (laptop sleep, long
 *     stall, heavy scrape) to 8:30 wali run CHUPCHAP SKIP ho jaati thi. Ab
 *     process resume hote hi wahi run fire hoti hai.
 *   - `MORNING_LATE_SKIP_HOUR` (default 11) — bohat late recover hui run
 *     (e.g., 3 PM wali neend ke baad) purani timetable nahi bhejti.
 *   - Per-user per-day marker (`data/morning_schedule_state.json`) — ek din me
 *     ek hi morning message: restart / duplicate instance / retry se duplicate
 *     send nahi (marker sirf SUCCESSFUL send par set hota hai).
 *   - Boot catch-up (`catchUpMorningSchedule`, server.js se) — server 08:30 pe
 *     chal hi nahi raha tha to start hote hi aaj ka timetable chala jaata hai.
 *   - Har log line me poora IST timestamp — "8:30 pe gaya ya nahi" turant pata.
 *
 * Standalone:
 *   node src/scheduler.js --now --morning  -> morning job abhi (force: marker ignore)
 *   node src/scheduler.js --catchup        -> sirf catch-up check
 *   node src/scheduler.js                  -> keep only the cron loop alive
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const db = require('./db');
const { getTodaysScheduleWithRoom } = require('./scraper');
const { sendMessage } = require('./telegram');
const { formatMorningSchedule } = require('./messages');
const { maybeNotifySessionExpired } = require('./alerts');

// 8:30 AM every day (pehli class 9:00 se pehle dekhne ka time).
// MORNING_CRON env se override ho sakta hai (invalid ho to default + warning).
const MORNING_CRON_DEFAULT = '30 8 * * *';
const MORNING_CRON_ENV = String(process.env.MORNING_CRON || '').trim();
const MORNING_CRON = MORNING_CRON_ENV && cron.validate(MORNING_CRON_ENV) ? MORNING_CRON_ENV : MORNING_CRON_DEFAULT;
// Is hour ke baad recovered/catch-up run bhejna skip (stale timetable avoid).
const MORNING_LATE_SKIP_HOUR = Number(process.env.MORNING_LATE_SKIP_HOUR || 11);
// 08:15 IST pre-warm: 8:30 wala message fast rakhne ke liye aaj ka weekly cache
// pehle hi build kar dete hain (warna 8:30 par live scrape chalta hai aur
// message minutes late ho jaata hai). `MORNING_PREWARM_CRON=off` se disable.
const MORNING_PREWARM_CRON_ENV = String(process.env.MORNING_PREWARM_CRON || '').trim();
const MORNING_PREWARM_CRON =
  MORNING_PREWARM_CRON_ENV.toLowerCase() === 'off'
    ? null
    : MORNING_PREWARM_CRON_ENV && cron.validate(MORNING_PREWARM_CRON_ENV)
      ? MORNING_PREWARM_CRON_ENV
      : '15 8 * * *';
const TIMEZONE = 'Asia/Kolkata';
// Per-user per-day "aaj bhej diya" marker (JSON state file — alerts/watcher
// jaise hi pattern). MORNING_STATE_FILE env tests/deploy ke liye override.
const MORNING_STATE_FILE = process.env.MORNING_STATE_FILE
  ? path.resolve(process.env.MORNING_STATE_FILE)
  : path.join(__dirname, '..', 'data', 'morning_schedule_state.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** IST ke parts — cron TIMEZONE se independent, sirf logging/window checks ke liye. */
function istParts(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
    .formatToParts(d)
    .reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
  const hour = Number(p.hour) % 24;
  return {
    ymd: `${p.year}-${p.month}-${p.day}`,
    hour,
    minute: Number(p.minute),
    stamp: `${p.year}-${p.month}-${p.day} ${String(hour).padStart(2, '0')}:${p.minute}:${p.second} IST`,
  };
}

function readMorningState(file = MORNING_STATE_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function writeMorningState(state, file = MORNING_STATE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

/** Purani (>7 din) entries hata do — state file chhoti rehti hai. */
function pruneMorningState(state, todayYMD) {
  const cutoff = new Date(`${todayYMD}T00:00:00Z`).getTime() - 7 * 24 * 60 * 60 * 1000;
  const out = {};
  for (const [userId, ymd] of Object.entries(state)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(ymd)) && new Date(`${ymd}T00:00:00Z`).getTime() >= cutoff) {
      out[userId] = ymd;
    }
  }
  return out;
}


async function activeUsers() {
  const all = await db.allUsers();
  for (const u of all) {
    if (u.qumsSessionStatus === 'expired') continue;
    await db.ensureSessionOnDisk(u).catch(() => {});
  }
  return all.filter((u) => u.qumsSessionPath && u.qumsSessionStatus !== 'expired' && fs.existsSync(u.qumsSessionPath));
}

/**
 * Morning schedule text — Task 2 (weekly cache) logic:
 *   1. weekly_schedule_cache me aaj ke dayOfWeek ki FRESH (<=7 din purani)
 *      entries hain -> seedha cache se message (fast, koi scrape nahi)
 *   2. cache missing/stale -> live merge (Today's Attendance + Timetable room)
 *      -> message banao -> cache turant upsert
 * forceRefresh=true -> cache skip + live merge (dashboard "Refresh Schedule").
 */
async function getMorningScheduleText(user, { forceRefresh = false, log = console, fetchFn = null, now = new Date() } = {}) {
  const dow = now.getDay();
  if (!forceRefresh) {
    const cached = await db.getWeeklySchedule(user.id, dow);
    if (cached.fresh) {
      log.log(`[scheduler] ${user.email}: weekly cache HIT (dow=${dow}, ${cached.rows.length} periods) — live scrape skip.`);
      return {
        text: formatMorningSchedule(cached.rows, undefined, user.studentName || ''),
        mode: cached.rows.length ? 'weekly-cache' : 'weekly-cache-empty',
      };
    }
    log.log(`[scheduler] ${user.email}: weekly cache MISS/STALE (dow=${dow}) — live merge chalega.`);
  }
  // live merge + cache upsert (tests me fetchFn inject hota hai — koi QUMS/Playwright nahi)
  const rows = fetchFn ? await fetchFn(user) : await getTodaysScheduleWithRoom(user.id);
  return {
    text: formatMorningSchedule(rows, undefined, user.studentName || ''),
    mode: forceRefresh ? 'live-merge (forced)' : 'live-merge',
  };
}

let isMorningJobRunning = false;

/**
 * Roz 08:30 (IST) — per-user aaj ki classes: kon si class, kis time, kaunse room.
 *
 * opts:
 *   force      -> per-day marker ignore (manual: `--now --morning`, dashboard)
 *   now        -> clock inject (tests)
 *   stateFile  -> marker file override (tests)
 *   sendFn     -> (user, text) => Promise<boolean>  (tests: no Telegram network)
 *   fetchFn    -> (user) => Promise<rows>           (tests: no QUMS scrape)
 *   sleepMs    -> per-user gap (default 500)
 *   userEmail  -> sirf ek user ke liye (optional; default: saare active users)
 */
async function runMorningScheduleJob(log = console, opts = {}) {
  const now = opts.now || new Date();
  const at = istParts(now);
  const force = Boolean(opts.force);
  const stateFile = opts.stateFile || MORNING_STATE_FILE;
  const sleepMs = opts.sleepMs === undefined ? 500 : Number(opts.sleepMs);
  const sendFn = opts.sendFn || ((user, text) => sendMessage(user.id, text, log, { category: 'MORNING_SCHEDULE', timetableDate: at.ymd }));

  if (isMorningJobRunning && !force) {
    log.log(`[scheduler] morning schedule already running — skip duplicate concurrent execution.`);
    return { sent: 0, skipped: true, running: true, at: at.stamp };
  }
  isMorningJobRunning = true;

  try {
    const all = await activeUsers();
    const users = opts.userEmail ? all.filter((u) => u.email === opts.userEmail) : all;

    // Per-day dedupe: check both local state file and DB notification_log
    const state = readMorningState(stateFile);
    const pending = [];
    for (const u of (force ? users : users.filter((u) => state[u.id] !== at.ymd))) {
      if (force) {
        pending.push(u);
        continue;
      }
      const dedupeKey = `morning_schedule:${u.id}:${at.ymd}`;
      // eslint-disable-next-line no-await-in-loop
      const alreadyInDb = await db.hasNotificationLog(u.id, dedupeKey).catch(() => false);
      if (alreadyInDb) {
        state[u.id] = at.ymd;
      } else {
        pending.push(u);
      }
    }
    writeMorningState(pruneMorningState(state, at.ymd), stateFile);

    log.log(
      `[scheduler] morning schedule ${at.stamp} — ${pending.length}/${users.length} user(s) pending${force ? ' (force: marker ignore)' : ' (dedupe: 1/user/day)'}.`
    );
    if (!pending.length) {
      log.log('[scheduler] morning schedule skip — aaj ke saare users ko already bhej diya gaya hai.');
      return { sent: 0, total: users.length, skipped: users.length, at: at.stamp };
    }

    // Bohat late (recovered / catch-up) run: purani timetable bhejne ka fayda nahi.
    const pastLateLimit = at.hour > MORNING_LATE_SKIP_HOUR || (at.hour === MORNING_LATE_SKIP_HOUR && at.minute > 0);
    if (pastLateLimit && !force) {
      log.log(
        `[scheduler] morning schedule SKIPPED — ${at.stamp} late hai (limit ${MORNING_LATE_SKIP_HOUR}:00 IST). Aaj ka timetable purana ho gaya; kal 8:30 par normal run hoga.`
      );
      return { sent: 0, total: users.length, skipped: users.length, late: true, at: at.stamp };
    }

    let ok = 0;
    for (const user of pending) {
      try {
        const dedupeKey = `morning_schedule:${user.id}:${at.ymd}`;
        if (!force) {
          // eslint-disable-next-line no-await-in-loop
          const alreadyInDb = await db.hasNotificationLog(user.id, dedupeKey).catch(() => false);
          if (alreadyInDb) {
            state[user.id] = at.ymd;
            writeMorningState(pruneMorningState(state, at.ymd), stateFile);
            log.log(`[scheduler] ${user.email}: morning schedule already sent in DB — skipping duplicate.`);
            continue;
          }
        }
        // eslint-disable-next-line no-await-in-loop
        const { text, mode } = await getMorningScheduleText(user, { log, fetchFn: opts.fetchFn, now });
        // eslint-disable-next-line no-await-in-loop
        const sent = await sendFn(user, text);
        if (sent) {
          state[user.id] = at.ymd;
          writeMorningState(pruneMorningState(state, at.ymd), stateFile);
          // Persistent audit/analytics row with persistent deduplication
          // eslint-disable-next-line no-await-in-loop
          await db.tryRecordNotificationLog(user.id, 'morning_schedule', dedupeKey, { date: at.ymd }).catch(() => {});
          // eslint-disable-next-line no-await-in-loop
          await db.recordNotification(user.id, 'morning_schedule', { dedupeKey, classDate: at.ymd }, log).catch(() => {});
        }
        if (!sent) throw new Error('Telegram is not linked — connect it from the dashboard.');
        ok += 1;
        log.log(`[scheduler] 📲 morning schedule sent -> ${user.email} [${mode}] at ${istParts().stamp}`);
      } catch (err) {
        log.error(`[scheduler] morning schedule FAILED for ${user.email}: ${err.message}`);
        if (err.name === 'SessionExpiredError') {
          await db.updateUser(user.id, { qumsSessionStatus: 'expired' }).catch(() => {});
          // eslint-disable-next-line no-await-in-loop
          await maybeNotifySessionExpired(log, user.id, { evidence: true });
        }
      }
      // eslint-disable-next-line no-await-in-loop
      if (sleepMs > 0) await sleep(sleepMs);
    }
    log.log(`[scheduler] morning schedule done: ${ok}/${pending.length} sent at ${istParts().stamp}.`);
    return { sent: ok, total: users.length, at: at.stamp };
  } finally {
    isMorningJobRunning = false;
  }
}

/**
 * Boot catch-up — server 08:30 IST par chal hi nahi raha tha (band tha / cold
 * start / sleep) to start hote hi aaj ka timetable ek baar bhej do.
 * Window: 08:30 se `MORNING_LATE_SKIP_HOUR` (default 11:00 IST) tak.
 * Per-day marker hone se ye kabhi duplicate nahi bhejta.
 */
async function catchUpMorningSchedule(log = console, opts = {}) {
  const at = istParts(opts.now || new Date());
  const windowOpen = at.hour > 8 || (at.hour === 8 && at.minute >= 30);
  const beforeLimit = at.hour < MORNING_LATE_SKIP_HOUR;
  if (!windowOpen || !beforeLimit) {
    log.log(`[scheduler] morning catch-up: ${at.stamp} window (08:30–${MORNING_LATE_SKIP_HOUR}:00 IST) ke bahar — skip.`);
    return { sent: 0, skipped: true, at: at.stamp };
  }
  log.log(`[scheduler] morning catch-up check ${at.stamp} — 8:30 wali run miss hui ho to abhi bhej denge.`);
  return runMorningScheduleJob(log, opts);
}

/**
 * 08:15 IST pre-warm — 8:30 ke message ko on-time rakhne ke liye aaj ka weekly
 * cache pehle hi build kar dete hain. Cache fresh ho to turant return (koi
 * scrape nahi); stale/missing ho to live merge abhi ho jaata hai, isliye 8:30
 * par message bhejna seconds ka kaam rehta hai (live-merge ki 5-10 min deri
 * message ko late nahi karti). Kuch bhi SEND nahi hota.
 */
async function prewarmMorningSchedule(log = console, opts = {}) {
  const now = opts.now || new Date();
  const at = istParts(now);
  const sleepMs = opts.sleepMs === undefined ? 500 : Number(opts.sleepMs);
  const users = await activeUsers();
  log.log(`[scheduler] prewarm ${at.stamp} — ${users.length} user(s) ka aaj ka timetable cache check/build (koi message nahi).`);
  let built = 0;
  let failed = 0;
  for (const user of users) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const { mode } = await getMorningScheduleText(user, { log, fetchFn: opts.fetchFn, now });
      if (mode.startsWith('live-merge')) built += 1; // cache MISS thi -> ab build ho gayi
    } catch (err) {
      failed += 1;
      log.error(`[scheduler] prewarm FAILED for ${user.email}: ${err.message}`);
    }
    // eslint-disable-next-line no-await-in-loop
    if (sleepMs > 0) await sleep(sleepMs);
  }
  log.log(`[scheduler] prewarm done at ${istParts().stamp}: ${built} built, ${users.length - built - failed} already fresh, ${failed} failed.`);
  return { built, total: users.length, failed, at: at.stamp };
}

/** Real scheduler status for the admin System Health panel (no fakes). */
const schedulerStatus = { armed: false, lastMorningRunAt: null, lastMorningSent: 0, lastMorningTotal: 0 };
function getSchedulerStatus() { return { ...schedulerStatus }; }

function startScheduler(log = console) {
  if (MORNING_CRON_ENV && MORNING_CRON !== MORNING_CRON_ENV) {
    log.error(`[scheduler] MORNING_CRON "${MORNING_CRON_ENV}" invalid hai — default "${MORNING_CRON_DEFAULT}" use ho raha hai.`);
  }
  // recoverMissedExecutions: 8:30 ke minute me tick miss hua (sleep/stall) to
  // resume hote hi wahi run fire hoti hai (default false = chupchap skip).
  const morningTask = cron.schedule(MORNING_CRON, () => {
    runMorningScheduleJob(log).catch((e) => log.error(`[scheduler] morning schedule crashed: ${e.message}`));
  }, { timezone: TIMEZONE, recoverMissedExecutions: true });
  log.log(`[scheduler] armed — "${MORNING_CRON}" (8:30 AM IST morning schedule, missed-run recovery ON), ${TIMEZONE}, saare users`);
  const tasks = [morningTask];

  // 08:15 pre-warm (optional) — 8:30 par message seconds me jaata hai.
  if (MORNING_PREWARM_CRON) {
    const prewarmTask = cron.schedule(MORNING_PREWARM_CRON, () => {
      prewarmMorningSchedule(log).catch((e) => log.error(`[scheduler] prewarm crashed: ${e.message}`));
    }, { timezone: TIMEZONE, recoverMissedExecutions: true });
    log.log(`[scheduler] armed — "${MORNING_PREWARM_CRON}" (pre-warm cache so the 8:30 message is on time), ${TIMEZONE}`);
    tasks.push(prewarmTask);
  }
  return tasks;
}

module.exports = {
  startScheduler,
  getSchedulerStatus,
  runMorningScheduleJob,
  activeUsers,
  catchUpMorningSchedule,
  prewarmMorningSchedule,
  getMorningScheduleText,
  istParts,
  MORNING_STATE_FILE,
  MORNING_LATE_SKIP_HOUR,
  MORNING_PREWARM_CRON,
  MORNING_CRON,
  TIMEZONE,
};

if (require.main === module) {
  if (process.argv.includes('--now') && process.argv.includes('--morning')) {
    // Manual run: marker ignore (force) — user khud bhej raha hai.
    db.init()
      .then(() => runMorningScheduleJob(console, { force: true }))
      .then((r) => {
        console.log(`[scheduler] manual morning run done: ${r.sent}/${r.total} sent (at ${r.at}).`);
        process.exit(0);
      })
      .catch((err) => {
        console.error('[scheduler] manual morning run failed:', err.message);
        process.exit(1);
      });
  } else if (process.argv.includes('--catchup')) {
    db.init()
      .then(() => catchUpMorningSchedule(console))
      .then((r) => {
        console.log(`[scheduler] catch-up done: sent=${r.sent}${r.skipped ? ' (window ke bahar)' : ''} at ${r.at}.`);
        process.exit(0);
      })
      .catch((err) => {
        console.error('[scheduler] catch-up failed:', err.message);
        process.exit(1);
      });
  } else {
    startScheduler();
    console.log('[scheduler] running. Ctrl+C to stop.');
  }
}
