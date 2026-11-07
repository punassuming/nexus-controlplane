/**
 * Approvals: typed, single-use decisions on one exact request, minted and consumed here. An approval is never a
 * pattern ("allow all bash"), and deciding one never types prose into a terminal: each kind has a fixed executor.
 *
 *   agent_prompt  an agent's own approval menu (raised by the watch loop); executes the chosen option key
 *   send_keys     an orchestrator wants to type into its task's terminal; executes send_keys {text, enter}
 *   stop          an orchestrator wants to close its task; executes stop_session
 *   resume        a resource limit paused a task; executes pause_session {paused: false}
 *   tool_call     an orchestrator called an upstream tool the policy marks 'approve'; executes that exact call
 */
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { audit } from './db.ts';
import { NexusError } from './nexus/client.ts';
import type { NexusApi, PromptOption } from './nexus/types.ts';
import { PERSISTENT } from './policy.ts';
import { redactCapped } from './redact.ts';

export type ApprovalKind = 'agent_prompt' | 'send_keys' | 'stop' | 'resume' | 'tool_call';
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'stale';

export interface Approval {
  id: string;
  kind: ApprovalKind;
  task_id: string | null;
  session_id: string;
  requested_by: string;
  request: Record<string, any>;
  request_hash: string;
  reason: string | null;
  detail: string | null;
  tail: string | null;
  options: PromptOption[];
  proposed_key: string | null;
  proposed_by: string | null;
  status: ApprovalStatus;
  created_at: number;
  expires_at: number;
  decided_at: number | null;
  decision: string | null;
  decided_by: string | null;
  policy_rule: string | null;
  consumed_at: number | null;
  result: string | null;
}

/** The action on screen (or the terminal) is not the one decided on. Nothing was sent. */
export class StaleApprovalError extends Error {}

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

function hash(kind: string, session: string, request: unknown): string {
  return createHash('sha256').update(JSON.stringify([kind, session, request])).digest('hex');
}

export interface ApprovalHooks {
  /** A stop approval was executed. */
  stopped?: (session: string) => void;
  /** A resume approval was executed. */
  resumed?: (session: string) => void;
  /** Executes an approved tool_call on its upstream; returns the answer to keep for the orchestrator. */
  callUpstream?: (upstream: string, tool: string, args: Record<string, unknown>) => Promise<string>;
}

export class ApprovalQueue {
  constructor(
    private db: DatabaseSync,
    private nexus: NexusApi,
    private ttlMs: () => number,
    private hooks: ApprovalHooks = {},
  ) {}

  private row(r: any): Approval {
    return { ...r, options: JSON.parse(r.options), request: JSON.parse(r.request) };
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

  pendingPrompt(session_id: string): Approval | undefined {
    const r = this.db.prepare("SELECT * FROM approvals WHERE session_id=? AND kind='agent_prompt' AND status='pending'").get(session_id);
    return r ? this.row(r) : undefined;
  }

  private insert(a: {
    kind: ApprovalKind; session_id: string; task_id?: string | null; requested_by: string; request: Record<string, any>;
    reason?: string; detail?: string; tail?: string; options?: PromptOption[];
  }): Approval {
    const request_hash = hash(a.kind, a.session_id, a.request);
    // The same request already waiting: hand back that one rather than minting a second.
    const same = this.db.prepare("SELECT id FROM approvals WHERE request_hash=? AND status='pending'").get(request_hash) as any;
    if (same) return this.get(same.id)!;
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare(`INSERT INTO approvals (id, kind, task_id, session_id, requested_by, request, request_hash, reason, detail, tail,
        options, status, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, a.kind, a.task_id ?? null, a.session_id, a.requested_by, JSON.stringify(a.request), request_hash, a.reason ?? null,
        a.detail ?? null, a.tail ?? null, JSON.stringify(a.options ?? []), 'pending', now, now + this.ttlMs());
    audit(this.db, 'approval.created', id, { kind: a.kind, session: a.session_id, requested_by: a.requested_by, detail: a.detail });
    return this.get(id)!;
  }

  /** An approval for an orchestrator's (or the resource limiter's) request. Always decided by a human. */
  request(kind: 'send_keys' | 'stop' | 'resume' | 'tool_call', a: { session_id: string; task_id?: string | null; requested_by: string; request?: Record<string, any>; reason?: string }): Approval {
    return this.insert({ kind, ...a, request: a.request ?? {} });
  }

  /**
   * An agent's approval menu, from the watch loop. One pending per session: the same question again is deduped
   * (typed options from get_state replace guessed ones); a different question supersedes the old one.
   */
  enqueue(i: { session_id: string; task_id?: string | null; detail?: string; tail?: string; options: PromptOption[] }): Approval {
    const existing = this.pendingPrompt(i.session_id);
    if (existing && (existing.detail ?? '') === (i.detail ?? '')) {
      if (i.options.length) this.db.prepare('UPDATE approvals SET options=? WHERE id=?').run(JSON.stringify(i.options), existing.id);
      return this.get(existing.id)!;
    }
    if (existing) this.supersede(i.session_id);
    return this.insert({
      kind: 'agent_prompt', session_id: i.session_id, task_id: i.task_id, requested_by: 'agent',
      request: { detail: i.detail ?? null }, detail: i.detail, tail: i.tail, options: i.options,
    });
  }

  /** An orchestrator's suggested answer to a pending agent prompt, shown to the human who decides. */
  propose(id: string, client: string, key: string, reason?: string): Approval {
    this.db.prepare("UPDATE approvals SET proposed_key=?, proposed_by=?, reason=? WHERE id=? AND status='pending'").run(key, client, reason ?? null, id);
    audit(this.db, 'approval.proposed', id, { by: client, key });
    return this.get(id)!;
  }

  /** Mark pending approvals past their deadline. Nothing is sent. */
  expireDue(now = Date.now()): Approval[] {
    const due = this.db.prepare("SELECT id, session_id FROM approvals WHERE status='pending' AND expires_at<=?").all(now) as any[];
    for (const r of due) {
      this.db.prepare("UPDATE approvals SET status='expired', decided_at=? WHERE id=?").run(now, r.id);
      audit(this.db, 'approval.expired', r.id, { session: r.session_id });
    }
    return due.map((r) => this.get(r.id)!);
  }

  /**
   * The agent's prompt went away without a decision here (answered in the app, agent moved on). With `all`, every
   * pending approval for the session closes (its terminal is gone).
   */
  supersede(session_id: string, all = false): Approval[] {
    const rows = this.db.prepare(
      `SELECT id FROM approvals WHERE session_id=? AND status='pending' ${all ? '' : "AND kind='agent_prompt'"}`,
    ).all(session_id) as any[];
    for (const r of rows) {
      this.db.prepare("UPDATE approvals SET status='stale', decided_at=?, decision='superseded' WHERE id=?").run(Date.now(), r.id);
      audit(this.db, 'approval.superseded', r.id, { session: session_id });
    }
    return rows.map((r) => this.get(r.id)!);
  }

  /**
   * Decide and, for an approval, execute it once. The row is claimed first (no double execution). Before anything
   * is sent, the live state is checked: the agent must still show the same prompt (agent_prompt), or the terminal
   * must still be open (the other kinds); otherwise nothing is sent and the approval goes stale.
   *
   * `by` is a person (UI login), `client:<id>` (an orchestrator refusing a prompt) or `policy:<rule>` (a low-risk rule).
   */
  async decide(id: string, verdict: 'allow' | 'deny', by: string, o: { optionKey?: string; rule?: string } = {}): Promise<Approval> {
    const a = this.get(id);
    if (!a) throw new Error('unknown approval');
    if (a.status !== 'pending') throw new Error(`approval already ${a.status}`);
    if (a.expires_at <= Date.now()) {
      this.expireDue();
      throw new Error('approval expired');
    }
    const claimed = this.db.prepare(
      "UPDATE approvals SET status=?, decided_at=?, decided_by=?, policy_rule=? WHERE id=? AND status='pending'",
    ).run(verdict === 'allow' ? 'approved' : 'denied', Date.now(), by, o.rule ?? null, id);
    if (claimed.changes !== 1) throw new Error('approval already decided');
    const reopen = () => this.db.prepare(
      "UPDATE approvals SET status='pending', decided_at=NULL, decision=NULL, decided_by=NULL, policy_rule=NULL WHERE id=?",
    ).run(id);

    // Refusing an orchestrator's or the limiter's request executes nothing.
    if (a.kind !== 'agent_prompt' && verdict === 'deny') {
      this.db.prepare("UPDATE approvals SET decision='denied' WHERE id=?").run(id);
      audit(this.db, 'approval.deny', id, { kind: a.kind, session: a.session_id, by });
      return this.get(id)!;
    }

    let decision: string;
    if (a.kind === 'tool_call') {
      try {
        if (!this.hooks.callUpstream) throw new Error('no upstream executor');
        const { upstream, tool, args } = a.request;
        const result = await this.hooks.callUpstream(upstream, tool, args ?? {});
        this.db.prepare('UPDATE approvals SET decision=?, consumed_at=?, result=? WHERE id=? AND consumed_at IS NULL')
          .run('called', Date.now(), redactCapped(result, 64 * 1024), id);
      } catch (e: any) {
        reopen();
        audit(this.db, 'approval.delivery_failed', id, { error: String(e?.message ?? e) });
        throw e;
      }
      audit(this.db, 'approval.allow', id, { kind: a.kind, upstream: a.request.upstream, tool: a.request.tool, by });
      return this.get(id)!;
    }
    try {
      const live = await this.nexus.getState(a.session_id);
      const stale = (why: string, data: unknown) => {
        this.db.prepare("UPDATE approvals SET status='stale', decision='stale' WHERE id=?").run(id);
        audit(this.db, 'approval.stale', id, { kind: a.kind, session: a.session_id, by, live: data });
        return new StaleApprovalError(why);
      };
      if (!live?.running) throw stale('the terminal is gone; nothing was sent', null);

      if (a.kind === 'agent_prompt') {
        const agent = live.agent;
        if (agent?.state !== 'needs-input' || (a.detail && agent.detail && agent.detail !== a.detail)) {
          throw stale('the prompt changed or was answered elsewhere; nothing was sent', agent && { state: agent.state, detail: agent.detail });
        }
        const options = agent.options?.length ? agent.options : a.options;
        const opt = o.optionKey !== undefined ? options.find((x) => x.key === o.optionKey) : pickOption(options, verdict);
        if (o.optionKey !== undefined && !opt) throw new Error(`no option ${o.optionKey} on this prompt`);
        if (!opt && verdict === 'allow') throw new Error('no one-shot allow option on this prompt; choose an option explicitly');
        // Only a person may pick a persistent grant, and only by naming it.
        if (opt && PERSISTENT.test(opt.label) && (o.optionKey === undefined || by.includes(':'))) {
          throw new Error('persistent grants are only chosen explicitly by a person');
        }
        await this.nexus.sendKeys(a.session_id, opt?.key ?? ESCAPE);
        decision = opt?.label ?? 'Escape';
      } else if (a.kind === 'send_keys') {
        await this.nexus.sendKeys(a.session_id, String(a.request.text ?? ''), a.request.enter === true);
        decision = 'keys sent';
      } else if (a.kind === 'stop') {
        await this.nexus.stopSession(a.session_id);
        this.hooks.stopped?.(a.session_id);
        decision = 'stopped';
      } else {
        await this.nexus.pauseSession(a.session_id, false);
        this.hooks.resumed?.(a.session_id);
        decision = 'resumed';
      }
    } catch (e: any) {
      if (!(e instanceof StaleApprovalError)) {
        reopen();
        if (e instanceof NexusError) audit(this.db, 'approval.delivery_failed', id, { error: e.message });
      }
      throw e;
    }
    this.db.prepare('UPDATE approvals SET decision=?, consumed_at=? WHERE id=? AND consumed_at IS NULL').run(decision, Date.now(), id);
    audit(this.db, `approval.${verdict}`, id, { kind: a.kind, session: a.session_id, decision, by, ...(o.rule ? { rule: o.rule } : {}) });
    return this.get(id)!;
  }
}
