/**
 * Catch-up and Silent Baseline Synchronization for ClassQU.
 *
 * 1. SILENT BASELINE (First QUMS Connection):
 *    - Saves existing attendance records and assignments to database snapshots.
 *    - Sends ZERO Telegram notifications for historical data.
 *    - Sets monitoring_started_at = NOW().
 *
 * 2. RECONNECT CATCH-UP (After Session Expiry):
 *    - Compares fresh QUMS attendance against the stored snapshot in PostgreSQL.
 *    - Detects genuine status transitions (N->P, N->A, P->A, A->P) and backdated entries.
 *    - Compares fresh QUMS assignments against saved assignments for genuinely new ones.
 *    - Sends notifications ONLY for changes that occurred during the disconnected period.
 *    - Does NOT re-send old historical records.
 *    - Persistent deduplication through notification_log.
 */
require('dotenv').config();
const db = require('./db');
const { scrapeMonthRegisterRange, scrapeAssignments, istDateString } = require('./scraper');
const { sendMessage } = require('./telegram');
const { formatBackdatedUpdate, formatNewAssignment } = require('./messages');
const { notifyQumsReconnected } = require('./alerts');

/**
 * Perform silent baseline on first QUMS connection.
 * Scrapes current records, stores them in PostgreSQL, and sends ZERO alerts.
 */
async function initializeSilentBaseline(userId, sessionPath, log = console) {
  const user = await db.getUserById(userId);
  if (!user) return false;
  const qid = user.qumsQid || '';

  // 1. Silent Attendance Baseline
  try {
    const [, curMonth, curYear] = istDateString().split('/').map(Number);
    const months = [{ year: curYear, month: curMonth }];
    const fetched = await scrapeMonthRegisterRange(sessionPath, months, { log });
    const records = (Array.isArray(fetched) ? fetched : [fetched])
      .flatMap((m) => (m && m.records ? m.records : []))
      .filter((r) => r && r.status !== 'unmarked');

    if (records.length) {
      await db.upsertKnownAttendance(userId, records);
      for (const rec of records) {
        if (rec.date && rec.subjectCode) {
          await db.saveAttendanceRecord(userId, qid, rec);
        }
      }
      log.log(`[catchup] silent attendance baseline seeded for user=${userId} (${records.length} records). No alerts sent.`);
    }
  } catch (err) {
    log.log(`[catchup] attendance baseline fetch warning: ${err.message}`);
  }

  // 2. Silent Assignment Baseline
  try {
    const assignments = await scrapeAssignments(sessionPath, { log });
    if (assignments && assignments.length) {
      const keys = assignments.map((a) => a.id ? `new:${a.id}` : `new:${a.title}`);
      await db.addKnownAssignments(
        userId,
        assignments.map((a, i) => ({ ...a, key: keys[i] }))
      );
      for (const a of assignments) {
        await db.saveAssignmentRecord(userId, qid, a);
      }
      log.log(`[catchup] silent assignment baseline seeded for user=${userId} (${assignments.length} assignments). No alerts sent.`);
    }
  } catch (err) {
    log.log(`[catchup] assignment baseline fetch warning: ${err.message}`);
  }

  const now = new Date().toISOString();
  const todayIst = db.getIstDateString();
  const patch = {
    qumsSessionStatus: 'active',
  };
  if (!user.monitoringStartedDate) {
    patch.monitoringStartedDate = todayIst;
  }
  if (!user.monitoringStartedAt) {
    patch.monitoringStartedAt = now;
  }
  await db.updateUser(userId, patch);
  await db.touchUserSync(userId, { attendance: true, assignment: true });
  return true;
}

/**
 * Perform reconnect catch-up after a session was restored.
 * Compares current QUMS state against the last saved PostgreSQL snapshot.
 */
async function runReconnectCatchup(userId, sessionPath, log = console, opts = {}) {
  if (sessionPath && typeof sessionPath === 'object') {
    opts = sessionPath;
    sessionPath = null;
    log = console;
  }

  const user = await db.getUserById(userId);
  if (!user) return false;
  const qid = user.qumsQid || '';
  const monitoringStartedDate = user.monitoringStartedDate || (user.monitoringStartedAt ? db.getIstDateString(user.monitoringStartedAt) : '');

  let attendanceAlertsSent = 0;
  let assignmentAlertsSent = 0;

  // 1. Attendance Catch-Up
  try {
    let fetched;
    if (opts.attendanceRecords) {
      fetched = opts.attendanceRecords;
    } else if (opts.monthFetcher) {
      fetched = await opts.monthFetcher();
    } else {
      const [, curMonth, curYear] = istDateString().split('/').map(Number);
      const prevMonth = curMonth === 1 ? 12 : curMonth - 1;
      const prevYear = curMonth === 1 ? curYear - 1 : curYear;
      const months = [
        { year: curYear, month: curMonth },
        { year: prevYear, month: prevMonth },
      ];
      fetched = await scrapeMonthRegisterRange(sessionPath, months, { log });
    }
    const freshRecords = (Array.isArray(fetched) ? fetched : [fetched])
      .flatMap((m) => (m && m.records ? m.records : (m && m.key ? [m] : [])))
      .filter((r) => r && r.status !== 'unmarked');

    const knownRecords = await db.listKnownAttendance(userId);
    const byKey = new Map();
    for (const r of knownRecords || []) {
      if (r && r.key) byKey.set(r.key, r);
    }
    const dbRecords = await db.listAttendanceRecords(userId, qid).catch(() => []);
    for (const r of dbRecords || []) {
      const key = `${r.classDate}-${r.subjectCode}`;
      if (!byKey.has(key)) {
        byKey.set(key, {
          key,
          date: r.classDate,
          subjectCode: r.subjectCode,
          subject: r.subjectName,
          status: r.status,
        });
      }
    }

    const pending = [];
    for (const rec of freshRecords) {
      if (!rec || !rec.key) continue;
      const prev = byKey.get(rec.key);
      if (!prev) {
        // Newly marked record since disconnection
        pending.push({ rec, prev: null });
      } else {
        const prevStatus = (prev.statusRaw || prev.status || '').toUpperCase().trim();
        const nextStatus = (rec.statusRaw || rec.status || '').toUpperCase().trim();
        if (prevStatus && nextStatus && prevStatus !== nextStatus) {
          // Changed status (e.g. Absent -> Present)
          pending.push({ rec, prev });
        }
      }
    }

    for (const item of pending) {
      const { rec, prev } = item;

      // ABSOLUTE RULE FOR OLD ATTENDANCE:
      // If class_date < monitoring_started_date -> NEVER send an attendance notification.
      if (monitoringStartedDate && rec.date < monitoringStartedDate) {
        // Silently update database snapshot so it doesn't trigger again
        await db.upsertKnownAttendance(userId, [rec]);
        if (rec.date && rec.subjectCode) {
          await db.saveAttendanceRecord(userId, qid, rec);
        }
        continue;
      }

      // Check if this attendance event was already notified (by fast loop or previous cycle)
      const alreadyNotified = await db.hasAttendanceBeenNotified(userId, {
        qid,
        classDate: rec.date,
        subjectCode: rec.subjectCode,
        status: rec.status,
        prevStatus: prev ? prev.status : 'unmarked',
      });

      if (alreadyNotified) {
        log.log(`[catchup] duplicate suppressed for user=${userId} (${rec.date} ${rec.subjectCode}: ${rec.status}) — already notified.`);
        await db.upsertKnownAttendance(userId, [rec]);
        if (rec.date && rec.subjectCode) {
          await db.saveAttendanceRecord(userId, qid, rec);
        }
        continue;
      }

      const dedupeKey = `attendance_catchup:${qid}:${rec.date}:${rec.subjectCode}:${prev ? prev.status : 'N'}->${rec.status}`;
      const isNew = await db.tryRecordNotificationLog(userId, 'attendance_catchup', dedupeKey, {
        qid,
        classDate: rec.date,
        subjectCode: rec.subjectCode,
        prevStatus: prev ? prev.status : 'unmarked',
        newStatus: rec.status,
        status: rec.status,
      });

      if (isNew) {
        const text = formatBackdatedUpdate(rec, prev);
        if (user.telegramChatId) {
          await sendMessage(userId, text, log, { category: 'ATTENDANCE' }).catch(() => {});
          attendanceAlertsSent++;
        }
        await db.upsertKnownAttendance(userId, [rec]);
        if (rec.date && rec.subjectCode) {
          await db.saveAttendanceRecord(userId, qid, rec);
        }
      }
    }

    await db.touchUserSync(userId, { attendance: true });
    log.log(`[catchup] attendance catchup for user=${userId}: ${pending.length} pending, ${attendanceAlertsSent} notified.`);
  } catch (err) {
    log.log(`[catchup] attendance catchup error for user=${userId}: ${err.message}`);
  }

  // 2. Assignment Catch-Up
  try {
    let freshAssignments;
    if (opts.assignments) {
      freshAssignments = opts.assignments;
    } else if (opts.skipAssignments || !sessionPath) {
      freshAssignments = [];
    } else {
      freshAssignments = await scrapeAssignments(sessionPath, { log });
    }
    const knownAssignments = await db.listKnownAssignments(userId);
    const knownKeys = new Set(knownAssignments.map((a) => a.key || a.id));

    const newAssignments = [];
    for (const a of freshAssignments || []) {
      if (!a || !a.title) continue;
      const key = a.id ? `new:${a.id}` : `new:${a.title}`;
      if (!knownKeys.has(key)) {
        newAssignments.push({ ...a, key });
      }
    }

    for (const a of newAssignments) {
      const dedupeKey = `assignment_catchup:${a.key}`;
      const isNew = await db.tryRecordNotificationLog(userId, 'assignment_catchup', dedupeKey, {
        title: a.title,
        subject: a.subject,
        deadline: a.deadlineYMD || '',
      });

      if (isNew) {
        const text = formatNewAssignment(a);
        if (user.telegramChatId) {
          await sendMessage(userId, text, log, { category: 'ASSIGNMENT' }).catch(() => {});
          assignmentAlertsSent++;
        }
        await db.addKnownAssignments(userId, [a]);
        await db.saveAssignmentRecord(userId, qid, a);
      }
    }

    await db.touchUserSync(userId, { assignment: true });
    log.log(`[catchup] assignment catchup for user=${userId}: ${newAssignments.length} new, ${assignmentAlertsSent} notified.`);
  } catch (err) {
    log.log(`[catchup] assignment catchup error for user=${userId}: ${err.message}`);
  }

  // 3. Send QUMS Reconnected confirmation message to Telegram
  await notifyQumsReconnected(log, userId).catch(() => {});

  await db.updateUser(userId, { qumsSessionStatus: 'active' });
  await db.clearSessionExpiry(userId);
  return { attendanceAlertsSent, assignmentAlertsSent };
}

module.exports = {
  initializeSilentBaseline,
  runReconnectCatchup,
};
