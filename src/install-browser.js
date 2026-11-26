// Downloads Playwright's Chromium on local installs. Skipped in Docker
// (the Dockerfile runs `playwright install --with-deps chromium` itself,
// which also installs the Linux system libraries Chromium needs).
//
// NOTE: this file lives in src/ (not scripts/) because .dockerignore
// excludes the whole scripts/ folder from the Docker build context.
// AntiDeploy validates package.json scripts against the copied file
// tree — a postinstall pointing at an ignored file fails the build
// with "couldn't be found at build time".
if (process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === '1') {
  console.log('[postinstall] browser download skipped (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1)');
  process.exit(0);
}

const { execSync } = require('child_process');
execSync('npx playwright install chromium', { stdio: 'inherit', shell: true });