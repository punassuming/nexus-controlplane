import { EventEmitter } from 'node:events';
import type { DatabaseSync } from 'node:sqlite';
import { ApprovalQueue, optionsFromChoices } from './approvals.ts';
import { audit } from './db.ts';
import type { NexusApi, WatchEvent } from './nexus/types.ts';
import { TaskStore } from './tasks.ts';

export interface BusEvent {
  seq: number;
  type: 'agent' | 'approval' | 'task' | 'nexus';
  data: any;
}

/** In-memory fan-out with a replay ring so SSE clients can resume via Last-Event-ID. */
export class Bus extends EventEmitter {
  private seq = 0;
  private ring: BusEvent[] = [];
  publish(type: BusEvent['type'], data: any) {
    const ev = { seq: ++this.seq, type, data };
    this.ring.push(ev);
    if (this.ring.length > 500) this.ring.shift();
    this.emit('event', ev);
  }
  since(seq: number): BusEvent[] {
    return this.ring.filter((e) => e.seq > seq);
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
    this.bus.publish('agent', { task_id: task.task_id, ...ev });
    if (ev.state !== 'needs-input') {
      for (const a of this.approvals.supersede(ev.sessionId)) this.bus.publish('approval', a);
      return;
    }
    let options = optionsFromChoices(ev.choices ?? []);
    // get_state (#56) has the typed options (key, kind) the watch event leaves out.
    const live = await this.nexus.getState(ev.sessionId).catch(() => undefined);
    if (live?.agent?.state === 'needs-input' && live.agent.options?.length) options = live.agent.options;
    const a = this.approvals.enqueue({ session_id: ev.sessionId, task_id: task.task_id, detail: ev.detail, tail: ev.tail, options });
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
