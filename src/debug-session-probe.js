/**
 * Session probe — kisi bhi QUMS session file ki health check.
 * Usage:
 *   node src/debug-session-probe.js                 (root session_state.json)
 *   node src/debug-session-probe.js <sessionPath>   (kisi user ka session)
 * Verdict only — koi cookie value print nahi hoti.
 */
require('dotenv').config();
const path = require('path');
const { request } = require('playwright');

const sessionPath = process.argv[2] || path.join(__dirname, '..', 'session_state.json');

(async () => {
  const ctx = await request.newContext({
    storageState: sessionPath,
    baseURL: 'https://qums.quantumuniversity.edu.in',
  });
  const resp = await ctx
    .get('/Web_StudentAcademic/Cyborg_S_Dashboard', { timeout: 60000 })
    .catch(() => null);
  if (!resp) {
    console.log('VERDICT: UNKNOWN (request fail)');
  } else {
    const html = await resp.text();
    const hasPassword = /type=["']password["']/i.test(html);
    const hasRegId = /var\s+RegID\s*=\s*'/i.test(html);
    console.log('status:', resp.status(), '| password input:', hasPassword, '| RegID:', hasRegId);
    console.log(
      'VERDICT:',
      hasRegId ? 'SESSION ZINDA HAI ✓' : hasPassword ? 'SESSION EXPIRE — /qums-setup dobara karo' : 'UNKNOWN page shape'
    );
  }
  await ctx.dispose();
})();
