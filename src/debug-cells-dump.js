/**
 * DEBUG: timetable ke RAW cells dump karo — room parsing ko REAL text/DOM ke
 * against verify karo (guess nahi). Valid session chahiye (user session use
 * hota hai: data/qums-sessions/<userId>.json).
 *
 *   node src/debug-cells-dump.js
 *
 * Har non-empty cell ke liye dikhata hai:
 *   - RAW text (textContent, JSON-quoted — spaces dikhte hain)
 *   - innerHTML (truncated — <br>/<span> structure dikhta hai)
 *   - child elements (kya room alag <span>/<div> me hai?)
 *   - parseTimetableCell() ka output (production function)
 *
 * Writes: debug-cells-dump.txt
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { chromium } = require('playwright');
const scraper = require('./scraper');

const TIMETABLE_URL =
  process.env.QUMS_TIMETABLE_URL ||
  'https://qums.quantumuniversity.edu.in/Web_StudentAcademic/Cyborg_StudentTimeTable?id=Time%20Table';
const OUT_FILE = path.join(__dirname, '..', 'debug-cells-dump.txt');

(async () => {
  // pehla linked user jiska session ho
  const user = db.allUsers().find((u) => u.qumsSessionPath);
  if (!user) throw new Error('Koi QUMS-linked user nahi mila.');
  console.log(`[cells] user session: ${user.qumsSessionPath}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: user.qumsSessionPath,
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();
  await page.goto(TIMETABLE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
  await page
    .waitForFunction(
      () => /monday|tuesday|wednesday|thursday|thrusday|friday|saturday|sunday/i.test(document.body ? document.body.innerText : ''),
      { timeout: 20000 }
    )
    .catch(() => {});
  await page.waitForTimeout(2000);

  const pw = await page.locator('input[type="password"]').count();
  if (pw > 0 || isLoginLike(page.url())) throw new Error('Session expired — pehle /qums-setup se re-login karo, phir ye script chalao.');

  const dump = await page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const out = {};
    const grid = document.querySelector('table.ui-jqgrid-btable') || document.querySelector('#jqgrdTimeTable');
    const htable = document.querySelector('table.ui-jqgrid-htable');
    out.headers = htable
      ? Array.from(htable.rows).flatMap((r) => Array.from(r.cells).map((c) => norm(c.textContent)))
      : [];
    out.headers = out.headers.filter(Boolean);
    if (!grid) {
      out.error = 'grid table (ui-jqgrid-btable) nahi mili';
      return out;
    }
    const rows = Array.from(grid.querySelectorAll('tr'));
    out.totalRows = rows.length;
    out.dayRows = [];
    const DAY_RE = /^(mon|tues|tue|wed|thu|thur|thurs|thrus|fri|sat|sun)/i;
    for (const tr of rows) {
      const cells = Array.from(tr.querySelectorAll('th,td'));
      const texts = cells.map((c) => norm(c.textContent));
      const dayIdx = texts.findIndex((t) => DAY_RE.test(t));
      if (dayIdx === -1) continue;
      out.dayRows.push({
        day: texts[dayIdx],
        cells: cells.map((c, i) => ({
          index: i,
          rawText: norm(c.textContent),
          innerHTML: c.innerHTML.replace(/\s+/g, ' ').slice(0, 240),
          children: Array.from(c.children).map((ch) => `${ch.tagName}${ch.className ? '.' + String(ch.className).trim().split(/\s+/)[0] : ''}`).join(',') || '(none)',
        })),
      });
    }
    return out;
  });

  const lines = [];
  lines.push(`URL: ${page.url()}`);
  lines.push(`total grid rows: ${dump.totalRows}, day rows: ${(dump.dayRows || []).length}`);
  lines.push(`\n=== HEADER CELLS (raw) ===`);
  dump.headers.forEach((h, i) => lines.push(`  [${i}] ${JSON.stringify(h)}`));
  let roomOk = 0, roomEmpty = 0;
  for (const row of dump.dayRows || []) {
    lines.push(`\n=== ROW: ${row.day} ===`);
    for (const c of row.cells) {
      if (!c.rawText) continue;
      lines.push(`[${row.day} #${c.index}] RAW TEXT = ${JSON.stringify(c.rawText)}`);
      lines.push(`    innerHTML = ${JSON.stringify(c.innerHTML)}`);
      lines.push(`    children  = ${c.children}`);
      const parsed = scraper.parseTimetableCell(c.rawText);
      lines.push(`    PARSED    = ${JSON.stringify(parsed)}`);
      if (parsed.room) roomOk += 1; else roomEmpty += 1;
    }
  }
  lines.push(`\n=== SUMMARY: cells with room parsed = ${roomOk}, empty room = ${roomEmpty} ===`);
  const text = lines.join('\n');
  fs.writeFileSync(OUT_FILE, text, 'utf8');
  console.log(text);
  console.log(`\n[cells] dump saved: ${OUT_FILE}`);
  await browser.close();
})().catch((e) => {
  console.error(`[x] ${e.name || 'Error'}: ${e.message}`);
  process.exit(1);
});

function isLoginLike(urlString) {
  try {
    return new URL(urlString).pathname.toLowerCase().includes('login');
  } catch {
    return false;
  }
}
