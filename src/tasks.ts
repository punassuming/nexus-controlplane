import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { audit } from './db.ts';
import type { NexusApi, WatchState } from './nexus/types.ts';
import type { Policy } from './policy.ts';

export type TaskStatus = 'starting' | WatchState | 'stopped';

export interface Task {
  task_id: string;
  session_id: string | null;
  client_id: string | null;
  agent: string;
  name: string;
  cwd: string;
  prompt: string | null;
  status: TaskStatus;
  created_at: number;
  updated_at: number;
}

const FINAL: TaskStatus[] = ['stopped', 'exited'];

/** A request the policy refused. */
export class PolicyError extends Error {}

export class TaskStore {
  constructor(private db: DatabaseSync, private nexus: NexusApi, private policy: Policy) {}

  /**
   * Nexus has no task_id: the label we pass as `name` carries it, and we keep the mapping here. Every start, from
   * the UI or an orchestrator (`client`), passes the policy: agent and directory allowlists and the active-task limit.
   */
  async create(input: { agent: string; cwd: string; prompt?: string; name?: string; client?: string }): Promise<Task> {
    const decision = await this.policy.checkStart({ client: input.client, agent: input.agent, cwd: input.cwd, active: this.live().length });
    if (decision.verdict !== 'allow') {
      audit(this.db, 'task.denied', input.client ?? 'ui', { agent: input.agent, cwd: input.cwd, reason: decision.reason });
      throw new PolicyError(decision.reason);
    }
    // checkStart awaited; two starts may both have passed it. Re-count with no await before the insert.
    const max = this.policy.get().maxActiveTasks;
    if (this.live().length >= max) throw new PolicyError(`${this.live().length} active task(s); the limit is ${max}`);
    const task_id = randomUUID();
    const name = `cp-${(input.name || 'task').replace(/[^\w.-]+/g, '-').slice(0, 40)}-${task_id.slice(0, 8)}`;
    const now = Date.now();
    this.db.prepare(
      'INSERT INTO tasks (task_id, session_id, client_id, agent, name, cwd, prompt, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).run(task_id, null, input.client ?? null, input.agent, name, input.cwd, input.prompt ?? null, 'starting', now, now);
    try {
      const s = await this.nexus.startAgent({ agent: input.agent, cwd: input.cwd, name, prompt: input.prompt });
      this.db.prepare('UPDATE tasks SET session_id=?, status=?, updated_at=? WHERE task_id=?')
        .run(s.id, s.agent?.state ?? 'none', Date.now(), task_id);
      audit(this.db, 'task.start', task_id, { session: s.id, name, agent: input.agent, cwd: input.cwd, by: input.client ?? 'ui' });
    } catch (e: any) {
      // Never got a terminal: not active, so it doesn't hold the one-task slot.
      this.setStatus(task_id, 'exited');
      audit(this.db, 'task.start_failed', task_id, { error: String(e?.message ?? e) });
      throw e;
    }
    return this.get(task_id)!;
  }

  get(task_id: string): Task | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE task_id=?').get(task_id) as Task | undefined;
  }

  bySession(session_id: string): Task | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE session_id=?').get(session_id) as Task | undefined;
  }

  list(client?: string): Task[] {
    const rows = client === undefined
      ? this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all()
      : this.db.prepare('SELECT * FROM tasks WHERE client_id=? ORDER BY created_at DESC').all(client);
    return rows as unknown as Task[];
  }

  /** Tasks whose terminal is (or is about to be) open in Nexus. */
  live(): Task[] {
    return this.list().filter((t) => !FINAL.includes(t.status));
  }

  isLive(t: Task): boolean {
    return !!t.session_id && !FINAL.includes(t.status);
  }

  /** A stopped task stays stopped whatever late events say. */
  setStatus(task_id: string, status: TaskStatus) {
    this.db.prepare("UPDATE tasks SET status=?, updated_at=? WHERE task_id=? AND status<>'stopped'").run(status, Date.now(), task_id);
  }

  markStopped(session_id: string, by: string) {
    const t = this.bySession(session_id);
    if (!t) return;
    this.setStatus(t.task_id, 'stopped');
    audit(this.db, 'task.stop', t.task_id, { session: session_id, by });
  }

  private session(task_id: string): string {
    const t = this.get(task_id);
    if (!t) throw new Error('unknown task');
    if (!this.isLive(t)) throw new Error(`task is ${t.status}`);
    return t.session_id!;
  }

  /** Guide the agent with a typed prompt. Only the prompt's length is audited, as in Nexus's own activity log. */
  async prompt(task_id: string, text: string, by: string, force = false): Promise<Task> {
    const session = this.session(task_id);
    await this.nexus.promptAgent(session, text, { force });
    audit(this.db, 'task.prompt', task_id, { session, length: text.length, force, by });
    return this.get(task_id)!;
  }

  /** A person stopping a task from the UI. Orchestrators request a stop through an approval instead. */
  async stop(task_id: string, by: string): Promise<Task> {
    const session = this.session(task_id);
    await this.nexus.stopSession(session);
    this.markStopped(session, by);
    return this.get(task_id)!;
  }
}
