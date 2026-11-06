/**
 * QUMS login form helpers — shared by the HEADLESS web captcha relay
 * (src/qums-login-web.js): captcha image web dashboard pe dikhti hai, user
 * wahan type karta hai, backend headless Chromium me submit karta hai.
 * Koi visible browser window nahi khulti — VPS/headless deployment-safe.
 *
 * (Purana headful `npm run login` CLI flow hata diya gaya hai — ab captcha
 * hamesha web dashboard se solve hota hai.)
 */

function isLoginLikeUrl(urlString) {
  try {
    const { pathname } = new URL(urlString);
    const p = pathname.toLowerCase();
    if (p === '/' || p === '' || p === '/#' || p.endsWith('/index.aspx') || p.endsWith('/default.aspx')) {
      return true;
    }
    return p.includes('login');
  } catch {
    return false;
  }
}

/**
 * The login form may be rendered in the main frame or inside an iframe.
 * Return the first frame that has BOTH a text input and a password input.
 */
async function findLoginForm(page) {
  for (const frame of page.frames()) {
    try {
      const [textCount, passCount] = await Promise.all([
        frame.locator('input[type="text"]').count(),
        frame.locator('input[type="password"]').count(),
      ]);
      if (textCount > 0 && passCount > 0) return frame;
    } catch {
      /* frame detached mid-check — skip */
    }
  }
  return page.mainFrame();
}

/**
 * Fill QID + password, leaving the captcha input untouched for the user.
 * The QID field is picked by name/id/placeholder hints when possible,
 * otherwise it falls back to the first visible text input (known QUMS layout:
 * QID text input, then password, then captcha text input).
 * NOTE: no credential value is ever printed to the console.
 */
async function autofillCredentials(frame, qid, password) {
  const textInputs = frame.locator('input[type="text"]');
  const textCount = await textInputs.count();
  if (textCount === 0) {
    throw new Error('No text inputs found on the login form — portal markup may have changed.');
  }

  let qidInput = null;
  const fastQid = frame.locator('input#UserName, input[name="UserName" i]');
  if ((await fastQid.count().catch(() => 0)) > 0) {
    qidInput = fastQid.first();
  }
  if (!qidInput) {
    for (let i = 0; i < textCount; i++) {
    const el = textInputs.nth(i);
    const attrs = [
      await el.getAttribute('name'),
      await el.getAttribute('id'),
      await el.getAttribute('placeholder'),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (/qid|user|loginid|login_id|regd|roll|empid/.test(attrs)) {
      qidInput = el;
      break;
    }
    }
  }
  if (!qidInput) qidInput = textInputs.first();

  const passwordInput = frame.locator('input[type="password"]').first();

  await qidInput.waitFor({ state: 'visible', timeout: 15000 });
  await qidInput.fill(qid);
  await passwordInput.fill(password);

  console.log('[+] QID + password auto-filled. Captcha field left empty for you.');
  console.log('    (If QID goes in any wrong box, just fix it in the window.)');
}

/**
 * Locate the captcha text input: prefer name/id/placeholder matching /captcha/i,
 * else fall back to the LAST text input in the frame (known QUMS layout puts it
 * after the password field).
 */
async function locateCaptchaInput(frame) {
  const fastCaptcha = frame.locator('input#captcha, input[name="captcha" i], input.captcha');
  if ((await fastCaptcha.count().catch(() => 0)) > 0) {
    return fastCaptcha.first();
  }
  const textInputs = frame.locator('input[type="text"]');
  const count = await textInputs.count();
  for (let i = 0; i < count; i++) {
    const el = textInputs.nth(i);
    const attrs = [
      await el.getAttribute('name'),
      await el.getAttribute('id'),
      await el.getAttribute('placeholder'),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (/captcha/.test(attrs)) return el;
  }
  if (count === 0) throw new Error('No captcha/text input found on the login form.');
  return textInputs.nth(count - 1);
}

/**
 * Click the login/submit button: submit input/button, or one labelled Login.
 */
async function clickLoginButton(frame) {
  const candidates = [
    frame.locator('button.btnSubmit').first(),
    frame.locator('button[type="submit"]').first(),
    frame.locator('input[type="submit"]').first(),
    frame.getByRole('button', { name: /login|sign in/i }).first(),
    frame.locator('a', { hasText: /login|sign in/i }).first(),
  ];
  for (const c of candidates) {
    try {
      if ((await c.count()) > 0 && (await c.isVisible())) {
        await c.click();
        return;
      }
    } catch {
      /* try next candidate */
    }
  }
  throw new Error('Login button not found on the login form.');
}

/**
 * Screenshot the captcha image element -> base64 data URL (web login flow me
 * user ko dikhane ke liye). Detection: img with captcha-ish src/id/alt/name,
 * else the last <img> inside the form.
 */
async function captureCaptchaImage(page, frame) {
  const imgs = frame.locator('img');
  const n = await imgs.count();
  if (n === 0) throw new Error('No <img> found for the captcha on the login form.');

  let chosen = null;
  // Fast path: QUMS portal uses img#imgPhoto
  const fastImg = frame.locator('img#imgPhoto, img[src*="captcha" i], img[id*="captcha" i]');
  const fastCount = await fastImg.count().catch(() => 0);
  if (fastCount > 0) {
    chosen = fastImg.first();
  }

  if (!chosen) {
    for (let i = 0; i < n; i++) {
      const el = imgs.nth(i);
      const attrs = [
        await el.getAttribute('src'),
        await el.getAttribute('id'),
        await el.getAttribute('name'),
        await el.getAttribute('alt'),
        await el.getAttribute('class'),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (/captcha/.test(attrs)) {
        chosen = el;
        break;
      }
    }
  }

  if (!chosen) {
    // fallback: imgs with a real size (skip icons/spacers), pick the widest that looks text-ish
    let best = null;
    let bestW = 0;
    for (let i = 0; i < n; i++) {
      const el = imgs.nth(i);
      const box = await el.boundingBox().catch(() => null);
      if (box && box.width >= 80 && box.width <= 400 && box.height >= 25 && box.height <= 120) {
        if (box.width > bestW) {
          best = el;
          bestW = box.width;
        }
      }
    }
    chosen = best || imgs.nth(n - 1);
  }

  try {
    await chosen.waitFor({ state: 'visible', timeout: 10000 });
    // Ensure src attribute is populated with valid image data (not empty and not whitey placeholder)
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const src = await chosen.getAttribute('src').catch(() => '');
      if (src && !src.includes('whitey.jpg') && (src.startsWith('data:image/') || src.startsWith('http') || src.startsWith('/'))) {
        break;
      }
      await (page || frame).waitForTimeout(200);
    }
    await chosen.scrollIntoViewIfNeeded();
  } catch {}
  const buf = await chosen.screenshot({ type: 'png' });
  const rawBase64 = `data:image/png;base64,${buf.toString('base64')}`;

  // Pad the captcha image onto a clean canvas with generous margins so mobile Telegram
  // (especially Android) never clips the letters on the left or right edges.
  try {
    const pageOrFrame = page || frame;
    if (pageOrFrame && typeof pageOrFrame.evaluate === 'function') {
      const padded = await pageOrFrame.evaluate((srcUrl) => {
        return new Promise((resolve) => {
          const timeout = setTimeout(() => resolve(null), 1500);
          const img = new Image();
          img.onload = () => {
            clearTimeout(timeout);
            const w = img.naturalWidth || img.width || 180;
            const h = img.naturalHeight || img.height || 45;
            const scale = 2; // 2x sharp display
            const padX = 65; // safe horizontal margin so Android Telegram rounded bubbles never clip the edge letters
            const padY = 28; // safe vertical margin so Telegram bottom-right timestamp badge never covers the captcha text
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(w * scale + padX * 2);
            canvas.height = Math.round(h * scale + padY * 2);
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img, padX, padY, w * scale, h * scale);
            resolve(canvas.toDataURL('image/png'));
          };
          img.onerror = () => {
            clearTimeout(timeout);
            resolve(null);
          };
          img.src = srcUrl;
        });
      }, rawBase64).catch(() => null);

      if (padded && typeof padded === 'string' && padded.startsWith('data:image/png;base64,')) {
        return padded;
      }
    }
  } catch {}

  return rawBase64;
}

module.exports = {
  isLoginLikeUrl,
  findLoginForm,
  autofillCredentials,
  locateCaptchaInput,
  clickLoginButton,
  captureCaptchaImage,
};
