import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { audit } from './db.ts';
import { NexusError } from './nexus/client.ts';
import type { NexusApi, PromptOption } from './nexus/types.ts';

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface Approval {
  id: string;
  task_id: string | null;
  session_id: string;
  detail: string | null;
  tail: string | null;
  options: PromptOption[];
  status: ApprovalStatus;
  created_at: number;
  expires_at: number;
  decided_at: number | null;
  decision: string | null;
  decided_by: string | null;
}

/** The prompt on screen is not the one the human decided on. Nothing was sent. */
export class StaleApprovalError extends Error {}

/** Choices that grant more than this one action. "Allow once" never presses them. */
const PERSISTENT = /\balways\b|don'?t ask|\bsession\b|\ball\b|\bevery|\bremember/i;
const APPROVE = /^(yes|y|allow|approve|accept|proceed|run|continue)\b/i;
const DENY = /^(no|n|deny|reject|cancel|decline|abort|skip)\b/i;
/** Escape dismisses Claude Code's and Codex's approval menus (a refusal). */
export const ESCAPE = '\x1b';

/**
 * watch_agents only gives choice labels "as the agent numbers them". Turn them into options: a leading
 * "2." or "2)" is the key, otherwise the position; the kind is read from the label.
 */
export function optionsFromChoices(choices: string[]): PromptOption[] {
  return choices.map((raw, i) => {
    const m = /^\s*(\w)[.)]\s+(.*)$/.exec(raw);
    const key = m ? m[1] : String(i + 1);
    const label = (m ? m[2] : raw).trim();
    const kind = APPROVE.test(label) ? 'approve' : DENY.test(label) ? 'deny' : 'other';
    return { key, label, kind };
  });
}

export function pickOption(options: PromptOption[], kind: 'allow' | 'deny'): PromptOption | undefined {
  return kind === 'allow'
    ? options.find((o) => o.kind === 'approve' && !PERSISTENT.test(o.label))
    : options.find((o) => o.kind === 'deny');
}

export class ApprovalQueue {
  constructor(private db: DatabaseSync, private nexus: NexusApi, private ttlMs: number) {}

  private row(r: any): Approval {
    return { ...r, options: JSON.parse(r.options) };
  }

  get(id: string): Approval | undefined {
    const r = this.db.prepare('SELECT * FROM approvals WHERE id=?').get(id);
    return r ? this.row(r) : undefined;
  }

  list(status?: ApprovalStatus): Approval[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM approvals WHERE status=? ORDER BY created_at DESC').all(status)
      : this.db.prepare('SELECT * FROM approvals ORDER BY created_at DESC LIMIT 200').all();
    return rows.map((r) => this.row(r));
  }

  /**
   * One pending approval per session. A repeat of the same prompt is deduped (typed options from
   * get_state replace guessed ones); a different prompt supersedes the old approval.
   */
  enqueue(i: { session_id: string; task_id?: string | null; detail?: string; tail?: string; options: PromptOption[] }): Approval {
    const existing = this.db.prepare("SELECT * FROM approvals WHERE session_id=? AND status='pending'").get(i.session_id) as any;
    if (existing && (existing.detail ?? '') === (i.detail ?? '')) {
      if (i.options.length) this.db.prepare('UPDATE approvals SET options=? WHERE id=?').run(JSON.stringify(i.options), existing.id);
      return this.get(existing.id)!;
    }
    if (existing) this.supersede(i.session_id);
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare(
      'INSERT INTO approvals (id, task_id, session_id, detail, tail, options, status, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(id, i.task_id ?? null, i.session_id, i.detail ?? null, i.tail ?? null, JSON.stringify(i.options), 'pending', now, now + this.ttlMs);
    audit(this.db, 'approval.created', id, { session: i.session_id, detail: i.detail });
    return this.get(id)!;
  }

  /** Mark pending approvals past their deadline. Nothing is sent: the agent stays blocked on its prompt. */
  expireDue(now = Date.now()): Approval[] {
    const due = this.db.prepare("SELECT id, session_id FROM approvals WHERE status='pending' AND expires_at<=?").all(now) as any[];
    for (const r of due) {
      this.db.prepare("UPDATE approvals SET status='expired', decided_at=? WHERE id=?").run(now, r.id);
      audit(this.db, 'approval.expired', r.id, { session: r.session_id });
    }
    return due.map((r) => this.get(r.id)!);
  }

  /** The prompt went away without a decision here (answered in the app, agent moved on, terminal closed). */
  supersede(session_id: string, reason = 'superseded'): Approval[] {
    const rows = this.db.prepare("SELECT id FROM approvals WHERE session_id=? AND status='pending'").all(session_id) as any[];
    for (const r of rows) {
      this.db.prepare("UPDATE approvals SET status='expired', decided_at=?, decision=? WHERE id=?").run(Date.now(), reason, r.id);
      audit(this.db, `approval.${reason}`, r.id, { session: session_id });
    }
    return rows.map((r) => this.get(r.id)!);
  }

  /**
   * Answer the prompt. The row is claimed first (no double send), then the agent's live state is checked:
   * if it is no longer showing this prompt, nothing is typed. Allow once never picks a persistent choice;
   * deny without a deny choice sends Escape.
   */
  async decide(id: string, kind: 'allow' | 'deny', by: string, optionKey?: string): Promise<Approval> {
    const a = this.get(id);
    if (!a) throw new Error('unknown approval');
    if (a.status !== 'pending') throw new Error(`approval already ${a.status}`);
    if (a.expires_at <= Date.now()) {
      this.expireDue();
      throw new Error('approval expired');
    }
    const claimed = this.db.prepare(
      "UPDATE approvals SET status=?, decided_at=?, decided_by=? WHERE id=? AND status='pending'",
    ).run(kind === 'allow' ? 'approved' : 'denied', Date.now(), by, id);
    if (claimed.changes !== 1) throw new Error('approval already decided');
    const reopen = () =>
      this.db.prepare("UPDATE approvals SET status='pending', decided_at=NULL, decision=NULL, decided_by=NULL WHERE id=?").run(id);

    let keys: string;
    let label: string;
    try {
      const live = await this.nexus.getState(a.session_id);
      const agent = live?.running ? live.agent : null;
      if (agent?.state !== 'needs-input' || (a.detail && agent.detail && agent.detail !== a.detail)) {
        this.db.prepare("UPDATE approvals SET status='expired', decision='stale' WHERE id=?").run(id);
        audit(this.db, 'approval.stale', id, { session: a.session_id, by, live: agent ? { state: agent.state, detail: agent.detail } : null });
        throw new StaleApprovalError('the prompt changed or was answered elsewhere; nothing was sent');
      }
      const options = agent.options?.length ? agent.options : a.options;
      const opt = optionKey !== undefined ? options.find((o) => o.key === optionKey) : pickOption(options, kind);
      if (optionKey !== undefined && !opt) throw new Error(`no option ${optionKey} on this prompt`);
      if (!opt && kind === 'allow') throw new Error('no one-shot allow option on this prompt; choose an option explicitly');
      keys = opt?.key ?? ESCAPE;
      label = opt?.label ?? 'Escape';
      await this.nexus.sendKeys(a.session_id, keys);
    } catch (e: any) {
      if (!(e instanceof StaleApprovalError)) {
        reopen();
        if (e instanceof NexusError) audit(this.db, 'approval.delivery_failed', id, { error: e.message });
      }
      throw e;
    }
    this.db.prepare('UPDATE approvals SET decision=? WHERE id=?').run(label, id);
    audit(this.db, `approval.${kind}`, id, { session: a.session_id, option: label, key: keys === ESCAPE ? 'Escape' : keys, by });
    return this.get(id)!;
  }
}
