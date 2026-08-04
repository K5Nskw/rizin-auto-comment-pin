-- Idempotent schema. Applied on every boot.

CREATE TABLE IF NOT EXISTS accounts (
  platform        TEXT PRIMARY KEY,          -- 'youtube' | 'tiktok'
  display_name    TEXT,
  external_id     TEXT,                      -- channel id / open id
  credentials_enc TEXT,                      -- sealed JSON: tokens
  connected_at    TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS templates (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  platform     TEXT NOT NULL DEFAULT 'all',      -- 'all' | 'youtube' | 'tiktok'
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  priority     INTEGER NOT NULL DEFAULT 100,     -- 小さいほど優先
  match_type   TEXT NOT NULL DEFAULT 'always',   -- 'always' | 'keyword' | 'regex' | 'clip'
  match_value  TEXT NOT NULL DEFAULT '',
  bodies       JSONB NOT NULL DEFAULT '[]'::jsonb, -- 複数入れるとランダムで1つ選ばれる
  pin          BOOLEAN NOT NULL DEFAULT TRUE,
  delay_seconds INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS videos (
  key          TEXT PRIMARY KEY,             -- '<platform>:<video_id>'
  platform     TEXT NOT NULL,
  video_id     TEXT NOT NULL,
  title        TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL DEFAULT '',
  url          TEXT NOT NULL DEFAULT '',
  published_at TIMESTAMPTZ,
  detected_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw          JSONB
);

CREATE TABLE IF NOT EXISTS jobs (
  id            SERIAL PRIMARY KEY,
  video_key     TEXT NOT NULL REFERENCES videos(key) ON DELETE CASCADE,
  platform      TEXT NOT NULL,
  template_id   INTEGER,
  template_name TEXT NOT NULL DEFAULT '',
  comment_text  TEXT NOT NULL,
  should_pin    BOOLEAN NOT NULL DEFAULT TRUE,
  -- pending -> commenting -> pinning -> done
  --                       \-> needs_manual (API で不可能な場合)
  --                       \-> failed
  status        TEXT NOT NULL DEFAULT 'pending',
  comment_id    TEXT,
  comment_done  BOOLEAN NOT NULL DEFAULT FALSE,
  pin_done      BOOLEAN NOT NULL DEFAULT FALSE,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  run_after     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One job per video. This is the core de-duplication guarantee: even if the
-- watcher fires twice for the same upload, only one comment is ever posted.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_video_key_uniq ON jobs (video_key);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status, run_after);

CREATE TABLE IF NOT EXISTS browser_sessions (
  platform   TEXT PRIMARY KEY,
  state_enc  TEXT NOT NULL,                  -- sealed Playwright storageState
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS logs (
  id         SERIAL PRIMARY KEY,
  level      TEXT NOT NULL,
  scope      TEXT NOT NULL,
  message    TEXT NOT NULL,
  meta       JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS logs_created_idx ON logs (created_at DESC);
