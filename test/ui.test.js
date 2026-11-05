/**
 * UI + production-hygiene tests (Phase 6/7/8/9/10/11/13 + 18 items 19-21).
 *
 *   node test/ui.test.js
 *
 * Pure static assertions over the shipped HTML/CSS/JS — no browser needed.
 * These are the acceptance checks that are easiest to silently regress:
 *   U1  dashboard greeting shows the QUMS student name, never an email
 *   U2  Quick Actions: the three required buttons incl. manual summary
 *   U3  mobile drawer = Dashboard / QUMS Setup / Telegram / Logout ONLY
 *   U4  small responsive ad slot on public + dashboard pages, no fake AdSense
 *   U5  exactly ONE /start handler + ONE polling bot initialisation
 *   U6  8:30 AM class alert kept; NO automatic 9 PM summary cron
 *   U7  reconnect page supports the Telegram deep link (?reconnect=1)
 *   U8  no global focus-outline removal (accessibility stays), no debug styles
 */
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
const SRC = path.join(__dirname, '..', 'src');
const read = (p) => fs.readFileSync(p, 'utf8');

let failures = 0;
function ok(label, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : `  ${extra}`}`);
  if (!cond) failures += 1;
}

/* ---------------- U1: greeting = student name, no email ---------------- */
const dash = read(path.join(PUBLIC, 'index.html'));
ok('U1 dashboard greets with Hello <name>', /Hello,?\s*<span id="welcomeName">/.test(dash), 'greeting span missing');
ok('U1 dashboard uses me.studentName for the greeting', /me\.studentName/.test(dash));
ok('U1 dashboard does not render me.email in the greeting/nav', !/welcomeName[^\n]*email/.test(dash) && !/me\.email/.test(dash));

/* ---------------- U2: Quick Actions removed (Phase 12/13) ---------------- */
ok('U2 heading "⚡ Quick Actions" removed', !/⚡ Quick Actions/.test(dash));
ok('U2 button Today\'s Classes removed', !/id="testMorningBtn"/.test(dash));
ok('U2 button Send Attendance Summary removed', !/id="testSummaryBtn"/.test(dash));
ok('U2 button Refresh My Schedule removed', !/id="refreshScheduleBtn"/.test(dash));
ok('U2 qumsLogoutBtn moved to status card', /id="qumsLogoutBtn"/.test(dash));
ok('U2 tgUnlinkBtn moved to status card', /id="tgUnlinkBtn"/.test(dash));

/* ---------------- U3: mobile drawer contents ---------------- */
const drawerMatch = dash.match(/<aside id="drawer"[\s\S]*?<\/aside>/);
ok('U3 drawer markup exists', Boolean(drawerMatch));
const drawer = drawerMatch ? drawerMatch[0] : '';
for (const keep of ['/dashboard', '/qums-setup', '/telegram-setup', '/logout']) {
  ok(`U3 drawer keeps ${keep}`, drawer.includes(keep));
}
for (const gone of ['/schedule', '/profile', '/help', 'Schedule', 'Profile', 'Help']) {
  ok(`U3 drawer has no "${gone}"`, !drawer.includes(gone));
}
ok('U3 no hidden duplicate drawer items left in the DOM', (dash.match(/id="drawer"/g) || []).length === 1);

/* ---------------- U4: advertisements removed ---------------- */
const pages = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html'));
for (const f of pages) {
  const html = read(path.join(PUBLIC, f));
  ok(`U4 ${f} has no advertisement markup`, !/Advertisement|ad-slot|data-ad-slot/.test(html));
  ok(`U4 ${f} has no ad-network script`, !/adsbygoogle|ca-pub-|googlesyndication/.test(html));
}
const css = read(path.join(PUBLIC, 'style.css'));
ok('U4 ad-slot CSS is removed', !/\.ad-slot\b|data-ad-slot/.test(css));
ok('U4 ads.txt is removed', !fs.existsSync(path.join(PUBLIC, 'ads.txt')));

/* ---------------- U5: one Telegram poller / one /start handler ---------------- */
const tg = read(path.join(SRC, 'telegram.js'));
const startHandlers = (tg.match(/bot\.onText\(\/\^\\\/start/g) || []).length;
ok('U5 exactly ONE /start handler registered', startHandlers === 1, `found ${startHandlers}`);
ok('U5 exactly one polling bot construction', (tg.match(/new TelegramBot\([^)]*polling:\s*true/g) || []).length === 1);
ok('U5 initTelegram is the single setup entry point', (tg.match(/function initTelegram\(/g) || []).length === 1);
ok('U5 update-level dedupe exists', /function isDuplicateUpdate\(/.test(tg));
ok('U5 machine-level single-poller lock exists', /function acquirePollingLock\(/.test(tg));
const serverInit = (read(path.join(SRC, 'server.js')).match(/telegram\.initTelegram\(/g) || []).length;
ok('U5 server calls initTelegram exactly once', serverInit === 1, `found ${serverInit}`);
ok('U5 no second getUpdates consumer (no startPolling outside initTelegram)', (tg.match(/startPolling\(/g) || []).length === 1);

/* ---------------- U6: schedules ---------------- */
const scheduler = read(path.join(SRC, 'scheduler.js'));
ok('U6 morning cron default is 8:30 AM', /MORNING_CRON_DEFAULT = '30 8 \* \* \*'/.test(scheduler));
ok('U6 morning job timezone is Asia/Kolkata', /TIMEZONE = 'Asia\/Kolkata'/.test(scheduler));
ok('U6 morning job keeps missed-run recovery', /recoverMissedExecutions: true/.test(scheduler));
ok('U6 NO 9 PM summary cron anywhere', !/'0 21 \* \* \*'|\"0 21 \* \* \*\"/.test(scheduler) && !/'0 21 \* \* \*'|\"0 21 \* \* \*\"/.test(read(path.join(SRC, 'server.js'))));
ok('U6 scheduler has no nightly summary job', !/21:00|9\s*PM IST summary|summaryCron/i.test(scheduler));
const assignments = read(path.join(SRC, 'assignments.js'));
ok('U6 assignment deadline reminder = 7:00 PM IST', /REMINDER_CRON = '0 19 \* \* \*'/.test(assignments));
const serverSrc = read(path.join(SRC, 'server.js'));
ok('U6 manual summary endpoint removed', !/\/api\/scheduler\/run/.test(serverSrc));

/* ---------------- U7: reconnect deep link ---------------- */
const setup = read(path.join(PUBLIC, 'qums-setup.html'));
ok('U7 reconnect page reads ?reconnect=1', /URLSearchParams\(location\.search\)\.get\('reconnect'\)/.test(setup));
ok('U7 reconnect page auto-starts the captcha flow', /if \(wantsReconnect && me\.qumsQid\) \{\s*\n\s*await startLogin\(\)/.test(setup));
ok('U7 reconnect button label is "🔐 Reconnect QUMS"', /🔐 Reconnect QUMS/.test(setup));
ok('U7 captcha is never auto-solved (no client captcha solver)', !/solveCaptcha|ocrad|tesseract|2captcha/i.test(setup));

/* ---------------- U8: focus styles / debug leftovers ---------------- */
ok('U8 :focus-visible ring is kept (accessibility)', /:focus-visible\s*\{[^}]*outline:/.test(css));
ok('U8 pointer focus outlines are removed deliberately', /button:focus:not\(:focus-visible\)/.test(css));
ok('U8 no global outline:none on all elements', !/^\s*\*\s*\{[^}]*outline:\s*none/m.test(css));
ok('U8 no red debug outlines', !/outline:\s*(1px|2px)?\s*solid\s+(red|#f00|#ff0000)/i.test(css));
ok('U8 tap highlight removed for mobile tap "black box"', /-webkit-tap-highlight-color:\s*transparent/.test(css));

/* ---------------- U9: production env behaviour ---------------- */
ok('U9 PORT comes from env with a fallback (never hardcoded only)', /Number\(process\.env\.PORT\)/.test(serverSrc));
ok('U9 APP_BASE_URL + RENDER_EXTERNAL_URL supported', /APP_BASE_URL/.test(serverSrc) && /RENDER_EXTERNAL_URL/.test(serverSrc));
ok('U9 DATABASE_URL selects PostgreSQL', /Boolean\(process\.env\.DATABASE_URL\)/.test(read(path.join(SRC, 'db.js'))));
ok('U9 secure cookies in production behind proxy', /secure:\s*IS_PROD/.test(serverSrc) && /trust proxy/.test(serverSrc));
ok('U9 health endpoint exists for Render', /app\.get\('\/health'/.test(serverSrc));

console.log(failures ? `\n${failures} UI/PRODUCTION TEST(S) FAILED` : '\nALL UI / PRODUCTION TESTS PASSED');
process.exit(failures ? 1 : 0);
