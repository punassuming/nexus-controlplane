/**
 * The MCP server outside orchestrator agents (Muse, Codex, …) talk to, through the gateway. It exposes a curated,
 * deterministic surface over Nexus: orchestrators start, read, watch and guide their own tasks; anything that types
 * into a terminal or closes it is only ever a *request* that a person approves on the phone. Raw Nexus tools
 * (send_keys, stop_session, list_sessions, …) are never exposed, and an orchestrator can't see another's tasks.
 *
 * Stateless like nexusd's own server: one McpServer per request. Only the gateway can call it: it must present the
 * internal secret, and it names the (already authenticated) client in x-cp-client.
 */
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Approval, ApprovalQueue } from './approvals.ts';
import { CLIENT_HEADER, GATEWAY_SECRET_HEADER, secretMatches } from './auth.ts';
import type { CallLog } from './calls.ts';
import type { Bus, BusEvent } from './events.ts';
import type { Limits } from './limits.ts';
import type { NexusApi } from './nexus/types.ts';
import type { Policy } from './policy.ts';
import { PolicyError, type Task, type TaskStore } from './tasks.ts';

export interface OrchestratorDeps {
  tasks: TaskStore;
  approvals: ApprovalQueue;
  policy: Policy;
  nexus: NexusApi;
  bus: Bus;
  limits: Limits;
  calls: CallLog;
}

const CLIENT_ID = /^[A-Za-z0-9][\w.-]{0,63}$/;

/** Who is calling, if the request really came through the gateway. */
export function gatewayClient(headers: IncomingHttpHeaders, secret: string, policy: Policy): { client: string } | { status: number; error: string } {
  const presented = headers[GATEWAY_SECRET_HEADER];
  if (typeof presented !== 'string' || !secretMatches(presented, secret)) return { status: 401, error: 'orchestrators connect through the gateway' };
  const client = headers[CLIENT_HEADER];
  if (typeof client !== 'string' || !CLIENT_ID.test(client)) return { status: 400, error: 'bad client id' };
  if (!policy.scope(client).enabled) return { status: 403, error: `client ${client} is disabled by policy` };
  return { client };
}

const INSTRUCTIONS = `Nexus Control Plane: start and supervise coding agents in Nexus terminals.
- start_task opens one agent terminal in an allowed directory; the policy limits agents, directories and how many run at once.
- watch long-polls (≤50 s) and wakes only when a task needs input, finishes, errors, exits, an approval is decided, or a limit trips. Keep its cursor.
- guide types a prompt to an agent that is idle or working. If the agent is waiting on its own approval menu, use answer_prompt.
- answer_prompt: refusing is always allowed; approving runs at once only when a low-risk rule allows that exact prompt, otherwise it waits for the user's phone.
- request_keys and request_stop always wait for the user's phone. Poll approval_status or watch for the decision.
- You only ever see the tasks you started. Errors read "<code>: <message>".`;

const ATTENTION = new Set(['needs-input', 'done', 'error', 'exited']);

/** Does this event warrant waking an orchestrator? */
function wakes(e: BusEvent): boolean {
  if (e.type === 'agent') return ATTENTION.has(e.data.state);
  if (e.type === 'approval') return e.data.status !== 'pending';
  return e.type === 'limit';
}

function summary(t: Task) {
  return { task: t.task_id, name: t.name, agent: t.agent, status: t.status, cwd: t.cwd, created_at: t.created_at };
}

function approvalView(a: Approval) {
  return {
    approval_id: a.id, kind: a.kind, task: a.task_id, status: a.status,
    ...(a.decision ? { decision: a.decision } : {}),
    ...(a.decided_by ? { decided_by: a.decided_by } : {}),
    ...(a.status === 'pending' ? { expires_at: a.expires_at } : {}),
  };
}

export function createOrchestrator(d: OrchestratorDeps) {
  /** Compact events: an orchestrator pays for every byte in tokens. The screen tail only comes with a prompt. */
  const compact = (e: BusEvent) => {
    if (e.type === 'agent') {
      const a = e.data.state === 'needs-input' && e.data.approval_id ? d.approvals.get(e.data.approval_id) : undefined;
      return {
        seq: e.seq, type: 'agent', task: e.task_id, state: e.data.state,
        ...(e.data.detail ? { detail: e.data.detail } : {}),
        ...(a ? { approval_id: a.id, options: a.options.map((o) => ({ key: o.key, label: o.label, kind: o.kind })), tail: e.data.tail } : {}),
      };
    }
    if (e.type === 'approval') return { seq: e.seq, type: 'approval', ...approvalView(e.data) };
    return { seq: e.seq, type: e.type, task: e.task_id, ...e.data };
  };

  const own = (client: string, task: string): Task => {
    const t = d.tasks.get(task);
    // Someone else's task looks exactly like a missing one.
    if (!t || t.client_id !== client) throw new Error(`not_found: no task ${task}`);
    return t;
  };

  const live = (client: string, task: string): Task & { session_id: string } => {
    const t = own(client, task);
    if (!d.tasks.isLive(t)) throw new Error(`task_closed: task ${task} is ${t.status}`);
    return t as Task & { session_id: string };
  };

  async function watch(client: string, cursor: number | undefined, timeoutSec: number) {
    if (cursor === undefined) {
      // First call: where things stand now, and a cursor to wait from.
      return { cursor: d.bus.head(), events: [], tasks: d.tasks.list(client).filter((t) => d.tasks.isLive(t)).map(summary) };
    }
    const deadline = Date.now() + timeoutSec * 1000;
    let cur = cursor;
    for (;;) {
      const evs = d.bus.since(cur, client);
      if (evs.length) {
        cur = evs.at(-1)!.seq;
        const hits = evs.filter(wakes);
        if (hits.length) return { cursor: cur, events: hits.map(compact) };
        continue;
      }
      const left = deadline - Date.now();
      if (left <= 0) return { cursor: cur, events: [] };
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); d.bus.off('event', on); resolve(); };
        const on = (e: BusEvent) => { if (e.client_id === client) done(); };
        const timer = setTimeout(done, left);
        d.bus.on('event', on);
      });
    }
  }

  function build(client: string): McpServer {
    const mcp = new McpServer({ name: 'Nexus Control Plane', version: '0.2.0' }, { instructions: INSTRUCTIONS });
    const task = z.string().describe('A task id from start_task or list_tasks');

    /** Register a tool whose every call is logged (never the text of prompts or keys). */
    const tool = <S extends z.ZodRawShape>(name: string, description: string, inputSchema: S, fn: (a: z.infer<z.ZodObject<S>>) => Promise<unknown>) =>
      mcp.registerTool(name, { description, inputSchema }, (async (args: any) => {
        const started = Date.now();
        const task_id = typeof args?.task === 'string' ? args.task : undefined;
        try {
          const value = await fn(args);
          const text = JSON.stringify(value);
          d.calls.record({
            direction: 'in', client, tool: name, task_id, ok: true, durationMs: Date.now() - started, bytes: text.length,
            wake: name === 'watch' && ((value as any)?.events?.length ?? 0) > 0,
          });
          return { content: [{ type: 'text' as const, text }] };
        } catch (e: any) {
          const text = String(e?.message ?? e);
          d.calls.record({ direction: 'in', client, tool: name, task_id, ok: false, error: text, durationMs: Date.now() - started, bytes: text.length });
          return { content: [{ type: 'text' as const, text }], isError: true };
        }
      }) as any);

    tool('whoami', 'Who you are to the control plane, what you may start, and the limits that apply.', {}, async () => {
      const s = d.policy.scope(client);
      const p = d.policy.get();
      return {
        client, agents: s.agents, roots: s.clientRoots ?? s.roots, maxActiveTasks: p.maxActiveTasks,
        activeTasks: d.tasks.live().length, resourceLimits: d.limits.status(), cursor: d.bus.head(),
      };
    });

    tool('list_tasks', 'Your tasks, newest first.', {}, async () => d.tasks.list(client).map(summary));

    tool('start_task', 'Start a coding agent in a new Nexus terminal. The policy decides which agents and directories are allowed and how many tasks may run.',
      { agent: z.string().describe('e.g. claude'), cwd: z.string().describe('Absolute directory on the Nexus host'), prompt: z.string().optional(), name: z.string().max(40).optional() },
      async (a) => {
        try {
          const t = await d.tasks.create({ ...a, client });
          d.bus.publish('task', t);
          return { ...summary(t), cursor: d.bus.head() };
        } catch (e: any) {
          throw e instanceof PolicyError ? new Error(`policy_denied: ${e.message}`) : e;
        }
      });

    tool('task_status', "A task's state, the agent's current question and choices, resource use, and pending approvals.", { task }, async ({ task: id }) => {
      const t = own(client, id);
      const s = d.tasks.isLive(t) ? await d.nexus.getState(t.session_id!) : undefined;
      return {
        ...summary(t),
        agent: s?.agent ? { state: s.agent.state, ...(s.agent.detail ? { detail: s.agent.detail } : {}), ...(s.agent.options ? { options: s.agent.options } : {}) } : null,
        resources: d.limits.reading(t.task_id) ?? null,
        pending: d.approvals.list('pending').filter((a) => a.task_id === t.task_id).map(approvalView),
      };
    });

    tool('read_output', "The end of a task's terminal as text. Pass the returned cursor as since_cursor to get only what's new.",
      { task, lines: z.number().int().min(1).max(500).default(80), since_cursor: z.number().int().min(0).optional() },
      async ({ task: id, lines, since_cursor }) => {
        const t = own(client, id);
        if (!t.session_id) throw new Error(`task_closed: task ${id} never started`);
        return d.nexus.readSession(t.session_id, { lines, since_cursor });
      });

    tool('resources', "A task's CPU, memory and process count.", { task }, async ({ task: id }) => {
      const t = live(client, id);
      if (!d.nexus.hasTool('resource_usage')) throw new Error('unsupported: this Nexus has no resource_usage');
      return (await d.nexus.resourceUsage(t.session_id)) ?? null;
    });

    tool('watch', 'Wait (up to timeout_seconds) until one of your tasks needs input, finishes, errors or exits, an approval is decided, or a limit trips. Call first without a cursor, then always with the returned cursor.',
      { cursor: z.number().int().min(0).optional(), timeout_seconds: z.number().int().min(1).max(50).default(50) },
      async ({ cursor, timeout_seconds }) => watch(client, cursor, timeout_seconds));

    tool('guide', 'Type a prompt into your agent and press Enter. Fails with agent_blocked while it waits on its approval menu (use answer_prompt).',
      { task, text: z.string().min(1) }, async ({ task: id, text }) => {
        const t = live(client, id);
        await d.tasks.prompt(t.task_id, text, `client:${client}`);
        return { task: t.task_id, sent: true };
      });

    tool('answer_prompt', "Answer your agent's approval menu. refuse=true (or a deny choice) always runs. An approve choice runs only if a low-risk rule allows this exact prompt; otherwise it waits for the user's phone with your choice and reason attached.",
      { task, option_key: z.string().optional(), refuse: z.boolean().default(false), reason: z.string().max(500).optional() },
      async ({ task: id, option_key, refuse, reason }) => {
        const t = live(client, id);
        const a = d.approvals.pendingPrompt(t.session_id);
        if (!a) throw new Error('no_prompt: the agent is not waiting on an approval menu');
        const publish = (x: Approval) => { d.bus.publish('approval', x); return approvalView(x); };
        if (refuse) return publish(await d.approvals.decide(a.id, 'deny', `client:${client}`));
        if (option_key === undefined) throw new Error('bad_request: give option_key or refuse=true');
        const option = a.options.find((o) => o.key === option_key);
        if (!option) throw new Error(`bad_request: no option ${option_key} (choices: ${a.options.map((o) => o.key).join(', ')})`);
        const verdict = d.policy.checkAnswer({ agent: t.agent, detail: a.detail, option });
        if (verdict.verdict === 'allow') {
          return option.kind === 'deny'
            ? publish(await d.approvals.decide(a.id, 'deny', `client:${client}`, { optionKey: option_key }))
            : publish(await d.approvals.decide(a.id, 'allow', `policy:${verdict.rule}`, { optionKey: option_key, rule: verdict.rule }));
        }
        const proposed = d.approvals.propose(a.id, client, option_key, reason);
        d.bus.publish('approval', proposed);
        return { ...approvalView(proposed), waiting_for: 'phone', why: verdict.verdict === 'approval' ? verdict.reason : undefined };
      });

    tool('request_keys', "Ask the user to approve typing text into your task's terminal. Waits for the phone; nothing is typed until then.",
      { task, text: z.string().min(1).max(4000), enter: z.boolean().default(false), reason: z.string().max(500) },
      async ({ task: id, text, enter, reason }) => {
        const t = live(client, id);
        const a = d.approvals.request('send_keys', { session_id: t.session_id, task_id: t.task_id, requested_by: client, request: { text, enter }, reason });
        d.bus.publish('approval', a);
        return { ...approvalView(a), waiting_for: 'phone' };
      });

    tool('request_stop', 'Ask the user to approve closing your task\'s terminal (and everything running in it). Waits for the phone.',
      { task, reason: z.string().max(500) }, async ({ task: id, reason }) => {
        const t = live(client, id);
        const a = d.approvals.request('stop', { session_id: t.session_id, task_id: t.task_id, requested_by: client, reason });
        d.bus.publish('approval', a);
        return { ...approvalView(a), waiting_for: 'phone' };
      });

    tool('approval_status', 'Where one of your approvals stands.', { approval_id: z.string() }, async ({ approval_id }) => {
      const a = d.approvals.get(approval_id);
      if (!a?.task_id) throw new Error(`not_found: no approval ${approval_id}`);
      own(client, a.task_id);
      return approvalView(a);
    });

    return mcp;
  }

  /** Serve one POST (already authenticated as `client`). */
  return async function handle(req: IncomingMessage, res: ServerResponse, body: unknown, client: string): Promise<void> {
    const mcp = build(client);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  };
}
