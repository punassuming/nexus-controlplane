import type { DatabaseSync } from 'node:sqlite';

/**
 * Every MCP call through the harness, both ways: orchestrators calling us (`in`) and us calling Nexus (`out`).
 * Like Nexus's own `mcp.call`, it keeps who, which tool, on what, how it went and how big the answer was, never the
 * text of a prompt or of typed keys.
 */
export interface CallRecord {
  direction: 'in' | 'out';
  client?: string;
  tool: string;
  task_id?: string;
  session_id?: string;
  ok: boolean;
  error?: string;
  durationMs: number;
  bytes: number;
  /** in: a watch that returned events (one orchestrator wake-up). */
  wake?: boolean;
}

export class CallLog {
  constructor(private db: DatabaseSync) {}

  record(c: CallRecord) {
    this.db.prepare(
      'INSERT INTO mcp_calls (ts, direction, client, tool, task_id, session_id, ok, error, duration_ms, bytes, wake) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ).run(Date.now(), c.direction, c.client ?? null, c.tool, c.task_id ?? null, c.session_id ?? null, c.ok ? 1 : 0,
      c.error?.slice(0, 300) ?? null, Math.round(c.durationMs), c.bytes, c.wake ? 1 : 0);
  }

  recent(limit = 100) {
    return this.db.prepare('SELECT * FROM mcp_calls ORDER BY id DESC LIMIT ?').all(Math.min(limit, 1000));
  }

  /** Per orchestrator: calls, wake-ups and answer size (bytes / 4 ≈ tokens it had to read). */
  metrics(since = 0) {
    const rows = this.db.prepare(`
      SELECT client, COUNT(*) AS calls, SUM(wake) AS wakes, SUM(bytes) AS bytes, SUM(1 - ok) AS errors
      FROM mcp_calls WHERE direction = 'in' AND ts >= ? GROUP BY client ORDER BY client`).all(since) as any[];
    const nexus = this.db.prepare(`
      SELECT COUNT(*) AS calls, SUM(1 - ok) AS errors FROM mcp_calls WHERE direction = 'out' AND ts >= ?`).get(since) as any;
    return {
      clients: rows.map((r) => ({ ...r, approxTokens: Math.round((r.bytes ?? 0) / 4) })),
      nexus: { calls: nexus.calls, errors: nexus.errors ?? 0 },
    };
  }
}
