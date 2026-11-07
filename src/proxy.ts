/**
 * The MCP proxy orchestrators sign on to, through the gateway. On sign-on they see Nexus's own tools (reached with
 * the supervisor token the control plane holds), intercepted per nexus/adapter.ts, plus the tools of any other
 * upstream the policy allows, plus two cp_ tools to follow approvals. Every transaction, both directions, goes into
 * the call log (masked payloads when transcripts.level is full).
 *
 * Stateless like nexusd's own server: one Server per request. Only the gateway can call it: it must present the
 * internal secret, and it names the (already authenticated) client.
 */
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Approval, ApprovalQueue } from './approvals.ts';
import { CLIENT_HEADER, GATEWAY_SECRET_HEADER, secretMatches } from './auth.ts';
import { callContext, type CallLog, type CallRecord } from './calls.ts';
import type { Bus } from './events.ts';
import type { Limits } from './limits.ts';
import { nexusAdapter, type Outcome } from './nexus/adapter.ts';
import { NexusError, type RawResult, type ToolDef } from './nexus/client.ts';
import type { Policy } from './policy.ts';
import type { TaskStore } from './tasks.ts';
import type { Upstreams } from './upstreams.ts';

export interface ProxyDeps {
  db: DatabaseSync;
  upstreams: Upstreams;
  tasks: TaskStore;
  approvals: ApprovalQueue;
  policy: Policy;
  limits: Limits;
  calls: CallLog;
  bus: Bus;
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

const INSTRUCTIONS = `You are connected to Nexus through the Nexus Control Plane, a supervising proxy.
- These are Nexus's own tools, scoped to the agents you start. start_agent runs in the background, in a directory the policy allows.
- Watch your agents with watch_agents (≤50 s per call; keep the cursor). Guide them with prompt_agent.
- send_keys on your agent's approval menu answers it: refusing runs at once; approving runs at once only if a low-risk rule allows that exact prompt. Everything else that types into a terminal, and stop_session, waits for the user's approval on their phone and returns {status: "pending_approval", approval_id}.
- Follow approvals with cp_approval_status or cp_list_approvals. Do not retry a pending request; it would only wait again.
- Every call is recorded.`;

const CP_TOOLS: ToolDef[] = [
  {
    name: 'cp_approval_status',
    description: 'Where one of your approval requests stands: pending, approved, denied, expired or stale (the terminal changed before it could run). For an approved upstream tool call, includes its result.',
    inputSchema: { type: 'object', properties: { approval_id: { type: 'string' } }, required: ['approval_id'], additionalProperties: false },
  },
  {
    name: 'cp_list_approvals',
    description: "Your approval requests that are still waiting for the user.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const text = (v: unknown): RawResult => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const error = (message: string): RawResult => ({ content: [{ type: 'text', text: message }], isError: true });

function approvalView(a: Approval) {
  return {
    approval_id: a.id, kind: a.kind, status: a.status,
    ...(a.task_id ? { task: a.task_id } : {}),
    ...(a.decision ? { decision: a.decision } : {}),
    ...(a.decided_by ? { decided_by: a.decided_by } : {}),
    ...(a.status === 'pending' ? { expires_at: new Date(a.expires_at).toISOString() } : {}),
    ...(a.kind === 'tool_call' && a.result ? { result: a.result } : {}),
  };
}

export function createProxy(d: ProxyDeps) {
  const publish = (a: Approval) => d.bus.publish('approval', a);
  const nexus = nexusAdapter({ db: d.db, tasks: d.tasks, approvals: d.approvals, policy: d.policy, limits: d.limits, publish });

  const mine = (client: string, a: Approval | undefined): boolean =>
    !!a && (a.requested_by === client || (!!a.task_id && d.tasks.get(a.task_id)?.client_id === client));

  /** Everything this client may see, under the names it sees them by. */
  function listTools(): ToolDef[] {
    const out: ToolDef[] = [...CP_TOOLS];
    const seen = new Set(out.map((t) => t.name));
    for (const u of d.upstreams.all()) {
      for (const def of u.client.toolDefs()) {
        const exposed = u.id === 'nexus' ? nexus.describe(def) : (() => {
          const rule = d.policy.toolRule(u.id, def.name);
          if (rule === 'deny') return undefined;
          const note = rule === 'approve' ? "\n\nThrough the control plane: waits for the user's approval on their phone (you get an approval_id)." : '';
          return { ...def, description: `${def.description ?? ''}${note}`.trim() };
        })();
        if (!exposed) continue;
        const name = `${u.prefix}${def.name}`;
        if (seen.has(name)) continue; // first upstream wins a name clash
        seen.add(name);
        out.push({ ...exposed, name });
      }
    }
    return out;
  }

  /** What to do with one call. */
  async function route(client: string, name: string, args: Record<string, any>): Promise<Outcome & { upstream?: string; tool?: string }> {
    if (name === 'cp_approval_status') {
      const a = d.approvals.get(String(args.approval_id ?? ''));
      return mine(client, a) ? { kind: 'local', value: approvalView(a!) } : { kind: 'deny', message: `not_found: no approval ${args.approval_id}` };
    }
    if (name === 'cp_list_approvals') {
      return { kind: 'local', value: d.approvals.list('pending').filter((a) => mine(client, a)).map(approvalView) };
    }
    const hit = d.upstreams.resolve(name);
    if (!hit) return { kind: 'deny', message: `unknown_tool: ${name}` };
    const { upstream, tool } = hit;
    if (upstream.id === 'nexus') return { ...(await nexus.handle(client, tool, args)), upstream: 'nexus', tool };
    const rule = d.policy.toolRule(upstream.id, tool);
    if (rule === 'deny') return { kind: 'deny', message: `unknown_tool: ${name}` };
    if (rule === 'approve') {
      const a = d.approvals.request('tool_call', { session_id: '', requested_by: client, request: { upstream: upstream.id, tool, args } });
      publish(a);
      return { kind: 'approval', approval: a, why: `the policy requires approval for ${name}`, upstream: upstream.id, tool };
    }
    return { kind: 'forward', args, upstream: upstream.id, tool };
  }

  async function call(client: string, name: string, args: Record<string, any>): Promise<RawResult> {
    const started = Date.now();
    const log: Partial<CallRecord> = { client, tool: name, request: args };
    let result: RawResult;
    try {
      const o = await callContext.run({ client }, () => route(client, name, args));
      log.upstream = o.upstream;
      if ('task_id' in o) log.task_id = o.task_id;
      if ('session_id' in o) log.session_id = o.session_id;
      if (o.kind === 'deny') {
        log.decision = 'denied';
        result = error(o.message);
      } else if (o.kind === 'local') {
        log.decision = 'local';
        result = text(o.value);
      } else if (o.kind === 'approval') {
        log.decision = 'approval';
        log.approval_id = o.approval.id;
        result = text({
          status: 'pending_approval', approval_id: o.approval.id, kind: o.approval.kind, waiting_for: "the user's phone",
          ...(o.why ? { why: o.why } : {}), expires_at: new Date(o.approval.expires_at).toISOString(),
          next: 'check cp_approval_status later; do not retry',
        });
      } else {
        log.decision = 'forwarded';
        const upstream = d.upstreams.get(o.upstream!)!;
        const raw = await callContext.run({ client, task_id: o.task_id }, () => upstream.client.callRaw(o.tool!, o.args, o.timeoutMs));
        result = o.post ? o.post(raw) : raw;
        if (o.wakes && !result.isError) {
          const v = (() => { try { return JSON.parse(String(result.content?.[0]?.text ?? '')); } catch { return undefined; } })();
          log.wake = (v?.events?.length ?? 0) > 0;
        }
      }
    } catch (e: any) {
      log.decision = 'error';
      result = error(e instanceof NexusError ? e.message : `error: ${e?.message ?? e}`);
    }
    const body = result.content?.map((c: any) => c.text ?? '').join('') ?? '';
    d.calls.record({
      ...(log as CallRecord), direction: 'in', ok: !result.isError, durationMs: Date.now() - started, bytes: body.length,
      response: body, ...(result.isError ? { error: body.slice(0, 300) } : {}),
    });
    return result;
  }

  function build(client: string): Server {
    const server = new Server({ name: 'Nexus Control Plane', version: '0.3.0' }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = listTools();
      d.calls.record({ direction: 'in', client, tool: 'tools/list', ok: true, durationMs: 0, bytes: JSON.stringify(tools).length, decision: 'local' });
      return { tools } as any;
    });
    server.setRequestHandler(CallToolRequestSchema, async (req) => call(client, req.params.name, (req.params.arguments ?? {}) as Record<string, any>) as any);
    return server;
  }

  /** Serve one POST (already authenticated as `client`). */
  return async function handle(req: IncomingMessage, res: ServerResponse, body: unknown, client: string): Promise<void> {
    const server = build(client);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };
}
