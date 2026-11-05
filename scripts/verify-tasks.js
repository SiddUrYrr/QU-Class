/**
 * LIVE verify (Task 1+2+3) — real user ke saath:
 *   1. getTodaysScheduleWithRoom(userId) -> merged rows + cache upsert
 *   2. getWeeklySchedule -> cache HIT check
 *   3. getMorningScheduleText -> mode 'weekly-cache' hona chahiye (2nd call)
 *   4. runBaselineForUser -> aaj ke marked periods ka seed
 *   node scripts/verify-tasks.js
 */
require('dotenv').config();
const db = require('../src/db');
const scraper = require('../src/scraper');
const scheduler = require('../src/scheduler');
const watcher = require('../src/watcher');

(async () => {
  const user = db.allUsers().find((u) => u.qumsSessionPath);
  if (!user) {
    console.log('[x] koi user with QUMS session nahi mila.');
    process.exit(1);
  }
  console.log('user:', user.email);

  console.log('\n--- Task 1: getTodaysScheduleWithRoom (live merge) ---');
  const rows = await scraper.getTodaysScheduleWithRoom(user.id);
  rows.forEach((r) =>
    console.log(`  ${r.period} | ${r.duration} | ${r.subject} (${r.subjectCode}) | teacher: ${r.teacher} | room: ${r.room || 'N/A'} | ${r.attendance}`)
  );

  console.log('\n--- Task 2: cache upsert hua? ---');
  const dow = new Date().getDay();
  const cached = db.getWeeklySchedule(user.id, dow);
  console.log(`  dow=${dow} | fresh: ${cached.fresh} | rows: ${cached.rows.length}`);

  console.log('\n--- Task 2: getMorningScheduleText (cache-first) ---');
  const { text, mode } = await scheduler.getMorningScheduleText(user, { log: console });
  console.log(`  mode: ${mode} | message preview:\n${text.split('\n').slice(0, 6).join('\n')}\n  …`);
  const second = await scheduler.getMorningScheduleText(user, { log: console });
  console.log(`  2nd call mode: ${second.mode} (weekly-cache hona chahiye — koi scrape nahi)`);

  console.log('\n--- Task 3: baseline (aaj ke marked periods ka seed) ---');
  const b = await watcher.runBaselineForUser(user.id);
  console.log('  baseline result:', JSON.stringify(b));

  console.log('\nDone.');
  process.exit(0);
})().catch((e) => {
  console.error('[x]', e.name || 'Error', '-', e.message);
  if (e.hint) console.error('    hint:', e.hint);
  process.exit(1);
});
