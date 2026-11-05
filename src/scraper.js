
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { request: playwrightRequest, chromium } = require('playwright');

const SESSION_FILE = path.join(__dirname, '..', 'session_state.json');
const DASHBOARD_URL =
  process.env.QUMS_DASHBOARD_URL ||
  'https://qums.quantumuniversity.edu.in/Web_StudentAcademic/Cyborg_S_Dashboard';
const TIMETABLE_URL =
  process.env.QUMS_TIMETABLE_URL ||
  'https://qums.quantumuniversity.edu.in/Web_StudentAcademic/Cyborg_StudentTimeTable?id=Time%20Table';
const ATTENDANCE_API = '/Web_StudentAcademic/GetYearSemWiseAttendance';
// QUMS student-detail API (live-probed): POST { RegID } ->
// { state: "[{ RegID, StudentID, EnrollmentNo, StudentName, ... }]" }
const STUDENT_DETAIL_API = '/Web_StudentAcademic/GetStudentDetailOnRegID';
// QUMS assignment page + its AJAX API (from Cyborg_StudentAssignment?id=Assignment):
//   POST /Web_StudentAcademic/GetStudentAssignment { RegID }
//     -> { state:  "[...assignment rows: AssignID, AssignmentDetailID, ASSIGNMENT
//                   (title), ASSIGNMENTSUBJECT, CLASSSUBJECT, EMPLOYEENAME,
//                   Assignmenttype, DATEFROM, DATETO (submit/deadline), UploadFlag...]",
//          state2: "[...study-material/assignment-detail rows: AssignmentDetailID,
//                   Subject (title), ASSIGNMENTSUBJECT, CLASSSUBJECT, EMPLOYEENAME...]" }
const ASSIGNMENT_PAGE_URL =
  process.env.QUMS_ASSIGNMENT_URL ||
  'https://qums.quantumuniversity.edu.in/Web_StudentAcademic/Cyborg_StudentAssignment?id=Assignment';
const ASSIGNMENT_API = '/Web_StudentAcademic/GetStudentAssignment';

class ScrapeError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'ScrapeError';
    this.hint = hint || null;
  }
}
class SessionExpiredError extends Error {
  constructor() {
    super('QUMS session expired — the portal returned the login page.');
    this.name = 'SessionExpiredError';
    this.hint = 'Dashboard → QUMS Setup → "Reconnect QUMS" — you only need to solve the captcha.';
  }
}
/**
 * QUMS could not be reached (DNS/socket/timeout/5xx/portal maintenance).
 * IMPORTANT: this is NOT a session expiry. Watchers must not mark the session
 * expired or spam the user with a reconnect alert for a temporary outage —
 * they retry on the next cycle instead.
 */
class QumsUnreachableError extends Error {
  constructor(message, cause) {
    super(message || 'QUMS portal is unreachable right now.');
    this.name = 'QumsUnreachableError';
    this.cause = cause || null;
    this.hint = 'Portal down ya network issue — thodi der baad agla cycle retry karega.';
  }
}
class NoSessionError extends Error {
  constructor() {
    super('No saved QUMS session found (session_state.json missing).');
    this.name = 'NoSessionError';
    this.hint = 'Dashboard → QUMS Setup → run the one-time QID/password + captcha login.';
  }
}

/** Network-level failures (never an authentication signal). */
function isNetworkError(err) {
  const m = String((err && err.message) || '').toLowerCase();
  return (
    err instanceof QumsUnreachableError ||
    /econnrefused|econnreset|etimedout|eai_again|enotfound|socket hang up|network|timeout|timed out|fetch failed|aborted|502|503|504/.test(m)
  );
}


const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

function assertSessionFile(sessionPath) {
  if (!sessionPath || typeof sessionPath !== 'string') {
    const e = new NoSessionError('No QUMS session path provided.');
    throw e;
  }
  if (!fs.existsSync(sessionPath)) {
    const e = new NoSessionError(`QUMS session file does not exist: ${sessionPath}`);
    e.sessionPath = sessionPath;
    throw e;
  }
}

function looksLikeLoginHtml(html) {
  const lower = (html || '').toLowerCase();
  const hasLoginForm = /<input[^>]+type=["']password["']/.test(lower);
  const titleSaysLogin = /<title>[^<]*(login|sign in)/.test(lower);
  const noStudentData = !/var\s+RegID\s*=\s*'/i.test(lower);
  return (hasLoginForm && noStudentData) || titleSaysLogin;
}

/**
 * Browser page pe session-expired detection (no UI clicking — URL-only policy):
 * login pe redirect hua? -> clear SessionExpiredError throw karo.
 * 3 signals: (1) URL me 'login', (2) password input rendered hai,
 * (3) HTML shape login jaisi hai (looksLikeLoginHtml). QUMS login page root URL
 * (https://qums.quantumuniversity.edu.in/) pe serve hota hai — isliye sirf URL
 * check kaafi nahi, HTML check zaroori hai.
 */
async function throwIfLoginPage(page) {
  const lowerUrl = (page.url() || '').toLowerCase();
  if (lowerUrl.includes('login')) throw new SessionExpiredError();
  const passwordBoxes = await page.locator('input[type="password"]').count();
  if (passwordBoxes > 0) throw new SessionExpiredError();
  const html = await page.content().catch(() => '');
  if (looksLikeLoginHtml(html)) throw new SessionExpiredError();
}

const regIdMemoryCache = new Map(); // sessionPath -> { regId, time }
const REGID_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

function getCachedRegId(sessionPath) {
  if (!sessionPath) return null;
  const entry = regIdMemoryCache.get(sessionPath);
  if (entry && Date.now() - entry.time < REGID_CACHE_TTL) {
    return entry.regId;
  }
  return null;
}

function setCachedRegId(sessionPath, regId) {
  if (sessionPath && regId) {
    regIdMemoryCache.set(sessionPath, { regId, time: Date.now() });
  }
}

function clearCachedRegId(sessionPath) {
  if (sessionPath) regIdMemoryCache.delete(sessionPath);
}

/** Fetch the dashboard page and pull out the embedded RegID + selected Year/Sem. */
async function getStudentContext(apiContext, opts = {}) {
  const sessionPath = opts.sessionPath || null;
  const resp = await apiGet(apiContext, DASHBOARD_URL, { timeout: 60000 });

  if (!resp.ok()) {
    throw new ScrapeError(
      `Dashboard load failed (HTTP ${resp.status()}).`,
      'Portal down ho sakta hai — thodi der baad retry karo.'
    );
  }

  const html = await resp.text();
  if (looksLikeLoginHtml(html)) {
    if (sessionPath) clearCachedRegId(sessionPath);
    throw new SessionExpiredError();
  }

  // QUMS embeds RegID in the dashboard page.
  const regIdMatch =
    html.match(/var\s+RegID\s*=\s*[\'\"](\d+)[\'\"]/i) ||
    html.match(/\bRegID\s*[:=]\s*[\'\"]?(\d+)[\'\"]?/i);

  const regId = regIdMatch ? regIdMatch[1] : null;

  if (!regId) {
    throw new ScrapeError(
      'Dashboard HTML me RegID nahi mila.',
      'Dashboard → QUMS Setup → Reconnect QUMS try karo.'
    );
  }
  if (sessionPath) setCachedRegId(sessionPath, regId);

  const detectedYearSems = [];
  let yearSem = null;
  let attendancePayload = null;

  // FAST PATH 1: If known/hinted yearSem is passed (e.g. from user profile or opts), check it FIRST!
  const candidateSem = String(opts.yearSem || opts.hintYearSem || '').trim();
  if (/^[1-8]$/.test(candidateSem)) {
    try {
      const attendanceResp = await apiPost(apiContext, ATTENDANCE_API, {
        form: { RegID: regId, YearSem: candidateSem },
        timeout: 30000,
      });
      if (attendanceResp.ok()) {
        const raw = await attendanceResp.text();
        if (raw && !raw.trim().startsWith('<')) {
          const payload = JSON.parse(raw);
          let rawRows = [];
          try {
            rawRows = typeof payload.data === 'string'
              ? JSON.parse(payload.data || '[]')
              : (Array.isArray(payload.data) ? payload.data : []);
          } catch {
            rawRows = [];
          }
          const hasSubjects = Array.isArray(rawRows) && rawRows.some(
            (row) => row && (norm(row.Subject) || norm(row.SubjectCode))
          );
          if (hasSubjects) {
            yearSem = candidateSem;
            detectedYearSems.push(candidateSem);
            attendancePayload = payload;
          }
        }
      }
    } catch {}
  }

  // FAST PATH 2: If not found yet, probe remaining semesters in PARALLEL via Promise.all
  if (!yearSem) {
    const semsToProbe = [1, 2, 3, 4, 5, 6, 7, 8].filter((s) => String(s) !== candidateSem);
    const probeResults = await Promise.all(
      semsToProbe.map(async (sem) => {
        try {
          const attendanceResp = await apiPost(apiContext, ATTENDANCE_API, {
            form: { RegID: regId, YearSem: String(sem) },
            timeout: 30000,
          });
          if (!attendanceResp.ok()) return null;
          const raw = await attendanceResp.text();
          if (!raw || raw.trim().startsWith('<')) return null;
          const payload = JSON.parse(raw);
          let rawRows = [];
          try {
            rawRows = typeof payload.data === 'string'
              ? JSON.parse(payload.data || '[]')
              : (Array.isArray(payload.data) ? payload.data : []);
          } catch {
            rawRows = [];
          }
          const hasSubjects = Array.isArray(rawRows) && rawRows.some(
            (row) => row && (norm(row.Subject) || norm(row.SubjectCode))
          );
          if (hasSubjects) {
            return { sem: String(sem), payload };
          }
        } catch {}
        return null;
      })
    );

    for (const res of probeResults) {
      if (res) {
        detectedYearSems.push(res.sem);
        if (!yearSem) {
          yearSem = res.sem;
          attendancePayload = res.payload;
        }
      }
    }
  }

  // Compatibility fallback only if the portal API returned no active semester.
  if (!yearSem) {
    const envSem = String(process.env.QUMS_CURRENT_YEARSEM || '').trim();
    if (/^[1-8]$/.test(envSem)) yearSem = envSem;
  }

  if (!yearSem) {
    throw new ScrapeError(
      'QUMS se current Year/Sem aur subjects detect nahi hue.',
      'GetYearSemWiseAttendance ne Sem 1-8 me kisi bhi value par subjects return nahi kiye. QUMS Setup → Reconnect QUMS karke retry karo.'
    );
  }

  console.log(
    `[QUMS] Student context detected: RegID=${regId}, YearSem=${yearSem}` +
    (detectedYearSems.length > 1
      ? `, available active Year/Sems=${detectedYearSems.join(',')}`
      : '')
  );

  let studentName = opts.studentName || '';
  if (!studentName) {
    try {
      let detailResp = await apiPost(apiContext, STUDENT_DETAIL_API, {
        data: { RegID: String(regId) },
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Requested-With': 'XMLHttpRequest' },
        timeout: 30000,
      }).catch(() => null);
      if (!detailResp || !detailResp.ok()) {
        detailResp = await apiPost(apiContext, STUDENT_DETAIL_API, {
          form: { RegID: String(regId) },
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
          timeout: 30000,
        }).catch(() => null);
      }
      if (detailResp && detailResp.ok()) {
        const detailRaw = await detailResp.text();
        if (detailRaw && !detailRaw.trim().startsWith('<')) {
          const parsed = JSON.parse(detailRaw);
          const extracted = extractProfileFromPayload(parsed);
          if (extracted.studentName) studentName = extracted.studentName;
        }
      }
    } catch (err) {
      console.log(`[QUMS] student-name lookup skipped: ${err.name || 'Error'}: ${err.message}`);
    }
  }

  return {
    regId,
    yearSem,
    availableYearSems: detectedYearSems,
    studentName,
    attendancePayload,
  };
}

/** Map one API row to the app's subject shape, with EXACT counts attached. */
function mapAttendanceRow(raw) {
  const num = (v) => {
    if (v === undefined || v === null || String(v).trim() === '') return null;
    const n = Number(String(v).trim());
    return Number.isFinite(n) ? n : null;
  };
  const row = {
    subject: norm(raw.Subject),
    subjectCode: norm(raw.SubjectCode),
    percentage: num(raw.Percentage),
    topAttendance: norm(raw.Toper) || undefined,
    totalClasses: num(raw.TotalLecture) ?? undefined,
    attended: num(raw.TotalPresent) ?? undefined,
    totalAbsent: num(raw.TotalAbsent) ?? undefined,
    totalLeave: num(raw.TotalLeave) ?? undefined,
    yearSem: norm(raw.YearSem) || undefined,
  };
  // Recompute percentage from exact counts when they exist and look sane.
  if (row.totalClasses > 0 && row.attended != null && row.attended >= 0) {
    row.percentageExact = Math.round((row.attended / row.totalClasses) * 1000) / 10;
  }
  return row;
}

/** Shared API context: session cookies + AJAX-ish headers, no browser needed. */
async function newApiContext(sessionPath = SESSION_FILE) {
  try {
    return await playwrightRequest.newContext({
      storageState: sessionPath,
      baseURL: new URL(DASHBOARD_URL).origin,
      extraHTTPHeaders: { 'X-Requested-With': 'XMLHttpRequest', Referer: DASHBOARD_URL },
    });
  } catch (err) {
    // Corrupt/unreadable session file or a network-level context failure is NOT
    // proof that the authenticated session expired.
    throw new QumsUnreachableError(`QUMS request context failed: ${err.message}`, err);
  }
}

/** GET/POST helpers: classify transport failures so watchers never mistake a
 *  temporary outage for session expiry (requirement: no Telegram spam on outages). */
async function apiGet(ctx, url, opts = {}) {
  try {
    return await ctx.get(url, opts);
  } catch (err) {
    throw new QumsUnreachableError(`QUMS GET ${url} failed: ${err.message}`, err);
  }
}
async function apiPost(ctx, url, { form, data, headers, timeout } = {}) {
  try {
    const opts = { timeout };
    if (form) opts.form = form;
    if (data) opts.data = data;
    if (headers) opts.headers = headers;
    return await ctx.post(url, opts);
  } catch (err) {
    throw new QumsUnreachableError(`QUMS POST ${url} failed: ${err.message}`, err);
  }
}

/**
 * Main entry: scrape attendance for the current Year/Sem via the portal's
 * own API. opts: { sessionPath } (default = root session_state.json).
 * Returns an array of subject rows with EXACT counts:
 *   [{ subject, subjectCode, percentage, percentageExact, topAttendance,
 *      totalClasses, attended, totalAbsent, totalLeave, yearSem }]
 */
async function scrapeAttendance(opts = {}) {
  const sessionPath = opts.sessionPath || SESSION_FILE;
  assertSessionFile(sessionPath);
  const apiContext = await newApiContext(sessionPath);
  try {
    const { regId, yearSem, availableYearSems, attendancePayload } = await getStudentContext(apiContext, {
      sessionPath,
      yearSem: opts.yearSem,
      studentName: opts.studentName,
    });
    const candidates = [yearSem, ...(availableYearSems || []).filter((v) => v !== yearSem)];
    let payload = attendancePayload || null;
    let usedYearSem = yearSem;

    if (!payload) {
      for (const candidate of candidates) {
        const resp = await apiPost(apiContext, ATTENDANCE_API, {
          form: { RegID: regId, YearSem: candidate },
          timeout: 60000,
        });
        if (!resp.ok()) continue;
        try {
          const p = await resp.json();
          const rowsText = typeof p.data === 'string' ? p.data.trim() : '';
          if (!rowsText) continue;
          const rawRows = JSON.parse(rowsText);
          if (Array.isArray(rawRows) && rawRows.some((r) => r && (r.Subject || r.SubjectCode))) {
            payload = p;
            usedYearSem = candidate;
            break;
          }
        } catch { }
      }
    }

    if (!payload) {
      throw new ScrapeError(
        `Attendance API returned no subjects (tried Year/Sem: ${candidates.join(', ')}).`,
        'QUMS ne valid subjects return nahi kiye. Reconnect QUMS karke retry karo.'
      );
    }

    const rows = JSON.parse(payload.data).map(mapAttendanceRow).filter((r) => r.subject);
    if (!rows.length) throw new ScrapeError(`Attendance API returned an empty subject list (YearSem=${usedYearSem}).`, 'Reconnect QUMS karke retry karo.');

    let summary = null;
    try {
      const st = JSON.parse(payload.state || '[]')[0];
      if (st) {
        const rawTot = st.TotalPercentage !== undefined && st.TotalPercentage !== null && String(st.TotalPercentage).trim() !== ''
          ? String(st.TotalPercentage).trim()
          : null;
        const numTot = rawTot !== null && !isNaN(Number(rawTot)) ? Number(rawTot) : null;
        summary = {
          dateFrom: norm(st.DateFrom),
          dateTo: norm(st.DateTo),
          overallPercentage: numTot,
          overallPercentageRaw: rawTot || undefined,
        };
      }
    } catch { }

    return rows.map((r) => ({ ...r, periodSummary: summary }));
  } finally {
    await apiContext.dispose();
  }
}

// ---------------------------------------------------------------------------
// Today's Attendance (watcher ke liye) — the "Today's Attendance" jqGrid data.
// Portal contract (reverse-engineered from its own JS, FillAttendanceToday):
//   POST /Web_StudentAcademic/GetTodayAttendance  { RegID, date: 'DD/MM/YYYY' }
//   -> JSON body: "" (empty) | { state: "[{Period, Duration, subject,
//      SubjectCode, Employeename, Attend}, ...]" }
// `Attend` values: "N.M." = not marked; "P"/"A"/"PRESENT"/"ABSENT" etc. when marked.
// ---------------------------------------------------------------------------

const TODAY_ATTENDANCE_API = '/Web_StudentAcademic/GetTodayAttendance';
const MONTH_REGISTER_API = '/Web_StudentAcademic/GetMonthRegister';
const TIMETABLE_API = '/Web_StudentAcademic/FillStudentTimeTable';


/** Current date in IST as DD/MM/YYYY (the format QUMS APIs expect). */
function istDateString(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(d);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
  return `${get('day')}/${get('month')}/${get('year')}`;
}

/** Normalize the portal's Attend value: 'unmarked' | 'present' | 'absent' | 'other'. */
function normalizeAttendanceValue(value) {
  const v = norm(value).toUpperCase().replace(/\./g, '');
  if (!v || v === 'NM' || v === 'NOT MARKED' || v === '-') return 'unmarked';
  if (v.includes('P')) return 'present'; // P / PRESENT (checked before A)
  if (v.includes('A')) return 'absent'; // A / ABSENT
  return 'other'; // e.g. L(EAVE) — notify with the raw value
}

/** Map one raw API row to the watcher's row shape (+ dedupe key). */
function mapTodayRow(raw) {
  const period = norm(raw.Period);
  const subjectCode = norm(raw.SubjectCode);
  return {
    period,
    duration: norm(raw.Duration),
    subject: norm(raw.subject),
    subjectCode,
    employee: norm(raw.Employeename),
    attendance: norm(raw.Attend),
    status: normalizeAttendanceValue(raw.Attend),
    key: `${period}-${subjectCode}`,
  };
}

/**
 * Scrape "Today's Attendance" rows. opts: { sessionPath, date }.
 * Rows: [{ period, duration, subject, subjectCode, employee, attendance, status, key }]
 * Empty portal response ("") -> [].
 */
async function scrapeTodaysAttendance(opts = {}) {
  const dateStr = typeof opts === 'string' ? opts : opts.date; // legacy: string date
  const sessionPath = (typeof opts === 'object' && opts.sessionPath) || SESSION_FILE;
  assertSessionFile(sessionPath);
  const apiContext = await newApiContext(sessionPath);
  try {
    const regId = await getRegIdLight(apiContext, { sessionPath });
    const date = dateStr || istDateString();

    const resp = await apiPost(apiContext, TODAY_ATTENDANCE_API, {
      form: { RegID: regId, date },
      timeout: 60000,
    });
    if (!resp.ok()) {
      throw new ScrapeError(
        `Today's-attendance API failed (HTTP ${resp.status()}).`,
        'Portal down ya session issue — thodi der baad retry, ya Dashboard → QUMS Setup → Reconnect QUMS.'
      );
    }
    const body = await resp.text();
    if (body.trim().startsWith('<')) {
      clearCachedRegId(sessionPath);
      throw new SessionExpiredError(); // HTML = login page
    }

    let rawRows = [];
    try {
      const parsed = JSON.parse(body);
      if (Array.isArray(parsed)) rawRows = parsed;
      else if (parsed && typeof parsed.state === 'string' && parsed.state.trim()) {
        rawRows = JSON.parse(parsed.state);
      }
    } catch {
      rawRows = []; // unparseable = treat as "nothing yet"
    }
    return rawRows.map(mapTodayRow).filter((r) => r.period || r.subject);
  } finally {
    await apiContext.dispose();
  }
}

/**
 * Bonus: parse the timetable grid (Days x Periods) — DOM-based (no simple JSON
 * endpoint). Handles BOTH layouts seen in the wild:
 *   1. plain table: header row ["Day","P1",...], day name in the FIRST cell
 *   2. live QUMS jqGrid: period headers live in a sibling table
 *      (table.ui-jqgrid-htable: ["", "Days/Period", "(P1)09:00 - 09:55", ...]),
 *      and data rows look like ["1", "Monday", "Subject(CODE) (Room),Teacher", ...]
 *      — row-number col first, day name in the SECOND cell.
 * Day column is auto-detected by matching a weekday name in each row, so both
 * layouts (and header rows with empty cells) work.
 */
function parseTimetableInPage() {
  const normLocal = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const DAY_RE = /^(monday|tuesday|wednesday|thursday|thrusday|friday|saturday|sunday|mon|tues|wed|thurs|thrus|fri|sat|sun)\b/i;
  let best = null;
  for (const table of document.querySelectorAll('table')) {
    const trs = Array.from(table.querySelectorAll('tr'));
    if (!trs.length) continue;

    // Header: <thead> ka last row, warna pehli row; empty ho to jqGrid ke
    // sibling header-table (ui-jqgrid-htable) se.
    let headerCells = null;
    if (table.tHead && table.tHead.rows.length) {
      headerCells = Array.from(table.tHead.rows[table.tHead.rows.length - 1].cells).map((c) => normLocal(c.textContent));
    }
    if (!headerCells || headerCells.filter(Boolean).length < 2) {
      headerCells = Array.from(trs[0].querySelectorAll('th,td')).map((c) => normLocal(c.textContent));
    }
    if (!headerCells || headerCells.filter(Boolean).length < 2) {
      const ht = document.querySelector('table.ui-jqgrid-htable');
      if (ht) {
        for (let r = ht.rows.length - 1; r >= 0; r--) {
          const cs = Array.from(ht.rows[r].cells).map((c) => normLocal(c.textContent));
          if (cs.filter(Boolean).length >= 2) {
            headerCells = cs;
            break;
          }
        }
      }
    }

    const days = [];
    for (const tr of trs) {
      const cells = Array.from(tr.querySelectorAll('th,td')).map((c) => normLocal(c.textContent));
      const dayIdx = cells.findIndex((c) => DAY_RE.test(c));
      if (dayIdx === -1) continue; // header / empty jqGrid row
      const periods = cells.slice(dayIdx + 1).map((text, i) => ({
        period: (headerCells && headerCells[dayIdx + 1 + i]) || `P${i + 1}`,
        text,
      }));
      days.push({ day: cells[dayIdx], periods });
    }
    if (days.length >= 2 && (!best || days.length > best.days.length)) {
      best = { periods: (headerCells || []).slice(2), days };
    }
  }
  return best;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Subject code pattern: QUMS codes like CS35303, AE35362, SI35375 (2-6 digits bhi chalega). */
const CODE_RE = /([A-Za-z]{2,4}\d{2,6})/;

/** 'CS35303 (Design and Analysis of Algorithm (S))' -> { subjectCode, subject }. */
function parseSubjectLabel(label) {
  const text = norm(label);
  const m = text.match(/^([A-Za-z]{2,4}\d{2,6})\s*\((.*)\)$/);
  if (m) {
    // trailing "(S)"/"(L)"/"(T)" section-tag hata do (display ke liye)
    const subject = norm(m[2]).replace(/\s*\(([SLT])\)$/i, '');
    return { subjectCode: m[1].toUpperCase(), subject };
  }
  const c = text.match(CODE_RE);
  return { subjectCode: c ? c[1].toUpperCase() : '', subject: text };
}

/**
 * Timetable period cell — step-by-step parsing (single-regex nahi, kyunki
 * cell format hamesha same nahi hota: room kabhi 1 paren group, kabhi 2 —
 * labs me section suffix ke saath).
 *
 * Live examples:
 *   "Design and Analysis of Algorithm (CS35303) (A-004),RAJ KUMAR"
 *       -> { subject: 'Design and Analysis of Algorithm', subjectCode: 'CS35303', room: 'A-004', teacher: 'RAJ KUMAR' }
 *   "Design and Analysis of Algorithm Lab(CS35363) (E-202)(B),RAJ KUMAR"
 *       -> { ..., room: 'E-202B', ... }   (E-202 + B join)
 *   "R Programming(CS3026/CS30364) (A-102),TEACHER NAME"
 *       -> { subjectCode: 'CS3026/CS30364', room: 'A-102', ... }
 *
 * 1) Teacher hamesha LAST comma ke baad (subject names me comma ho sakte hain).
 * 2) Saare (...) groups: pehla = subject code, baaki join = room.
 * 3) Subject = parens hata ke jo bacha.
/** Standard weekdays in order */
const STANDARD_WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function canonicalDayTitle(name) {
  const k = canonicalDayKey(name);
  const match = STANDARD_WEEKDAYS.find((d) => d.toLowerCase() === k);
  return match || norm(name);
}

function normalizeTimeTo24h(timeStr, ampm) {
  if (!timeStr) return '';
  const parts = timeStr.split(':').map(Number);
  let h = parts[0];
  const m = parts[1] || 0;
  const p = String(ampm || '').toUpperCase().trim();
  if (p === 'PM' && h < 12) h += 12;
  if (p === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function parsePeriodTimeInfo(periodStr, durationStr = '') {
  const p = norm(periodStr);
  const d = norm(durationStr);
  const dur = d || extractTimeRange(p) || resolvePeriodDuration('', p);
  const m12 = dur.match(/(\d{1,2}:\d{2})\s*(AM|PM)?\s*-\s*(\d{1,2}:\d{2})\s*(AM|PM)?/i);
  let startTime = '';
  let endTime = '';
  if (m12) {
    const startRaw = m12[1];
    const startAmPm = m12[2];
    const endRaw = m12[3];
    const endAmPm = m12[4];
    startTime = normalizeTimeTo24h(startRaw, startAmPm || (endAmPm === 'PM' && Number(startRaw.split(':')[0]) < 12 ? 'PM' : ''));
    endTime = normalizeTimeTo24h(endRaw, endAmPm);
  }
  const periodKey = extractPeriodKey(p);
  const mNum = (periodKey || p).match(/\d+/);
  const periodNumber = mNum ? Number(mNum[0]) : null;
  const startParts = startTime.split(':').map(Number);
  const startTimeMinutes = startParts.length >= 2 && !Number.isNaN(startParts[0]) && !Number.isNaN(startParts[1])
    ? startParts[0] * 60 + startParts[1]
    : null;

  return {
    period: periodKey || p,
    periodNumber,
    rawPeriod: p,
    duration: dur,
    startTime,
    endTime,
    startTimeMinutes,
  };
}

function splitTimetableEntries(text) {
  const entries = [];
  let cur = '';
  let phase = 'subject'; // subject -> paren -> post-paren -> teacher (comma ke baad)
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') {
      const close = text.indexOf(')', i);
      const end = close === -1 ? text.length : close + 1;
      cur += text.slice(i, end);
      i = end - 1;
      phase = 'post-paren';
      continue;
    }
    if (ch === ',' && phase === 'post-paren') {
      phase = 'teacher';
      cur += ch;
      continue;
    }
    if (ch === '-' && phase === 'teacher') {
      // Teacher ke baad '-' separator tabhi split hoga agar agle hisse me '(' (subject code) hai.
      // Subject names me comma ho sakte hain (e.g. "Contracts, Taxation and Beyond"),
      // isliye nextComma check nahi karte.
      const nextParen = text.indexOf('(', i);
      if (nextParen !== -1) {
        entries.push(cur);
        cur = '';
        phase = 'subject';
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim()) entries.push(cur);
  return entries;
}

/** Cell ke saare subject entries (multi-subject cells supported). */
function parseTimetableCellEntries(rawText) {
  const text = norm(rawText);
  if (!text) return [];
  return splitTimetableEntries(text).map((entry) => {
    const lastComma = entry.lastIndexOf(',');
    const teacher = lastComma !== -1 ? norm(entry.slice(lastComma + 1)) : '';
    const beforeTeacher = lastComma !== -1 ? entry.slice(0, lastComma) : entry;
    const groups = [];
    const parenRe = /\(([^()]*)\)/g;
    let m;
    while ((m = parenRe.exec(beforeTeacher)) !== null) groups.push(m[1].trim());
    const subjectCode = groups[0] || '';
    const room = groups.slice(1).join('');
    const subject = norm(beforeTeacher.replace(/\([^)]*\)/g, ''));
    return { subject, subjectCode, room, teacher };
  });
}

/** First-entry compat wrapper (purana naam — single-subject cells ke liye same). */
function parseTimetableCell(rawText) {
  const entries = parseTimetableCellEntries(rawText);
  return entries[0] || { subject: '', subjectCode: '', room: '', teacher: '' };
}

/** FillStudentTimeTable ka `state` rows -> timetable { periods, days }. */
function parseTimetableApiState(rows) {
  const periodKeys = [];
  for (const row of rows || []) {
    for (const k of Object.keys(row || {})) {
      if (k !== 'Days/Period' && k !== 'rn' && !k.startsWith('_') && !periodKeys.includes(k)) {
        periodKeys.push(k);
      }
    }
  }

  // Chronological sort on periodKeys
  periodKeys.sort((a, b) => {
    const infoA = parsePeriodTimeInfo(a);
    const infoB = parsePeriodTimeInfo(b);
    if (infoA.startTime && infoB.startTime && infoA.startTime !== infoB.startTime) {
      return infoA.startTime.localeCompare(infoB.startTime);
    }
    const numA = parseInt((infoA.period || '').replace(/\D/g, ''), 10);
    const numB = parseInt((infoB.period || '').replace(/\D/g, ''), 10);
    if (!isNaN(numA) && !isNaN(numB) && numA !== numB) return numA - numB;
    return a.localeCompare(b);
  });

  const days = (rows || [])
    .map((row) => {
      const rawDay = norm(row['Days/Period']);
      const canonicalDay = canonicalDayTitle(rawDay);
      return {
        day: rawDay, // raw preserved for test compatibility
        dayName: canonicalDay, // normalized weekday title (e.g. 'Thursday')
        periods: periodKeys.map((pk) => {
          const info = parsePeriodTimeInfo(pk);
          return {
            period: pk,
            periodCode: info.period,
            duration: info.duration,
            startTime: info.startTime,
            endTime: info.endTime,
            text: norm(row[pk] || ''),
          };
        }),
      };
    })
    .filter((d) => d.day);

  // Sort days in standard weekly order (Monday -> Sunday)
  days.sort((a, b) => {
    const idxA = STANDARD_WEEKDAYS.indexOf(a.dayName);
    const idxB = STANDARD_WEEKDAYS.indexOf(b.dayName);
    return (idxA !== -1 ? idxA : 99) - (idxB !== -1 ? idxB : 99);
  });

  return { periods: periodKeys, days };
}

/** Alias — purana naam, same logic. */
const parsePeriodCell = parseTimetableCell;

/** 'YYYY-MM-DD' | 'DD/MM/YYYY' -> Date (civil/local, weekday TZ-safe). */
function dateFromAny(dateLike) {
  if (dateLike instanceof Date) return dateLike;
  const s = String(dateLike || '');
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/**
 * Day-name matching portal ke typos ko bhi handle kare — especially
 * "Thrusday" (T-h-r-u!) jo startsWith('thu') se KABHI match nahi hota.
 * Canonical: pehle 3 letters -> alias table (thr/thu => thursday, tues => tuesday).
 */
const DAY_ALIASES = { thu: 'thursday', thr: 'thursday', tues: 'tuesday', wen: 'wednesday', mon: 'monday', tue: 'tuesday', wed: 'wednesday', fri: 'friday', sat: 'saturday', sun: 'sunday' };

function canonicalDayKey(name) {
  const k = String(name || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 3);
  return DAY_ALIASES[k] || k;
}

/**
 * getTodaySubjects ka generalized version: kisi bhi date ka weekday nikaal ke
 * timetable grid ki us row ko parse karta hai — teacher + room ke saath.
 */
function getTimetableForDate(timetable, date = new Date()) {
  if (!timetable || !Array.isArray(timetable.days)) return [];
  let want;
  if (date instanceof Date) {
    const wdName = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata',
      weekday: 'long',
    }).format(date);
    want = canonicalDayKey(wdName);
  } else {
    const wd = dateFromAny(date).getDay();
    want = canonicalDayKey(DAY_NAMES[wd]);
  }
  const row = timetable.days.find(
    (d) => canonicalDayKey(d.day) === want || canonicalDayKey(d.dayName) === want
  );
  if (!row) return [];
  return (row.periods || [])
    .filter((p) => {
      const txt = p.text || p.raw || p.subject || '';
      return txt && !/break|lunch|^free/i.test(txt);
    })
    .flatMap((p) => {
      const timeInfo = parsePeriodTimeInfo(p.period, p.duration);
      if (p.subject && !p.text) {
        return [{
          period: p.period,
          periodCode: timeInfo.period,
          duration: timeInfo.duration || p.duration,
          startTime: timeInfo.startTime || (p.startTime ? p.startTime : ''),
          endTime: timeInfo.endTime || (p.endTime ? p.endTime : ''),
          subject: p.subject || '',
          subjectCode: p.subjectCode || '',
          room: p.room || '',
          teacher: p.teacher || '',
          raw: p.raw || p.subject || '',
        }];
      }
      return parseTimetableCellEntries(p.text || p.raw || '').map((cell) => ({
        period: p.period,
        periodCode: timeInfo.period,
        duration: timeInfo.duration,
        startTime: timeInfo.startTime,
        endTime: timeInfo.endTime,
        subject: cell.subject || '',
        subjectCode: cell.subjectCode || '',
        room: cell.room || '',
        teacher: cell.teacher || '',
        raw: p.text || p.raw || '',
      }));
    });
}

/** Return clean normalized weekly timetable grouped by weekday, sorted chronologically */
function formatNormalizedTimetable(timetable) {
  if (!timetable || !Array.isArray(timetable.days)) {
    return { days: [] };
  }
  const activeWeekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const days = activeWeekdays.map((weekday) => {
    const row = timetable.days.find(
      (d) => canonicalDayKey(d.day) === canonicalDayKey(weekday) || canonicalDayKey(d.dayName) === canonicalDayKey(weekday)
    );
    if (!row) {
      return { day: weekday, classes: [] };
    }
    const classes = (row.periods || [])
      .filter((p) => {
        const txt = p.text || p.raw || p.subject || '';
        return !/break|lunch|^free/i.test(txt);
      })
      .flatMap((p) => {
        const timeInfo = parsePeriodTimeInfo(p.period, p.duration);
        if (p.subject && !p.text) {
          const startTime = timeInfo.startTime || (p.startTime ? p.startTime : '');
          const endTime = timeInfo.endTime || (p.endTime ? p.endTime : '');
          return [{
            period: timeInfo.period || p.period,
            rawPeriod: p.period,
            duration: timeInfo.duration || p.duration,
            startTime,
            endTime,
            subject: p.subject || '',
            subjectCode: p.subjectCode || '',
            room: p.room || null,
            teacher: p.teacher || null,
            raw: p.raw || p.subject || '',
          }];
        }
        return parseTimetableCellEntries(p.text || p.raw || '').map((cell) => ({
          period: timeInfo.period || p.period,
          rawPeriod: p.period,
          duration: timeInfo.duration,
          startTime: timeInfo.startTime,
          endTime: timeInfo.endTime,
          subject: cell.subject || '',
          subjectCode: cell.subjectCode || '',
          room: cell.room || null,
          teacher: cell.teacher || null,
          raw: p.text,
        }));
      });

    // Chronological sort
    classes.sort((a, b) => {
      const aTime = a.startTime ? scraperTimeToMinutes(a.startTime) : 9999;
      const bTime = b.startTime ? scraperTimeToMinutes(b.startTime) : 9999;
      if (aTime !== bTime) return aTime - bTime;
      return (a.period || '').localeCompare(b.period || '');
    });

    return {
      day: weekday,
      classes,
      periods: classes,
    };
  });

  return { days };
}

function scraperTimeToMinutes(timeStr) {
  if (!timeStr) return 9999;
  const parts = timeStr.split(':').map(Number);
  if (parts.length >= 2 && !Number.isNaN(parts[0]) && !Number.isNaN(parts[1])) {
    return parts[0] * 60 + parts[1];
  }
  return 9999;
}

/**
 * Map a weekday onto the parsed timetable and extract subject names/codes
 * from cells like "Subject Name(CODE) (Room), Teacher Name".
 */
function getTodaySubjects(timetable, now = new Date()) {
  return getTimetableForDate(timetable, now);
}


async function createSessionContext(sessionPath = SESSION_FILE) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: sessionPath,
    viewport: { width: 1366, height: 900 },
  });
  return { browser, context };
}

/** FillStudentTimeTable API se timetable (bina browser) — VPS-friendly. */
async function fetchTimetableViaApi(apiContext, regId) {
  const resp = await apiPost(apiContext, TIMETABLE_API, { form: { RegID: regId }, timeout: 60000 });
  if (!resp.ok()) {
    throw new ScrapeError(
      `TimeTable API failed (HTTP ${resp.status()}).`,
      'Portal down ho sakta hai — thodi der baad retry.'
    );
  }
  const body = await resp.text();
  if (body.trim().startsWith('<')) throw new SessionExpiredError(); // login/403 page
  let rows = [];
  try {
    const payload = JSON.parse(body);
    rows = JSON.parse(payload.state || '[]');
  } catch {
    rows = [];
  }
  if (!Array.isArray(rows) || !rows.length) {
    throw new ScrapeError('TimeTable API ne khali data diya.', 'Portal change ho sakta hai — debug-timetable-net.js chalao.');
  }
  return parseTimetableApiState(rows);
}

async function scrapeTimetable(opts = {}) {
  const sessionPath = opts.sessionPath || SESSION_FILE;
  assertSessionFile(sessionPath);

  // 1) API-first: FillStudentTimeTable — browser-free (fast + VPS-safe).
  //    Rooms/teachers wahi text format me aate hain jo parser expect karta hai.
  const apiContext = await newApiContext(sessionPath);
  try {
    const regId = await getRegIdLight(apiContext, { sessionPath });
    const viaApi = await fetchTimetableViaApi(apiContext, regId);
    if (viaApi.days && viaApi.days.length) {
      viaApi.source = 'api';
      return viaApi;
    }
  } catch (err) {
    if (err.name === 'SessionExpiredError') throw err; // session dead — browser se bhi nahi hoga
    // API fail (shape change etc.) — niche browser fallback try hota hai
  } finally {
    await apiContext.dispose();
  }

  // 2) Fallback: headless browser parse (jqGrid DOM) — retry ke saath
  const { browser, context } = await createSessionContext(sessionPath);
  try {
    let timetable = null;
    // Portal WAF kabhi-kabhi lagataar requests pe grid ka AJAX rok deta hai —
    // ek retry (fresh navigation) rakha hai.
    for (let attempt = 1; attempt <= 2 && !timetable; attempt++) {
      if (attempt > 1) await new Promise((r) => setTimeout(r, 4000));
      const page = await context.newPage();
      try {
        await page.goto(TIMETABLE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        try {
          await page.waitForLoadState('networkidle', { timeout: 15000 });
        } catch { }
        // Direct-URL navigation: page.goto se session cookies kaam karte hain,
        // koi Academic-tile/Time-Table-link click nahi. Login pe redirect ->
        // throwIfLoginPage clear SessionExpiredError deta hai (3 signals).
        await throwIfLoginPage(page);
        // Grid AJAX ke baad render hota hai — kisi cell me weekday name aa jaane
        // tak wait karo (race-safe; timeout pe jo hai wahi parse hoga).
        await page
          .waitForFunction(
            () => /monday|tuesday|wednesday|thursday|thrusday|friday|saturday|sunday/i.test(document.body ? document.body.innerText : ''),
            { timeout: 20000 }
          )
          .catch(() => { });
        await page.waitForTimeout(2000);
        timetable = await page.evaluate(parseTimetableInPage);
      } finally {
        await page.close().catch(() => { });
      }
    }
    if (!timetable) {
      throw new ScrapeError(
        'Timetable grid parsed to nothing — markup differs from expectations.',
        'Inspect the timetable page in DevTools and update parseTimetableInPage in src/scraper.js'
      );
    }
    return timetable;
  } finally {
    await browser.close();
  }
}


// ---------------------------------------------------------------------------
// Assignments (Part 5/6/7) — same API-first pattern as the Month Register:
//   POST /Web_StudentAcademic/GetStudentAssignment { RegID }  (discovered from
//   the Cyborg_StudentAssignment page's own AJAX; verified live 200).
// Response is { state: "<json rows>", state2: "<json rows>" }:
//   state  rows = the "Assignment Details" grid (Assignmenttype Assignment/Quiz/
//                 Class Test/Internal/...) with Submit Date (DATETO) +
//                 Assignment Given Date (DATEFROM) when the teacher set them.
//   state2 rows = study-material/assignment-detail rows (no date columns).
// Row fields verified from the page's jqGrid colModel + live 200 responses:
//   AssignmentDetailID (unique id), ASSIGNMENT / ASSIGNMENTSUBJECT / Subject
//   (title), CLASSSUBJECT (subject), EMPLOYEENAME (teacher), Assignmenttype,
//   DATEFROM, DATETO, UploadFlag, AssignmentExt.
// ---------------------------------------------------------------------------

/**
 * QUMS date string -> 'YYYY-MM-DD' (IST civil date) or null.
 * Accepted live shapes: 'YYYY-MM-DD...', 'DD/MM/YYYY', 'DD-MM-YYYY',
 * 'DD MMM YYYY' (day-first — Indian portal). Anything unparseable -> null
 * (we NEVER guess a deadline).
 */
function qumsDateToYMD(v) {
  const s = norm(v);
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3,})[\s-](\d{4})/);
  if (m) {
    const mi = monthFromName(m[2]);
    if (mi) return `${m[3]}-${String(mi).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

/**
 * One raw QUMS assignment row (state OR state2) -> normalized shape:
 * { id, title, subject, teacher, type, assignedYMD, deadlineYMD, ext, uploadFlag, source }.
 * id = AssignmentDetailID (QUMS's own unique id) when present, else '' (callers
 * fingerprint from the real fields via assignments.assignmentFingerprint).
 */
function normalizeAssignmentRow(raw, source = 'state') {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.AssignmentDetailID ?? raw.AssignID ?? '').trim();
  const title = norm(raw.ASSIGNMENT) || norm(raw.ASSIGNMENTSUBJECT) || norm(raw.Subject);
  const subject = norm(raw.CLASSSUBJECT) || norm(raw.SubjectName);
  const teacher = norm(raw.EMPLOYEENAME);
  const type = norm(raw.Assignmenttype) || (source === 'state2' ? 'Study Material' : 'Assignment');
  const assignedYMD = qumsDateToYMD(raw.DATEFROM);
  const deadlineYMD = qumsDateToYMD(raw.DATETO);
  const ext = norm(raw.AssignmentExt || raw.Extension);
  const uploadFlag = Number(raw.UploadFlag);
  if (!id && !title) return null;
  return {
    id,
    title,
    subject,
    teacher,
    type,
    assignedYMD,
    deadlineYMD,
    ext,
    uploadFlag: Number.isFinite(uploadFlag) ? uploadFlag : null,
    source,
  };
}

/**
 * POST GetStudentAssignment for one session and return the normalized rows
 * (state + state2 merged, each tagged with its source). Throws
 * SessionExpiredError on login-page HTML — same contract as the other scrapers.
 */
async function scrapeAssignments(opts = {}) {
  const sessionPath = (typeof opts === 'object' && opts.sessionPath) || SESSION_FILE;
  assertSessionFile(sessionPath);
  const apiContext = await newApiContext(sessionPath);
  try {
    const regId = await getRegIdLight(apiContext, { sessionPath });
    const resp = await apiPost(apiContext, ASSIGNMENT_API, {
      form: { RegID: regId },
      timeout: 60000,
    });
    if (!resp.ok()) {
      throw new ScrapeError(
        `Assignment API failed (HTTP ${resp.status()}).`,
        'Portal down ya session issue — thodi der baad retry, ya Dashboard → QUMS Setup → Reconnect QUMS.'
      );
    }
    const body = await resp.text();
    if (body.trim().startsWith('<')) throw new SessionExpiredError(); // HTML = login page
    let payload = {};
    try {
      payload = JSON.parse(body);
    } catch {
      return []; // unparseable = treat as "nothing yet"
    }
    const rowsOf = (v) => {
      try {
        if (typeof v === 'string') return JSON.parse(v || '[]');
        if (Array.isArray(v)) return v;
      } catch { /* empty */ }
      return [];
    };
    const out = [];
    for (const r of rowsOf(payload.state)) {
      const n = normalizeAssignmentRow(r, 'state');
      if (n) out.push(n);
    }
    for (const r of rowsOf(payload.state2)) {
      const n = normalizeAssignmentRow(r, 'state2');
      if (n) out.push(n);
    }
    return out;
  } finally {
    await apiContext.dispose();
  }
}

// ---------------------------------------------------------------------------
// Month Register (backdated attendance) — API-first, live-UI se reverse-
// engineered (debug-inspect-month-register.js + debug-month-api-probe.js):
//
//   POST /Web_StudentAcademic/GetMonthRegister  { RegID, Month: 1..12 }
//     -> { state: "[{\"Subject\":\"CS35303 (Design and ... (S))\",
//                    \"1\":\"P\",\"2\":\"P\",\"3\":\"N\", ..., \"30\":\"N\"}, ...]",
//          data: "[{\"Total\":\"0\",\"Present\":\"0\",\"Absent\":\"0\",\"Percet\":\"0.00 %\"}]" }
//
//   Cell values: "P" present | "A" absent | "N" not marked | "P,P" = same day
//   me 2 lectures. Month Register me TEACHER ka column NAHI hota — teacher
//   timetable (getTimetableForDate) se cross-match hota hai.
//   Dashboard ke Present/Absent/Diff Lecture buttons sirf LEGEND hain
//   (readonly inputs, no onclick) — koi filter toggle nahi.
// ---------------------------------------------------------------------------

/** 'September' | 'Sep' | 9 | '9' -> 9 (1..12); invalid -> null. */
function monthFromName(monthName) {
  if (monthName == null || monthName === '') return null;
  const n = Number(monthName);
  if (Number.isInteger(n) && n >= 1 && n <= 12) return n;
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const s = String(monthName).trim().toLowerCase();
  const exact = MONTHS.findIndex((m) => m === s);
  if (exact !== -1) return exact + 1;
  const partial = MONTHS.findIndex((m) => m.startsWith(s) && s.length >= 3);
  if (partial !== -1) return partial + 1;
  return null;
}

/** Raw GetMonthRegister rows -> flat records (N skip; "P,P" = 2 lectures breakdown; EK alert per subject/day). */
function expandMonthRegisterRows(rawRows, { year, month } = {}) {
  const out = [];
  const ym = `${year}-${String(month).padStart(2, '0')}`;
  for (const row of rawRows || []) {
    if (!row || !row.Subject) continue;
    const { subjectCode, subject } = parseSubjectLabel(row.Subject);
    for (const [key, val] of Object.entries(row)) {
      if (key === 'Subject') continue;
      const day = Number(key);
      if (!Number.isInteger(day) || day < 1 || day > 31) continue;
      const v = norm(val).toUpperCase();
      if (!v || v === 'N') continue; // N = not marked
      // "P,P" = us din 2 lectures — EK record (ek hi alert), lectures breakdown ke saath
      const lectures = v.split(',').map((s) => s.trim()).filter(Boolean)
        .map((l) => ({ statusRaw: l, status: normalizeAttendanceValue(l) }));
      const ymd = `${ym}-${String(day).padStart(2, '0')}`;
      out.push({
        date: ymd,
        day,
        subjectCode,
        subject,
        statusRaw: lectures.map((l) => l.statusRaw).join(','),
        status: lectures[0].status, // primary = pehla lecture
        lectures,
        lecturesThatDay: lectures.length,
        key: `${ymd}-${subjectCode}`, // group key: ek hi alert per subject/day
      });
    }
  }
  return out;
}

/**
 * Month Register scrape — koi UI click nahi, seedha portal ka AJAX endpoint.
 * opts: { sessionPath, month (1..12, default current IST month), year? }
 * Returns { year, month, records, summary } — records me backdated + aaj ke
 * marked periods sab hote hain.
 */
async function scrapeMonthRegister(opts = {}) {
  const sessionPath = opts.sessionPath || SESSION_FILE;
  assertSessionFile(sessionPath);
  const [, curMonth, curYear] = istDateString().split('/').map(Number);
  const month = Number(opts.month) || curMonth;
  // Year guess: future month poocha to pichhle saal ka (Jan'27 me "December" => Dec 2026).
  const year = Number(opts.year) || (month > curMonth ? curYear - 1 : curYear);
  const apiContext = await newApiContext(sessionPath);
  try {
    const regId = await getRegIdLight(apiContext, { sessionPath });
    const resp = await apiPost(apiContext, MONTH_REGISTER_API, {
      form: { RegID: regId, Month: month },
      timeout: 60000,
    });
    if (!resp.ok()) {
      throw new ScrapeError(
        `Month Register API failed (HTTP ${resp.status()}).`,
        'Portal down ya session issue — thodi der baad retry, ya Dashboard → QUMS Setup → Reconnect QUMS.'
      );
    }
    const body = await resp.text();
    if (body.trim().startsWith('<')) throw new SessionExpiredError(); // HTML = login/403 page
    let payload = {};
    try {
      payload = JSON.parse(body);
    } catch {
      payload = {};
    }
    let rawRows = [];
    try {
      rawRows = JSON.parse(payload.state || '[]');
    } catch {
      rawRows = [];
    }
    let summary = null;
    try {
      const s = JSON.parse(payload.data || '[]')[0];
      if (s) {
        summary = {
          total: Number(s.Total) || 0,
          present: Number(s.Present) || 0,
          absent: Number(s.Absent) || 0,
          percentage: String(s.Percet || '').trim() || null,
        };
      }
    } catch { }
    const records = expandMonthRegisterRows(rawRows, { year, month });
    return { year, month, records, summary };
  } finally {
    await apiContext.dispose();
  }
}

/**
 * Month-by-month Month Register scan (Phase 4) — SEQUENTIAL, bounded.
 *
 * The same verified endpoint is used for every month
 * (POST /Web_StudentAcademic/GetMonthRegister { RegID, Month }); nothing new is
 * invented. Current IST month first, then `monthsBack` previous months
 * (default 2 months total). Requests are serialized with a small delay so the
 * portal (and the student's own quota) is never hammered.
 *
 * opts: { sessionPath, monthsBack (default 1), startMonth (1..12), year?, delayMs }
 * Returns an ARRAY of { year, month, records, summary } — one entry per month
 * that answered. A SessionExpiredError aborts immediately (monitoring must
 * stop and the user must be asked to reconnect); any other month failure is
 * skipped so one bad month cannot stop the whole scan.
 */
async function scrapeMonthRegisterRange(optsOrSessionPath = {}, maybeMonths, maybeOpts = {}) {
  const opts = (typeof optsOrSessionPath === 'string')
    ? { sessionPath: optsOrSessionPath, months: maybeMonths, ...(maybeOpts || {}) }
    : (optsOrSessionPath || {});
  const sessionPath = opts.sessionPath || SESSION_FILE;
  const monthsBack = Math.max(0, Number(opts.monthsBack ?? 1) || 0);
  const delayMs = Number(opts.delayMs ?? 400);
  const [, nowMonth, nowYear] = istDateString().split('/').map(Number);
  const startMonth = Number(opts.startMonth) || nowMonth;
  const sessionWasPresent = fs.existsSync(sessionPath);
  if (!sessionWasPresent) assertSessionFile(sessionPath); // NoSessionError (same contract)

  const wanted = [];
  if (Array.isArray(opts.months) && opts.months.length) {
    // Explicit plan (tiered schedule / tests): [ { year, month }, ... ]
    for (const m of opts.months) {
      const month = Number(m && m.month);
      const year = Number(m && m.year);
      if (Number.isInteger(month) && month >= 1 && month <= 12) {
        wanted.push({ month, year: Number.isInteger(year) && year > 2000 ? year : nowYear });
      }
    }
  } else {
    for (let i = 0; i <= monthsBack; i++) {
      // Walk backwards across the year boundary (Jan -> Dec of previous year).
      let month = startMonth - i;
      let year = Number(opts.year) || nowYear;
      while (month < 1) {
        month += 12;
        year -= 1;
      }
      wanted.push({ month, year });
    }
  }

  const out = [];
  let firstError = null;
  for (let i = 0; i < wanted.length; i++) {
    const { month, year } = wanted[i];
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await scrapeMonthRegister({ sessionPath, month, year });
      out.push(result);
    } catch (err) {
      if (err.name === 'SessionExpiredError' || err.name === 'NoSessionError') throw err;
      if (!firstError) firstError = err;
      // otherwise: skip this month, keep scanning the rest
    }
    // eslint-disable-next-line no-await-in-loop
    if (i < wanted.length - 1 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  if (!out.length && firstError) throw firstError;
  return out;
}

/** Ek month-register record ke liye timetable se teacher cross-match karo. */
function teacherForRecord(timetable, rec) {
  if (!timetable || !rec || !rec.date) return '';
  const periods = getTimetableForDate(timetable, rec.date);
  const hit = periods.find((p) => p.subjectCode && p.subjectCode === rec.subjectCode);
  return (hit && hit.teacher) || '';
}

/** Ek month-register record ke liye timetable se ROOM cross-match karo. */
function roomForRecord(timetable, rec) {
  if (!timetable || !rec || !rec.date) return '';
  const hit = getTimetableForDate(timetable, rec.date).find((p) => p.subjectCode && p.subjectCode === rec.subjectCode);
  return (hit && hit.room) || '';
}

/**
 * Spec API: getTodaysTimetable(userId) — aaj ki periods (teacher + room ke saath).
 * Direct-URL navigation (no UI clicks): primary path FillStudentTimeTable API
 * (wahi endpoint jo Cyborg_StudentTimeTable grid khud call karta hai —
 * debug-timetable-net.txt me captured), fallback seedha
 * page.goto(QUMS_TIMETABLE_URL) — Academic tile / Time Table link click nahi.
 * Room number innerText se aata hai — "(CODE) (ROOM)" paren groups
 * (title attribute portal me hota hi nahi, debug-cells-dump.txt me confirm).
 * Session expired -> SessionExpiredError (dono paths pe).
 */
async function getTodaysTimetable(userId) {
  const timetable = await scrapeTimetable({ sessionPath: db.sessionPathFor(userId) });
  return getTimetableForDate(timetable, new Date());
}

const QUMS_STANDARD_DURATIONS = {
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
  if (!m) return norm(str).toUpperCase();
  return m[1].toUpperCase().startsWith('P') ? m[1].toUpperCase() : `P${m[1]}`;
}

function extractTimeRange(str) {
  if (!str) return '';
  const m = String(str).match(/\d{1,2}:\d{2}(?:\s*[AaPp][Mm])?\s*-\s*\d{1,2}:\d{2}(?:\s*[AaPp][Mm])?/);
  return m ? norm(m[0]) : '';
}

function resolvePeriodDuration(duration, period) {
  if (duration && String(duration).trim()) return norm(duration);
  const fromP = extractTimeRange(period);
  if (fromP) return fromP;
  const k = extractPeriodKey(period);
  return QUMS_STANDARD_DURATIONS[k] || '';
}

function periodMatches(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const kA = extractPeriodKey(a);
  const kB = extractPeriodKey(b);
  if (kA && kB && kA === kB) return true;
  const sA = String(a).trim().toUpperCase();
  const sB = String(b).trim().toUpperCase();
  return sA.includes(sB) || sB.includes(sA);
}

/**
 * PURE merge (Task 1 spec): subject + teacher "Today's Attendance" se (clean/
 * reliable — QUMS isi se marking karta hai), room SIRF Timetable se.
 * Match: pehle subjectCode, na mile to period. Na mile to room = null
 * (frontend/message "N/A" dikha sakta hai).
 */
function mergeScheduleWithRoom(todaysRows, timetablePeriods) {
  const tt = timetablePeriods || [];
  const matchedIndices = new Set();
  return (todaysRows || []).map((row) => {
    let matchIdx = tt.findIndex(
      (t, i) => !matchedIndices.has(i) &&
        periodMatches(t.period, row.period) &&
        t.subjectCode && row.subjectCode &&
        String(t.subjectCode).trim().toUpperCase() === String(row.subjectCode).trim().toUpperCase()
    );
    if (matchIdx === -1) {
      matchIdx = tt.findIndex(
        (t, i) => !matchedIndices.has(i) &&
          t.subjectCode && row.subjectCode &&
          String(t.subjectCode).trim().toUpperCase() === String(row.subjectCode).trim().toUpperCase()
      );
    }
    if (matchIdx === -1) {
      matchIdx = tt.findIndex(
        (t, i) => !matchedIndices.has(i) && periodMatches(t.period, row.period)
      );
    }
    let match = null;
    if (matchIdx !== -1) {
      matchedIndices.add(matchIdx);
      match = tt[matchIdx];
    }
    const dur = row.duration || (match && match.duration) || resolvePeriodDuration(row.duration, row.period) || '';
    return {
      period: row.period,
      duration: dur,
      subject: row.subject,
      subjectCode: row.subjectCode,
      teacher: row.employee || (match && match.teacher) || '',
      attendance: row.attendance,
      status: row.status,
      key: row.key,
      room: match ? match.room || null : null,
    };
  });
}

/**
 * Combines full scheduled periods for today (from student's weekly timetable)
 * with live attendance marking register. Preserves ALL scheduled periods
 * in chronological order, with room, teacher, timing, and marking status.
 */
function combineTimetableWithLiveAttendance(timetablePeriods, todaysRows) {
  const tt = Array.isArray(timetablePeriods) ? timetablePeriods : [];
  const live = Array.isArray(todaysRows) ? todaysRows : [];

  if (!tt.length) {
    return mergeScheduleWithRoom(live, []);
  }

  const matchedLiveIndices = new Set();

  const merged = tt.map((tp) => {
    // 1. Period + SubjectCode match
    let matchIdx = live.findIndex(
      (lr, idx) => !matchedLiveIndices.has(idx) &&
        periodMatches(lr.period, tp.period) &&
        lr.subjectCode && tp.subjectCode &&
        String(lr.subjectCode).trim().toUpperCase() === String(tp.subjectCode).trim().toUpperCase()
    );

    // 2. Period alone
    if (matchIdx === -1) {
      matchIdx = live.findIndex(
        (lr, idx) => !matchedLiveIndices.has(idx) && periodMatches(lr.period, tp.period)
      );
    }

    // 3. Subject code alone
    if (matchIdx === -1) {
      matchIdx = live.findIndex(
        (lr, idx) => !matchedLiveIndices.has(idx) &&
          lr.subjectCode && tp.subjectCode &&
          String(lr.subjectCode).trim().toUpperCase() === String(tp.subjectCode).trim().toUpperCase()
      );
    }

    let liveRow = null;
    if (matchIdx !== -1) {
      matchedLiveIndices.add(matchIdx);
      liveRow = live[matchIdx];
    }

    const dur = (liveRow && liveRow.duration) || tp.duration || resolvePeriodDuration(tp.duration, tp.period) || '';
    const cleanPeriod = tp.periodCode || extractPeriodKey(tp.period) || tp.period || (liveRow ? liveRow.period : '');

    return {
      period: cleanPeriod,
      rawPeriod: tp.period,
      duration: dur,
      startTime: tp.startTime || '',
      endTime: tp.endTime || '',
      subject: tp.subject || (liveRow ? liveRow.subject : ''),
      subjectCode: tp.subjectCode || (liveRow ? liveRow.subjectCode : ''),
      teacher: (liveRow && liveRow.employee) || tp.teacher || '',
      room: tp.room || (liveRow ? liveRow.room : null) || null,
      attendance: liveRow ? liveRow.attendance : 'N.M.',
      status: liveRow ? (liveRow.status || 'unmarked') : 'unmarked',
      key: liveRow ? liveRow.key : `${cleanPeriod}-${tp.subjectCode || ''}`,
    };
  });

  // Any unmatched live row (e.g. extra/makeup class)
  live.forEach((lr, idx) => {
    if (!matchedLiveIndices.has(idx)) {
      merged.push({
        period: extractPeriodKey(lr.period) || lr.period,
        rawPeriod: lr.period,
        duration: lr.duration || resolvePeriodDuration(lr.duration, lr.period) || '',
        subject: lr.subject,
        subjectCode: lr.subjectCode,
        teacher: lr.employee || '',
        room: lr.room || null,
        attendance: lr.attendance || 'N.M.',
        status: lr.status || 'unmarked',
        key: lr.key,
      });
    }
  });

  // Chronologically sort merged entries
  merged.sort((a, b) => {
    const aTime = a.startTime ? scraperTimeToMinutes(a.startTime) : (extractTimeRange(a.duration) ? scraperTimeToMinutes(extractTimeRange(a.duration).split('-')[0]) : 9999);
    const bTime = b.startTime ? scraperTimeToMinutes(b.startTime) : (extractTimeRange(b.duration) ? scraperTimeToMinutes(extractTimeRange(b.duration).split('-')[0]) : 9999);
    if (aTime !== bTime) return aTime - bTime;
    const numA = parseInt(String(a.period || '').replace(/\D/g, ''), 10);
    const numB = parseInt(String(b.period || '').replace(/\D/g, ''), 10);
    if (!isNaN(numA) && !isNaN(numB) && numA !== numB) return numA - numB;
    return String(a.period || '').localeCompare(String(b.period || ''));
  });

  return merged;
}

/**
 * Spec API: getTodaysAttendance(userId) — aaj ke periods (attendance status ke saath).
 * Direct-URL navigation (no UI clicks): session file (storageState) se cookies
 * utha kar seedha Cyborg_S_Dashboard GET + GetTodayAttendance POST — Academic
 * tile click-through ki zaroorat nahi. Session file project convention:
 * db.sessionPathFor(userId) = data/qums-sessions/<userId>.json (wahi path
 * jahan qums-login-web.js sessions save karta hai).
 * Session expired (login redirect/HTML response) -> SessionExpiredError.
 */
async function getTodaysAttendance(userId) {
  return scrapeTodaysAttendance({ sessionPath: db.sessionPathFor(userId) });
}

/**
 * Spec API: getTodaysScheduleWithRoom(userId) — FULL MERGED schedule:
 *   [{ period, duration, subject, subjectCode, teacher, room, attendance, status }]
 * Uses today's official weekly timetable as master source of periods, merged
 * with live attendance register marks and rooms.
 * Side-effect: result ka (period, subject, subjectCode, teacher, room) aaj ke
 * dayOfWeek pe weekly_schedule_cache me UPSERT ho jata hai.
 */
async function getTodaysScheduleWithRoom(userId) {
  let todaysRows = [];
  try {
    todaysRows = await scrapeTodaysAttendance({ sessionPath: db.sessionPathFor(userId) });
  } catch {
    todaysRows = [];
  }
  let timetablePeriods = [];
  try {
    const timetable = await scrapeTimetable({ sessionPath: db.sessionPathFor(userId) });
    timetablePeriods = getTimetableForDate(timetable, new Date());
  } catch {
    timetablePeriods = [];
  }

  let merged = [];
  if (todaysRows && todaysRows.length) {
    merged = mergeScheduleWithRoom(todaysRows, timetablePeriods);
  } else if (timetablePeriods && timetablePeriods.length) {
    merged = timetablePeriods.map((tp) => ({
      period: tp.period,
      duration: tp.duration || resolvePeriodDuration(tp.duration, tp.period),
      subject: tp.subject,
      subjectCode: tp.subjectCode,
      teacher: tp.teacher,
      room: tp.room,
      attendance: 'N.M.',
      status: 'unmarked',
    }));
  }

  const dow = new Date().getDay();
  if (merged.length) {
    await db.clearWeeklySchedule(userId, dow);
    await db.upsertWeeklySchedule(
      userId,
      dow,
      merged.map((r) => ({
        period: r.period,
        duration: r.duration || '',
        subject: r.subject,
        subjectCode: r.subjectCode,
        teacher: r.teacher,
        room: r.room,
      }))
    );
  }
  return merged;
}

/**
 * Spec API: getMonthRegister(userId, monthName) — flat records with teacher
 * (timetable cross-match se; timetable na mile to teacher '' rehta hai).
 */
async function getMonthRegister(userId, monthName) {
  const sessionPath = db.sessionPathFor(userId);
  const month = monthFromName(monthName);
  const reg = await scrapeMonthRegister({ sessionPath, month });
  let timetable = null;
  try {
    timetable = await scrapeTimetable({ sessionPath });
  } catch {
    timetable = null; // teacher optional rahega
  }
  return reg.records.map((rec) => ({ ...rec, teacher: teacherForRecord(timetable, rec) }));
}

/**
 * Part 1 — one-shot student profile fetch for a saved session:
 * { regId, yearSem, studentName, ... }. Reuses getStudentContext (which already
 * calls GetStudentDetailOnRegID for the name). Used by server.js after QUMS
 * setup to map the name onto the application user.
 */
async function getStudentProfile(opts = {}) {
  const sessionPath = (typeof opts === 'object' && opts.sessionPath) || SESSION_FILE;
  assertSessionFile(sessionPath);
  const apiContext = await newApiContext(sessionPath);
  try {
    return await getStudentContext(apiContext);
  } finally {
    await apiContext.dispose();
  }
}

/** RegID from the dashboard page ONLY (no semester probing — light path). */
async function getRegIdLight(apiContext, opts = {}) {
  const sessionPath = opts && opts.sessionPath;
  if (sessionPath && !opts.returnHtml) {
    const cached = getCachedRegId(sessionPath);
    if (cached) return cached;
  }

  const resp = await apiContext.get(DASHBOARD_URL, { timeout: 60000 });
  if (!resp.ok()) {
    throw new ScrapeError(
      `Dashboard load failed (HTTP ${resp.status()}).`,
      'Portal down ho sakta hai — thodi der baad retry karo.'
    );
  }
  const html = await resp.text();
  if (looksLikeLoginHtml(html)) {
    if (sessionPath) clearCachedRegId(sessionPath);
    throw new SessionExpiredError();
  }
  const regIdMatch =
    html.match(/var\s+RegID\s*=\s*['"]?(\d+)['"]?/i) ||
    html.match(/\bRegID\s*[:=]\s*['"]?(\d+)['"]?/i) ||
    html.match(/name=['"]RegID['"][^>]*value=['"](\d+)['"]/i) ||
    html.match(/id=['"]RegID['"][^>]*value=['"](\d+)['"]/i) ||
    html.match(/value=['"](\d+)['"][^>]*id=['"]RegID['"]/i) ||
    html.match(/data-regid=['"](\d+)['"]/i);
  if (!regIdMatch) {
    throw new ScrapeError(
      'Dashboard HTML me RegID nahi mila.',
      'Dashboard → QUMS Setup → Reconnect QUMS try karo.'
    );
  }
  const regId = regIdMatch[1];
  if (sessionPath) setCachedRegId(sessionPath, regId);
  if (opts && opts.returnHtml) {
    return { regId, html };
  }
  return regId;
}

/**
 * Extract student name and Year/Sem from multiple potential QUMS JSON formats:
 *   - ASP.NET serialized JSON string in `.state` or `.data` or `.d`
 *   - Plain array in `.state` or `.data` or `.d` or root array
 *   - Direct object properties (`StudentName`, `studentName`, `STUDENTNAME`, `Name`, etc.)
 *   - Nested objects/tables
 */
function extractProfileFromPayload(parsed) {
  let studentName = '';
  let yearSem = '';
  const candidates = [];

  if (Array.isArray(parsed)) {
    candidates.push(...parsed);
  } else if (parsed && typeof parsed === 'object') {
    candidates.push(parsed);
    for (const val of Object.values(parsed)) {
      if (typeof val === 'string') {
        try {
          const inner = JSON.parse(val);
          if (Array.isArray(inner)) candidates.push(...inner);
          else if (inner && typeof inner === 'object') candidates.push(inner);
        } catch {}
      } else if (Array.isArray(val)) {
        candidates.push(...val);
      } else if (val && typeof val === 'object') {
        candidates.push(val);
      }
    }
  }

  for (const item of candidates) {
    if (!item || typeof item !== 'object') continue;
    for (const [k, v] of Object.entries(item)) {
      if (!studentName && /^(student_?name|studentname|name|student)$/i.test(k) && typeof v === 'string') {
        const val = norm(v);
        if (val && !/^(student|null|undefined|unknown)$/i.test(val)) studentName = val;
      }
      if (!yearSem && /^(year_?sem|sem|semester|current_?sem)$/i.test(k) && (typeof v === 'string' || typeof v === 'number')) {
        const val = norm(String(v));
        if (val) yearSem = val;
      }
    }
    if (studentName && yearSem) break;
  }
  return { studentName, yearSem };
}

/**
 * Fetch the QUMS profile: student's displayed name + current Year/Sem.
 * Primary: `POST /Web_StudentAcademic/GetStudentDetailOnRegID` with `{ "RegID": "<actual RegID>" }`.
 * Fallbacks: `GetStudentTileData`, dashboard HTML parsing, and semester probe.
 * Returns { studentName, yearSem } ('' when the portal does not provide them).
 */
async function fetchQumsProfile(sessionPath, log = console) {
  assertSessionFile(sessionPath);
  const apiContext = await newApiContext(sessionPath);
  try {
    const { regId, html: dashHtml } = await getRegIdLight(apiContext, { returnHtml: true });
    log.log(`[QUMS-Profile] Profile request started | RegID=${regId ? 'found' : 'missing'}`);
    let studentName = '';
    let yearSem = '';

    // Primary: Call GetStudentDetailOnRegID with JSON body { "RegID": "<actual RegID>" }
    let resp = await apiPost(apiContext, STUDENT_DETAIL_API, {
      data: { RegID: String(regId) },
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Requested-With': 'XMLHttpRequest' },
      timeout: 30000,
    }).catch(() => null);

    // If JSON body returned non-OK or non-JSON, fallback to form-encoded request
    if (!resp || !resp.ok()) {
      resp = await apiPost(apiContext, STUDENT_DETAIL_API, {
        form: { RegID: String(regId) },
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        timeout: 30000,
      }).catch(() => null);
    }

    log.log(`[QUMS-Profile] STUDENT_DETAIL_API HTTP=${resp ? resp.status() : 'failed'}`);
    if (resp && resp.ok()) {
      const raw = await resp.text();
      if (raw && !raw.trim().startsWith('<')) {
        try {
          const parsed = JSON.parse(raw);
          const keys = parsed && typeof parsed === 'object' ? Object.keys(parsed) : [];
          log.log(`[QUMS-Profile] Response keys=${keys.join(',') || typeof parsed}`);
          const extracted = extractProfileFromPayload(parsed);
          studentName = extracted.studentName;
          yearSem = extracted.yearSem;
          log.log(`[QUMS-Profile] Parsed: studentName=${Boolean(studentName)} (len=${studentName.length}), yearSem=${yearSem || 'not detected'}`);
        } catch (parseErr) {
          log.log(`[QUMS-Profile] JSON parse error: ${parseErr.message}`);
        }
      } else {
        log.log('[QUMS-Profile] Response is HTML/empty, not JSON');
      }
    }

    // Secondary fallback: GetStudentTileData
    if (!studentName || !yearSem) {
      try {
        const tileResp = await apiPost(apiContext, '/Web_StudentAcademic/GetStudentTileData', {
          data: { RegID: String(regId) },
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Requested-With': 'XMLHttpRequest' },
          timeout: 20000,
        }).catch(() => null);
        if (tileResp && tileResp.ok()) {
          const tileRaw = await tileResp.text();
          if (tileRaw && !tileRaw.trim().startsWith('<')) {
            const tileParsed = JSON.parse(tileRaw);
            const tileExt = extractProfileFromPayload(tileParsed);
            if (!studentName && tileExt.studentName) studentName = tileExt.studentName;
            if (!yearSem && tileExt.yearSem) yearSem = tileExt.yearSem;
            log.log(`[QUMS-Profile] GetStudentTileData parsed: studentName=${Boolean(studentName)}, yearSem=${yearSem || 'not detected'}`);
          }
        }
      } catch {}
    }

    // Tertiary fallback: dashboard HTML parsing
    if (!studentName && dashHtml) {
      const nameMatch =
        dashHtml.match(/var\s+StudentName\s*=\s*['"]([^'"]+)['"]/i) ||
        dashHtml.match(/id=['"]lblStudentName['"][^>]*>([^<]+)</i) ||
        dashHtml.match(/id=['"]lblStudent['"][^>]*>([^<]+)</i) ||
        dashHtml.match(/class=['"][^'"]*profile-username[^'"]*['"][^>]*>([^<]+)</i) ||
        dashHtml.match(/Welcome,?\s*<b[^>]*>([^<]+)<\/b>/i);
      if (nameMatch) {
        const val = norm(nameMatch[1]);
        if (val && !/^(student|null|undefined|unknown)$/i.test(val)) {
          studentName = val;
          log.log(`[QUMS-Profile] Dashboard HTML studentName=${studentName}`);
        }
      }
    }

    if (!yearSem || !studentName) {
      // Fallback: the portal's own dashboard & attendance probe provides Year/Sem & StudentName
      try {
        log.log('[QUMS-Profile] Probing getStudentContext for missing fields...');
        const ctxData = await getStudentContext(apiContext);
        if (!yearSem) yearSem = String(ctxData.yearSem || '');
        if (!studentName) studentName = ctxData.studentName || '';
        log.log(`[QUMS-Profile] Context probe: studentName=${Boolean(studentName)}, yearSem=${yearSem || 'not detected'}`);
      } catch (err) {
        if (err.name === 'SessionExpiredError' || err.name === 'NoSessionError') throw err;
      }
    }
    return { studentName, yearSem };
  } finally {
    await apiContext.dispose().catch(() => {});
  }
}

/** True when the cached QUMS profile should be refreshed from the portal. */
function profileNeedsRefresh(user, maxAgeMs = Number(process.env.QUMS_PROFILE_TTL_MS || 6 * 60 * 60 * 1000)) {
  if (!user) return false;
  if (!user.qumsSessionPath) return false;
  if (!user.studentName || !user.qumsYearSem) return true; // cache incomplete
  if (!user.profileSyncedAt) return true;
  const age = Date.now() - Date.parse(user.profileSyncedAt);
  return !Number.isFinite(age) || age > maxAgeMs;
}

/**
 * Refresh the QUMS identity cache for ONE user (multi-user safe).
 *
 * QUMS IS THE SOURCE OF TRUTH: on every successful setup/reconnect and on every
 * refresh window the portal value OVERWRITES the cache, so a name changed on
 * the QUMS side is picked up (requirement: dynamic identity, never static).
 *
 * `users.student_name` / `users.qums_year_sem` are CACHES of this value — they
 * exist so the dashboard/Telegram/admin can render without a live QUMS call.
 * A session expiry is recorded as real evidence; a network failure is NOT.
 */
async function refreshQumsProfile(userId, log = console, { force = false } = {}) {
  const user = await db.getUserById(userId);
  if (!user) return { ok: false, reason: 'no-user' };
  if (!user.qumsSessionPath || !fs.existsSync(user.qumsSessionPath)) return { ok: false, reason: 'no-session' };
  if (!force && !profileNeedsRefresh(user)) return { ok: true, cached: true, studentName: user.studentName, yearSem: user.qumsYearSem };

  try {
    const { studentName, yearSem } = await module.exports.fetchQumsProfile(user.qumsSessionPath, log);
    const patch = {};
    if (studentName) patch.studentName = studentName; // overwrite cache (QUMS wins)
    if (yearSem) patch.qumsYearSem = yearSem;
    if (Object.keys(patch).length) await db.updateUser(userId, patch);
    await db.clearSessionExpiry(userId);
    await db.touchUserSync(userId, { profile: true, error: '' });
    log.log(`[QUMS] profile synced user=${userId} yearSem=${yearSem || 'unknown'} name=${studentName ? 'set' : 'unavailable'}`);
    return { ok: true, studentName, yearSem, refreshed: true };
  } catch (err) {
    if (err.name === 'SessionExpiredError' || err.name === 'NoSessionError') {
      await db.markSessionExpired(userId, 'profile-sync');
      await db.updateUser(userId, { qumsSessionStatus: 'expired' }).catch(() => {});
      await db.touchUserSync(userId, { error: 'session-expired' });
      const { maybeNotifySessionExpired } = require('./alerts');
      await maybeNotifySessionExpired(log, userId, { evidence: true }).catch(() => {});
      throw err; // caller (setup/watch) decides the user-facing message
    }
    // Temporary failure: remember it, but never claim the session expired.
    await db.touchUserSync(userId, { error: err.name || 'error' });
    log.log(`[QUMS] profile sync skipped user=${userId} (${err.name || 'Error'}): ${err.message}`);
    return { ok: false, reason: err.name || 'error', error: err.message };
  }
}

/**
 * Ensure the user's QUMS identity cache is present/fresh (throttled).
 * Used by the dashboard (/api/me) and the Telegram link path; best-effort:
 * never throws, never blocks a response, always scoped to ONE user.
 */
async function ensureStudentName(userId, log = console) {
  if (!userId) return '';
  try {
    const res = await refreshQumsProfile(userId, log);
    if (res && res.studentName) return res.studentName;
    const user = await db.getUserById(userId);
    return (user && user.studentName) || '';
  } catch (err) {
    log.log(`[QUMS] identity refresh skipped: ${err.name || 'Error'}: ${err.message}`);
    return '';
  }
}

module.exports = {

  scrapeAttendance,
  scrapeTodaysAttendance,
  scrapeMonthRegister,
  scrapeAssignments,
  normalizeAssignmentRow,
  qumsDateToYMD,
  scrapeTimetable,
  getTodaySubjects,
  getTimetableForDate,
  getTodaysTimetable,
  getTodaysAttendance,
  getTodaysScheduleWithRoom,
  combineTimetableWithLiveAttendance,
  mergeScheduleWithRoom,
  getMonthRegister,
  monthFromName,
  expandMonthRegisterRows,
  scrapeMonthRegisterRange,
  parseSubjectLabel,
  parsePeriodCell,
  parseTimetableCell,
  parseTimetableCellEntries,
  splitTimetableEntries,
  parseTimetableApiState,
  fetchTimetableViaApi,
  formatNormalizedTimetable,
  parsePeriodTimeInfo,
  STANDARD_WEEKDAYS,
  teacherForRecord,
  roomForRecord,
  dateFromAny,
  mapAttendanceRow,
  mapTodayRow,
  normalizeAttendanceValue,
  istDateString,
  getStudentContext,
  getStudentProfile,
  getRegIdLight,
  clearCachedRegId,
  fetchQumsProfile,
  profileNeedsRefresh,
  refreshQumsProfile,
  ensureStudentName,
  extractProfileFromPayload,
  isNetworkError,
  QumsUnreachableError,
  looksLikeLoginHtml,
  ASSIGNMENT_PAGE_URL,
  ScrapeError,
  SessionExpiredError,
  NoSessionError,
};

if (require.main === module) {
  const wantTimetable = process.argv.includes('--timetable');
  const wantToday = process.argv.includes('--today');
  const monthIdx = process.argv.indexOf('--month');
  const wantMonth = monthIdx !== -1 ? Number(process.argv[monthIdx + 1]) || null : null;
  (async () => {
    try {
      const result = {};
      if (wantToday) {
        result.todayAttendance = await scrapeTodaysAttendance();
      }
      if (wantMonth) {
        result.monthRegister = await scrapeMonthRegister({ month: wantMonth });
      }
      if (!wantToday && !wantMonth) {
        result.attendance = await scrapeAttendance();
      }
      if (wantTimetable) {
        try {
          const timetable = await scrapeTimetable();
          result.timetable = timetable;
          result.todaySubjects = getTodaySubjects(timetable);
        } catch (err) {
          result.timetableError = err.message;
        }
      }
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(`[x] ${err.name || 'Error'}: ${err.message}`);
      if (err.hint) console.error(`    hint: ${err.hint}`);
      process.exit(1);
    }
  })();
}
