import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseSync } from 'node:sqlite';
import type { Policy } from './policy.ts';
import { redactCapped } from './redact.ts';

/**
 * Every MCP transaction through the proxy, both ways: orchestrators calling us (`in`) and us calling an upstream
 * such as Nexus (`out`). Metadata always; with `transcripts.level: full` also the request and response, with
 * secrets masked and size capped, kept for `transcripts.retentionDays`.
 */
export interface CallRecord {
  direction: 'in' | 'out';
  client?: string;
  upstream?: string;
  tool: string;
  task_id?: string;
  session_id?: string;
  ok: boolean;
  error?: string;
  durationMs: number;
  bytes: number;
  /** in: a watch that returned events (one orchestrator wake-up). */
  wake?: boolean;
  /** in: what the proxy did: forwarded, answered locally, queued an approval, denied. */
  decision?: 'forwarded' | 'local' | 'approval' | 'denied' | 'error';
  approval_id?: string;
  request?: unknown;
  response?: unknown;
}

/** Which orchestrator call an outbound upstream call was made for. */
export const callContext = new AsyncLocalStorage<{ client?: string; task_id?: string }>();

export class CallLog {
  constructor(private db: DatabaseSync, private policy?: Policy) {}

  record(c: CallRecord) {
    const t = this.policy?.get().transcripts ?? { level: 'full', maxPayloadBytes: 64 * 1024 };
    const ctx = c.direction === 'out' ? callContext.getStore() : undefined;
    const keep = (v: unknown) => (t.level === 'full' && v !== undefined ? redactCapped(v, t.maxPayloadBytes) : null);
    this.db.prepare(`INSERT INTO mcp_calls (ts, direction, client, upstream, tool, task_id, session_id, ok, error, duration_ms, bytes, wake,
        decision, approval_id, request, response) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(Date.now(), c.direction, c.client ?? ctx?.client ?? null, c.upstream ?? null, c.tool, c.task_id ?? ctx?.task_id ?? null,
        c.session_id ?? null, c.ok ? 1 : 0, c.error ? redactCapped(c.error, 300) : null, Math.round(c.durationMs), c.bytes, c.wake ? 1 : 0,
        c.decision ?? null, c.approval_id ?? null, keep(c.request), keep(c.response));
  }

  /** Newest first. Payloads only when asked for (they can be large). */
  recent(o: { limit?: number; client?: string; task_id?: string; payloads?: boolean } | number = {}) {
    const q = typeof o === 'number' ? { limit: o } : o;
    const cols = q.payloads ? '*' : 'id, ts, direction, client, upstream, tool, task_id, session_id, ok, error, duration_ms, bytes, wake, decision, approval_id';
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.client) { where.push('client = ?'); args.push(q.client); }
    if (q.task_id) { where.push('task_id = ?'); args.push(q.task_id); }
    args.push(Math.min(q.limit ?? 100, 1000));
    return this.db.prepare(`SELECT ${cols} FROM mcp_calls ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...args);
  }

  get(id: number) {
    return this.db.prepare('SELECT * FROM mcp_calls WHERE id = ?').get(id);
  }

  /** Drop transactions older than the retention period. */
  prune(now = Date.now()): number {
    const days = this.policy?.get().transcripts.retentionDays ?? 14;
    return Number(this.db.prepare('DELETE FROM mcp_calls WHERE ts < ?').run(now - days * 86_400_000).changes);
  }

  /** Per orchestrator: calls, wake-ups and answer size (bytes / 4 ≈ tokens it had to read). */
  metrics(since = 0) {
    const rows = this.db.prepare(`
      SELECT client, COUNT(*) AS calls, SUM(wake) AS wakes, SUM(bytes) AS bytes, SUM(1 - ok) AS errors,
             SUM(decision = 'approval') AS approvals, SUM(decision = 'denied') AS denied
      FROM mcp_calls WHERE direction = 'in' AND ts >= ? GROUP BY client ORDER BY client`).all(since) as any[];
    const out = this.db.prepare(`
      SELECT COALESCE(upstream, 'nexus') AS upstream, COUNT(*) AS calls, SUM(1 - ok) AS errors
      FROM mcp_calls WHERE direction = 'out' AND ts >= ? GROUP BY upstream`).all(since) as any[];
    const nexus = out.find((u) => u.upstream === 'nexus') ?? { calls: 0, errors: 0 };
    return {
      clients: rows.map((r) => ({ ...r, approxTokens: Math.round((r.bytes ?? 0) / 4) })),
      upstreams: out,
      nexus: { calls: nexus.calls, errors: nexus.errors ?? 0 },
    };
  }
}
