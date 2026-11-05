/**
 * 75% attendance calculator.
 *
 * Input:  current attendance % (per subject) + assumed total classes held
 *         (defaults to ATTENDANCE_TOTAL_CLASSES env var, else 40).
 *
 * Below 75%: how many CONSECUTIVE classes must be attended to reach 75%?
 *   (attended + k) / (total + k) >= 0.75
 *   =>  k >= (0.75 * total - attended) / 0.25
 *   =>  needed = ceil((0.75 * total - attended) / 0.25)
 *
 * At/above 75%: how many classes can be MISSED while staying >= 75%?
 *   attended / (total + k) >= 0.75
 *   =>  k <= (attended - 0.75 * total) / 0.75
 *   =>  canSkip = floor((attended - 0.75 * total) / 0.75)
 *
 * Pure module — no dependencies, safe to unit test directly.
 */
const REQUIRED_PERCENTAGE = 75;
const FALLBACK_TOTAL_CLASSES = 40;

function getDefaultTotalClasses() {
  const n = Number(process.env.ATTENDANCE_TOTAL_CLASSES);
  return Number.isFinite(n) && n > 0 ? n : FALLBACK_TOTAL_CLASSES;
}

/** Estimate attended classes from a percentage (percentage may be a number or string). */
function estimateAttended(percentage, totalClasses) {
  return Math.round((Number(percentage) / 100) * totalClasses);
}

function classesNeededToReach75(attended, totalClasses) {
  const needed = Math.ceil(((REQUIRED_PERCENTAGE / 100) * totalClasses - attended) / 0.25);
  return Math.max(0, needed);
}

function classesCanSkipAndStay75(attended, totalClasses) {
  const skippable = Math.floor((attended - (REQUIRED_PERCENTAGE / 100) * totalClasses) / 0.75);
  return Math.max(0, skippable);
}

function pluralClasses(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * Analyze one subject row. Prefers EXACT counts (totalClasses + attended from
 * the portal API); falls back to estimating attended from the percentage.
 * Returns row + status + guidance used by API, dashboard and the alerts.
 */
function analyzeSubject(entry, totalClasses) {
  const fallbackTc = totalClasses || getDefaultTotalClasses();
  const rawPct = Number(entry && entry.percentage);
  const exactTotal = Number(entry && entry.totalClasses);
  const exactAttended = Number(entry && entry.attended);
  const hasExact =
    Number.isFinite(exactTotal) && exactTotal > 0 &&
    Number.isFinite(exactAttended) && exactAttended >= 0;

  const tc = hasExact ? exactTotal : fallbackTc;
  const attended = hasExact
    ? exactAttended
    : (Number.isFinite(rawPct) ? estimateAttended(rawPct, fallbackTc) : null);

  // Display % : portal's official Percentage; if missing, derive from counts.
  const displayPct = Number.isFinite(rawPct)
    ? rawPct
    : (hasExact ? Math.round((exactAttended / exactTotal) * 1000) / 10 : null);

  const subject = (entry && entry.subject) || 'Unknown subject';
  const subjectCode = (entry && entry.subjectCode) || '';

  const base = {
    subject,
    subjectCode,
    percentage: displayPct,
    attendedEstimate: attended,
    totalClassesAssumed: tc,
    countSource: hasExact ? 'exact' : 'estimated',
  };

  if (displayPct === null || attended === null) {
    return {
      ...base,
      status: 'unknown',
      guidance: 'Attendance data could not be read — please check the portal data.',
    };
  }

  if (displayPct < REQUIRED_PERCENTAGE) {
    // Rounding can make needed 0 (e.g. 74% -> 30/40) — but if the portal says
    // we're below 75%, at least ONE more class is required.
    const needed = Math.max(1, classesNeededToReach75(attended, tc));
    const counts = hasExact
      ? `${attended}/${tc} attended`
      : `approximately ${attended}/${tc} attended`;
    return {
      ...base,
      status: 'below-75',
      classesNeeded: needed,
      guidance: `Attend the next ${pluralClasses(needed, 'class', 'classes')} to reach 75% (${counts}).`,
    };
  }

  const canSkip = classesCanSkipAndStay75(attended, tc);
  const counts = hasExact
    ? `${attended}/${tc} attended`
    : `approximately ${attended}/${tc} attended`;
  return {
    ...base,
    status: 'ok',
    canSkip,
    guidance: `You can miss ${pluralClasses(canSkip, 'class', 'classes')} and remain at 75%+ (${counts}).`,
  };
}

/**
 * Analyze all subjects. Returns the full payload used by the API,
 * the dashboard and the alert messages:
 *   { generatedAt, requiredPercentage, totalClassesAssumed, subjects[], summary{}, overall{} }
 */
function analyzeAttendance(subjects, totalClasses) {
  const tc = totalClasses || getDefaultTotalClasses();
  const list = Array.isArray(subjects) ? subjects : [];
  const detailed = list.map((s) => analyzeSubject(s, tc));
  const below = detailed.filter((d) => d.status === 'below-75');

  // Period info from the portal (DateFrom/DateTo/overall %), if scraped.
  const withPeriod = list.find((s) => s && s.periodSummary);
  const period = withPeriod ? withPeriod.periodSummary : null;

  // Overall attendance: exact match to QUMS portal.
  // 1. If QUMS provides the official overall percentage in periodSummary (st.TotalPercentage),
  //    use it directly without altering or rounding.
  // 2. Otherwise fall back to weighted totals across subjects.
  let overall = null;
  const exactRows = detailed.filter((d) => d.countSource === 'exact');
  const tot = exactRows.length ? exactRows.reduce((a, d) => a + d.totalClassesAssumed, 0) : 0;
  const att = exactRows.length ? exactRows.reduce((a, d) => a + d.attendedEstimate, 0) : 0;

  const portalOverall = period && (period.overallPercentageRaw || (period.overallPercentage != null ? String(period.overallPercentage) : null));
  if (portalOverall != null && portalOverall !== '') {
    const num = Number(portalOverall);
    overall = {
      attended: att,
      total: tot,
      percentage: Number.isFinite(num) ? num : portalOverall,
      percentageRaw: String(portalOverall),
    };
  } else if (tot > 0) {
    const rawCalc = (att / tot) * 100;
    const exactPct = Math.round(rawCalc * 100) / 100;
    overall = {
      attended: att,
      total: tot,
      percentage: exactPct,
      percentageRaw: String(exactPct),
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    requiredPercentage: REQUIRED_PERCENTAGE,
    totalClassesAssumed: tc,
    subjects: detailed,
    overall,
    period,
    summary: {
      totalSubjects: detailed.length,
      below75: below.length,
      ok: detailed.length - below.length,
      overallStatus: below.length ? 'ATTENTION' : 'ALL GOOD',
      attentionSubjects: below.map((b) => `${b.subject} (${b.subjectCode}) — ${b.percentage}%`),
    },
  };
}

module.exports = {
  REQUIRED_PERCENTAGE,
  FALLBACK_TOTAL_CLASSES,
  getDefaultTotalClasses,
  estimateAttended,
  classesNeededToReach75,
  classesCanSkipAndStay75,
  analyzeSubject,
  analyzeAttendance,
};
