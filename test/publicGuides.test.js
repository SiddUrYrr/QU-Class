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

console.log('=== RUNNING PUBLIC GUIDES VALIDATION SUITE ===\n');

// 2. Guide HTML files existence and structure
const guides = [
  { file: 'attendance-calculator-guide.html', canonical: 'https://qu-class.onrender.com/attendance-calculator-guide' },
  { file: 'qums-troubleshooting.html', canonical: 'https://qu-class.onrender.com/qums-troubleshooting' },
  { file: 'telegram-guide.html', canonical: 'https://qu-class.onrender.com/telegram-guide' },
  { file: 'security-and-privacy.html', canonical: 'https://qu-class.onrender.com/security-and-privacy' },
];

for (const g of guides) {
  const filePath = path.join(PUBLIC, g.file);
  ok(`G2 ${g.file} exists`, fs.existsSync(filePath));
  if (fs.existsSync(filePath)) {
    const html = read(filePath);
    ok(`G2 ${g.file} has valid HTML5 doctype and title`, html.includes('<!DOCTYPE html>') && /<title>.+<\/title>/.test(html));
    ok(`G2 ${g.file} has meta description`, /<meta\s+name=["']description["']/.test(html));
    ok(`G2 ${g.file} has correct canonical link`, html.includes(`<link rel="canonical" href="${g.canonical}" />`));
    ok(`G2 ${g.file} has no advertisement markup`, !/Advertisement|ad-slot|data-ad-slot/.test(html));
    ok(`G2 ${g.file} has no ad-network scripts`, !/adsbygoogle|ca-pub-|googlesyndication/.test(html));
  }
}

// 3. Server route registrations
const serverSrc = read(path.join(SRC, 'server.js'));
const expectedRoutes = [
  '/attendance-calculator-guide',
  '/guides/attendance-calculator',
  '/qums-troubleshooting',
  '/guides/qums-troubleshooting',
  '/telegram-guide',
  '/guides/telegram-guide',
  '/security-and-privacy',
  '/guides/security-and-privacy',
];

for (const r of expectedRoutes) {
  ok(`G3 server.js registers public route ${r}`, serverSrc.includes(`app.get('${r}'`));
}

// 4. Sitemap and Robots
const sitemap = read(path.join(PUBLIC, 'sitemap.xml'));
for (const g of guides) {
  ok(`G4 sitemap.xml includes ${g.canonical}`, sitemap.includes(`<loc>${g.canonical}</loc>`));
}

const robots = read(path.join(PUBLIC, 'robots.txt'));
ok('G4 robots.txt remains available', robots.includes('User-agent: *'));
ok('G4 robots.txt links sitemap', robots.includes('Sitemap: https://qu-class.onrender.com/sitemap.xml'));
ok('G4 robots.txt keeps private routes disallowed', robots.includes('Disallow: /dashboard') && robots.includes('Disallow: /api/'));

// 5. Calculator mathematical logic verification
const { classesNeededToReach75, classesCanSkipAndStay75 } = require('../src/calculator');
ok('G5 calculator: 12/20 needs 12 classes to reach 75%', classesNeededToReach75(12, 20) === 12);
ok('G5 calculator: 18/28 needs 12 classes to reach 75%', classesNeededToReach75(18, 28) === 12);
ok('G5 calculator: 30/45 needs 15 classes to reach 75%', classesNeededToReach75(30, 45) === 15);
ok('G5 calculator: 18/20 can skip 4 classes', classesCanSkipAndStay75(18, 20) === 4);
ok('G5 calculator: 24/30 can skip 2 classes', classesCanSkipAndStay75(24, 30) === 2);
ok('G5 calculator: 20/25 can skip 1 class', classesCanSkipAndStay75(20, 25) === 1);

console.log(failures ? `\n${failures} PUBLIC GUIDES TEST(S) FAILED` : '\nALL PUBLIC GUIDES & ADSENSE TESTS PASSED');
process.exit(failures ? 1 : 0);
