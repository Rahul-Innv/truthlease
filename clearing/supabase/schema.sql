-- Clearing: Supabase Postgres schema for the serverless server mode (CLEARING_STORE=supabase).
--
-- Run this once in the Supabase dashboard: SQL Editor → New query → paste → Run.
-- It is idempotent (IF NOT EXISTS), so running it again is safe.
--
-- Mirrors the SQLite schema in src/lib/store.ts. JSON columns are TEXT, exactly as in
-- SQLite: the app validates every run and event with its Zod contracts on read and write.
-- Row Level Security is enabled with no policies, so the public Data API (anon /
-- authenticated keys) cannot read or write these tables; the app connects with the
-- database connection string (table owner), which is not subject to RLS.

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  state TEXT NOT NULL              -- Run JSON, validated on read and write
);

CREATE TABLE IF NOT EXISTS events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  cause_id TEXT,
  summary TEXT NOT NULL,
  payload TEXT NOT NULL,           -- JSON
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX IF NOT EXISTS events_by_cause ON events (run_id, cause_id);

CREATE TABLE IF NOT EXISTS idempotency (
  run_id TEXT NOT NULL,
  key TEXT NOT NULL,
  response TEXT NOT NULL,          -- JSON {status, body}
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, key)
);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,              -- current_run_id
  v TEXT NOT NULL
);

-- P1 attendee opt-in: anonymous answers (no names, emails or phone numbers) and link tokens.
CREATE TABLE IF NOT EXISTS attendee_responses (
  run_id TEXT NOT NULL,
  respondent_id TEXT NOT NULL,
  preference TEXT NOT NULL,
  party_size INTEGER NOT NULL,
  submitted_at TEXT NOT NULL,
  PRIMARY KEY (run_id, respondent_id)
);

CREATE TABLE IF NOT EXISTS attendee_links (
  token TEXT PRIMARY KEY,
  run_id TEXT NOT NULL
);

ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendee_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendee_links ENABLE ROW LEVEL SECURITY;
