/**
 * DEBUG: timetable page ka jqGrid endpoint + params + raw JSON probe.
 *   node src/debug-timetable-net.js
 * User session (data/qums-sessions/<id>.json) chahiye.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { chromium } = require('playwright');

const TIMETABLE_URL =
  process.env.QUMS_TIMETABLE_URL ||
  'https://qums.quantumuniversity.edu.in/Web_StudentAcademic/Cyborg_StudentTimeTable?id=Time%20Table';
const OUT_FILE = path.join(__dirname, '..', 'debug-timetable-net.txt');

(async () => {
  const user = db.allUsers().find((u) => u.qumsSessionPath);
  if (!user) throw new Error('Koi QUMS-linked user nahi.');
  console.log(`[net] user session: ${user.qumsSessionPath}`);

  const netLog = [];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: user.qumsSessionPath,
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();
  page.on('response', async (resp) => {
    try {
      const url = resp.url();
      const method = resp.request().method();
      if (method === 'GET' && resp.request().resourceType() === 'document') return;
      if (/\.(css|js|png|jpg|jpeg|gif|svg|woff2?|ico|map)(\?|$)/i.test(url)) return;
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      if (!/json|html|text\/plain/.test(ct)) return;
      let postBody = null;
      try { postBody = resp.request().postData(); } catch {}
      const body = await resp.text();
      netLog.push(
        `### ${method} ${resp.status()} ${url}\nCONTENT-TYPE: ${ct}` +
        (postBody ? `\nPOST BODY: ${postBody.slice(0, 1500)}` : '') +
        `\nRESPONSE (${body.length} chars): ${body.slice(0, 2500)}${body.length > 2500 ? '\n...(truncated)' : ''}`
      );
    } catch {}
  });

  await page.goto(TIMETABLE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
  await page
    .waitForFunction(() => /monday|tuesday|wednesday|thursday|thrusday|friday|saturday|sunday/i.test(document.body ? document.body.innerText : ''), { timeout: 20000 })
    .catch(() => {});
  await page.waitForTimeout(2500);

  const gridInfo = await page.evaluate(() => {
    const out = { hasJquery: !!window.jQuery, grids: [] };
    if (!window.jQuery) return out;
    for (const id of ['jqgrdTimeTable']) {
      try {
        const $g = window.jQuery('#' + id);
        if (!$g.length) continue;
        const gp = (name) => { try { return $g.jqGrid('getGridParam', name); } catch { return null; } };
        out.grids.push({
          id,
          url: gp('url'),
          mtype: gp('mtype'),
          datatype: gp('datatype'),
          postData: gp('postData'),
          colNames: gp('colNames'),
          colModel: (gp('colModel') || []).map((c) => ({ name: c.name, index: c.index, width: c.width })),
        });
      } catch (e) {
        out.grids.push({ id, error: e.message });
      }
    }
    return out;
  });

  const lines = [];
  lines.push(`URL: ${page.url()}`);
  lines.push(`\n=== JQGRID PARAMS ===\n${JSON.stringify(gridInfo, null, 2)}`);
  lines.push(`\n=== NETWORK (${netLog.length} entries) ===\n${netLog.join('\n\n')}`);
  const text = lines.join('\n');
  fs.writeFileSync(OUT_FILE, text, 'utf8');
  console.log(text.slice(0, 6000));
  console.log(`\n[net] full dump: ${OUT_FILE}`);
  await browser.close();
})().catch((e) => {
  console.error(`[x] ${e.name || 'Error'}: ${e.message}`);
  process.exit(1);
});
