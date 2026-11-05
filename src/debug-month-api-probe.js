/**
 * DEBUG: Month Register API + timetable direct-URL probe (headless, fast).
 *   node src/debug-month-api-probe.js [monthNumber]
 */
require('dotenv').config();
const path = require('path');
const db = require('./db');
const scraper = require('./scraper');

const MONTH_API = '/Web_StudentAcademic/GetMonthRegister';
const TIMETABLE_URL =
  process.env.QUMS_TIMETABLE_URL ||
  'https://qums.quantumuniversity.edu.in/Web_StudentAcademic/Cyborg_StudentTimeTable?id=Time%20Table';

(async () => {
  // --user: pehla QUMS-linked user (koi hardcoded path nahi — machine-agnostic)
  const linkedUser = db.allUsers().find((u) => u.qumsSessionPath);
  const sessionPath = process.argv.includes('--user') && linkedUser
    ? db.sessionPathFor(linkedUser.id)
    : path.join(__dirname, '..', 'session_state.json');

  // ---- 1. GetMonthRegister via request context (bina browser) ----
  const { request: playwrightRequest, chromium } = require('playwright');
  const DASHBOARD_URL =
    process.env.QUMS_DASHBOARD_URL ||
    'https://qums.quantumuniversity.edu.in/Web_StudentAcademic/Cyborg_S_Dashboard';
  const ctx = await playwrightRequest.newContext({
    storageState: sessionPath,
    baseURL: new URL(DASHBOARD_URL).origin,
    extraHTTPHeaders: { 'X-Requested-With': 'XMLHttpRequest', Referer: DASHBOARD_URL },
  });
  try {
    const { regId } = await scraper.getStudentContext(ctx);
    console.log(`[probe] RegID=${regId}`);
    for (const month of [Number(process.argv[2]) || 9, 5]) {
      const resp = await ctx.post(MONTH_API, { form: { RegID: regId, Month: month }, timeout: 60000 });
      const body = await resp.text();
      let parsed = null;
      try { parsed = JSON.parse(body); } catch {}
      let rows = [];
      try { rows = JSON.parse(parsed.state || '[]'); } catch {}
      console.log(`\n[probe] Month=${month} HTTP=${resp.status()} rows=${rows.length}`);
      if (rows.length) {
        const sample = rows[0];
        const dayKeys = Object.keys(sample).filter((k) => k !== 'Subject').sort((a, b) => Number(a) - Number(b));
        console.log(`  subject: ${sample.Subject}`);
        console.log(`  dayColumns: ${dayKeys[0]}..${dayKeys[dayKeys.length - 1]} (count ${dayKeys.length})`);
        const marked = rows.map((r) => {
          const days = Object.entries(r).filter(([k, v]) => k !== 'Subject' && v && v !== 'N');
          return { subject: r.Subject, markedDays: Object.fromEntries(days) };
        }).filter((r) => Object.keys(r.markedDays).length);
        console.log(`  rows-with-marks: ${marked.length}`);
        console.log(`  sample marked: ${JSON.stringify(marked.slice(0, 3))}`);
      } else {
        console.log(`  raw body: ${body.slice(0, 200)}`);
      }
    }
  } finally {
    await ctx.dispose();
  }

  // ---- 2. Timetable direct URL (headless browser) + parser live ----
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ storageState: sessionPath, viewport: { width: 1366, height: 900 } });
    const page = await context.newPage();
    await page.goto(TIMETABLE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
    await page.waitForTimeout(3000);
    console.log(`\n[probe] timetable URL: ${page.url()}`);
    const passCount = await page.locator('input[type="password"]').count();
    console.log(`[probe] password boxes: ${passCount} (0 = session works, >0 = login redirect)`);
    const tables = await page.evaluate(() =>
      Array.from(document.querySelectorAll('table')).slice(0, 8).map((t, i) => ({
        i,
        id: t.id || null,
        cls: t.className,
        rows: t.rows.length,
        header: t.rows[0] ? Array.from(t.rows[0].cells).map((c) => c.textContent.trim().replace(/\s+/g, ' ')) : [],
        row1: t.rows[1] ? Array.from(t.rows[1].cells).map((c) => c.textContent.trim().replace(/\s+/g, ' ').slice(0, 80)) : [],
      }))
    );
    console.log('[probe] tables:', JSON.stringify(tables, null, 2).slice(0, 4000));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(`[x] ${e.name}: ${e.message}`);
  process.exit(1);
});
