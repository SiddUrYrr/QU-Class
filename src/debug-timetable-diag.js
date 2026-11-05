/** DEBUG: parseTimetableInPage ko live timetable page pe diagnose karo. */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const SESSION_FILE = path.join(__dirname, '..', 'session_state.json');
const TIMETABLE_URL =
  process.env.QUMS_TIMETABLE_URL ||
  'https://qums.quantumuniversity.edu.in/Web_StudentAcademic/Cyborg_StudentTimeTable?id=Time%20Table';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: SESSION_FILE, viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  await page.goto(TIMETABLE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
  await page.waitForTimeout(4000);

  const diag = await page.evaluate(() => {
    const normLocal = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const DAY_RE = /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues|wed|thurs|fri|sat|sun)\b/i;
    const out = { tables: [] };
    document.querySelectorAll('table').forEach((table, ti) => {
      const trs = Array.from(table.querySelectorAll('tr'));
      const info = { ti, id: table.id, cls: table.className, rowCount: trs.length, rows: [] };
      trs.slice(0, 10).forEach((tr) => {
        const cells = Array.from(tr.querySelectorAll('th,td')).map((c) => normLocal(c.textContent));
        info.rows.push({ tag: tr.tagName, cellCount: cells.length, dayIdx: cells.findIndex((c) => DAY_RE.test(c)), cells: cells.slice(0, 5).map((c) => c.slice(0, 40)) });
      });
      out.tables.push(info);
    });
    const ht = document.querySelector('table.ui-jqgrid-htable');
    out.hasHtable = !!ht;
    if (ht) {
      out.htableRows = Array.from(ht.rows).map((tr) =>
        Array.from(tr.cells).map((c) => normLocal(c.textContent).slice(0, 40))
      );
    }
    out.gridDivs = Array.from(document.querySelectorAll('[id*="jqgrd" i], [class*="jqgrid" i]')).slice(0, 10).map((el) => ({ tag: el.tagName, id: el.id, cls: el.className, tag2: el.tagName }));
    out.iframes = document.querySelectorAll('iframe').length;
    return out;
  });
  // Naya parser EXACT live page pe — error ke saath
  try {
    const src2 = fs.readFileSync(path.join(__dirname, 'scraper.js'), 'utf8');
    const st = src2.indexOf('function parseTimetableInPage() {');
    const en = src2.indexOf('\n}', st);
    if (st !== -1 && en !== -1) {
      const res = await page.evaluate(`(() => { try { const f = ${src2.slice(st, en + 2)}; const r = f(); return { ok: true, days: r ? r.days.length : null, dayNames: r ? r.days.map((d) => d.day) : [] }; } catch (e) { return { ok: false, err: e.message }; } })()`);
      console.log('parser live result:', JSON.stringify(res));
    }
  } catch (e) {
    console.log('parser eval error:', e.message);
  }
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
