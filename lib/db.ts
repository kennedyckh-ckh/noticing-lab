import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type DB = Database.Database;

const g = globalThis as unknown as { __pdDb?: DB; __pdDbPath?: string };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('participant','facilitator')),
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- One PD session = one video-based PD event with its own groups, questions and settings.
CREATE TABLE IF NOT EXISTS pd_sessions (
  id TEXT PRIMARY KEY,
  facilitator_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  video_title TEXT NOT NULL DEFAULT '',
  video_url TEXT NOT NULL DEFAULT '',
  join_code TEXT NOT NULL UNIQUE,
  sharing_enabled INTEGER NOT NULL DEFAULT 1,
  salient_criteria TEXT NOT NULL DEFAULT '',
  part2_unlocked_at TEXT,
  part2_unlocked_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_members (
  session_id TEXT NOT NULL REFERENCES pd_sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (session_id, user_id)
);

CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES pd_sessions(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (session_id, code)
);

-- Facilitator-defined allow-list: who may pick which group.
CREATE TABLE IF NOT EXISTS group_authorisations (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

-- The participant's actual choice: one group per participant per session.
CREATE TABLE IF NOT EXISTS group_members (
  session_id TEXT NOT NULL REFERENCES pd_sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  selected_at TEXT NOT NULL,
  PRIMARY KEY (session_id, user_id)
);

CREATE TABLE IF NOT EXISTS guiding_questions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES pd_sessions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- One row per noticing entry. Part 1 and Part 2 entries are different rows (part column),
-- so Part 2 can never overwrite Part 1.
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES pd_sessions(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  part INTEGER NOT NULL CHECK (part IN (1,2)),
  seq INTEGER NOT NULL,
  public_id TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES users(id),
  observation TEXT NOT NULL DEFAULT '',
  timestamp_sec INTEGER,
  evidence TEXT NOT NULL DEFAULT '',
  interpretation TEXT NOT NULL DEFAULT '',
  question TEXT NOT NULL DEFAULT '',
  guiding_question_id TEXT REFERENCES guiding_questions(id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (group_id, part, seq)
);
CREATE INDEX IF NOT EXISTS idx_entries_group ON entries(group_id, part);

-- Collective, immutable submission record per group and part (snapshot of what was submitted).
CREATE TABLE IF NOT EXISTS group_submissions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES pd_sessions(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  part INTEGER NOT NULL CHECK (part IN (1,2)),
  submitted_by TEXT NOT NULL REFERENCES users(id),
  submitted_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  UNIQUE (group_id, part)
);

CREATE TABLE IF NOT EXISTS entry_shares (
  entry_id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES pd_sessions(id) ON DELETE CASCADE,
  shared_by TEXT NOT NULL REFERENCES users(id),
  shared_at TEXT NOT NULL,
  show_author INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS session_overrides (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES pd_sessions(id) ON DELETE CASCADE,
  part INTEGER NOT NULL CHECK (part IN (1,2)),
  reason TEXT NOT NULL,
  missing_group_ids_json TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_outputs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES pd_sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('group_summary','cross_group','salient_points')),
  group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
  part TEXT NOT NULL CHECK (part IN ('1','2','both')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  simulated INTEGER NOT NULL DEFAULT 0,
  criteria TEXT NOT NULL DEFAULT '',
  generated_json TEXT NOT NULL,
  edited_json TEXT,
  source_entry_ids_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  override_id TEXT,
  reviewed_at TEXT,
  reviewed_by TEXT,
  published_json TEXT,
  published_at TEXT,
  published_by TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_session ON ai_outputs(session_id, kind);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  actor_id TEXT,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
`;

export function getDb(): DB {
  const p = process.env.PD_DB_PATH || path.join(process.cwd(), "data", "pd.sqlite");
  if (g.__pdDb && g.__pdDbPath === p) return g.__pdDb;
  if (g.__pdDb) {
    g.__pdDb.close();
    g.__pdDb = undefined;
  }
  if (p !== ":memory:") fs.mkdirSync(path.dirname(p), { recursive: true });
  const db = new Database(p);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  g.__pdDb = db;
  g.__pdDbPath = p;
  return db;
}

export function closeDb(): void {
  if (g.__pdDb) {
    g.__pdDb.close();
    g.__pdDb = undefined;
    g.__pdDbPath = undefined;
  }
}
