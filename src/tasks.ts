import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { audit } from './db.ts';
import type { NexusApi, WatchState } from './nexus/types.ts';

export type TaskStatus = 'starting' | WatchState | 'stopped';

export interface Task {
  task_id: string;
  session_id: string | null;
  name: string;
  cwd: string;
  prompt: string | null;
  status: TaskStatus;
  created_at: number;
  updated_at: number;
}

const FINAL: TaskStatus[] = ['stopped', 'exited'];

export class TaskStore {
  constructor(private db: DatabaseSync, private nexus: NexusApi) {}

  /** Nexus has no task_id: the label we pass as `name` carries it, and we keep the mapping here. */
  async create(input: { agent: string; cwd: string; prompt?: string; name?: string }): Promise<Task> {
    const task_id = randomUUID();
    const name = `cp-${(input.name || 'task').replace(/[^\w.-]+/g, '-')}-${task_id.slice(0, 8)}`;
    const now = Date.now();
    this.db.prepare(
      'INSERT INTO tasks (task_id, session_id, name, cwd, prompt, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
    ).run(task_id, null, name, input.cwd, input.prompt ?? null, 'starting', now, now);
    try {
      const s = await this.nexus.startAgent({ agent: input.agent, cwd: input.cwd, name, prompt: input.prompt });
      this.db.prepare('UPDATE tasks SET session_id=?, status=?, updated_at=? WHERE task_id=?')
        .run(s.id, s.agent?.state ?? 'none', Date.now(), task_id);
      audit(this.db, 'task.start', task_id, { session: s.id, name, agent: input.agent, cwd: input.cwd });
    } catch (e: any) {
      this.setStatus(task_id, 'error');
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

  list(): Task[] {
    return this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all() as unknown as Task[];
  }

  /** Tasks whose terminal should still exist in Nexus. */
  live(): Task[] {
    return this.list().filter((t) => t.session_id && !FINAL.includes(t.status));
  }

  /** A stopped task stays stopped whatever late events say. */
  setStatus(task_id: string, status: TaskStatus) {
    this.db.prepare("UPDATE tasks SET status=?, updated_at=? WHERE task_id=? AND status<>'stopped'").run(status, Date.now(), task_id);
  }

  private session(task_id: string): string {
    const t = this.get(task_id);
    if (!t) throw new Error('unknown task');
    if (!t.session_id || FINAL.includes(t.status)) throw new Error(`task is ${t.status}`);
    return t.session_id;
  }

  /** Guide the agent. Only the prompt's length is audited, as in Nexus's own activity log. */
  async prompt(task_id: string, text: string, by: string, force = false): Promise<Task> {
    const session = this.session(task_id);
    await this.nexus.promptAgent(session, text, { force });
    audit(this.db, 'task.prompt', task_id, { session, length: text.length, force, by });
    return this.get(task_id)!;
  }

  async stop(task_id: string, by = 'system'): Promise<Task> {
    const session = this.session(task_id);
    await this.nexus.stopSession(session);
    this.setStatus(task_id, 'stopped');
    audit(this.db, 'task.stop', task_id, { session, by });
    return this.get(task_id)!;
  }
}
