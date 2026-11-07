/**
 * How the proxy treats each Nexus tool when an orchestrator calls it with the shared supervisor token. Nexus sees one
 * caller (the supervisor) for every orchestrator, so this is where orchestrators are kept apart: every session
 * argument must be one of the caller's own tasks, and every list is filtered to them.
 *
 *   whoami                                answered here: which orchestrator, and its policy scope
 *   list_sessions, where, resource_usage  forwarded, filtered to the caller's sessions
 *   read_session, get_state, wait_for     own sessions only; waits capped at 50 s (MCP clients give up near 60)
 *   watch_agents                          own sessions only; a call that returns events is one wake
 *   start_agent                           policy (agent, directory, active tasks); background; no extra CLI args
 *   prompt_agent                          guidance; never `force` (that would type into a blocked approval menu)
 *   send_keys                             on the agent's approval menu: an answer (refusals and low-risk matches
 *                                         run, the rest waits for the phone); any other typing waits for the phone
 *   stop_session                          waits for the phone
 *   pause_session                         pausing runs; resuming what the limiter paused waits for the phone
 *   anything else                         hidden unless the policy's upstreams.nexus allows it
 */
import type { DatabaseSync } from 'node:sqlite';
import { StaleApprovalError, type Approval, type ApprovalQueue } from '../approvals.ts';
import { audit } from '../db.ts';
import type { Limits } from '../limits.ts';
import type { Policy } from '../policy.ts';
import { PolicyError, type Task, type TaskStore } from '../tasks.ts';
import type { RawResult, ToolDef } from './client.ts';

export type Outcome =
  | { kind: 'forward'; args: Record<string, unknown>; timeoutMs?: number; post?: (r: RawResult) => RawResult; task_id?: string; session_id?: string; wakes?: boolean }
  | { kind: 'local'; value: unknown; task_id?: string; session_id?: string }
  | { kind: 'approval'; approval: Approval; why?: string; task_id?: string; session_id?: string }
  | { kind: 'deny'; message: string };

export interface AdapterDeps {
  db: DatabaseSync;
  tasks: TaskStore;
  approvals: ApprovalQueue;
  policy: Policy;
  limits: Limits;
  publish: (a: Approval) => void;
}

const MAX_WAIT_SECONDS = 50;
const KNOWN = new Set(['whoami', 'list_sessions', 'where', 'read_session', 'start_agent', 'prompt_agent', 'wait_for', 'watch_agents',
  'send_keys', 'stop_session', 'get_state', 'pause_session', 'resource_usage']);

/** What orchestrators are told about the control plane's handling, appended to Nexus's own descriptions. */
const NOTES: Record<string, string> = {
  start_agent: 'Through the control plane: always in the background; the agent and directory must be allowed by policy; extra CLI args are refused; cwd is required.',
  prompt_agent: 'Through the control plane: force is refused; waits are capped at 50 s.',
  wait_for: 'Through the control plane: waits are capped at 50 s; call again to keep waiting.',
  watch_agents: 'Through the control plane: only your own agents.',
  send_keys: "Through the control plane: picking an option of your agent's approval menu runs at once only when refusing or when a low-risk rule allows that exact prompt; otherwise, and for any other typing, it waits for the user's approval on their phone (you get an approval_id).",
  stop_session: "Through the control plane: waits for the user's approval on their phone (you get an approval_id).",
  pause_session: "Through the control plane: resuming a task the resource limiter paused waits for the user's approval.",
  list_sessions: 'Through the control plane: only your own terminals.',
  where: 'Through the control plane: only your own terminals.',
};

function parse(r: RawResult): any {
  const text = r.content?.map((c: any) => c.text ?? '').join('') ?? '';
  try { return JSON.parse(text); } catch { return undefined; }
}

function replace(r: RawResult, value: unknown): RawResult {
  return { ...r, content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

const sid = (x: any): string | undefined => (typeof x?.sessionId === 'string' ? x.sessionId : typeof x?.id === 'string' ? x.id : undefined);

export function nexusAdapter(d: AdapterDeps) {
  /** The caller's task for a session argument (id, name or unique name prefix), or undefined. */
  function own(client: string, target: unknown): Task | undefined {
    if (typeof target !== 'string' || !target || target === 'self') return undefined;
    const mine = d.tasks.list(client).filter((t) => t.session_id);
    const exact = mine.find((t) => t.session_id === target || t.name === target);
    if (exact) return exact;
    const prefixed = mine.filter((t) => t.name.startsWith(target));
    return prefixed.length === 1 ? prefixed[0] : undefined;
  }

  const notFound = (target: unknown): Outcome => ({ kind: 'deny', message: `not_found: no session ${String(target)} among your tasks` });

  /** Keep only the caller's sessions in a Nexus answer (arrays of sessions, and `sessions` fields). */
  function filtered(client: string): (r: RawResult) => RawResult {
    const owned = new Set(d.tasks.list(client).map((t) => t.session_id).filter(Boolean) as string[]);
    return (r) => {
      if (r.isError) return r;
      const v = parse(r);
      if (v === undefined) return r;
      const keep = (list: any[]) => list.filter((x) => { const id = sid(x); return id === undefined || owned.has(id); });
      if (Array.isArray(v)) return replace(r, keep(v));
      if (v && typeof v === 'object') {
        const out: any = { ...v };
        const all = Array.isArray(v.sessions) ? v.sessions.map(sid).filter(Boolean) as string[] : [];
        const foreign = all.filter((id) => !owned.has(id));
        if (Array.isArray(v.sessions)) out.sessions = keep(v.sessions);
        // Overlaps name other terminals; keep only those that mention none of someone else's.
        if (Array.isArray(v.overlaps)) out.overlaps = v.overlaps.filter((o: any) => !foreign.some((id) => JSON.stringify(o).includes(id)));
        if (Array.isArray(v.events)) out.events = v.events.filter((e: any) => owned.has(e.sessionId));
        return replace(r, out);
      }
      return r;
    };
  }

  const clampWait = (v: unknown, dflt: number) => Math.min(typeof v === 'number' && v > 0 ? v : dflt, MAX_WAIT_SECONDS);

  return {
    /** The tool as orchestrators see it, or undefined to hide it. */
    describe(def: ToolDef): ToolDef | undefined {
      if (!KNOWN.has(def.name) && d.policy.toolRule('nexus', def.name) === 'deny') return undefined;
      const note = NOTES[def.name];
      return note ? { ...def, description: `${def.description ?? ''}\n\n${note}`.trim() } : def;
    },

    async handle(client: string, tool: string, args: Record<string, any>): Promise<Outcome> {
      switch (tool) {
        case 'whoami': {
          const s = d.policy.scope(client);
          return {
            kind: 'local', value: {
              client, via: 'nexus-controlplane', access: 'supervisor, scoped to the tasks you start',
              agents: s.agents, roots: s.clientRoots ?? s.roots, maxActiveTasks: d.policy.get().maxActiveTasks,
              activeTasks: d.tasks.live().length, resourceLimits: d.limits.status(),
              can: 'start agents in allowed directories, read and watch them, guide them; typing keys and stopping need the user\'s approval',
            },
          };
        }

        case 'list_sessions':
        case 'where':
          return { kind: 'forward', args, post: filtered(client) };

        case 'resource_usage': {
          if (args.session === undefined) return { kind: 'forward', args, post: filtered(client) };
          const t = own(client, args.session);
          return t ? { kind: 'forward', args: { ...args, session: t.session_id }, task_id: t.task_id, session_id: t.session_id! } : notFound(args.session);
        }

        case 'read_session':
        case 'get_state': {
          const t = own(client, args.session);
          return t ? { kind: 'forward', args: { ...args, session: t.session_id }, task_id: t.task_id, session_id: t.session_id! } : notFound(args.session);
        }

        case 'wait_for': {
          const t = own(client, args.session);
          if (!t) return notFound(args.session);
          const timeout_seconds = clampWait(args.timeout_seconds, 600);
          return { kind: 'forward', args: { ...args, session: t.session_id, timeout_seconds }, timeoutMs: (timeout_seconds + 10) * 1000, task_id: t.task_id, session_id: t.session_id! };
        }

        case 'watch_agents': {
          let sessions: string[];
          if (Array.isArray(args.sessions)) {
            const ts = args.sessions.map((s: unknown) => own(client, s));
            const missing = args.sessions.find((_s: unknown, i: number) => !ts[i]);
            if (missing !== undefined) return notFound(missing);
            sessions = ts.map((t: Task | undefined) => t!.session_id!);
          } else {
            sessions = d.tasks.list(client).filter((t) => d.tasks.isLive(t)).map((t) => t.session_id!);
          }
          if (!sessions.length) return { kind: 'local', value: { events: [], cursor: args.cursor ?? 0, next: 'you have no live tasks; start one with start_agent' } };
          const timeout_seconds = clampWait(args.timeout_seconds, MAX_WAIT_SECONDS);
          return {
            kind: 'forward', args: { ...args, sessions, include: 'children', timeout_seconds },
            timeoutMs: (timeout_seconds + 10) * 1000, post: filtered(client), wakes: true,
          };
        }

        case 'start_agent': {
          if (typeof args.cwd !== 'string' || !args.cwd) return { kind: 'deny', message: 'bad_request: cwd is required' };
          if (Array.isArray(args.args) && args.args.length) return { kind: 'deny', message: 'policy_denied: extra agent CLI args are not allowed through the control plane' };
          try {
            const t = await d.tasks.create({ agent: String(args.agent), cwd: args.cwd, prompt: args.prompt, name: args.name, client });
            return {
              kind: 'local', task_id: t.task_id, session_id: t.session_id!,
              value: { id: t.session_id, name: t.name, agent: { id: t.agent, state: t.status }, cwd: t.cwd, task: t.task_id },
            };
          } catch (e: any) {
            if (e instanceof PolicyError) return { kind: 'deny', message: `policy_denied: ${e.message}` };
            throw e;
          }
        }

        case 'prompt_agent': {
          const t = own(client, args.session);
          if (!t) return notFound(args.session);
          if (args.force === true) return { kind: 'deny', message: 'policy_denied: force would type into a blocked approval menu; answer it with send_keys' };
          const timeout_seconds = clampWait(args.timeout_seconds, 900);
          audit(d.db, 'task.prompt', t.task_id, { session: t.session_id, length: String(args.text ?? '').length, by: `client:${client}` });
          return { kind: 'forward', args: { ...args, session: t.session_id, timeout_seconds, force: false }, timeoutMs: (timeout_seconds + 10) * 1000, task_id: t.task_id, session_id: t.session_id! };
        }

        case 'send_keys': {
          const t = own(client, args.session);
          if (!t || !d.tasks.isLive(t)) return notFound(args.session);
          const text = String(args.text ?? '');
          const prompt = d.approvals.pendingPrompt(t.session_id!);
          const at = { task_id: t.task_id, session_id: t.session_id! };
          if (prompt) {
            const refuse = text === '\x1b' || /^esc(ape)?$/i.test(text.trim());
            const option = prompt.options.find((o) => o.key === text.trim());
            if (refuse || option) {
              const verdict = d.policy.checkAnswer({ agent: t.agent, detail: prompt.detail, option: refuse ? undefined : option });
              try {
                if (verdict.verdict === 'allow') {
                  const decided = !option || option.kind === 'deny'
                    ? await d.approvals.decide(prompt.id, 'deny', `client:${client}`, option ? { optionKey: option.key } : {})
                    : await d.approvals.decide(prompt.id, 'allow', `policy:${verdict.rule}`, { optionKey: option.key, rule: verdict.rule });
                  d.publish(decided);
                  return { kind: 'local', ...at, value: { sent: true, approval_id: decided.id, decision: decided.decision, decided_by: decided.decided_by } };
                }
              } catch (e) {
                if (e instanceof StaleApprovalError) return { kind: 'deny', message: `stale: ${e.message}` };
                throw e;
              }
              const proposed = d.approvals.propose(prompt.id, client, option!.key);
              d.publish(proposed);
              return { kind: 'approval', approval: proposed, why: verdict.verdict === 'approval' ? verdict.reason : undefined, ...at };
            }
          }
          const a = d.approvals.request('send_keys', { session_id: t.session_id!, task_id: t.task_id, requested_by: client, request: { text, enter: args.enter === true } });
          d.publish(a);
          return { kind: 'approval', approval: a, why: 'typing into a terminal needs the user\'s approval', ...at };
        }

        case 'stop_session': {
          const t = own(client, args.session);
          if (!t || !d.tasks.isLive(t)) return notFound(args.session);
          const a = d.approvals.request('stop', { session_id: t.session_id!, task_id: t.task_id, requested_by: client });
          d.publish(a);
          return { kind: 'approval', approval: a, why: 'closing a terminal needs the user\'s approval', task_id: t.task_id, session_id: t.session_id! };
        }

        case 'pause_session': {
          const t = own(client, args.session);
          if (!t || !d.tasks.isLive(t)) return notFound(args.session);
          if (args.paused === false && d.limits.pausedByLimiter(t.session_id!)) {
            const a = d.approvals.request('resume', { session_id: t.session_id!, task_id: t.task_id, requested_by: client, reason: `${client} asks to resume` });
            d.publish(a);
            return { kind: 'approval', approval: a, why: 'the resource limiter paused this task', task_id: t.task_id, session_id: t.session_id! };
          }
          return { kind: 'forward', args: { ...args, session: t.session_id }, task_id: t.task_id, session_id: t.session_id! };
        }

        default: {
          // A Nexus tool this proxy doesn't know yet, allowed by policy. Session arguments still have to be the caller's.
          const rule = d.policy.toolRule('nexus', tool);
          if (rule === 'deny') return { kind: 'deny', message: `unknown_tool: ${tool}` };
          if (args.session !== undefined) {
            const t = own(client, args.session);
            if (!t) return notFound(args.session);
            args = { ...args, session: t.session_id };
          }
          if (rule === 'approve') {
            const a = d.approvals.request('tool_call', { session_id: '', requested_by: client, request: { upstream: 'nexus', tool, args } });
            d.publish(a);
            return { kind: 'approval', approval: a, why: `the policy requires approval for ${tool}` };
          }
          return { kind: 'forward', args, post: filtered(client) };
        }
      }
    },
  };
}
