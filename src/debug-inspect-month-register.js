/**
 * DEBUG: real-UI inspection for (1) Time Table navigation and (2) the Month
 * Register widget — BEFORE writing any parsing logic (guess-free approach).
 *
 *   node src/debug-inspect-month-register.js
 *
 * headless:false — ek visible Chromium window khulti hai. Agar session expired
 * hai to QID/password auto-fill hote hain aur YOU type the captcha (5 min).
 * Fresh session root session_state.json + data/qums-sessions/<userId>.json
 * dono me save hoti hai (same account), phir inspection chalti hai:
 *
 *   A. Dashboard -> "Academic" click -> left menu -> "Time Table" click ->
 *      final URL + grid DOM + live run of parseTimetableInPage.
 *   B. Dashboard -> Month Register widget: select options, View button,
 *      Present/Absent/Diff Lecture buttons (filter vs legend?), then month
 *      select + View click for several months until real records are found.
 *
 * Writes: debug-month-register.txt (page structure + network log only —
 * credentials kabhi print nahi hote).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { chromium } = require('playwright');
const {
  findLoginForm,
  autofillCredentials,
  isLoginLikeUrl,
} = require('./login');

const SESSION_FILE = path.join(__dirname, '..', 'session_state.json');
const DASHBOARD_URL =
  process.env.QUMS_DASHBOARD_URL ||
  'https://qums.quantumuniversity.edu.in/Web_StudentAcademic/Cyborg_S_Dashboard';
const OUT_FILE = path.join(__dirname, '..', 'debug-month-register.txt');
const CAPTCHA_TIMEOUT_MS = 5 * 60 * 1000;

const sections = [];
function log(line) {
  console.log(line);
  sections.push(line);
}
function dump(label, text) {
  sections.push(`\n===== ${label} =====\n${text || '(empty)'}`);
}

// ---------------------------------------------------------------------------
// In-page DOM probes (run via page.evaluate)
// ---------------------------------------------------------------------------
/** All elements whose own text or alt matches /academic/i — with selectors info. */
function probeAcademic() {
  const out = [];
  for (const el of document.querySelectorAll('a,div,span,li,td,img,button,input')) {
    const direct = Array.from(el.childNodes || [])
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .join(' ');
    const alt = el.getAttribute ? el.getAttribute('alt') : null;
    const title = el.getAttribute ? el.getAttribute('title') : null;
    if (/academic/i.test(direct) || /academic/i.test(alt || '') || /academic/i.test(title || '')) {
      out.push({
        tag: el.tagName,
        id: el.id || null,
        cls: el.className || null,
        alt: alt || null,
        title: title || null,
        text: direct.slice(0, 60) || null,
        href: el.getAttribute('href') || null,
        onclick: el.getAttribute('onclick') || null,
        visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
        outer: el.outerHTML.slice(0, 400),
      });
    }
  }
  return out.slice(0, 25);
}

/** All links/elements matching /time\s*table/i (after Academic click). */
function probeTimeTableLinks() {
  const out = [];
  for (const el of document.querySelectorAll('a,li,span,div,button,td')) {
    const direct = Array.from(el.childNodes || [])
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .join(' ');
    if (/time\s*table/i.test(direct) || /time\s*table/i.test(el.getAttribute('title') || '') ||
        /timetable/i.test(el.getAttribute('href') || '')) {
      out.push({
        tag: el.tagName,
        id: el.id || null,
        cls: el.className || null,
        text: (direct || el.textContent || '').trim().slice(0, 60),
        href: el.getAttribute('href') || null,
        visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
        outer: el.outerHTML.slice(0, 300),
      });
    }
  }
  return out.slice(0, 25);
}

/** Describe every table: header cells + first rows' cell texts. */
function probeTables(label) {
  const out = [];
  document.querySelectorAll('table').forEach((table, ti) => {
    const trs = Array.from(table.querySelectorAll('tr'));
    if (!trs.length) return;
    const rows = trs.slice(0, 4).map((tr) =>
      Array.from(tr.querySelectorAll('th,td')).map((c) => (c.textContent || '').replace(/\s+/g, ' ').trim())
    );
    out.push({
      label,
      tableIndex: ti,
      id: table.id || null,
      cls: table.className || null,
      rowCount: trs.length,
      rows,
    });
  });
  return out;
}


/** Month Register widget hunt: heading + selects + status buttons + View. */
function probeMonthRegister() {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const mrEls = [];
  document.querySelectorAll('div,span,h1,h2,h3,h4,h5,td,th,legend,label,p,b').forEach((el) => {
    const direct = Array.from(el.childNodes || [])
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .join(' ');
    if (/month\s*register/i.test(direct)) {
      mrEls.push({ tag: el.tagName, id: el.id || null, cls: el.className || null, text: norm(direct), outer: el.outerHTML.slice(0, 200) });
    }
  });

  const selects = [];
  document.querySelectorAll('select').forEach((s) => {
    const options = Array.from(s.querySelectorAll('option')).map((o) => ({ value: o.value, label: norm(o.textContent), selected: o.selected }));
    selects.push({ id: s.id || null, name: s.name || null, cls: s.className || null, optionCount: options.length, options: options.slice(0, 20) });
  });

  const statusButtons = [];
  for (const el of document.querySelectorAll('a,button,input,span,div,li')) {
    const t = norm(el.textContent || el.value || '');
    if (/^(present|absent|diff\s*lecture)$/i.test(t)) {
      statusButtons.push({
        tag: el.tagName,
        type: el.getAttribute('type') || null,
        id: el.id || null,
        cls: el.className || null,
        text: t,
        onclick: el.getAttribute('onclick') || null,
        href: el.getAttribute('href') || null,
        outer: el.outerHTML.slice(0, 300),
      });
    }
  }

  const viewButtons = [];
  for (const el of document.querySelectorAll('a,button,input')) {
    const t = norm(el.textContent || el.value || '');
    if (/^view$/i.test(t)) {
      viewButtons.push({
        tag: el.tagName,
        type: el.getAttribute('type') || null,
        id: el.id || null,
        name: el.name || null,
        cls: el.className || null,
        onclick: el.getAttribute('onclick') || null,
        outer: el.outerHTML.slice(0, 300),
      });
    }
  }

  // Heading se upar widget container (5 levels, jab tak <select> wala container na mile)
  let target = null;
  document.querySelectorAll('div,span,td,legend,label,p,b,h3,h4,h5').forEach((el) => {
    const direct = Array.from(el.childNodes || [])
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .join(' ');
    if (/month\s*register/i.test(direct) && !target) target = el;
  });
  let widgetHtml = null;
  if (target) {
    let container = target;
    for (let i = 0; i < 5; i++) {
      if (container.parentElement && /div|form|section|article|aside/i.test(container.parentElement.tagName)) {
        container = container.parentElement;
      }
      if (container.outerHTML.includes('<select') && container.outerHTML.length > 500) break;
    }
    widgetHtml = container.outerHTML.slice(0, 8000);
  }
  if (mrEls.length && !widgetHtml) widgetHtml = `heading only: ${mrEls[0].outer}`;

  return { mrEls, selects, statusButtons, viewButtons, widgetHtml };
}

/** "No records"-jaisa koi text page pe hai? */
function probeNoRecords() {
  const hits = [];
  const re = /no\s*records|no\s*data|koi\s*record/i;
  for (const el of document.querySelectorAll('div,span,td,th,p,label,li')) {
    const direct = Array.from(el.childNodes || [])
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .join(' ');
    if (re.test(direct)) hits.push({ tag: el.tagName, id: el.id || null, cls: el.className || null, text: direct.slice(0, 120) });
  }
  return hits.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  log(`[inspect] start — ${new Date().toISOString()}`);

  const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
  try {
    const contextOpts = { viewport: null };
    if (fs.existsSync(SESSION_FILE)) contextOpts.storageState = SESSION_FILE;
    const context = await browser.newContext(contextOpts);
    const page = await context.newPage();

    // Network log — AJAX endpoints reveal karna (month register ka POST etc.)
    const netLog = [];
    let netMark = 0;
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
          `### ${method} ${resp.status()} ${url}\nCONTENT-TYPE: ${ct || '(none)'}` +
          (postBody ? `\nPOST BODY: ${postBody.slice(0, 2500)}` : '') +
          `\nRESPONSE (${body.length} chars): ${body.slice(0, 6000)}${body.length > 6000 ? '\n...(truncated)' : ''}`
        );
      } catch {}
    });

    // ---- Step 0: login page? (expired session) -> captcha wait ----
    await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);
    const passwordBoxes = await page.locator('input[type="password"]').count();
    if (isLoginLikeUrl(page.url()) || passwordBoxes > 0) {
      log('[inspect] session expired — login page khula. QID+password auto-fill ho rahe hain...');
      log('[inspect] >>> WINDOW ME CAPTCHA SOLVE KARO (5 min ka time hai) <<<');
      const frame = await findLoginForm(page);
      const qid = process.env.QUMS_QID;
      const password = process.env.QUMS_PASSWORD;
      if (!qid || !password) throw new Error('QUMS_QID/QUMS_PASSWORD .env me nahi hain.');
      await autofillCredentials(frame, qid, password);
      await page.waitForURL((u) => !isLoginLikeUrl(u.toString()), { timeout: CAPTCHA_TIMEOUT_MS });
      await page.waitForTimeout(3000);
      // Fresh session dono jagah save (root + linked user) — same account.
      await context.storageState({ path: SESSION_FILE });
      for (const user of db.allUsers()) {
        if (user.qumsSessionPath) {
          try { await context.storageState({ path: user.qumsSessionPath }); } catch {}
        }
      }
      log('[inspect] login OK — fresh session saved (root + linked user sessions).');
      await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(3000);
    } else {
      log('[inspect] session valid hai — seedha inspection.');
    }

    try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
    dump('DASHBOARD-URL', page.url());

    // ---- Step A1: Academic probe ----
    dump('A1: ACADEMIC ELEMENTS (text/alt/title match)', JSON.stringify(await page.evaluate(probeAcademic), null, 2));

    // ---- Step A2: Academic click (candidates try karo) ----
    const academicSelectors = [
      'text=Academic',
      'img[alt*="Academic" i]',
      '[title*="Academic" i]',
      'a:has-text("Academic")',
      'div:has-text("Academic")',
    ];
    let clickedAcademic = null;
    for (const sel of academicSelectors) {
      try {
        await page.locator(sel).first().click({ timeout: 4000 });
        clickedAcademic = sel;
        break;
      } catch (e) {
        log(`[inspect] academic click fail: ${sel} -> ${(e.message || '').split('\n')[0].slice(0, 120)}`);
      }
    }
    log(`[inspect] Academic clicked via: ${clickedAcademic || 'NONE'}`);
    await page.waitForTimeout(1500);
    dump('A2: TIME TABLE LINKS (after Academic click)', JSON.stringify(await page.evaluate(probeTimeTableLinks), null, 2));

    // ---- Step A3: Time Table click ----
    const ttSelectors = [
      'a:has-text("Time Table")',
      'text=Time Table',
      '[title*="Time Table" i]',
      'a[href*="TimeTable" i]',
      'a[href*="Time%20Table" i]',
    ];
    let clickedTt = null;
    for (const sel of ttSelectors) {
      try {
        await page.locator(sel).first().click({ timeout: 4000 });
        clickedTt = sel;
        break;
      } catch (e) {
        log(`[inspect] timetable click fail: ${sel} -> ${(e.message || '').split('\n')[0].slice(0, 120)}`);
      }
    }
    log(`[inspect] Time Table clicked via: ${clickedTt || 'NONE'}`);
    try { await page.waitForLoadState('networkidle', { timeout: 20000 }); } catch {}
    await page.waitForTimeout(3000);
    dump('A3: TIME TABLE FINAL URL', page.url());
    dump('A4: TIME TABLE TABLES (headers + first rows)', JSON.stringify(await page.evaluate(probeTables, 'timetable-page'), null, 2));

    // ---- Step A5: existing parser REAL page pe live run ----
    try {
      const src = fs.readFileSync(path.join(__dirname, 'scraper.js'), 'utf8');
      const start = src.indexOf('function parseTimetableInPage() {');
      const end = src.indexOf('\n}', start);
      if (start !== -1 && end !== -1) {
        const parsed = await page.evaluate(src.slice(start, end + 2));
        dump('A5: parseTimetableInPage LIVE RESULT', JSON.stringify(parsed, null, 2).slice(0, 6000));
      }
    } catch (e) {
      dump('A5: parseTimetableInPage LIVE RESULT', `error: ${e.message}`);
    }

    // ---- Step B1: dashboard wapas, Month Register widget probe ----
    await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
    await page.waitForTimeout(3000);
    const mr = await page.evaluate(probeMonthRegister);
    dump('B1: MONTH REGISTER WIDGET HTML', mr.widgetHtml || '(heading not found)');
    dump('B1a: MR HEADING MATCHES', JSON.stringify(mr.mrEls, null, 2));
    dump('B1b: ALL SELECTS ON DASHBOARD (options included)', JSON.stringify(mr.selects, null, 2));
    dump('B1c: PRESENT/ABSENT/DIFF-LECTURE ELEMENTS (filter ya legend?)', JSON.stringify(mr.statusButtons, null, 2));
    dump('B1d: VIEW BUTTONS', JSON.stringify(mr.viewButtons, null, 2));

    // ---- Step B2: month select + View click — months iterate karo ----
    const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const nowIst = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', month: 'long' }).format(new Date());
    const candidates = [];
    const mi = MONTH_NAMES.indexOf(nowIst);
    for (let back = 0; back < 5; back++) candidates.push(MONTH_NAMES[(mi - back + 12) % 12]);

    const allSelectLocators = await page.locator('select').count();
    log(`[inspect] dashboard pe ${allSelectLocators} select(s) mile.`);

    let foundMonth = null;
    for (const monthName of candidates) {
      // har iteration me fresh locate (postback ke baad DOM badal sakta hai)
      let selIdx = -1;
      let selOpts = [];
      for (let si = 0; si < allSelectLocators; si++) {
        const opts = await page.locator('select').nth(si).locator('option').allTextContents().catch(() => []);
        if (opts.some((o) => o.trim().toLowerCase() === monthName.toLowerCase())) {
          selIdx = si;
          selOpts = opts;
          break;
        }
      }
      if (selIdx === -1) {
        log(`[inspect] "${monthName}" kisi select me nahi mila — skip.`);
        continue;
      }
      try {
        await page.locator('select').nth(selIdx).selectOption({ label: monthName });
      } catch (e) {
        log(`[inspect] selectOption fail (${monthName}): ${(e.message || '').split('\n')[0]}`);
        continue;
      }
      // Month Register ka View button exact ID se (generic "View" pehla galat
      // button pakad leta hai — btnYearSemWiseAttendance etc.)
      let viewClicked = false;
      for (const vs of ['#btnMonthRegister', 'button:has-text("View")', 'input[type="submit"][value*="View" i]', 'input[value="View"]', 'a:has-text("View")']) {
        try {
          await page.locator(vs).first().click({ timeout: 3000 });
          viewClicked = true;
          break;
        } catch {}
      }
      if (!viewClicked) {
        log(`[inspect] View button nahi mila (${monthName}) — skip.`);
        continue;
      }
      log(`[inspect] View clicked for "${monthName}" (select#${selIdx}, options=[${selOpts.join('|').slice(0, 200)}]).`);
      try { await page.waitForLoadState('networkidle', { timeout: 20000 }); } catch {}
      await page.waitForTimeout(3000);

      const noRec = await page.evaluate(probeNoRecords);
      const tables = await page.evaluate(probeTables, `month-${monthName}`);
      const netSlice = netLog.slice(netMark);
      netMark = netLog.length;
      dump(
        `B2: MONTH=${monthName} — RESULT`,
        `URL: ${page.url()}\nNO-RECORDS TEXTS: ${JSON.stringify(noRec)}\n\nTABLES:\n${JSON.stringify(tables, null, 2)}\n\nNETWORK (new since click):\n${netSlice.join('\n\n') || '(none)'}`
      );
      const hasData = tables.some(
        (t) => t.rows.length > 1 && t.rows.slice(1).some((cells) => cells.some((c) => c && !/no\s*records/i.test(c)))
      );
      if (hasData && !noRec.length) {
        foundMonth = monthName;
        log(`[inspect] ✅ "${monthName}" me real records mile — aage try karne ki zaroorat nahi.`);
        break;
      }
      log(`[inspect] "${monthName}" empty lag raha hai — agla month...`);
      // dashboard reset (postback ke baad fresh state)
      await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
      await page.waitForTimeout(2000);
    }

    log(foundMonth ? `[inspect] DATA MONTH = ${foundMonth}` : '[inspect] kisi month me data nahi mila — dump file dekho.');

    // ---- Save everything ----
    fs.writeFileSync(OUT_FILE, sections.join('\n'), 'utf8');
    console.log(`\n[inspect] DONE — dump: ${OUT_FILE}`);
  } catch (err) {
    dump('FATAL', `${err.name || 'Error'}: ${err.message}\n${(err.stack || '').split('\n').slice(0, 5).join('\n')}`);
    try { fs.writeFileSync(OUT_FILE, sections.join('\n'), 'utf8'); } catch {}
    console.error(`[x] inspect failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
})();

