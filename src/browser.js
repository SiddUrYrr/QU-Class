const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium: playwrightChromium } = require('playwright');

let bundledChromiumRuntimePromise;

// Sticky: once the system Chromium is found to be missing shared libraries
// (or the operator forces it), every later launch in this process goes
// straight to the bundled Chromium instead of paying a failed launch first.
let useBundledChromium = process.env.CHROMIUM_BUNDLED === '1';

// Playwright's raw launch dump ("browserType.launch: ... Browser logs: ...")
// is useful in server logs, but must never reach the user. These patterns
// identify a missing-system-libraries failure.
const SHARED_LIBRARY_RE =
  /cannot open shared object file|error while loading shared libraries|missing dependencies to run browsers|libnspr|libnss|libatk|libxkb|libgbm|libasound/i;

function isMissingSharedLibraryError(error) {
  const message = String((error && error.message) || error || '');
  return SHARED_LIBRARY_RE.test(message) || (error && error.code === 'ERR_DLOPEN_FAILED');
}

// Flags shipped by @sparticuz/chromium that conflict with Playwright's own
// headless/sandbox handling outside AWS Lambda. Passing them through makes
// the bundled browser die with "Target page, context or browser has been
// closed" even when the libraries are present.
const UNSAFE_BUNDLED_ARG_PREFIXES = [
  '--headless',
  '--single-process',
  '--no-zygote',
  '--disable-web-security',
  '--allow-running-insecure-content',
  '--disable-site-isolation-trials',
  '--ignore-gpu-blocklist',
  '--in-process-gpu',
  '--use-gl',
  '--use-angle',
  '--enable-unsafe-swiftshader',
];

function filterBundledArgs(args) {
  return (args || []).filter(
    (arg) => !UNSAFE_BUNDLED_ARG_PREFIXES.some((prefix) => arg === prefix || arg.startsWith(`${prefix}=`))
  );
}

// Clean, user-safe error. The original Playwright dump is logged server-side
// only (see launchChromium) and attached as `cause` for debugging.
function browserLaunchError(cause) {
  const error = new Error(
    'Server browser failed to start (missing system libraries). ' +
      'Deploy with the Dockerfile so Chromium system libraries are installed.'
  );
  error.name = 'BrowserLaunchError';
  error.hint =
    'Please try again in a minute. If this persists, the server needs its browser libraries installed (deploy via Dockerfile, or set CHROMIUM_BUNDLED=1 on non-Docker hosts).';
  error.cause = cause;
  return error;
}

async function getBundledChromiumRuntime() {
  if (!bundledChromiumRuntimePromise) {
    bundledChromiumRuntimePromise = (async () => {
      const { default: bundledChromium, inflate, setupLambdaEnvironment } = await import(
        '@sparticuz/chromium'
      );
      const packageRoot = path.resolve(
        path.dirname(require.resolve('@sparticuz/chromium')),
        '..'
      );
      const libraryDir = path.join(os.tmpdir(), 'al2023', 'lib');
      // @sparticuz/chromium only extracts these AL2023 libraries inside AWS
      // Lambda/Vercel. On Render/AntiDeploy (Debian slim, no --with-deps) we
      // must extract them ourselves or Chromium dies on libnspr4/libnss3.
      if (!fs.existsSync(path.join(libraryDir, 'libnss3.so'))) {
        await fs.promises.rm(path.dirname(libraryDir), { recursive: true, force: true });
        await inflate(path.join(packageRoot, 'bin', 'al2023.tar.br'));
      }
      if (!fs.existsSync(path.join(libraryDir, 'libnspr4.so'))) {
        throw new Error(`Bundled Chromium libraries missing in ${libraryDir}`);
      }
      // Mutates process.env.LD_LIBRARY_PATH so the browser child process
      // (spawned by Playwright with the inherited environment) finds them.
      setupLambdaEnvironment(libraryDir);

      const executablePath = await bundledChromium.executablePath();
      fs.accessSync(executablePath, fs.constants.X_OK);

      return {
        chromium: bundledChromium,
        executablePath,
        libraryDir,
      };
    })();
  }

  try {
    return await bundledChromiumRuntimePromise;
  } catch (error) {
    bundledChromiumRuntimePromise = null;
    throw error;
  }
}

async function launchWithBundledChromium(options) {
  const runtime = await getBundledChromiumRuntime();
  const args = [...new Set([...filterBundledArgs(runtime.chromium.args), ...(options.args || [])])];

  // No custom `env` here: Playwright inherits process.env by default, which
  // already contains the LD_LIBRARY_PATH set by setupLambdaEnvironment().
  // Overriding env can silently drop HOME/PATH and break the child process.
  return playwrightChromium.launch({
    ...options,
    args,
    executablePath: runtime.executablePath,
  });
}

async function launchChromium(options = {}) {
  const launchOptions = { headless: true, ...options };

  if (useBundledChromium && process.platform === 'linux') {
    try {
      return await launchWithBundledChromium(launchOptions);
    } catch (error) {
      console.error('[browser] Bundled Chromium launch failed:', error && error.message);
      throw browserLaunchError(error);
    }
  }

  try {
    return await playwrightChromium.launch(launchOptions);
  } catch (error) {
    if (process.platform !== 'linux' || !isMissingSharedLibraryError(error)) {
      throw error;
    }

    console.warn(
      '[browser] System Chromium is missing a Linux shared library; switching to bundled Chromium.'
    );
    useBundledChromium = true;
    try {
      return await launchWithBundledChromium(launchOptions);
    } catch (fallbackError) {
      console.error('[browser] Bundled Chromium launch failed:', fallbackError && fallbackError.message);
      throw browserLaunchError(fallbackError);
    }
  }
}

module.exports = { launchChromium, isMissingSharedLibraryError, filterBundledArgs };
