import type { TestContext } from 'node:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ApprovalQueue } from '../src/approvals.ts';
import { CLIENT_HEADER, GATEWAY_SECRET_HEADER } from '../src/auth.ts';
import { CallLog } from '../src/calls.ts';
import { ClientRegistry } from '../src/clients.ts';
import { openDb } from '../src/db.ts';
import { Bus, Poller } from '../src/events.ts';
import { Limits } from '../src/limits.ts';
import { NexusClient } from '../src/nexus/client.ts';
import type { PromptOption } from '../src/nexus/types.ts';
import { Policy, type PolicyInput } from '../src/policy.ts';
import { buildServer } from '../src/server.ts';
import { Push } from '../src/push.ts';
import { TaskStore } from '../src/tasks.ts';
import { Upstreams, type Upstream } from '../src/upstreams.ts';
import { MockNexus } from './mock-nexus.ts';

/** Typed options as get_state returns them for a Claude Code permission prompt. */
export const OPTS: PromptOption[] = [
  { key: '1', label: 'Yes', kind: 'approve', selected: true },
  { key: '2', label: "Yes, and don't ask again for npm test", kind: 'approve' },
  { key: '3', label: 'No, and tell Claude what to do differently', kind: 'deny' },
];

export const tmp = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

/** The whole control plane wired to a fresh mock Nexus, with one allowed root. */
export async function harness(t: TestContext, o: { issue56?: boolean; policy?: PolicyInput; extraUpstreams?: Upstream[] } = {}) {
  const nexus = new MockNexus('sup-token', o.issue56 ?? true);
  await nexus.start();
  t.after(() => nexus.stop());
  const root = tmp('cp-root-');
  const db = openDb(':memory:');
  const policy = new Policy(undefined, { roots: [root], agents: ['claude', 'codex'], maxActiveTasks: 5, ...o.policy });
  const calls = new CallLog(db, policy);
  const client = new NexusClient(nexus.url, nexus.token, (c) => calls.record(c));
  await client.listTools();
  const upstreams = new Upstreams(client, o.extraUpstreams ?? []);
  await upstreams.refresh();
  const bus = new Bus(db);
  const tasks = new TaskStore(db, client, policy);
  let limits: Limits;
  const approvals = new ApprovalQueue(db, client, () => policy.get().approvalTtlMs, {
    stopped: (s) => tasks.markStopped(s, 'approval'),
    resumed: (s) => limits.resumed(s),
    callUpstream: async (u, tool, args) => {
      const r = await upstreams.get(u)!.client.callRaw(tool, args);
      return r.content.map((c: any) => c.text ?? '').join('');
    },
  });
  limits = new Limits(db, client, tasks, approvals, bus, policy);
  const poller = new Poller(db, client, tasks, approvals, bus, 1);
  const sent = () => nexus.calls.filter((c) => c.tool === 'send_keys').map((c) => c.args);
  const nexusCalls = (tool: string) => nexus.calls.filter((c) => c.tool === tool);
  const auditKinds = () => (db.prepare('SELECT kind FROM audit ORDER BY id').all() as any[]).map((r) => r.kind);
  // Web Push with a capturing sender instead of a real push service.
  const pushed: { endpoint: string; payload: any }[] = [];
  const push = new Push(db, join(tmp('cp-vapid-'), 'vapid.json'), 'mailto:test@example.invalid', (async (sub: any, payload: any) => {
    pushed.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
    return { statusCode: 201, body: '', headers: {} };
  }) as any);
  push.attach(bus, tasks);
  return { nexus, root, db, calls, policy, client, upstreams, bus, tasks, approvals, limits, poller, push, pushed, sent, nexusCalls, auditKinds };
}

export type Harness = Awaited<ReturnType<typeof harness>>;

/** Start a task and bring it to an approval prompt the poller has seen. */
export async function atPrompt(h: Harness, detail = 'Bash: npm test', options = OPTS, client?: string) {
  const task = await h.tasks.create({ agent: 'claude', cwd: h.root, prompt: 'run the tests', name: 'pilot', client });
  await h.poller.tick(); // establishes the cursor
  h.nexus.setState(task.session_id!, 'needs-input', { detail, options });
  await h.poller.tick();
  const approval = h.approvals.pendingPrompt(task.session_id!)!;
  return { task, approval };
}

/** The HTTP server (UI API + orchestrator endpoint) on a random loopback port. */
export async function serve(t: TestContext, h: Harness, auth: Parameters<typeof buildServer>[0]['auth'] = { mode: 'none', token: '', allowedUsers: [] }) {
  const secret = 's'.repeat(43);
  const dir = tmp('cp-clients-');
  const clients = new ClientRegistry(join(dir, 'clients.json'));
  const app = buildServer({
    db: h.db, upstreams: h.upstreams, tasks: h.tasks, approvals: h.approvals, bus: h.bus, policy: h.policy, limits: h.limits, calls: h.calls, push: h.push,
    clients, gatewaySecret: () => secret, auth, status: () => ({ online: true }),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  return { app, base, secret, clients, clientsDir: dir };
}

/** An MCP client for the orchestrator endpoint. `call` returns parsed JSON, or throws the tool's error text. */
export async function mcpClient(t: TestContext, url: string, headers: Record<string, string>) {
  const c = new Client({ name: 'test-orchestrator', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  t.after(() => c.close());
  return {
    raw: c,
    async call(name: string, args: Record<string, unknown> = {}): Promise<any> {
      const r: any = await c.callTool({ name, arguments: args }, undefined, { timeout: 70_000 });
      const text = r.content?.[0]?.text ?? '';
      if (r.isError) throw new Error(text);
      return JSON.parse(text);
    },
  };
}

/** A tool result's JSON (the proxy and Nexus answer in text content). */
export const json = (r: any) => JSON.parse(r.content[0].text);

/** Straight to the control plane, as the gateway would call it. */
export function asGateway(base: string, secret: string, client: string) {
  return { url: `${base}/orchestrator/mcp`, headers: { [GATEWAY_SECRET_HEADER]: secret, [CLIENT_HEADER]: client } };
}
