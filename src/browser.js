const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium: playwrightChromium } = require('playwright');

let bundledChromiumRuntimePromise;

function isMissingSharedLibraryError(error) {
  return /error while loading shared libraries:.*cannot open shared object file/i.test(
    String(error && error.message)
  );
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
      if (!fs.existsSync(path.join(libraryDir, 'libnss3.so'))) {
        await fs.promises.rm(path.dirname(libraryDir), { recursive: true, force: true });
        await inflate(path.join(packageRoot, 'bin', 'al2023.tar.br'));
      }
      setupLambdaEnvironment(libraryDir);

      return {
        chromium: bundledChromium,
        executablePath: await bundledChromium.executablePath(),
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
  const env = { ...process.env, ...(options.env || {}) };
  env.LD_LIBRARY_PATH = [runtime.libraryDir, env.LD_LIBRARY_PATH]
    .filter(Boolean)
    .join(path.delimiter);

  return playwrightChromium.launch({
    ...options,
    args: [...runtime.chromium.args, ...(options.args || [])],
    executablePath: runtime.executablePath,
    env,
  });
}

async function launchChromium(options = {}) {
  try {
    return await playwrightChromium.launch(options);
  } catch (error) {
    if (process.platform !== 'linux' || !isMissingSharedLibraryError(error)) {
      throw error;
    }

    console.warn(
      'System Chromium is missing a Linux shared library; retrying with bundled Chromium.'
    );
    try {
      return await launchWithBundledChromium(options);
    } catch (fallbackError) {
      throw new AggregateError(
        [error, fallbackError],
        'System and bundled Chromium both failed to launch.'
      );
    }
  }
}

module.exports = { launchChromium };
