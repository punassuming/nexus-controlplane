import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS tasks (
      task_id    TEXT PRIMARY KEY,
      session_id TEXT,
      client_id  TEXT,          -- orchestrator that started it; NULL for the web UI
      agent      TEXT NOT NULL,
      name       TEXT NOT NULL,
      cwd        TEXT NOT NULL,
      prompt     TEXT,
      status     TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id            TEXT PRIMARY KEY,
      kind          TEXT NOT NULL,    -- agent_prompt | send_keys | stop | resume
      task_id       TEXT,
      session_id    TEXT NOT NULL,
      requested_by  TEXT NOT NULL,    -- 'agent', 'limits' or an orchestrator client id
      request       TEXT NOT NULL,    -- the exact action, JSON
      request_hash  TEXT NOT NULL,
      reason        TEXT,
      detail        TEXT,
      tail          TEXT,
      options       TEXT NOT NULL,
      proposed_key  TEXT,             -- agent_prompt: the orchestrator's suggested choice
      proposed_by   TEXT,
      status        TEXT NOT NULL,    -- pending | approved | denied | expired | stale
      created_at    INTEGER NOT NULL,
      expires_at    INTEGER NOT NULL,
      decided_at    INTEGER,
      decision      TEXT,
      decided_by    TEXT,
      policy_rule   TEXT,
      consumed_at   INTEGER
    );
    CREATE TABLE IF NOT EXISTS audit (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      ts      INTEGER NOT NULL,
      kind    TEXT NOT NULL,
      subject TEXT NOT NULL,
      data    TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      seq       INTEGER PRIMARY KEY AUTOINCREMENT,
      ts        INTEGER NOT NULL,
      type      TEXT NOT NULL,
      task_id   TEXT,
      client_id TEXT,
      data      TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mcp_calls (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          INTEGER NOT NULL,
      direction   TEXT NOT NULL,      -- in: an orchestrator called us; out: we called Nexus
      client      TEXT,
      tool        TEXT NOT NULL,
      task_id     TEXT,
      session_id  TEXT,
      ok          INTEGER NOT NULL,
      error       TEXT,
      duration_ms INTEGER NOT NULL,
      bytes       INTEGER NOT NULL,   -- response size; ~4 bytes per token for the orchestrator's budget
      wake        INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `);
  return db;
}

export function audit(db: DatabaseSync, kind: string, subject: string, data: unknown) {
  db.prepare('INSERT INTO audit (ts, kind, subject, data) VALUES (?, ?, ?, ?)')
    .run(Date.now(), kind, subject, JSON.stringify(data));
}
