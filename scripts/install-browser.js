// Downloads Playwright's Chromium on local installs. Skipped in Docker
// (the Dockerfile runs `playwright install --with-deps chromium` itself,
// which also installs the Linux system libraries Chromium needs).
if (process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === '1') {
  console.log('[postinstall] browser download skipped (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1)');
  process.exit(0);
}

const { execSync } = require('child_process');
execSync('npx playwright install chromium', { stdio: 'inherit', shell: true });