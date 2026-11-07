import { EventEmitter } from 'node:events';
import type { DatabaseSync } from 'node:sqlite';
import { ApprovalQueue, optionsFromChoices } from './approvals.ts';
import { audit } from './db.ts';
import type { NexusApi, WatchEvent } from './nexus/types.ts';
import { TaskStore } from './tasks.ts';

export type BusType = 'agent' | 'approval' | 'task' | 'nexus' | 'limit';

export interface BusEvent {
  seq: number;
  ts: number;
  type: BusType;
  task_id: string | null;
  client_id: string | null;
  data: any;
}

/**
 * Event fan-out, persisted so cursors survive restarts: SSE resumes with Last-Event-ID and orchestrators long-poll
 * from their own cursor. Each event carries the task's owner, so an orchestrator only ever sees its own tasks.
 */
export class Bus extends EventEmitter {
  private inserts = 0;

  constructor(private db: DatabaseSync, private keep = 20_000) {
    super();
    this.setMaxListeners(0);
  }

  publish(type: BusType, data: any): BusEvent {
    const task_id: string | null = data?.task_id ?? null;
    const client_id = task_id ? ((this.db.prepare('SELECT client_id FROM tasks WHERE task_id=?').get(task_id) as any)?.client_id ?? null) : null;
    const ts = Date.now();
    const r = this.db.prepare('INSERT INTO events (ts, type, task_id, client_id, data) VALUES (?,?,?,?,?)')
      .run(ts, type, task_id, client_id, JSON.stringify(data));
    const ev: BusEvent = { seq: Number(r.lastInsertRowid), ts, type, task_id, client_id, data };
    if (++this.inserts % 500 === 0) this.db.prepare('DELETE FROM events WHERE seq <= ?').run(ev.seq - this.keep);
    this.emit('event', ev);
    return ev;
  }

  /** Events after `seq`, oldest first; with `client`, only that orchestrator's tasks. */
  since(seq: number, client?: string, limit = 500): BusEvent[] {
    const rows = client === undefined
      ? this.db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?').all(seq, limit)
      : this.db.prepare('SELECT * FROM events WHERE seq > ? AND client_id = ? ORDER BY seq LIMIT ?').all(seq, client, limit);
    return (rows as any[]).map((r) => ({ ...r, data: JSON.parse(r.data) }));
  }

  head(): number {
    return Number((this.db.prepare('SELECT MAX(seq) AS s FROM events').get() as any)?.s ?? 0);
  }
}

/** Long-polls watch_agents (no push in Nexus) and turns events into task state, approvals and bus messages. */
export class Poller {
  private running = false;
  private count = 0;
  private healthy = false;
  polls() { return this.count; }

  constructor(
    private db: DatabaseSync,
    private nexus: NexusApi,
    private tasks: TaskStore,
    private approvals: ApprovalQueue,
    private bus: Bus,
    private waitSec: number,
  ) {}

  private getCursor(): number | undefined {
    const v = (this.db.prepare("SELECT v FROM kv WHERE k='watch_cursor'").get() as any)?.v;
    return v === undefined ? undefined : Number(v);
  }
  private setCursor(c: number) {
    this.db.prepare("INSERT INTO kv (k,v) VALUES ('watch_cursor',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(String(c));
  }

  async handle(ev: WatchEvent) {
    const task = this.tasks.bySession(ev.sessionId);
    // Only supervise sessions this harness started; ignore everything else Nexus reports.
    if (!task) return;
    this.tasks.setStatus(task.task_id, ev.state);
    if (ev.state !== 'needs-input') {
      this.bus.publish('agent', { task_id: task.task_id, ...ev });
      // A closed terminal takes every pending request for it along; otherwise only its prompt went away.
      for (const a of this.approvals.supersede(ev.sessionId, ev.state === 'exited')) this.bus.publish('approval', a);
      return;
    }
    let options = optionsFromChoices(ev.choices ?? []);
    // get_state (#56) has the typed options (key, kind) the watch event leaves out.
    const live = await this.nexus.getState(ev.sessionId).catch(() => undefined);
    if (live?.agent?.state === 'needs-input' && live.agent.options?.length) options = live.agent.options;
    // The approval exists before anyone hears about the prompt, so a woken orchestrator can answer it at once.
    const a = this.approvals.enqueue({ session_id: ev.sessionId, task_id: task.task_id, detail: ev.detail, tail: ev.tail, options });
    this.bus.publish('agent', { task_id: task.task_id, ...ev, approval_id: a.id });
    this.bus.publish('approval', a);
  }

  /** After lost events (missed cursor, harness restart), rebuild from each live task's current state. */
  async resync() {
    for (const t of this.tasks.live()) {
      const s = await this.nexus.getState(t.session_id!);
      const state = !s || !s.running ? 'exited' : (s.agent?.state ?? 'none');
      await this.handle({
        seq: 0, sessionId: t.session_id!, name: t.name, state, detail: s?.agent?.detail,
        choices: s?.agent?.options?.map((o) => o.label), tail: '', at: Date.now(),
      });
    }
  }

  async tick(): Promise<void> {
    const res = await this.nexus.watchAgents(this.getCursor(), this.waitSec);
    this.count++;
    if (res.missed) {
      audit(this.db, 'nexus.missed', 'poller', { cursor: this.getCursor() });
      await this.resync();
    }
    for (const ev of res.events) await this.handle(ev);
    this.setCursor(res.cursor);
    for (const a of this.approvals.expireDue()) this.bus.publish('approval', a);
  }

  start() {
    if (this.running) return;
    this.running = true;
    void (async () => {
      let backoff = 1000;
      let synced = false;
      while (this.running) {
        try {
          if (!synced) { await this.resync(); synced = true; }
          await this.tick();
          if (!this.healthy) this.bus.publish('nexus', { online: true });
          this.healthy = true;
          backoff = 1000;
        } catch (e: any) {
          synced = false;
          this.healthy = false;
          this.bus.publish('nexus', { online: false, error: String(e?.message ?? e) });
          audit(this.db, 'nexus.error', 'poller', { error: String(e?.message ?? e) });
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, 30_000);
        }
      }
    })();
  }
  stop() { this.running = false; }
}
