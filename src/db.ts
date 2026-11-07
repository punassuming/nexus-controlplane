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
      name       TEXT NOT NULL,
      cwd        TEXT NOT NULL,
      prompt     TEXT,
      status     TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id          TEXT PRIMARY KEY,
      task_id     TEXT,
      session_id  TEXT NOT NULL,
      detail      TEXT,
      tail        TEXT,
      options     TEXT NOT NULL,
      status      TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      decided_at  INTEGER,
      decision    TEXT,
      decided_by  TEXT
    );
    CREATE TABLE IF NOT EXISTS audit (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      ts      INTEGER NOT NULL,
      kind    TEXT NOT NULL,
      subject TEXT NOT NULL,
      data    TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `);
  return db;
}

export function audit(db: DatabaseSync, kind: string, subject: string, data: unknown) {
  db.prepare('INSERT INTO audit (ts, kind, subject, data) VALUES (?, ?, ?, ?)')
    .run(Date.now(), kind, subject, JSON.stringify(data));
}
