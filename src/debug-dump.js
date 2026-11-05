/**
 * DEBUG: dump the real QUMS dashboard DOM so the parser can be tuned
 * against actual markup. Reuses session_state.json exactly like scraper.js.
 *
 *   node src/debug-dump.js
 *
 * Writes: debug-qums-dom.txt  (safe to share — contains page structure only)
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const SESSION_FILE = path.join(__dirname, '..', 'session_state.json');
const DASHBOARD_URL =
  process.env.QUMS_DASHBOARD_URL ||
  'https://qums.quantumuniversity.edu.in/Web_StudentAcademic/Cyborg_S_Dashboard';
const OUT_FILE = path.join(__dirname, '..', 'debug-qums-dom.txt');

(async () => {
  if (!fs.existsSync(SESSION_FILE)) {
    console.error('[x] session_state.json missing — /qums-setup pe QUMS login karo (ya user session ke saath chalao)');
    process.exit(1);
  }
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: SESSION_FILE,
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();
  // Capture AJAX responses — jqGrid fetches data via XHR (JSON *or* HTML
  // fragments). Log URL + request POST body + response body for analysis.
  const netLog = [];
  page.on('response', async (resp) => {
    try {
      const url = resp.url();
      const method = resp.request().method();
      // skip the main document navigation and static assets
      if (method === 'GET' && resp.request().resourceType() === 'document') return;
      if (/\.(css|js|png|jpg|jpeg|gif|svg|woff2?|ico|map)(\?|$)/i.test(url)) return;
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      if (!/json|html|text\/plain/.test(ct)) return;
      let postBody = null;
      try { postBody = resp.request().postData(); } catch {}
      const body = await resp.text();
      netLog.push(
        `\n########## ${method} ${resp.status()} ${url}` +
        `\nCONTENT-TYPE: ${ct || '(none)'}` +
        (postBody ? `\nPOST BODY: ${postBody.slice(0, 2000)}` : '') +
        `\nRESPONSE (${body.length} chars): ${body.slice(0, 6000)}${body.length > 6000 ? '\n...(truncated)' : ''}`
      );
    } catch {}
  });
  try {
    await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle', timeout: 60000 });
  } catch (err) {
    console.error(`[!] goto: ${err.message} (dumping whatever loaded)`);
  }
  // Give JS-rendered grids extra time, then interact like a user:
  // 1) list all <select> dropdowns, 2) pick the student's Year/Sem in any
  // sem-like dropdown, 3) click attendance-ish tabs, 4) wait for jqGrid AJAX.
  await page.waitForTimeout(4000);

  const selectsInfo = await page.evaluate(() =>
    Array.from(document.querySelectorAll('select')).map((s) => ({
      id: s.id || '(no id)',
      name: s.name || '',
      value: s.value,
      options: Array.from(s.options).slice(0, 12).map((o) => `${o.value}:${o.textContent.trim()}`),
    }))
  );
  console.log(`\n[i] SELECT dropdowns (${selectsInfo.length}):`);
  selectsInfo.forEach((s) => console.log(`  #${s.id} [${s.name}] value=${s.value} options=${JSON.stringify(s.options)}`));

  const currentSem = process.env.QUMS_CURRENT_YEARSEM || '5';
  // The attendance grid's own semester selector — force-fire its change event
  // even if the value is already correct (jqGrid listens for change).
  try {
    const attSel = page.locator('#ddlYearSemAttendance');
    if ((await attSel.count()) > 0) {
      await attSel.evaluate((el, sem) => {
        el.value = sem;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        if (window.jQuery) window.jQuery(el).trigger('change');
      }, currentSem);
      console.log(`[i] #ddlYearSemAttendance forced to "${currentSem}" + change fired`);
      await page.waitForTimeout(6000);
    }
  } catch (err) {
    console.log(`[!] #ddlYearSemAttendance trigger failed: ${err.message}`);
  }

  for (const label of ['Attendance', 'Attendance Summary', 'Year/Sem Wise']) {
    try {
      const el = page.locator(`text=${label}`).first();
      if (await el.isVisible({ timeout: 1000 })) {
        await el.click();
        console.log(`[i] clicked "${label}"`);
        await page.waitForTimeout(4000);
        break;
      }
    } catch {}
  }
  // jqGrid populates via AJAX — wait for the data to arrive, then re-check.
  await page.waitForTimeout(8000);

  const gridState = await page.evaluate(() => {
    const grids = ['tblYearSemWiseAttendance', 'tblAttendanceToday', 'tblLectureToday', 'tblSummary'];
    return grids.map((id) => {
      const t = document.getElementById(id);
      if (!t) return `${id}: (not found)`;
      const dataRows = Array.from(t.querySelectorAll('tr')).filter(
        (r) => !r.className.includes('jqgfirstrow') && r.querySelector('td[role="gridcell"]')
      );
      return `${id}: ${dataRows.length} data rows` + (dataRows.length ? `\n  FIRST ROW: ${dataRows[0].outerHTML.replace(/\s+/g, ' ').slice(0, 4000)}` : '');
    }).join('\n');
  });
  console.log(`\n[i] grid state after AJAX wait:\n${gridState}`);

  // Reveal HOW the page loads the attendance grid: dump inline scripts
  // mentioning the grid/endpoints, plus all external JS file URLs.
  const jsInfo = await page.evaluate(() => {
    const inline = Array.from(document.querySelectorAll('script:not([src])'))
      .map((s, i) => ({ i, t: s.textContent || '' }))
      .filter((s) => s.t.length > 200)
      .map((s) => `===== INLINE SCRIPT #${s.i + 1} (${s.t.length} chars) =====\n${s.t.slice(0, 80000)}`);
    const external = Array.from(document.querySelectorAll('script[src]')).map((s) => s.src);
    return `${inline.join('\n\n') || '(no inline script mentions the attendance grid)'}\n\nEXTERNAL SCRIPTS:\n${external.join('\n')}`;
  });
  console.log(`\n${jsInfo.slice(0, 3000)}`);
  fs.writeFileSync(path.join(__dirname, '..', 'debug-qums-js.txt'), jsInfo);

  const dump = await page.evaluate(() => {
    const out = [];
    out.push(`MAIN URL: ${location.href}`);
    out.push(`TITLE: ${document.title}`);
    const iframes = Array.from(document.querySelectorAll('iframe')).map((f) => f.src);
    out.push(`IFRAMES (${iframes.length}): ${iframes.join(', ') || '(none)'}`);
    const tables = Array.from(document.querySelectorAll('table'));
    out.push(`TABLES in main frame: ${tables.length}`);
    tables.forEach((t, i) => {
      const html = t.outerHTML.replace(/\s+/g, ' ');
      out.push(`\n===== TABLE ${i + 1} (${html.length} chars) =====`);
      out.push(html.slice(0, 8000));
      if (html.length > 8000) out.push('...(truncated)');
    });
    // Non-table elements that look like grid rows (div-based grids)
    const pctNodes = Array.from(document.querySelectorAll('*')).filter(
      (el) => el.children.length === 0 && /^\d{1,3}(\.\d+)?\s*%$/.test((el.textContent || '').trim())
    );
    out.push(`\nBARE "%"-TEXT NODES: ${pctNodes.length}`);
    pctNodes.slice(0, 40).forEach((el) => {
      const chain = [];
      let cur = el;
      while (cur && cur !== document.body && chain.length < 6) {
        chain.push(`${cur.tagName.toLowerCase()}${cur.className ? '.' + String(cur.className).split(' ')[0] : ''}`);
        cur = cur.parentElement;
      }
      out.push(`  ${el.outerHTML.slice(0, 120)}   <- chain: ${chain.join(' < ')}`);
    });
    return out.join('\n');
  });

  // Per-frame tables (attendance grid may live inside an iframe)
  const frameDumps = [];
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      const info = await frame.evaluate(() => {
        const tables = Array.from(document.querySelectorAll('table'));
        return {
          url: location.href,
          count: tables.length,
          html: tables.map((t, i) => `\n===== IFRAME TABLE ${i + 1} =====\n` + t.outerHTML.replace(/\s+/g, ' ').slice(0, 8000)).join('\n'),
        };
      });
      frameDumps.push(`\n########## FRAME: ${info.url} — tables: ${info.count} ##########${info.html}`);
    } catch (err) {
      frameDumps.push(`\n########## FRAME dump failed: ${err.message} ##########`);
    }
  }

  const full = `[debug-qums-dom] generated ${new Date().toISOString()}\n\n[i] GRID STATE AFTER AJAX WAIT:\n${gridState}\n\n${dump}\n${frameDumps.join('\n')}\n\n[i] CAPTURED XHR JSON RESPONSES (${netLog.length}):\n${netLog.join('\n')}`;
  fs.writeFileSync(OUT_FILE, full);
  console.log(`[i] dump written: ${OUT_FILE} (${full.length} chars)`);
  console.log(full.slice(0, 1500));
  await browser.close();
})();
