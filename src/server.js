
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const bcrypt = require('bcryptjs');
const { normalizeEmail, validEmail, validatePassword, createResetToken } = require('./auth');
const { sendMail, buildResetEmail } = require('./mailer');

const db = require('./db');
const { encryptSecret } = require('./crypto');
const { resolveUserRuntime } = require('./credentials');
const {
  scrapeAttendance,
  scrapeTodaysAttendance,
  scrapeTimetable,
  formatNormalizedTimetable,
  getTimetableForDate,
  combineTimetableWithLiveAttendance,
  mergeScheduleWithRoom,
  getStudentProfile,
  ensureStudentName,
} = require('./scraper');
const { analyzeAttendance } = require('./calculator');
const telegram = require('./telegram');
const { sendMessage } = require('./telegram');
const { startScheduler, runMorningScheduleJob, catchUpMorningSchedule, getMorningScheduleText, getSchedulerStatus } = require('./scheduler');
const { startWatcher, runBaselineForUser, getWatcherStatus } = require('./watcher');
const { getAssignmentStatus } = require('./assignments');
const { clearSessionAlert, maybeNotifySessionExpired } = require('./alerts');
const qumsLogin = require('./qums-login-web');
const { formatMorningSchedule, formatAttendanceMessage } = require('./messages');

const app = express();
const PORT = Number(process.env.PORT) || 10000; // Render PORT deta hai; local fallback 10000
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SESSION_DIR = path.join(__dirname, '..', 'data', 'app-sessions');
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me';
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('invalid-login-password', 10);
// Render automatically RENDER=true set karta hai — NODE_ENV bhool jao to bhi
// secure-cookie/prod behavior theek rahega.
const IS_PROD = process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER);

if (IS_PROD && !process.env.SESSION_SECRET) {
  console.error('[server] ⚠️ SESSION_SECRET missing in production — insecure dev fallback in use!');
  console.error('[server] ⚠️ Render Dashboard → Environment → SESSION_SECRET set karo (phir restart).');
}

/**
 * Public base URL — deployment-safe resolution order:
 *   1. APP_BASE_URL               (explicit; Render Dashboard → Environment me set)
 *   2. RENDER_EXTERNAL_URL        (Render khud inject karta hai — APP_BASE_URL
 *                                  set karna bhool jao to bhi reset link sahi banega)
 *   3. http://localhost:<PORT>    (LOCAL DEV ONLY — production me pehle dono
 *                                  available hote hain, isliye localhost kabhi
 *                                  production reset links me nahi jaayega)
 * Trailing "/" normalize hota hai -> `https://host//reset` jaisa bug kabhi nahi.
 */
function normalizeBaseUrl(u) {
  return String(u || '').trim().replace(/\/+$/, '');
}
const BASE_URL =
  normalizeBaseUrl(process.env.APP_BASE_URL) ||
  normalizeBaseUrl(process.env.RENDER_EXTERNAL_URL) ||
  `http://localhost:${PORT}`;

fs.mkdirSync(SESSION_DIR, { recursive: true }); // Render/first-run pe dir missing na ho

app.disable('x-powered-by');
app.set('trust proxy', 1); // Render ke reverse proxy ke peeche req.protocol/secure sahi rahe
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(
  session({
    store: new FileStore({
      path: SESSION_DIR,
      ttl: 90 * 24 * 60 * 60, // seconds — 90 din
      logFn: () => {}, // silence file-store noise
    }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 90 * 24 * 60 * 60 * 1000, // 90 din
      httpOnly: true, // JS se cookie accessible nahi (XSS safe-ish)
      sameSite: 'lax', // basic CSRF protection
      secure: IS_PROD, // production me HTTPS-only
    },
  })
);

// ---- helpers ----
async function currentUser(req) {
  if (!req.session || !req.session.userId) return null;
  return await db.getUserById(req.session.userId);
}

/** Pages -> redirect /login; APIs -> 401 JSON. /api/auth/* aur /health public rehte hain. */
async function requireAuth(req, res, next) {
  try {
    const user = await currentUser(req);
    if (user) {
      if (user.isSuspended) {
        if (req.session) {
          req.session.userId = null;
        }
        if (req.path.startsWith('/api/')) {
          return res.status(403).json({
            error: 'Your account has been suspended by the administrator.',
            code: 'ACCOUNT_SUSPENDED',
          });
        }
        return res.status(403).send('<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Account Suspended</title><link rel="stylesheet" href="/style.css"></head><body style="padding:40px;text-align:center;"><h1>Account Suspended</h1><p>Your account has been suspended by the administrator. Please contact support if you believe this is an error.</p><p style="margin-top:20px;"><a href="/login" class="btn" style="display:inline-block;padding:8px 16px;background:var(--primary,#1e3a8a);color:#fff;text-decoration:none;border-radius:6px;">Back to Login</a></p></body></html>');
      }
      req.appUser = user;
      return next();
    }
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Login required', code: 'AUTH_REQUIRED' });
    return res.redirect('/login');
  } catch (err) {
    console.error('[auth] lookup failed:', err.message);
    return res.status(500).json({ error: 'Authentication service temporarily unavailable.' });
  }
}

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

function isUserAdmin(user) {
  if (!user) return false;
  if (user.isAdmin) return true;
  if (user.email && ADMIN_EMAILS.includes(user.email.toLowerCase())) return true;
  return false;
}

async function requireAdmin(req, res, next) {
  try {
    const user = await currentUser(req);
    if (!user) {
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Login required', code: 'AUTH_REQUIRED' });
      return res.redirect('/login');
    }
    if (user.isSuspended) {
      if (req.session) {
        req.session.userId = null;
      }
      if (req.path.startsWith('/api/')) {
        return res.status(403).json({
          error: 'Your account has been suspended by the administrator.',
          code: 'ACCOUNT_SUSPENDED',
        });
      }
      return res.status(403).send('<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Account Suspended</title><link rel="stylesheet" href="/style.css"></head><body style="padding:40px;text-align:center;"><h1>Account Suspended</h1><p>Your account has been suspended by the administrator.</p></body></html>');
    }
    req.appUser = user;
    if (!isUserAdmin(user)) {
      if (req.path.startsWith('/api/')) {
        return res.status(403).json({ error: 'Admin access required', code: 'ADMIN_REQUIRED' });
      }
      return res.status(403).send('<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>403 Forbidden</title><link rel="stylesheet" href="/style.css"></head><body style="padding:40px;text-align:center;"><h1>403 Forbidden</h1><p>You do not have administrative privileges to access this area.</p><p style="margin-top:20px;"><a href="/dashboard" class="btn" style="display:inline-block;padding:8px 16px;background:var(--primary,#1e3a8a);color:#fff;text-decoration:none;border-radius:6px;">Return to Dashboard</a></p></body></html>');
    }
    return next();
  } catch (err) {
    console.error('[admin auth] lookup failed:', err.message);
    return res.status(500).json({ error: 'Authentication service temporarily unavailable.' });
  }
}

function httpStatusFor(err) {
  if (err.name === 'ConcurrentLoginError') return 429;
  if (err.name === 'QumsSetupRequired') return 403;
  if (err.name === 'SessionExpiredError' || err.name === 'NoSessionError') return 409;
  if (err.name === 'NoPendingLogin' || err.name === 'TelegramNotLinked') return 409;
  if (err.name === 'QumsCredsMissing' || err.name === 'QumsCredsRequired') return 400;
  if (err.name === 'ScrapeError') return 502;
  return 500;
}

// ---- minimal in-memory rate limiter (auth endpoints — brute-force/email-spam guard) ----
const RATE_WINDOW_MS = 15 * 60 * 1000; // 15 min window
const RATE_LIMITS = {
  '/api/login': 20,
  '/api/register': 10,
  '/api/forgot': 5,
  '/api/reset': 10,
  '/api/auth/verify-token': 30,
};
const rateHits = new Map(); // `${ip}:${route}` -> [hit timestamps]

function rateLimit(route) {
  const max = RATE_LIMITS[route];
  return (req, res, next) => {
    const key = `${req.ip || 'unknown'}:${route}`;
    const now = Date.now();
    const hits = (rateHits.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
    if (hits.length >= max) {
      return res.status(429).json({ error: 'Bahut zyada requests — thodi der baad try karo.' });
    }
    hits.push(now);
    rateHits.set(key, hits);
    if (rateHits.size > 5000) {
      // memory growth guard: purani entries delete
      for (const [k, v] of rateHits) {
        if (!v.some((t) => now - t < RATE_WINDOW_MS)) rateHits.delete(k);
      }
    }
    return next();
  };
}

/** 500s: prod me generic message (internals leak na ho), dev me detail. */
function safeServerError(res, err) {
  console.error('[server] route error:', err.name || 'Error', '-', err.message);
  const msg = IS_PROD ? 'Server error. Thodi der baad try karo.' : `${err.name || 'Error'}: ${err.message}`;
  res.status(500).json({ error: msg });
}

// ---- page routes ----
const sendPage = (name) => (req, res) => res.sendFile(path.join(PUBLIC_DIR, name));

/** Render the public Contact page with the ClassQU support details. */
function withContactEmail(html) {
  return html
    .replace(/__CONTACT_EMAIL__/g, 'siddh8786@gmail.com')
    .replace(/__CONTACT_EMAIL_NOTE__/g, 'Direct support & developer email for ClassQU assistance.');
}

/**
 * Home / Landing page (public).
 *
 * "/" used to redirect only: first run -> /register, signed out -> /login,
 * signed in -> /dashboard. A production site needs a real public landing page,
 * so "/" now serves home.html. Authenticated pages keep redirecting to /login
 * exactly as before, and the landing nav swaps its Login/Register buttons for
 * "Go to Dashboard" when a session already exists (existing /api/me).
 */
app.get('/', sendPage('home.html'));

app.get('/register', sendPage('register.html'));
app.get('/login', sendPage('login.html'));
app.get('/forgot', sendPage('forgot.html'));
app.get('/reset', sendPage('reset.html'));

// ---- public information pages (no auth required) ----
app.get('/features', sendPage('features.html'));
app.get('/how-it-works', sendPage('how-it-works.html'));
app.get('/about', sendPage('about.html'));
app.get('/faq', sendPage('faq.html'));
app.get('/privacy', sendPage('privacy.html'));
app.get('/terms', sendPage('terms.html'));
app.get('/contact', (req, res) => {
  res.send(withContactEmail(fs.readFileSync(path.join(PUBLIC_DIR, 'contact.html'), 'utf8')));
});

// ---- public guides (no auth required) ----
app.get('/attendance-calculator-guide', sendPage('attendance-calculator-guide.html'));
app.get('/guides/attendance-calculator', sendPage('attendance-calculator-guide.html'));
app.get('/qums-troubleshooting', sendPage('qums-troubleshooting.html'));
app.get('/guides/qums-troubleshooting', sendPage('qums-troubleshooting.html'));
app.get('/telegram-guide', sendPage('telegram-guide.html'));
app.get('/guides/telegram-guide', sendPage('telegram-guide.html'));
app.get('/security-and-privacy', sendPage('security-and-privacy.html'));
app.get('/guides/security-and-privacy', sendPage('security-and-privacy.html'));


function withQumsResetControl(html) {
  const script = `
<script>
(() => {
  function setupReset() {
    let btn = document.getElementById('permanentQumsResetBtn');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'permanentQumsResetBtn';
      btn.type = 'button';
      btn.textContent = 'Reset / Delete QUMS Connection';
      const resetTarget = document.getElementById('qumsResetSlot') || document.getElementById('setupCard') || document.querySelector('.card') || document.body;
      resetTarget.appendChild(btn);
    }
    btn.onclick = async () => {
      if (!confirm('Permanently reset the QUMS connection? The saved QID, password, and session will be deleted.')) return;
      btn.disabled = true; btn.textContent = 'Resetting...';
      try {
        const r = await fetch('/api/qums-reset', { method:'POST', headers:{'Content-Type':'application/json'} });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'Reset failed');
        window.location.href = j.redirect || '/qums-setup';
      } catch (e) { alert(e.message || 'QUMS reset failed'); btn.disabled = false; btn.textContent = 'Reset / Delete QUMS Connection'; }
    };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setupReset); else setupReset();
})();
</script>`;
  return html.includes('</body>') ? html.replace('</body>', script + '</body>') : html + script;
}

app.get('/dashboard', requireAuth, (req, res) => {
  const file = path.join(PUBLIC_DIR, 'index.html');
  res.send(withQumsResetControl(fs.readFileSync(file, 'utf8')));
});
app.get('/qums-setup', requireAuth, (req, res) => {
  const file = path.join(PUBLIC_DIR, 'qums-setup.html');
  res.send(withQumsResetControl(fs.readFileSync(file, 'utf8')));
});

// ---- Telegram setup page (same deep-link flow, same single bot/poller) ----
app.get('/telegram-setup', requireAuth, sendPage('telegram-setup.html'));

// ---- Admin dashboard page (protected by requireAdmin) ----
app.get('/admin', requireAdmin, sendPage('admin.html'));

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ---- auth APIs (public; rate-limited) ----
function regenerateSession(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = user.id;
      req.session.authVersion = user.authVersion || '';
      return resolve();
    });
  });
}

function authRedirect(user) {
  return user.qumsSessionPath ? '/dashboard' : '/qums-setup';
}

app.post('/api/register', rateLimit('/api/register'), async (req, res) => {
  try {
    const fullName = String(req.body?.fullName || req.body?.name || '').trim();
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    const confirmPassword = String(req.body?.confirmPassword || '');
    if (fullName.length < 2 || fullName.length > 120) return res.status(400).json({ error: 'Please enter your full name.' });
    if (!validEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
    const passwordError = validatePassword(password);
    if (passwordError) return res.status(400).json({ error: passwordError });
    if (password !== confirmPassword) return res.status(400).json({ error: 'Passwords do not match.' });
    if (await db.getUserByEmail(email)) return res.status(409).json({ error: 'This email is already registered. Please login.' });
    const user = await db.createUser({ email, fullName, passwordHash: await bcrypt.hash(password, 12) });
    await regenerateSession(req, user);
    return res.json({ ok: true, redirect: authRedirect(user) });
  } catch (err) { return safeServerError(res, err); }
});

app.post('/api/login', rateLimit('/api/login'), async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    const user = await db.getUserByEmail(email);
    const hash = user?.passwordHash || DUMMY_PASSWORD_HASH;
    const passwordOk = await bcrypt.compare(password, hash);
    if (!user || !passwordOk) return res.status(401).json({ error: 'Wrong email or password.' });
    if (user.isSuspended) return res.status(403).json({ error: 'Your account has been suspended by the administrator.', code: 'ACCOUNT_SUSPENDED' });
    await regenerateSession(req, user);
    return res.json({ ok: true, redirect: authRedirect(user) });
  } catch (err) { return safeServerError(res, err); }
});

app.post('/api/forgot', rateLimit('/api/forgot'), async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!validEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
    const user = await db.getUserByEmail(email);
    const response = { ok: true, message: 'If an account exists for that email, a reset link has been sent.' };
    if (!user) return res.json(response);
    const token = createResetToken();
    await db.storeResetToken(email, token);
    const link = BASE_URL + '/reset?token=' + encodeURIComponent(token);
    const emailContent = buildResetEmail(link);
    const delivery = await sendMail({ to: email, ...emailContent });
    if (!delivery.ok && IS_PROD) console.error('[auth] password reset delivery unavailable');
    if (!delivery.ok && !IS_PROD) response.developmentResetUrl = link;
    return res.json(response);
  } catch (err) { return safeServerError(res, err); }
});

app.get('/api/reset/validate', rateLimit('/api/reset'), async (req, res) => {
  const token = String(req.query?.token || '');
  if (!token) return res.status(400).json({ valid: false });
  const user = await db.peekResetToken(token);
  return res.json({ valid: Boolean(user) });
});

app.post('/api/reset', rateLimit('/api/reset'), async (req, res) => {
  try {
    const token = String(req.body?.token || '');
    const password = String(req.body?.password || '');
    const confirmPassword = String(req.body?.confirmPassword || '');
    const passwordError = validatePassword(password);
    if (!token || passwordError) return res.status(400).json({ error: passwordError || 'Reset token is required.' });
    if (password !== confirmPassword) return res.status(400).json({ error: 'Passwords do not match.' });
    const user = await db.consumeResetToken(token);
    if (!user) return res.status(400).json({ error: 'Reset link is invalid or expired.' });
    const updated = await db.updateUser(user.id, { passwordHash: await bcrypt.hash(password, 12), authVersion: require('crypto').randomBytes(16).toString('hex') });
    return res.json({ ok: true, redirect: '/login', invalidatedSessions: Boolean(updated) });
  } catch (err) { return safeServerError(res, err); }
});

// In-memory data caches for fast dashboard loading
const attendanceCache = new Map(); // userId -> { data, timestamp }
const ATTENDANCE_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

const todayCache = new Map(); // userId -> { data, timestamp }
const TODAY_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

const timetableCache = new Map(); // userId -> { data, timestamp }
const TIMETABLE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function invalidateUserDataCaches(userId) {
  if (userId) {
    attendanceCache.delete(userId);
    todayCache.delete(userId);
    timetableCache.delete(userId);
  }
}

// ---- protected data APIs (per-user) ----
app.get('/api/me', requireAuth, async (req, res) => {
  let user = await db.getUserById(req.session.userId);
  if (user && !user.studentName && user.qumsSessionPath && fs.existsSync(user.qumsSessionPath)) {
    // Refresh student name asynchronously in background — DO NOT block response
    setImmediate(() => {
      ensureStudentName(user.id).catch(() => {});
    });
  }

  await db.ensureSessionOnDisk(user).catch(() => {});

  const hasSession = Boolean(
    (user.qumsSessionPath && (fs.existsSync(user.qumsSessionPath) || user.qumsSessionData)) ||
    user.qumsSessionData
  );

  const expiry = await db.getSessionExpiryState(user.id).catch(() => null);
  const isExpired = Boolean(
    user.qumsSessionStatus === 'expired' ||
    (expiry && expiry.expiredAt && !expiry.resolvedAt)
  );

  const qumsSessionStatus = isExpired
    ? 'expired'
    : (hasSession ? (user.qumsSessionStatus === 'expired' ? 'active' : (user.qumsSessionStatus || 'active')) : 'not_setup');

  const hasSavedCreds = Boolean(user && user.qumsQid && (user.qumsPasswordEncrypted || (await db.getQumsEncryptedPassword(user.id))));
  res.json({
    email: user.email,
    studentName: user.studentName || '',
    qumsYearSem: user.qumsYearSem || '',
    qumsQid: user.qumsQid || '',
    qumsConfigured: hasSession,
    qumsSessionStatus,
    qumsCredentialsSaved: hasSavedCreds,
    telegramConnected: Boolean(user.telegramChatId),
    telegramConfigured: telegram.isConfigured(),
    isAdmin: isUserAdmin(user),
  });
});

app.get('/api/attendance', requireAuth, async (req, res) => {
  try {
    const runtime = resolveUserRuntime(req.appUser);
    const overrideTotal = Number(req.query.total);
    const forceFresh = req.query.fresh === '1' || req.query.refresh === '1' || req.query.force === '1';
    const userId = req.appUser.id;

    const cached = attendanceCache.get(userId);
    if (!forceFresh && !overrideTotal && cached && (Date.now() - cached.timestamp < ATTENDANCE_CACHE_TTL_MS)) {
      return res.json({ ...cached.data, _cached: true, _cachedAt: new Date(cached.timestamp).toISOString() });
    }

    const fetchStart = Date.now();
    const subjects = await scrapeAttendance({
      sessionPath: runtime.sessionPath,
      yearSem: req.appUser.qumsYearSem,
      studentName: req.appUser.studentName,
    });
    // Successful authenticated scrape clears any stale expiry state
    await db.clearSessionExpiry(userId, { maxExpiredAt: fetchStart }).catch(() => {});
    const analysis = analyzeAttendance(
      subjects,
      Number.isFinite(overrideTotal) && overrideTotal > 0 ? overrideTotal : undefined
    );
    if (!overrideTotal) {
      attendanceCache.set(userId, { data: analysis, timestamp: Date.now() });
    }
    res.json(analysis);
  } catch (err) {
    if (err.name === 'SessionExpiredError') {
      await db.updateUser(req.appUser.id, { qumsSessionStatus: 'expired' }).catch(() => {});
      await maybeNotifySessionExpired(console, req.appUser.id, { evidence: true }).catch(() => {});
    }
    res.status(httpStatusFor(err)).json({ error: err.message, hint: err.hint || null, code: err.name });
  }
});

app.get('/api/today', requireAuth, async (req, res) => {
  // Debug aid: shows exactly what the watcher polls for THIS user.
  try {
    const runtime = resolveUserRuntime(req.appUser);
    const forceFresh = req.query.fresh === '1' || req.query.refresh === '1' || req.query.force === '1';
    const userId = req.appUser.id;

    const cached = todayCache.get(userId);
    if (!forceFresh && cached && (Date.now() - cached.timestamp < TODAY_CACHE_TTL_MS)) {
      return res.json({ ...cached.data, _cached: true });
    }

    const fetchStart = Date.now();
    let periods = await scrapeTodaysAttendance({ sessionPath: runtime.sessionPath });
    // Successful authenticated scrape clears any stale expiry state
    await db.clearSessionExpiry(userId, { maxExpiredAt: fetchStart }).catch(() => {});

    // Room and teacher enrichment from timetable when available
    try {
      let timetable = null;
      const cachedTt = timetableCache.get(userId);
      if (cachedTt && cachedTt.data && cachedTt.data.timetable) {
        timetable = cachedTt.data.timetable;
      }
      if (!timetable) {
        timetable = await scrapeTimetable({ sessionPath: runtime.sessionPath }).catch(() => null);
      }
      if (timetable) {
        const todayPeriods = getTimetableForDate(timetable, new Date());
        periods = mergeScheduleWithRoom(periods, todayPeriods);
      }
    } catch {
      // Silently keep periods without room/teacher enrichment
    }

    const payload = { date: new Date().toISOString(), periods };
    todayCache.set(userId, { data: payload, timestamp: Date.now() });
    res.json(payload);
  } catch (err) {
    if (err.name === 'SessionExpiredError') {
      await db.updateUser(req.appUser.id, { qumsSessionStatus: 'expired' }).catch(() => {});
      await maybeNotifySessionExpired(console, req.appUser.id, { evidence: true }).catch(() => {});
    }
    res.status(httpStatusFor(err)).json({ error: err.message, hint: err.hint || null, code: err.name });
  }
});

app.get('/api/timetable', requireAuth, async (req, res) => {
  try {
    const runtime = resolveUserRuntime(req.appUser);
    const forceFresh = req.query.fresh === '1' || req.query.refresh === '1' || req.query.force === '1';
    const userId = req.appUser.id;

    const cached = timetableCache.get(userId);
    if (!forceFresh && cached && (Date.now() - cached.timestamp < TIMETABLE_CACHE_TTL_MS)) {
      return res.json({ ...cached.data, _cached: true });
    }

    const fetchStart = Date.now();
    const rawTimetable = await scrapeTimetable({ sessionPath: runtime.sessionPath });
    await db.clearSessionExpiry(userId, { maxExpiredAt: fetchStart }).catch(() => {});

    const formatted = formatNormalizedTimetable(rawTimetable);
    const hasData = Boolean(formatted && formatted.days && formatted.days.some((d) => d.periods && d.periods.length > 0));

    const payload = {
      success: true,
      updatedAt: new Date().toISOString(),
      hasData,
      timetable: formatted,
    };
    timetableCache.set(userId, { data: payload, timestamp: Date.now() });
    res.json(payload);
  } catch (err) {
    if (err.name === 'SessionExpiredError') {
      await db.updateUser(req.appUser.id, { qumsSessionStatus: 'expired' }).catch(() => {});
      await maybeNotifySessionExpired(console, req.appUser.id, { evidence: true }).catch(() => {});
    }
    const cached = timetableCache.get(req.appUser.id);
    if (cached) {
      return res.status(200).json({
        ...cached.data,
        _cached: true,
        _stale: true,
        warning: 'QUMS timetable currently unreachable, showing cached timetable.',
      });
    }
    res.status(httpStatusFor(err)).json({ error: err.message, hint: err.hint || null, code: err.name });
  }
});

/** Accurate Telegram-blocker error (token missing vs not-linked confuse na ho). */
async function telegramSendBlockError(userId) {
  const reason = await telegram.sendBlockerReason(userId);
  if (reason === 'not-configured') {
    return Object.assign(new Error('Telegram token set nahi hai (.env: TELEGRAM_BOT_TOKEN) — BotFather ka token daal ke server restart karo.'), { name: 'TelegramNotConfigured' });
  }
  if (reason === 'bot-not-initialized') {
    return Object.assign(new Error('Telegram polling start nahi hua — server restart karo (token .env me hone ke baad).'), { name: 'TelegramNotConfigured' });
  }
  return Object.assign(new Error('Telegram is not linked — connect it from the dashboard first.'), { name: 'TelegramNotLinked' });
}

app.all('/api/trigger-telegram', requireAuth, async (req, res) => {
  try {
    const runtime = resolveUserRuntime(req.appUser);
    const subjects = await scrapeAttendance({ sessionPath: runtime.sessionPath });
    const analysis = analyzeAttendance(subjects);
    const preview = formatAttendanceMessage(analysis);
    const sent = await sendMessage(req.appUser.id, preview);
    if (!sent) throw await telegramSendBlockError(req.appUser.id);
    res.json({ success: true, sentTo: req.appUser.email, preview });
  } catch (err) {
    if (err.name === 'SessionExpiredError') {
      await db.updateUser(req.appUser.id, { qumsSessionStatus: 'expired' }).catch(() => {});
      await maybeNotifySessionExpired(console, req.appUser.id, { evidence: true }).catch(() => {});
    }
    res.status(httpStatusFor(err)).json({ error: err.message, hint: err.hint || null, code: err.name });
  }
});

// ---- QUMS web login (HEADLESS captcha relay) ----
app.post('/api/qums-login/start', requireAuth, async (req, res) => {
  try {
    const { qid, password, confirmSwitch } = req.body || {};
    const finalQid = String(qid || req.appUser.qumsQid || '').trim();
    const finalPassword = password != null && String(password).trim() !== '' ? String(password) : undefined;

    const result = await qumsLogin.startQumsLogin(
      req.session.userId,
      { qid: finalQid, password: finalPassword, confirmSwitch: Boolean(confirmSwitch) }
    );
    res.json(result); // { ok: true, captchaImage }
  } catch (err) {
    if (err.name === 'IdentityConflictError' || err.code === 'IdentityConflict') {
      return res.status(409).json({
        ok: false,
        identityConflict: true,
        oldQid: err.oldQid,
        newQid: err.newQid,
        error: err.message,
      });
    }
    res.status(httpStatusFor(err)).json({ error: err.message, hint: err.hint || null, code: err.name });
  }
});

app.post('/api/qums-login/submit-captcha', requireAuth, async (req, res) => {
  try {
    const { captchaText, captcha } = req.body || {};
    const text = String(captchaText || captcha || '').trim().toUpperCase();
    const result = await qumsLogin.submitQumsCaptcha(req.session.userId, text);
    if (result && result.ok) {
      invalidateUserDataCaches(req.session.userId);
      // Seed baseline marked periods for today
      runBaselineForUser(req.session.userId).catch((e) =>
        console.error('[qums-setup] baseline fetch fail:', e.message)
      );
    }
    res.json(result); // { ok: true, sessionPath, studentName, yearSem } or { ok: false, error, captchaImage }
  } catch (err) {
    res.status(httpStatusFor(err)).json({ error: err.message, hint: err.hint || null, code: err.name });
  }
});

// ---- QUMS reset (permanent reset for req.session.userId only) ----
app.post('/api/qums-reset', requireAuth, async (req, res) => {
  try {
    invalidateUserDataCaches(req.session.userId);
    const user = await db.getUserById(req.session.userId);
    const sp = (user && user.qumsSessionPath) || db.sessionPathFor(req.session.userId);
    if (sp && fs.existsSync(sp)) {
      try { fs.unlinkSync(sp); } catch {}
    }
    await db.updateUser(req.session.userId, {
      qumsQid: '',
      qumsPasswordEncrypted: '',
      qumsSessionPath: '',
      studentName: '',
      qumsYearSem: '',
      qumsSessionStatus: 'disconnected',
    });
    if (db.USE_PG && db.pool) {
      await db.pool.query('UPDATE qums_identities SET is_active=FALSE, updated_at=NOW() WHERE user_id=$1', [req.session.userId]).catch(() => {});
    }
    await clearSessionAlert(req.session.userId);
    res.json({
      ok: true,
      redirect: '/qums-setup',
      message: 'QUMS connection permanently reset. Enter your QID and password again.',
    });
  } catch (err) {
    safeServerError(res, err);
  }
});

// ---- QUMS logout (deletes session file for req.session.userId only; retains QID for reconnect) ----
app.post('/api/qums-logout', requireAuth, async (req, res) => {
  try {
    invalidateUserDataCaches(req.session.userId);
    const user = await db.getUserById(req.session.userId);
    const sp = (user && user.qumsSessionPath) || db.sessionPathFor(req.session.userId);
    if (sp && fs.existsSync(sp)) {
      try { fs.unlinkSync(sp); } catch {}
    }
    await db.updateUser(req.session.userId, { qumsSessionPath: '' });
    res.json({
      ok: true,
      message: 'QUMS logout complete. To reconnect, open QUMS Setup and use "Reconnect QUMS" with the CAPTCHA.',
    });
  } catch (err) {
    safeServerError(res, err);
  }
});


// ---- Telegram linking (deep-link flow — koi QR nahi) ----
app.get('/api/telegram/status', requireAuth, async (req, res) => {
  const user = await db.getUserById(req.appUser.id);
  const code = await db.telegramLinkCodeFor(req.appUser.id);

  res.json({
    configured: telegram.isConfigured(),
    connected: Boolean(user?.telegramChatId),
    botUsername: telegram.getBotUsername(),
    linkUrl: telegram.deepLink(code),
  });
});

app.post('/api/telegram/unlink', requireAuth, async (req, res) => {
  await db.clearTelegramChatId(req.appUser.id);
  res.json({ ok: true, message: 'Telegram disconnected. Dobara connect karne ke liye "Connect Telegram" dabao.' });
});

// ---- Admin APIs (protected by requireAdmin; returns non-sensitive metadata only) ----
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const search = String(req.query.search || '');
    const filter = String(req.query.filter || 'all');
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 25;
    const data = await db.listUsersForAdmin({ search, filter, page, limit });
    res.json(data);
  } catch (err) {
    safeServerError(res, err);
  }
});

app.get('/api/admin/health', requireAdmin, async (req, res) => {
  try {
    const stats = await db.adminStats();
    const dbPing = await db.ping();
    const notifs = await db.notificationStats(30);
    const watcherStatus = typeof getWatcherStatus === 'function' ? getWatcherStatus() : {};
    const assignmentStatus = typeof getAssignmentStatus === 'function' ? getAssignmentStatus() : {};
    const schedulerStatus = typeof getSchedulerStatus === 'function' ? getSchedulerStatus() : {};
    const telegramInfo = {
      configured: telegram.isConfigured(),
      ready: telegram.isReady(),
      username: telegram.getBotUsername(),
    };
    res.json({
      ok: true,
      database: {
        mode: stats.dbMode,
        ping: dbPing,
        ...stats.database,
      },
      telegram: telegramInfo,
      scheduler: schedulerStatus,
      watcher: watcherStatus,
      assignments: assignmentStatus,
      stats: {
        totalUsers: stats.totalUsers,
        newUsers24h: stats.newUsers24h,
        newUsers7d: stats.newUsers7d,
        qumsConnected: stats.qumsConnected,
        sessionExpired: stats.sessionExpired,
        telegramConnected: stats.telegramConnected,
        suspended: stats.suspended,
        notificationsSent: notifs,
      },
      serverTime: new Date().toISOString(),
    });
  } catch (err) {
    safeServerError(res, err);
  }
});

app.post('/api/admin/users/:id/suspend', requireAdmin, async (req, res) => {
  try {
    const targetId = req.params.id;
    const target = await db.getUserById(targetId);
    if (!target) {
      return res.status(404).json({ error: 'User not found.' });
    }
    if (req.appUser && req.appUser.id === target.id) {
      return res.status(400).json({ error: 'Cannot suspend your own admin account.' });
    }
    const isSuspended = req.body && typeof req.body.suspended === 'boolean'
      ? req.body.suspended
      : !target.isSuspended;
    await db.setUserSuspended(target.id, isSuspended);
    console.log(`[admin] user ${target.email} (${target.id}) suspended: ${isSuspended} by ${req.appUser ? req.appUser.email : 'admin'}`);
    res.json({
      ok: true,
      id: target.id,
      isSuspended,
      message: isSuspended ? 'User has been suspended.' : 'User suspension lifted.',
    });
  } catch (err) {
    safeServerError(res, err);
  }
});

async function handleAdminDeleteUser(req, res) {
  try {
    const targetId = req.params.id;
    const target = await db.getUserById(targetId);
    if (!target) {
      return res.status(404).json({ error: 'User not found.' });
    }
    if (req.appUser && req.appUser.id === target.id) {
      return res.status(400).json({ error: 'Cannot delete your own admin account.' });
    }
    const sessionPath = target.qumsSessionPath || db.sessionPathFor(target.id);
    if (sessionPath) {
      try {
        if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
      } catch (e) {
        console.warn(`[admin] failed to unlink session file for ${target.id}:`, e.message);
      }
    }
    await db.deleteUser(target.id);
    console.log(`[admin] user ${target.email} (${target.id}) deleted by ${req.appUser ? req.appUser.email : 'admin'}`);
    res.json({
      ok: true,
      id: target.id,
      message: `User ${target.email} deleted successfully.`,
    });
  } catch (err) {
    safeServerError(res, err);
  }
}

app.post('/api/admin/users/:id/delete', requireAdmin, handleAdminDeleteUser);
app.delete('/api/admin/users/:id', requireAdmin, handleAdminDeleteUser);

app.post('/api/admin/users/bulk-reconnect-notify', requireAdmin, async (req, res) => {
  try {
    const rawIds = req.body && Array.isArray(req.body.userIds) ? req.body.userIds : [];
    if (!rawIds.length) {
      return res.status(400).json({ error: 'No user IDs provided for notification.' });
    }
    if (rawIds.length > 100) {
      return res.status(400).json({ error: 'Exceeded maximum batch limit of 100 recipients per request.' });
    }

    const uniqueIds = Array.from(new Set(rawIds.map((id) => String(id || '').trim()).filter(Boolean)));
    const adminEmail = req.appUser ? req.appUser.email : 'admin';
    console.log(`[admin] bulk reconnect notification triggered by ${adminEmail} for ${uniqueIds.length} user(s).`);

    const sent = [];
    const skipped = [];
    const failed = [];

    for (const targetId of uniqueIds) {
      const user = await db.getUserById(targetId);
      if (!user) {
        skipped.push({ id: targetId, email: '', reason: 'User not found' });
        continue;
      }
      if (!user.telegramChatId) {
        skipped.push({ id: user.id, email: user.email, reason: 'Telegram account not linked' });
        continue;
      }

      try {
        // Send existing secure QUMS session expiry alert & reconnect flow
        const didNotify = await maybeNotifySessionExpired(console, user.id, { evidence: true, isManualAdminAlert: true });
        if (didNotify) {
          sent.push({ id: user.id, email: user.email });
        } else {
          // If in cooldown or already sent for this event, attempt direct reconnect instruction message
          const savedEncrypted = user.qumsPasswordEncrypted || (await db.getQumsEncryptedPassword(user.id));
          const canTelegramReconnect = Boolean(user.telegramChatId && user.qumsQid && savedEncrypted);
          const replyMarkup = typeof telegram.reconnectKeyboard === 'function' ? telegram.reconnectKeyboard(canTelegramReconnect) : null;
          const msgSent = await sendMessage(
            user.id,
            '⚠️ <b>QUMS Reconnect Notice (Admin Alert)</b>\n\nYour QUMS portal session requires updating. Send /reconnect or use the action below to restore live monitoring.',
            console,
            { category: 'ALERT', autoDelete: false, replyMarkup }
          );
          if (msgSent) {
            sent.push({ id: user.id, email: user.email });
          } else {
            failed.push({ id: user.id, email: user.email, reason: 'Telegram delivery rejected' });
          }
        }
      } catch (sendErr) {
        console.error(`[admin] reconnect dispatch failed for user ${user.id}:`, sendErr.message);
        failed.push({ id: user.id, email: user.email, reason: sendErr.message });
      }

      // Safe rate-limiting pace: 100ms delay between consecutive Telegram sends
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    console.log(`[admin] bulk reconnect dispatch finished: sent=${sent.length}, skipped=${skipped.length}, failed=${failed.length}`);
    res.json({
      ok: true,
      sent,
      skipped,
      failed,
      totalRequested: uniqueIds.length,
    });
  } catch (err) {
    safeServerError(res, err);
  }
});

// ---- misc ----
// Health check — simple, secret-free: user counts / telegram state / internals
// PUBLIC endpoint pe leak nahi karte. Render Health Check Path isi ko point karo.
app.get('/health', (req, res) => {
  res.json({ ok: true, status: 'ok', uptimeSeconds: Math.round(process.uptime()), timestamp: new Date().toISOString() });
});

// AntiDeploy wakes sleeping apps by calling a route instead of keeping an
// in-process cron alive. The scheduler's catch-up window and daily dedupe
// make retries safe.
app.post('/api/cron/morning', async (req, res) => {
  if (req.get('x-antideploy-cron') !== '1') {
    return res.status(403).json({ error: 'Scheduled-job requests only.' });
  }
  try {
    const result = await catchUpMorningSchedule(console);
    return res.json({ ok: true, job: 'morning-schedule', ...result });
  } catch (err) {
    console.error('[cron] morning schedule failed:', err.message);
    return res.status(500).json({ ok: false, error: 'Morning schedule failed.' });
  }
});

app.use(express.static(PUBLIC_DIR, {
  maxAge: IS_PROD ? '1d' : 0,
  etag: true,
}));

// ---- API fallbacks: kabhi bhi HTML API clients tak na jaaye ----
app.use('/api', (req, res) => {
  res.status(404).json({ error: `Unknown API route: ${req.method} ${req.originalUrl}` });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[server] unhandled error:', err.name || 'Error', '-', err.message);
  if (!IS_PROD && err.stack) console.error(err.stack); // stack sirf dev logs me
  if (req.path.startsWith('/api/')) {
    return res.status(500).json({ error: IS_PROD ? 'Server error. Thodi der baad try karo.' : 'Server error: ' + err.message });
  }
  res.status(500).send('Server error');
});

// ---- process-level resilience: scheduler/watcher zinda rahen, chhote errors pe crash nahi ----
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection:', reason && reason.message ? `${reason.name || 'Error'}: ${reason.message}` : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[server] uncaughtException:', err.name || 'Error', '-', err.message);
});

// ---- boot ----
if (require.main === module) {
  (async () => {
    try {
      await db.init();
      startScheduler();
      startWatcher();
      telegram.initTelegram();
      // 8:30 IST par server band tha / late start hua -> aaj ka timetable ek baar
      // catch-up bhej do (per-day marker same-day duplicate rokta hai).
      catchUpMorningSchedule().catch((e) => console.error('[server] morning catch-up failed:', e.message));

      app.listen(PORT,() => {
    console.log(`[server] ClassQU (multi-user) running at ${BASE_URL}`);
    console.log(`[server] (listening on 0.0.0.0:${PORT}${IS_PROD ? ', production mode' : ', development mode'})`);
    console.log('[server] Pages: / (home) /features /how-it-works /about /faq /contact /privacy /terms | /register /login /dashboard /qums-setup /telegram-setup /forgot /reset');
    console.log('[server] APIs: /api/attendance | /api/today | /api/trigger-telegram | /health');
    console.log('[server] Scheduler: 8:30 AM IST (today\'s classes) — saare users, missed-run recovery + boot catch-up (daily 9 PM summary removed)');
    console.log('[server] Watcher: per-class alerts, college hours 08:30-17:00 IST + backdated month-register loop');
    console.log('[server] Assignments: new-assignment check (30 min) + deadline reminder 7:00 PM IST');
    if (!telegram.isConfigured()) {
      console.log('[server] Telegram: DISABLED — TELEGRAM_BOT_TOKEN set karo (Render env ya .env) aur restart; bina iske server theek chalega.');
    }
      });
    } catch (err) {
      console.error('[server] database boot failed:', err);
      process.exit(1);
    }
  })();
}

module.exports = app;
