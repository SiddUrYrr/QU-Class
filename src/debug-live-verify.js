/* Part 13 test 3 — live QUMS verification: student name + assignment API.
 *
 * Usage:
 *   node src/debug-live-verify.js              # first saved session
 *   node src/debug-live-verify.js <sessionPath>
 *   node src/debug-live-verify.js <sessionPath> --audit   # full structure audit
 *
 * READ-ONLY. It never prints cookies, tokens or credentials — only field names,
 * counts and samples, so the QUMS contracts can be re-verified any time.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const scraper = require('./scraper');

const DIR = path.join(__dirname, '..', 'data', 'qums-sessions');
const wantAudit = process.argv.includes('--audit');

/** Month Register structure probe (the backdated-attendance data source). */
async function auditMonthRegister(sessionPath) {
  const { request } = require('playwright');
  const ORIGIN = 'https://qums.quantumuniversity.edu.in';
  const ctx = await request.newContext({
    storageState: sessionPath,
    baseURL: ORIGIN,
    extraHTTPHeaders: { 'X-Requested-With': 'XMLHttpRequest', Referer: `${ORIGIN}/Web_StudentAcademic/Cyborg_S_Dashboard` },
  });
  try {
    const { regId } = await scraper.getStudentContext(ctx);
    const [, curMonth, curYear] = scraper.istDateString().split('/').map(Number);
    for (const month of [curMonth, curMonth === 1 ? 12 : curMonth - 1]) {
      const year = month > curMonth ? curYear - 1 : curYear;
      const resp = await ctx.post('/Web_StudentAcademic/GetMonthRegister', { form: { RegID: regId, Month: month }, timeout: 60000 });
      const body = await resp.text();
      let payload = {};
      try { payload = JSON.parse(body); } catch { }
      let rows = [];
      try { rows = JSON.parse(payload.state || '[]'); } catch { }
      console.log(`[audit] GetMonthRegister Month=${month} HTTP=${resp.status()} subjectRows=${rows.length}`);
      if (rows.length) {
        console.log('[audit]   row fields:', Object.keys(rows[0]).join(', '));
        console.log('[audit]   sample Subject label:', JSON.stringify(rows[0].Subject));
        const records = scraper.expandMonthRegisterRows(rows, { year, month });
        const pp = records.filter((r) => r.lecturesThatDay > 1).length;
        console.log(`[audit]   parsed records=${records.length} uniqueKeys=${new Set(records.map((r) => r.key)).size} twoLectureDays=${pp}`);
        const sample = records[0];
        if (sample) console.log('[audit]   sample record:', JSON.stringify(sample));
      }
    }
  } finally {
    await ctx.dispose();
  }
}

/** Which endpoint really carries the student's name? */
async function auditNameSources(sessionPath) {
  const { request } = require('playwright');
  const ORIGIN = 'https://qums.quantumuniversity.edu.in';
  const ctx = await request.newContext({ storageState: sessionPath, baseURL: ORIGIN });
  try {
    const { regId, studentName } = await scraper.getStudentContext(ctx);
    console.log('[audit] RegID present:', Boolean(regId), '| name via GetStudentDetailOnRegID:', JSON.stringify(studentName));
    const tile = await ctx.post('/Web_StudentAcademic/GetStudentTileData', { form: { RegID: regId }, timeout: 40000 });
    const tileBody = await tile.text();
    let tileRows = [];
    try { tileRows = JSON.parse(JSON.parse(tileBody).state || '[]'); } catch { }
    console.log('[audit] GetStudentTileData fields:', tileRows[0] ? Object.keys(tileRows[0]).join(', ') : '(none)',
      '| contains a name field:', tileRows[0] ? Object.keys(tileRows[0]).some((k) => /name/i.test(k)) : false);
  } finally {
    await ctx.dispose();
  }
}

(async () => {
  const argPath = process.argv.slice(2).find((a) => !a.startsWith('--'));
  let sessionPath = argPath;
  if (!sessionPath) {
    const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith('.json')) : [];
    if (!files.length) { console.log('no saved QUMS session — live test skipped'); process.exit(0); }
    sessionPath = path.join(DIR, files[0]);
  }
  if (!fs.existsSync(sessionPath)) { console.log('session file nahi mila:', sessionPath); process.exit(1); }

  if (wantAudit) {
    try { await auditNameSources(sessionPath); } catch (e) { console.log('[audit] name sources failed:', e.name, e.message); }
    try { await auditMonthRegister(sessionPath); } catch (e) { console.log('[audit] month register failed:', e.name, e.message); }
  }

  try {
    const profile = await scraper.getStudentProfile({ sessionPath });
    console.log('LIVE getStudentProfile:', JSON.stringify(profile));
  } catch (e) {
    console.log('LIVE profile failed (session may be expired):', e.name, e.message);
  }
  try {
    const rows = await scraper.scrapeAssignments({ sessionPath });
    console.log('LIVE scrapeAssignments: rows =', rows.length);
    const dated = rows.filter((r) => r.deadlineYMD);
    console.log('LIVE rows with deadline (DATETO):', dated.length);
    if (dated.length) console.log('SAMPLE:', JSON.stringify(dated[0]));
  } catch (e) {
    console.log('LIVE assignments failed:', e.name, e.message);
  }
  process.exit(0);
})();

