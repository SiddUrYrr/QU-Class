/**
 * Shared message builders (watcher + scheduler use these; Telegram pe jaate hain).
 */
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

/** 'Thu, 11 Sep 2026' in IST */
function dateLabelIST(d = new Date()) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(d);
}

function statusEmoji(status, raw) {
  if (status === 'present') return '✅ Present';
  if (status === 'absent') return '❌ Absent';
  return `ℹ️ ${norm(raw) || 'Marked'}`;
}

/**
 * Per-class alert — spec: teacher name + marked you as present/absent +
 * subject + date (kis din ka). Room timetable enrichment se aata hai (optional).
 */
function formatAttendanceUpdate(row, dateLabel = dateLabelIST()) {
  const lines = [
    `📌 *Attendance Update* — ${dateLabel}`,
    `Teacher: ${row.employee || '—'}`,
    `Subject: ${row.subject} (${row.subjectCode})`,
    `Period: ${row.period} (${row.duration})`,
  ];
  if (row.room) lines.push(`Room: ${row.room}`);
  lines.push(`${row.employee || 'Teacher'} marked you as: ${statusEmoji(row.status, row.attendance)}`);
  return lines.join('\n');
}

const QUMS_STANDARD_PERIOD_DURATIONS = {
  P1: '09:00 - 09:55',
  P2: '09:55 - 10:50',
  P3: '10:50 - 11:45',
  P4: '11:45 - 12:40',
  P5: '12:40 - 13:35',
  P6: '13:35 - 14:30',
  P7: '14:30 - 15:25',
  P8: '15:25 - 16:20',
};

function extractPeriodKey(str) {
  if (!str) return '';
  const m = String(str).match(/\b(P\d+|\d+)\b/i);
  if (!m) return '';
  return m[1].toUpperCase().startsWith('P') ? m[1].toUpperCase() : `P${m[1]}`;
}

function resolveDuration(duration, period) {
  const raw = norm(duration || '');
  if (raw && !raw.startsWith('(')) return raw;
  const fromPeriod = (period || '').match(/(\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2})/);
  if (fromPeriod) return norm(fromPeriod[0]);
  const mTimeDur = raw.match(/(\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2})/);
  if (mTimeDur) return norm(mTimeDur[0]);
  const cp = (period || '').match(/\b(P\d+|\d+)\b/i);
  if (cp) {
    const key = cp[1].toUpperCase().startsWith('P') ? cp[1].toUpperCase() : `P${cp[1]}`;
    if (QUMS_STANDARD_PERIOD_DURATIONS[key]) return QUMS_STANDARD_PERIOD_DURATIONS[key];
  }
  return raw;
}

/**
 * Morning schedule (daily 8:30 AM IST): all of today's classes + time + room + teacher.
 */
function formatMorningSchedule(rows, dateLabel = dateLabelIST(), studentName = '') {
  const list = (rows || []).filter((r) => r.period || r.subject);
  const hi = studentName ? `Hi ${studentName}! ` : '';
  const lines = [`🌅 *Today's Classes* — ${dateLabel}`, ''];
  if (!list.length) {
    lines.push(`🎉 ${hi}No classes are scheduled today. Enjoy your day!`);
  } else if (list.some((r) => 'room' in r)) {
    // Timetable mode — period time + ROOM + teacher available hai
    if (studentName) lines.push(`${hi}Here is your schedule for today (${list.length} ${list.length === 1 ? 'class' : 'classes'}):`, '');
    list.forEach((r, i) => {
      const dur = resolveDuration(r.duration, r.period);
      const timeLabel = dur || r.period;
      lines.push(`${i + 1}. 🕐 *${timeLabel}* — ${r.subject}${r.subjectCode ? ` (${r.subjectCode})` : ''}`);
      const extras = [];
      if (r.room) extras.push(`Room: ${r.room}`);
      if (r.teacher) extras.push(r.teacher);
      if (extras.length) lines.push(`    ${extras.join(' • ')}`);
      if (i < list.length - 1) lines.push('');
    });
    lines.push('');
    lines.push('_You will get an attendance update as soon as marks are entered 📲_');
  } else {
    // Attendance-rows mode (fallback — isme room nahi hota)
    if (studentName) lines.push(`${hi}Here is your schedule for today:`, '');
    list.forEach((r, i) => {
      const dur = resolveDuration(r.duration, r.period);
      lines.push(`${i + 1}. *${r.period}* (${dur || r.duration || 'TBA'})`);
      lines.push(`    ${r.subject} (${r.subjectCode}) — ${r.employee || 'TBA'}`);
      if (i < list.length - 1) lines.push('');
    });
    lines.push('');
    lines.push('_You will get an attendance update as soon as marks are entered 📲_');
  }
  return lines.join('\n');
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM-DD' -> '12 Sep 2026' (civil date — TZ-independent label). */
function dateLabelFromYMD(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(ymd || '');
  return `${m[3]} ${MONTHS_SHORT[Number(m[2]) - 1] || '?'} ${m[1]}`;
}

/**
 * Backdated month-register alert — English only, real class date, per-lecture
 * detail when the portal cell holds 2+ lectures.
 *
 * NEW record (nothing stored before):
 *   📌 Attendance Update
 *
 *   Subject: Java
 *   Code: CS35303
 *   Class Date: 22 September 2026
 *   Status: ✅ Present
 *
 * EXISTING record whose status changed:
 *   📌 Attendance Updated
 *
 *   Subject: Java
 *   Code: CS35303
 *   Class Date: 22 September 2026
 *   Previous Status: ❌ Absent
 *   Current Status: ✅ Present
 *
 * `Teacher:` is added ONLY when a real teacher value was cross-matched from the
 * user's own timetable — never invented.
 */
function formatBackdatedUpdate(rec, prev = null) {
  const changed = Boolean(prev);
  const code = rec.subjectCode || '';
  const lines = [changed ? '📌 *Attendance Updated*' : '📌 *Attendance Update*', ''];
  lines.push(`Subject: ${rec.subject || code}`);
  if (code) lines.push(`Code: ${code}`);
  lines.push(`Class Date: ${fullDateLabelFromYMD(rec.date)}`);

  const multi = (rec.lectures || []).length > 1;
  if (changed) {
    if (multi) {
      const prevLectures = prev.lectures || [];
      const label = (l, i) => `L${i + 1} ${statusEmoji(l.status, l.statusRaw)}`;
      lines.push(`Previous Status: ${prevLectures.length ? prevLectures.map(label).join(' | ') : statusEmoji(prev.status, prev.statusRaw)}`);
      lines.push(`Current Status: ${rec.lectures.map(label).join(' | ')}`);
    } else {
      lines.push(`Previous Status: ${statusEmoji(prev.status, prev.statusRaw)}`);
      lines.push(`Current Status: ${statusEmoji(rec.status, rec.statusRaw)}`);
    }
  } else if (multi) {
    lines.push(`Status: ${rec.lectures.map((l, i) => `L${i + 1} ${statusEmoji(l.status, l.statusRaw)}`).join(' | ')}`);
  } else {
    lines.push(`Status: ${statusEmoji(rec.status, rec.statusRaw)}`);
  }

  if (rec.teacher) lines.push(`Teacher: ${rec.teacher}`);
  lines.push('');
  lines.push('QUMS attendance was updated for a previous class.');
  return lines.join('\n');
}

/** 'YYYY-MM-DD' -> '22 September 2026' (full month name — spec format). */
function fullDateLabelFromYMD(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(ymd || '');
  const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${Number(m[3])} ${MONTHS_FULL[Number(m[2]) - 1] || '?'} ${m[1]}`;
}

/**
 * Attendance summary message (on-demand; the daily 9 PM cron was removed —
 * this builder stays for the manual summary trigger).
 */
function formatAttendanceMessage(analysis) {
  const below = (analysis.subjects || []).filter((s) => s.status === 'below-75');
  const safe = (analysis.subjects || []).filter((s) => s.status !== 'below-75');
  const stamp = new Date(analysis.generatedAt).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const compactSubject = (subject) =>
    String(subject || 'Unknown subject')
      .replace('Object Oriented Programming with C++', 'OOP with C++')
      .replace('Programming in Java Concepts', 'Java Programming');
  const countText = (s) =>
    Number.isFinite(s.attendedEstimate) && Number.isFinite(s.totalClassesAssumed)
      ? `${s.attendedEstimate}/${s.totalClassesAssumed} attended`
      : '';
  const plural = (n, singular, pluralWord) => `${n} ${n === 1 ? singular : pluralWord}`;
  const lines = [
    '*\u{1F4CA} CLASSQU ATTENDANCE*',
    '━━━━━━━━━━━━━━━━━━━━',
    `\u{1F552} ${stamp} IST`,
    '',
  ];
  if (below.length) {
    lines.push(`\u26A0\uFE0F *BELOW 75% \u00B7 ${below.length} SUBJECTS*`, '');
    below.forEach((s, index) => {
      lines.push(
        `${index + 1}. *${compactSubject(s.subject)}*`,
        `   ${s.subjectCode || 'No code'} \u00B7 ${s.percentage}%`,
        `   \u2705 Attend next ${plural(s.classesNeeded, 'class', 'classes')}`,
        `   \u{1F4C8} ${countText(s)}`,
        ''
      );
    });
  }
  if (safe.length) {
    lines.push(`\u2705 *SAFE \u00B7 ${safe.length} SUBJECTS*`, '');
    safe.forEach((s) => {
      lines.push(
        `\u2022 *${compactSubject(s.subject)}*`,
        `  ${s.subjectCode || 'No code'} \u00B7 ${s.percentage}%`,
        `  Can miss ${plural(s.canSkip, 'class', 'classes')} \u00B7 ${countText(s)}`,
        ''
      );
    });
  }
  lines.push(
    '━━━━━━━━━━━━━━━━━━━━',
    `\u{1F4DA} ${analysis.summary.totalSubjects} subjects \u00B7 \u26A0\uFE0F ${analysis.summary.below75} need attention`
  );
  if (analysis.demoData) {
    lines.push('_(DEMO data — live scrape nahi hua)_');
  }
  return lines.join('\n');
}

// ---- Assignment notifications (Parts 5/6/7) ----

const QUMS_ASSIGNMENT_URL =
  'https://qums.quantumuniversity.edu.in/Web_StudentAcademic/Cyborg_StudentAssignment?id=Assignment';

/**
 * 📚 New Assignment
 *
 * Subject: Java
 * Assignment: OOP Assignment
 * Last Date: 25 September 2026
 *
 * 🔗 Open QUMS: <url>
 */
function formatNewAssignment(a) {
  const lines = [
    '📚 *New Assignment*',
    '',
    `Subject: ${a.subject || '—'}`,
    `Assignment: ${a.title || '—'}`,
  ];
  if (a.deadlineYMD) lines.push(`Last Date: ${fullDateLabelFromYMD(a.deadlineYMD)}`);
  if (a.teacher) lines.push(`Faculty: ${a.teacher}`);
  lines.push('');
  lines.push(`🔗 Open QUMS: ${QUMS_ASSIGNMENT_URL}`);
  return lines.join('\n');
}

/**
 * ⚠️ Assignment Deadline Reminder
 *
 * Subject: Java
 * Assignment: OOP Assignment
 *
 * Today is the last date to submit this assignment.
 * Please submit it before the deadline.
 *
 * 🔗 Open QUMS
 */
function formatAssignmentDeadlineReminder(a) {
  return [
    '⚠️ *Assignment Deadline Reminder*',
    '',
    `Subject: ${a.subject || '—'}`,
    `Assignment: ${a.title || '—'}`,
    '',
    'Today is the last date to submit this assignment.',
    'Please submit it before the deadline.',
    '',
    `🔗 Open QUMS: ${QUMS_ASSIGNMENT_URL}`,
  ].join('\n');
}

/**
 * Today's attendance report: breakdown of all classes today with
 * Present / Absent / Not Marked status, room, and teacher.
 */
function formatTodayAttendanceStatus(rows, dateLabel = dateLabelIST(), studentName = '') {
  const list = (rows || []).filter((r) => r.period || r.subject);
  const hi = studentName ? `Hi ${studentName}! ` : '';
  const lines = [`📅 *Today's Classes & Attendance* — ${dateLabel}`, ''];

  if (!list.length) {
    lines.push(`🎉 ${hi}No classes found for today or Sunday/Holiday. Enjoy your day!`);
    return lines.join('\n');
  }

  if (studentName) {
    lines.push(`${hi}Here is your period-wise attendance for today (${list.length} ${list.length === 1 ? 'class' : 'classes'}):`, '');
  } else {
    lines.push(`Here is your period-wise attendance for today (${list.length} ${list.length === 1 ? 'class' : 'classes'}):`, '');
  }

  let presentCount = 0;
  let absentCount = 0;
  let unmarkedCount = 0;
  let otherCount = 0;

  list.forEach((r, i) => {
    const dur = resolveDuration(r.duration, r.period);
    const pKey = extractPeriodKey(r.period);
    const periodLabel = dur
      ? `🕐 *${dur}*${pKey ? ` (${pKey})` : ''}`
      : `🕐 *${pKey ? `Period ${pKey}` : (r.period || `Class ${i + 1}`)}*`;
    lines.push(`${i + 1}. ${periodLabel}`);
    lines.push(`   📚 *${r.subject || 'Class'}*${r.subjectCode ? ` (${r.subjectCode})` : ''}`);

    let statusText = '⏳ *Not Marked Yet*';
    if (r.status === 'present') {
      statusText = '✅ *Present*';
      presentCount++;
    } else if (r.status === 'absent') {
      statusText = '❌ *Absent*';
      absentCount++;
    } else if (r.status === 'unmarked' || !r.status) {
      statusText = '⏳ *Not Marked Yet*';
      unmarkedCount++;
    } else {
      statusText = `ℹ️ *${norm(r.attendance) || 'Marked'}*`;
      otherCount++;
    }
    lines.push(`   Status: ${statusText}`);

    const details = [];
    if (r.room) details.push(`📍 Room: ${r.room}`);
    const teacher = r.teacher || r.employee;
    if (teacher) details.push(`👨‍🏫 ${teacher}`);
    if (details.length) {
      lines.push(`   ${details.join(' • ')}`);
    }
    lines.push('');
  });

  lines.push('📊 *Today\'s Summary:*');
  lines.push(`• ✅ Present: ${presentCount}`);
  lines.push(`• ❌ Absent: ${absentCount}`);
  if (unmarkedCount > 0) {
    lines.push(`• ⏳ Not Marked: ${unmarkedCount}`);
  }
  if (otherCount > 0) {
    lines.push(`• ℹ️ Other: ${otherCount}`);
  }
  lines.push(`• 📚 Total Classes: ${list.length}`);

  return lines.join('\n');
}

/**
 * Split a long text into chunks that fit within maxLen without cutting lines.
 */
function splitTelegramMessage(text, maxLen = 4000) {
  if (!text || text.length <= maxLen) return [text || ''];
  const lines = text.split('\n');
  const chunks = [];
  let current = '';
  for (const line of lines) {
    if ((current ? current + '\n' + line : line).length > maxLen) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = current ? current + '\n' + line : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Format full date-wise attendance report for Telegram.
 * dateInfo: { day, month, year, ymd, formattedDate }
 * rows: array of class records for that date
 * options: { studentName, isCached }
 */
function formatDateAttendanceReport(dateInfo, rows, options = {}) {
  const { day, month, year, ymd } = dateInfo;
  const dStr = `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
  const fullDate = fullDateLabelFromYMD(ymd || `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);

  const lines = [
    `📅 *Attendance for ${fullDate}* (${dStr})`,
    '',
  ];

  if (options.isCached) {
    lines.push('_Showing offline cached records. Live QUMS portal was unreachable._');
    lines.push('');
  }

  const list = (rows || []).filter((r) => r && (r.subject || r.subjectCode || r.period));
  if (!list.length) {
    lines.push('🎉 No classes or attendance records found for this date.');
    lines.push('(It may be a Sunday, holiday, or attendance was not marked.)');
    return lines.join('\n');
  }

  let totalClasses = 0;
  let presentCount = 0;
  let absentCount = 0;
  let unmarkedCount = 0;
  let otherCount = 0;

  list.forEach((r, idx) => {
    const subName = r.subject || r.subjectCode || 'Class';
    const subCode = (r.subjectCode && r.subject && r.subjectCode !== r.subject) ? ` (${r.subjectCode})` : '';
    lines.push(`${idx + 1}. 📚 *${subName}*${subCode}`);

    const lectures = Array.isArray(r.lectures) && r.lectures.length > 0 ? r.lectures : null;
    if (lectures && lectures.length > 1) {
      const parts = lectures.map((l, i) => {
        totalClasses++;
        if (l.status === 'present') presentCount++;
        else if (l.status === 'absent') absentCount++;
        else if (l.status === 'unmarked') unmarkedCount++;
        else otherCount++;
        let stText = statusEmoji(l.status, l.statusRaw);
        if (l.status === 'unmarked') stText = '⏳ Not Marked';
        return `L${i + 1} ${stText}`;
      });
      lines.push(`   Status: ${parts.join(' | ')}`);
    } else {
      totalClasses++;
      const st = (lectures && lectures[0]) ? lectures[0].status : (r.status || 'unmarked');
      const raw = (lectures && lectures[0]) ? lectures[0].statusRaw : (r.statusRaw || r.attendance);
      if (st === 'present') presentCount++;
      else if (st === 'absent') absentCount++;
      else if (st === 'unmarked') unmarkedCount++;
      else otherCount++;

      let statusDisplay = statusEmoji(st, raw);
      if (st === 'unmarked') statusDisplay = '⏳ Not Marked';
      lines.push(`   Status: ${statusDisplay}`);
    }

    const extras = [];
    if (r.duration) {
      const dur = resolveDuration(r.duration, r.period);
      if (dur) extras.push(`🕐 ${dur}`);
    } else if (r.period) {
      const pKey = extractPeriodKey(r.period);
      extras.push(`🕐 ${pKey ? `Period ${pKey}` : r.period}`);
    }
    if (r.room) extras.push(`📍 Room: ${r.room}`);
    const teacher = r.teacher || r.employee;
    if (teacher) extras.push(`👨‍🏫 ${teacher}`);

    if (extras.length) {
      lines.push(`   ${extras.join(' • ')}`);
    }
    lines.push('');
  });

  lines.push('📊 *Day Summary:*');
  lines.push(`• ✅ Present: ${presentCount}`);
  lines.push(`• ❌ Absent: ${absentCount}`);
  if (unmarkedCount > 0) {
    lines.push(`• ⏳ Not Marked: ${unmarkedCount}`);
  }
  if (otherCount > 0) {
    lines.push(`• ℹ️ Other: ${otherCount}`);
  }
  lines.push(`• 📚 Total Classes: ${totalClasses}`);

  return lines.join('\n');
}

module.exports = {
  dateLabelIST,
  dateLabelFromYMD,
  fullDateLabelFromYMD,
  statusEmoji,
  formatAttendanceUpdate,
  formatBackdatedUpdate,
  formatMorningSchedule,
  formatAttendanceMessage,
  formatTodayAttendanceStatus,
  formatDateAttendanceReport,
  splitTelegramMessage,
  formatNewAssignment,
  formatAssignmentDeadlineReminder,
  QUMS_ASSIGNMENT_URL,
  norm,
};
