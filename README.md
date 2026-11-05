# ClassQU

**Smart University Attendance Monitor for Quantum University QUMS**

ClassQU connects a student's own QUMS account to a web dashboard and an
optional Telegram bot. It shows attendance and timetable data, calculates the
classes needed to reach 75%, tracks assignments, and alerts the student when
attendance is marked.


## What ClassQU does

- Native email/password authentication with bcrypt password hashing.
- Secure server-side sessions with session-ID regeneration at login.
- One-time password-reset links with one-hour expiry.
- QUMS attendance, timetable, assignment, and session-status monitoring.
- Exact attendance counts when QUMS provides them, with a safe estimate fallback.
- Dashboard guidance in **Hinglish** or **English**.
- Telegram deep-link connection for each user.
- Per-class Telegram alerts when a teacher marks attendance as present or absent.
- Backdated attendance alerts from the QUMS month register.
- Daily timetable notifications at 8:30 AM IST.
- Assignment notifications and deadline reminders.
- Five-minute auto-delete for temporary Telegram responses.
- PostgreSQL persistence for deployments and a JSON store for local development.
- Neubrutalist ClassQU dashboard styling.

## Requirements

- Node.js 18 or newer.
- Playwright's Chromium browser dependencies.
- PostgreSQL for production or another persistent deployment.
- A Telegram bot token for Telegram features.
- A Resend API key for production password-reset email delivery.

## Local setup on Windows PowerShell

```powershell
git clone https://github.com/SiddUrYrr/QU-Class.git
Set-Location .\qattend
npm install
npx playwright install chromium
Copy-Item .env.example .env
notepad .env
npm start
```

Open [http://localhost:3000](http://localhost:3000).

For local development, leaving `DATABASE_URL` empty uses the JSON store under
`data/`. For production, configure PostgreSQL and let the application run its
repeatable migrations on startup.

## First-time user setup

1. Register at `/register`.
2. Log in and open **QUMS Setup**.
3. Enter the QUMS student ID and password.
4. Complete the CAPTCHA in the browser flow.
5. Open **Telegram** from the dashboard.
6. Click **Connect Telegram**, then press **Start** in the bot chat.
7. Return to the dashboard and refresh attendance.

QUMS credentials are not stored as plaintext. The application stores protected
session/credential data according to the configured encryption and persistence
settings.

## Production environment

At minimum, configure these values:

```env
NODE_ENV=production
APP_BASE_URL=https://your-domain.example
DATABASE_URL=postgresql://user:password@host/database
SESSION_SECRET=use-a-long-random-secret
ENCRYPTION_KEY=64-hex-characters
```

Copy all available options from [.env.example](./.env.example). Never commit
`.env`, QUMS credentials, Telegram bot tokens, database URLs, Resend keys, or
encryption keys.

### PostgreSQL notes

- Use the complete connection string from your PostgreSQL provider.
- Supabase users can copy it from **Connect**.
- If the hostname returns `ENOTFOUND`, the hostname or connection string is
  stale/incorrect, or DNS is unavailable. It is not normally a password error.
- The application runs migrations automatically during startup.
- Set `IMPORT_JSON_DATA=1` only for an intentional one-time import from
  `data/db.json`.

### Resend and password resets

Resend is used only for password-reset email delivery:

```env
RESEND_API_KEY=re_your_key
RESEND_FROM=ClassQU <no-reply@your-verified-domain.example>
```

It is not used for login, registration, Telegram, attendance, or assignments.
Without a key, local development returns a development reset URL so the flow
can be tested. Production should use a verified sending domain and a valid
Resend key.

## Telegram monitoring

Configure the bot with BotFather:

```env
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_BOT_USERNAME=your_bot_username
```

The server must remain running for polling and notifications to work.

The fast attendance watcher:

- Checks during **08:30–17:00 IST**.
- Uses `WATCH_INTERVAL_MINUTES` between checks.
- Detects transitions such as `N.M.` to `P` or `A`.
- Sends alerts only to the user's linked Telegram chat.
- Seeds a baseline after QUMS setup so old marks do not create an alert storm.
- Deduplicates notifications per user, date, period, subject, and status.

The month-register watcher also detects marks entered later for an earlier
class date. Temporary command responses are scheduled for deletion after five
minutes. Permanent notifications are not automatically deleted unless their
specific policy says otherwise.

Only one process should poll Telegram updates. For additional workers:

```env
TELEGRAM_POLLING=off
```

## Scheduled jobs

| Job | Default |
|---|---|
| Morning timetable | 08:30 IST |
| Attendance watcher | `WATCH_INTERVAL_MINUTES` |
| Month-register watcher | `MONTH_REGISTER_INTERVAL_MINUTES` |
| Assignment check | Every 30 minutes |
| Assignment deadline reminder | 19:00 IST |

There is no nightly 9 PM attendance-summary job. Attendance summaries are
available on demand through the dashboard/Telegram flow.

## Useful routes

### Public

- `/` — ClassQU landing page
- `/register` — account registration
- `/login` — login
- `/forgot` — password reset request
- `/reset` — password reset
- `/telegram-guide` — Telegram setup guide
- `/qums-troubleshooting` — QUMS troubleshooting
- `/health` — deployment health check
- `POST /api/cron/morning` — AntiDeploy scheduled-job wake-up for the 8:30 AM IST timetable

### Authenticated

- `/dashboard` — attendance dashboard
- `/qums-setup` — QUMS connection and CAPTCHA flow
- `/telegram-setup` — Telegram connection status

### Main APIs

- `GET /api/me`
- `GET /api/attendance`
- `GET /api/today`
- `GET /api/timetable`
- `GET /api/telegram/status`
- `POST /api/telegram/unlink`

Admin endpoints require an authenticated administrator configured through
`ADMIN_EMAILS`.

## Commands

```powershell
npm start       # Start the web server and background jobs
npm test        # Run the complete regression suite
npm run scrape  # Run the scraper entry point
npm run cron    # Run the scheduler entry point
npm run telegram-test
```

### AntiDeploy scheduled jobs

AntiDeploy scales sleeping apps to zero, so the in-process `node-cron` timers
cannot wake the app. Add this scheduled job in the AntiDeploy dashboard:

- **Path:** `/api/cron/morning`
- **Method:** `POST`
- **Cron:** `0 3 * * *` (03:00 UTC = 08:30 IST)

AntiDeploy sends the required `x-antideploy-cron: 1` header automatically. The
route is safe to retry: it only sends the morning timetable inside the
08:30–11:00 IST catch-up window and deduplicates successful sends per user/day.

## Testing

The test suite covers:

- Native authentication and password reset helpers.
- QUMS parsing, attendance calculations, and exact-count guidance.
- Multi-user isolation and persistence.
- Telegram linking, delivery, deduplication, and auto-delete policies.
- Watcher recovery and session-expiry handling.
- Scheduler, assignment, and backdated attendance behavior.
- Admin routes, public guides, and dashboard UI invariants.

Run:

```powershell
npm test
```

## Project structure

```text
src/
  server.js       Express routes, authentication, APIs, boot
  auth.js         Authentication validation and reset-token helpers
  db.js           JSON/PostgreSQL persistence
  migrations.js   PostgreSQL schema migrations
  scraper.js      QUMS HTTP/browser scraping and parsing
  watcher.js      Live and backdated attendance monitoring
  scheduler.js    Timetable and scheduled notification jobs
  telegram.js     Telegram bot, deep links, delivery, deletion
  messages.js     Telegram message builders
  calculator.js   75% attendance calculations and guidance
  mailer.js       Resend password-reset delivery

public/
  index.html      Authenticated dashboard
  qums-setup.html QUMS connection flow
  telegram-setup.html
  login.html      Login page
  register.html   Registration page
  reset.html      Password reset page
  style.css       Shared ClassQU/neubrutalist UI
  logo.svg        ClassQU brand mark

test/
  *.test.js       Parser, auth, watcher, scheduler, UI, and regression tests
```

## Security and operations

- Use strong, unique `SESSION_SECRET` and `ENCRYPTION_KEY` values.
- Rotate credentials immediately if they are exposed in logs, screenshots, or
  chat.
- Use HTTPS in production.
- Keep QUMS and Telegram tokens out of source control.
- Configure a persistent database and persistent session/data storage.
- Keep the server process alive; stopping it stops polling and scheduled jobs.
- Review the admin health panel when diagnosing scheduler or watcher issues.

ClassQU is an independent utility and is not an official Quantum University
service.

** Inspire by https://github.com/karansin003/qattend **
