/**
 * Automatic resource limits. Polls #56 resource_usage for live tasks; a breach of the policy thresholds that lasts
 * `sustainSeconds` either alerts, or pauses the task's whole process tree and asks the phone whether to resume.
 * When Nexus has no resource_usage (or no thresholds are set), it says so instead of pretending to enforce.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { ApprovalQueue } from './approvals.ts';
import { audit } from './db.ts';
import type { Bus } from './events.ts';
import type { NexusApi, ResourceReading } from './nexus/types.ts';
import type { Policy } from './policy.ts';
import type { TaskStore } from './tasks.ts';

export interface LimitStatus {
  enforced: boolean;
  reason?: string;
}

export class Limits {
  private latest = new Map<string, ResourceReading>();
  private breachSince = new Map<string, number>();
  /** Sessions this limiter paused, until a resume approval runs. */
  private paused = new Set<string>();
  private alerted = new Set<string>();
  private timer?: NodeJS.Timeout;

  constructor(
    private db: DatabaseSync,
    private nexus: NexusApi,
    private tasks: TaskStore,
    private approvals: ApprovalQueue,
    private bus: Bus,
    private policy: Policy,
  ) {}

  status(): LimitStatus {
    const r = this.policy.get().resources;
    if (!this.nexus.hasTool('resource_usage')) return { enforced: false, reason: 'resource limits not enforced: Nexus lacks resource_usage (#56)' };
    if (r.cpuPercent === undefined && r.memoryBytes === undefined) return { enforced: false, reason: 'resource limits not enforced: no thresholds in the policy' };
    if (r.action === 'pause' && !this.nexus.hasTool('pause_session')) return { enforced: false, reason: 'resource limits alert only: Nexus lacks pause_session (#56)' };
    return { enforced: true };
  }

  reading(task_id: string): ResourceReading | undefined {
    return this.latest.get(task_id);
  }

  resumed(session: string) {
    this.paused.delete(session);
    this.breachSince.delete(session);
    this.alerted.delete(session);
  }

  async check(now = Date.now()): Promise<void> {
    if (!this.nexus.hasTool('resource_usage')) return;
    const r = this.policy.get().resources;
    for (const t of this.tasks.live()) {
      if (!t.session_id) continue;
      const u = await this.nexus.resourceUsage(t.session_id).catch(() => undefined);
      if (!u) continue;
      this.latest.set(t.task_id, u);
      const over = (r.cpuPercent !== undefined && u.cpu > r.cpuPercent) || (r.memoryBytes !== undefined && u.memory > r.memoryBytes);
      if (!over) {
        if (!this.paused.has(t.session_id)) { this.breachSince.delete(t.session_id); this.alerted.delete(t.session_id); }
        continue;
      }
      const since = this.breachSince.get(t.session_id) ?? now;
      this.breachSince.set(t.session_id, since);
      if (now - since < r.sustainSeconds * 1000 || this.paused.has(t.session_id) || this.alerted.has(t.session_id)) continue;

      const detail = { task_id: t.task_id, session: t.session_id, cpu: u.cpu, memory: u.memory, limits: { cpuPercent: r.cpuPercent, memoryBytes: r.memoryBytes } };
      if (r.action === 'pause' && this.nexus.hasTool('pause_session')) {
        try {
          await this.nexus.pauseSession(t.session_id, true);
        } catch (e: any) {
          audit(this.db, 'limit.pause_failed', t.task_id, { ...detail, error: e.message });
          continue;
        }
        this.paused.add(t.session_id);
        audit(this.db, 'limit.pause', t.task_id, detail);
        this.bus.publish('limit', { ...detail, action: 'paused' });
        const a = this.approvals.request('resume', {
          session_id: t.session_id, task_id: t.task_id, requested_by: 'limits',
          reason: `paused over the resource limit (cpu ${u.cpu.toFixed(0)}%, memory ${Math.round(u.memory / 1048576)} MB)`,
        });
        this.bus.publish('approval', a);
      } else {
        this.alerted.add(t.session_id);
        audit(this.db, 'limit.alert', t.task_id, detail);
        this.bus.publish('limit', { ...detail, action: 'alert' });
      }
    }
  }

  start(intervalMs = 10_000) {
    this.timer ??= setInterval(() => void this.check().catch(() => {}), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
