/**
 * Idempotent PostgreSQL migrations for ClassQU (Supabase).
 *
 * RULES (see project requirements):
 *   - PostgreSQL syntax only; SQL comments MUST be `--` (never `//`).
 *   - Every statement is executed INDIVIDUALLY (one pool.query per statement),
 *     each in its own implicit transaction. A single failing statement must
 *     never abort the remaining migrations — that exact failure mode is what
 *     previously left `users.student_name` missing and produced
 *     `column "student_name" of relation "users" does not exist`.
 *   - Every migration is safe to run many times (IF NOT EXISTS / guarded).
 *   - Applied migrations are recorded in `schema_migrations`.
 *   - No destructive statements run by default. Destructive ones (dropping the
 *     legacy qums_password_encrypted column) are opt-in via env flag.
 *
 * `student_name` IS A CACHE: the QUMS session/profile is the source of truth.
 */

/** Ordered, idempotent migration list. `id` must never change once shipped. */
const MIGRATIONS = [
  {
    id: '001_core_tables',
    statements: [
      `CREATE TABLE IF NOT EXISTS users (
         id TEXT PRIMARY KEY,
         email TEXT UNIQUE NOT NULL,
         password_hash TEXT NOT NULL,
         qums_qid TEXT DEFAULT '',
         qums_session_path TEXT DEFAULT '',
         telegram_link_code TEXT DEFAULT '',
         telegram_chat_id TEXT DEFAULT '',
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
      `CREATE TABLE IF NOT EXISTS resets (
         email TEXT PRIMARY KEY,
         token_hash TEXT NOT NULL,
         expires_at BIGINT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS known_attendance (
         user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
         records JSONB NOT NULL DEFAULT '[]'::jsonb
       )`,
      `CREATE TABLE IF NOT EXISTS weekly_schedule (
         user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         day_of_week INTEGER NOT NULL,
         period TEXT NOT NULL,
         duration TEXT DEFAULT '',
         subject TEXT DEFAULT '',
         subject_code TEXT DEFAULT '',
         teacher TEXT DEFAULT '',
         room TEXT DEFAULT '',
         last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         PRIMARY KEY (user_id, day_of_week, period)
       )`,
    ],
  },
  {
    id: '002_legacy_identity',
    statements: [
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS legacy_identity TEXT DEFAULT ''`,
    ],
  },
  {
    id: '003_student_name_cache',
    statements: [`ALTER TABLE users ADD COLUMN IF NOT EXISTS student_name TEXT DEFAULT ''`],
  },
  {
    id: '004_qums_year_sem',
    statements: [`ALTER TABLE users ADD COLUMN IF NOT EXISTS qums_year_sem TEXT DEFAULT ''`],
  },
  {
    id: '005_admin_flag',
    statements: [
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE`,
      `CREATE INDEX IF NOT EXISTS idx_users_is_admin ON users(is_admin)`,
    ],
  },
  {
    id: '006_sync_timestamps',
    statements: [
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS attendance_last_checked_at TIMESTAMPTZ`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS assignment_last_checked_at TIMESTAMPTZ`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_synced_at TIMESTAMPTZ`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_error TEXT DEFAULT ''`,
    ],
  },
  {
    id: '007_known_assignments',
    statements: [
      `CREATE TABLE IF NOT EXISTS known_assignments (
         user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
         records JSONB NOT NULL DEFAULT '[]'::jsonb
       )`,
    ],
  },
  {
    id: '008_session_expiry_state',
    statements: [
      `CREATE TABLE IF NOT EXISTS session_expiry_state (
         user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
         expired_at BIGINT,
         last_alert_at BIGINT,
         alert_count INTEGER NOT NULL DEFAULT 0,
         resolved_at BIGINT,
         note TEXT DEFAULT ''
       )`,
    ],
  },
  {
    id: '009_notifications',
    statements: [
      `CREATE TABLE IF NOT EXISTS notifications (
         id BIGSERIAL PRIMARY KEY,
         user_id TEXT NOT NULL,
         kind TEXT NOT NULL,
         subject TEXT DEFAULT '',
         class_date TEXT DEFAULT '',
         sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         meta JSONB NOT NULL DEFAULT '{}'::jsonb
       )`,
      `CREATE INDEX IF NOT EXISTS idx_notifications_user_time ON notifications(user_id, sent_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_notifications_kind_time ON notifications(kind, sent_at DESC)`,
    ],
  },
  {
    id: '010_lookup_indexes',
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
      `CREATE INDEX IF NOT EXISTS idx_users_telegram_chat ON users(telegram_chat_id)`,
      `CREATE INDEX IF NOT EXISTS idx_users_telegram_link_code ON users(telegram_link_code)`,
      `CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_weekly_user_day ON weekly_schedule(user_id, day_of_week)`,
    ],
  },
  {
    id: '011_structured_monitoring_and_identities',
    statements: [
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS qums_session_status TEXT DEFAULT 'active'`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS monitoring_started_at TIMESTAMPTZ`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_attendance_sync_at TIMESTAMPTZ`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_assignment_sync_at TIMESTAMPTZ`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      `CREATE TABLE IF NOT EXISTS qums_identities (
         id TEXT PRIMARY KEY,
         user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         qid TEXT NOT NULL,
         student_name TEXT DEFAULT '',
         year_sem TEXT DEFAULT '',
         monitoring_started_at TIMESTAMPTZ DEFAULT NOW(),
         is_active BOOLEAN NOT NULL DEFAULT TRUE,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         UNIQUE(user_id, qid)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_qums_identities_user ON qums_identities(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_qums_identities_qid ON qums_identities(qid)`,
      `CREATE TABLE IF NOT EXISTS attendance_records (
         id BIGSERIAL PRIMARY KEY,
         user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         qid TEXT NOT NULL,
         subject_code TEXT NOT NULL,
         subject_name TEXT DEFAULT '',
         class_date TEXT NOT NULL,
         status TEXT NOT NULL,
         first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         UNIQUE(user_id, qid, subject_code, class_date)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_att_records_user_date ON attendance_records(user_id, class_date)`,
      `CREATE INDEX IF NOT EXISTS idx_att_records_user_subj_date ON attendance_records(user_id, subject_code, class_date)`,
      `CREATE TABLE IF NOT EXISTS assignments (
         id BIGSERIAL PRIMARY KEY,
         user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         qid TEXT DEFAULT '',
         external_assignment_id TEXT NOT NULL,
         subject TEXT DEFAULT '',
         title TEXT DEFAULT '',
         last_date TEXT DEFAULT '',
         first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         UNIQUE(user_id, external_assignment_id)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_assignments_user_qid ON assignments(user_id, qid)`,
      `CREATE TABLE IF NOT EXISTS notification_log (
         id BIGSERIAL PRIMARY KEY,
         user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         type TEXT NOT NULL,
         reference_id TEXT DEFAULT '',
         dedupe_key TEXT NOT NULL,
         sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
         UNIQUE(user_id, dedupe_key)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_notification_log_user_type ON notification_log(user_id, type)`,
    ],
  },
  {
    id: '019_native_auth',
    statements: [
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT DEFAULT ''`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_version TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ`,
      `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
      `ALTER TABLE resets ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    ],
  },
  {
    id: '012_add_monitoring_started_date',
    statements: [
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS monitoring_started_date DATE`,
      `ALTER TABLE qums_identities ADD COLUMN IF NOT EXISTS monitoring_started_date DATE`,
      `UPDATE users
       SET monitoring_started_date = (monitoring_started_at AT TIME ZONE 'Asia/Kolkata')::date
       WHERE monitoring_started_date IS NULL AND monitoring_started_at IS NOT NULL`,
      `UPDATE qums_identities
       SET monitoring_started_date = (monitoring_started_at AT TIME ZONE 'Asia/Kolkata')::date
       WHERE monitoring_started_date IS NULL AND monitoring_started_at IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_users_monitoring_started_date ON users(monitoring_started_date)`,
    ],
  },
  {
    id: '013_ensure_qums_password_encrypted',
    statements: [
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS qums_password_encrypted TEXT DEFAULT ''`,
    ],
  },
  {
    id: '014_email_verified',
    statements: [
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE`,
      `CREATE INDEX IF NOT EXISTS idx_users_email_verified ON users(email_verified)`,
    ],
  },
  {
    id: '015_user_suspension',
    statements: [
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN NOT NULL DEFAULT FALSE`,
      `CREATE INDEX IF NOT EXISTS idx_users_is_suspended ON users(is_suspended)`,
    ],
  },
  {
    id: '016_session_expiry_telegram_message_id',
    statements: [
      `ALTER TABLE session_expiry_state ADD COLUMN IF NOT EXISTS telegram_message_id TEXT DEFAULT ''`,
    ],
  },
  {
    id: '017_qums_session_data',
    statements: [
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS qums_session_data TEXT DEFAULT ''`,
    ],
  },
  {
    id: '018_scheduled_message_deletions',
    statements: [
      `CREATE TABLE IF NOT EXISTS scheduled_message_deletions (
         id SERIAL PRIMARY KEY,
         chat_id TEXT NOT NULL,
         message_id BIGINT NOT NULL,
         delete_at BIGINT NOT NULL,
         created_at BIGINT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_sched_del_time ON scheduled_message_deletions (delete_at)`,
    ],
  },
  {
    id: '019_weekly_schedule_duration',
    statements: [
      `ALTER TABLE weekly_schedule ADD COLUMN IF NOT EXISTS duration TEXT DEFAULT ''`,
    ],
  },
];

/**
 * OPT-IN destructive migration: remove the legacy plaintext-adjacent QUMS
 * password column. ClassQU no longer reads or writes it (the user types the
 * password on every setup/reconnect), so it can be dropped once verified.
 * Enable with: DROP_QUMS_PASSWORD_COLUMN=1
 */
const OPTIONAL_MIGRATIONS = [
  {
    id: '900_drop_qums_password_column',
    enabled: () => String(process.env.DROP_QUMS_PASSWORD_COLUMN || '') === '1',
    statements: [
      `UPDATE users SET qums_password_encrypted = '' WHERE qums_password_encrypted IS NOT NULL AND qums_password_encrypted <> ''`,
      `ALTER TABLE users DROP COLUMN IF EXISTS qums_password_encrypted`,
    ],
  },
];

module.exports = { MIGRATIONS, OPTIONAL_MIGRATIONS };
