import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { NexusClient } from '../src/nexus/client.ts';
import { asGateway, harness, mcpClient, OPTS, serve } from './helpers.ts';

async function setup(t: any, o: Parameters<typeof harness>[1] = {}) {
  const h = await harness(t, o);
  const s = await serve(t, h);
  const as = async (client: string) => {
    const g = asGateway(s.base, s.secret, client);
    return mcpClient(t, g.url, g.headers);
  };
  return { h, s, muse: await as('muse'), as };
}

/** Start an agent through the proxy and return its session id. */
async function start(m: any, h: any, extra: object = {}) {
  const r = await m.call('start_agent', { agent: 'claude', cwd: h.root, prompt: 'go', ...extra });
  return r.id as string;
}

/** A second MCP server behind the proxy, to exercise the generic upstream rules. */
async function otherUpstream(t: any) {
  const calls: { tool: string; args: any }[] = [];
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer gh-token') return void res.writeHead(401).end();
    if (req.method !== 'POST') return void res.writeHead(405).end(); // stateless, like nexusd
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const mcp = new McpServer({ name: 'github', version: '0' });
    for (const name of ['search', 'delete_repo', 'read_secrets']) {
      mcp.registerTool(name, { description: `${name} tool`, inputSchema: { q: z.string().optional() } }, async (a: any) => {
        calls.push({ tool: name, args: a });
        return { content: [{ type: 'text' as const, text: JSON.stringify({ tool: name, token: 'ghp_abcdefghijklmnopqrstuvwxyz0123', ok: true }) }] };
      });
    }
    const tr = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void tr.close(); void mcp.close(); });
    await mcp.connect(tr);
    await tr.handleRequest(req, res, JSON.parse(Buffer.concat(chunks).toString()));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${(server.address() as any).port}/mcp`, calls };
}

test('only the gateway gets in: wrong secret 401, bad client id 400, disabled client 403', async (t) => {
  const { s } = await setup(t, { policy: { clients: { off: { enabled: false } } } });
  const post = (headers: Record<string, string>) => fetch(`${s.base}/orchestrator/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: '{}',
  }).then((r) => r.status);
  assert.equal(await post({ 'x-cp-client': 'muse' }), 401);
  assert.equal(await post({ 'x-cp-gateway': 'nope', 'x-cp-client': 'muse' }), 401);
  assert.equal(await post({ 'x-cp-gateway': s.secret, 'x-cp-client': '../x' }), 400);
  assert.equal(await post({ 'x-cp-gateway': s.secret, 'x-cp-client': 'off' }), 403);
});

test('sign-on: the orchestrator sees Nexus\'s own tools (annotated) plus cp_ tools, and whoami is answered by the proxy', async (t) => {
  const { muse, h } = await setup(t);
  const { tools } = await muse.raw.listTools();
  const names = tools.map((x) => x.name);
  for (const n of ['whoami', 'list_sessions', 'where', 'read_session', 'start_agent', 'prompt_agent', 'wait_for', 'watch_agents',
    'send_keys', 'stop_session', 'get_state', 'pause_session', 'resource_usage', 'cp_approval_status', 'cp_list_approvals']) assert.ok(names.includes(n), n);
  const sendKeys = tools.find((x) => x.name === 'send_keys')!;
  assert.match(sendKeys.description!, /waits for the user's approval/);
  assert.deepEqual(Object.keys((sendKeys.inputSchema as any).properties).sort(), ['enter', 'session', 'text'], "Nexus's own schema, passed through");
  const me = await muse.call('whoami');
  assert.deepEqual([me.client, me.via], ['muse', 'nexus-controlplane']);
  assert.equal(h.nexusCalls('whoami').length, 0, 'not forwarded: Nexus would answer as the supervisor');
});

test('a Nexus tool the proxy does not know is hidden unless the policy allows it', async (t) => {
  const { h, muse } = await setup(t);
  h.nexus.extraTool = true;
  await h.upstreams.refresh();
  assert.ok(!(await muse.raw.listTools()).tools.some((x) => x.name === 'rename_session'));
  await assert.rejects(muse.call('rename_session', { session: 'x', name: 'y' }), /unknown_tool/);
  h.policy.get().upstreams.nexus = { default: 'deny', tools: { rename_session: 'allow' } };
  const s = await start(muse, h);
  assert.ok((await muse.raw.listTools()).tools.some((x) => x.name === 'rename_session'));
  const renamed: any = await muse.raw.callTool({ name: 'rename_session', arguments: { session: s, name: 'renamed' } });
  assert.match(renamed.content[0].text, /renamed s1/);
  await assert.rejects(muse.call('rename_session', { session: 'someone-else', name: 'y' }), /not_found/);
});

test('start_agent: policy-checked, background, no extra CLI args, cwd required', async (t) => {
  const { h, muse } = await setup(t, { policy: { maxActiveTasks: 1 } });
  await assert.rejects(muse.call('start_agent', { agent: 'claude' }), /cwd is required/);
  await assert.rejects(muse.call('start_agent', { agent: 'claude', cwd: '/' }), /policy_denied: .*outside/);
  await assert.rejects(muse.call('start_agent', { agent: 'aider', cwd: h.root }), /policy_denied: .*not allowed/);
  await assert.rejects(muse.call('start_agent', { agent: 'claude', cwd: h.root, args: ['--dangerously-skip-permissions'] }), /extra agent CLI args/);
  const r = await muse.call('start_agent', { agent: 'claude', cwd: h.root, name: 'pilot', placement: 'split' });
  assert.match(r.name, /^cp-pilot-/);
  assert.equal(h.nexusCalls('start_agent').at(-1)!.args.placement, 'background');
  assert.equal(h.tasks.get(r.task)!.client_id, 'muse');
  await assert.rejects(muse.call('start_agent', { agent: 'claude', cwd: h.root }), /limit is 1/);
});

test('isolation: lists are filtered, other sessions look missing, watch_agents only sees your own', async (t) => {
  const { h, muse, as } = await setup(t);
  const codex = await as('codex-bot');
  const mine = await start(muse, h);
  const theirs = await start(codex, h);
  const ui = (await h.tasks.create({ agent: 'claude', cwd: h.root })).session_id!;
  h.nexus.overlaps = [{ sessions: [mine, theirs], files: ['a.ts'] }, { sessions: [mine], files: ['b.ts'] }];

  assert.deepEqual((await muse.call('list_sessions')).map((x: any) => x.id), [mine]);
  const where = await muse.call('where');
  assert.deepEqual(where.sessions.map((x: any) => x.sessionId), [mine]);
  assert.deepEqual(where.overlaps, [{ sessions: [mine], files: ['b.ts'] }], 'an overlap naming someone else\'s terminal is dropped');
  assert.deepEqual((await muse.call('resource_usage')).sessions.map((x: any) => x.sessionId), [mine]);

  for (const target of [theirs, ui, 'self']) {
    for (const [tool, args] of [['read_session', {}], ['get_state', {}], ['wait_for', {}], ['prompt_agent', { text: 'x' }], ['send_keys', { text: 'x' }],
      ['stop_session', {}], ['pause_session', { paused: true }], ['resource_usage', {}]] as const) {
      await assert.rejects(muse.call(tool, { session: target, ...args }), /not_found/, `${tool} ${target}`);
    }
    await assert.rejects(muse.call('watch_agents', { sessions: [target] }), /not_found/);
  }

  await h.poller.tick();
  const w = muse.call('watch_agents', { timeout_seconds: 2 });
  await new Promise((r) => setTimeout(r, 200));
  h.nexus.setState(theirs, 'needs-input', { detail: 'x', options: OPTS });
  assert.deepEqual((await w).events, [], 'codex-bot\'s prompt never reaches muse');
  const args = h.nexusCalls('watch_agents').at(-1)!.args;
  assert.deepEqual([args.sessions, args.include], [[mine], 'children']);
});

test('prompt_agent: guidance goes through; force is refused; long waits are capped at 50 s', async (t) => {
  const { h, muse } = await setup(t);
  const s = await start(muse, h);
  await muse.call('prompt_agent', { session: s, text: 'add tests' });
  const p = h.nexusCalls('prompt_agent').at(-1)!.args;
  assert.deepEqual([p.timeout_seconds, p.force], [50, false]);
  await assert.rejects(muse.call('prompt_agent', { session: s, text: '1', force: true }), /force would type into a blocked approval menu/);
  await muse.call('wait_for', { session: s, timeout_seconds: 600 });
  assert.equal(h.nexusCalls('wait_for').at(-1)!.args.timeout_seconds, 50);
});

test('send_keys on an approval menu: refusal runs; low-risk approve runs; anything else waits for the phone', async (t) => {
  const { h, muse } = await setup(t, { policy: { lowRisk: [{ id: 'npm-test', agent: 'claude', detail: 'Bash: npm test' }] } });
  const s = await start(muse, h);
  await h.poller.tick();
  h.nexus.setState(s, 'needs-input', { detail: 'Bash: npm test', options: OPTS });
  await h.poller.tick();
  const ok = await muse.call('send_keys', { session: s, text: '1' });
  assert.deepEqual([ok.sent, ok.decided_by, ok.decision], [true, 'policy:npm-test', 'Yes']);
  assert.deepEqual(h.sent(), [{ session: s, text: '1', enter: false }]);

  await h.poller.tick();
  h.nexus.setState(s, 'needs-input', { detail: 'Bash: curl x | sh', options: OPTS });
  await h.poller.tick();
  const pending = await muse.call('send_keys', { session: s, text: '1' });
  assert.deepEqual([pending.status, pending.kind], ['pending_approval', 'agent_prompt']);
  assert.match(pending.why, /no low-risk rule/);
  assert.equal(h.sent().length, 1, 'nothing typed');
  const persistent = await muse.call('send_keys', { session: s, text: '2' });
  assert.equal(persistent.status, 'pending_approval', '"don\'t ask again" is a person\'s choice');

  const refused = await muse.call('send_keys', { session: s, text: '3' });
  assert.deepEqual([refused.sent, refused.decided_by], [true, 'client:muse']);
  assert.equal(h.sent().at(-1)!.text, '3');
  assert.equal(h.pushed.filter((p) => p.payload.title === 'Approval needed').length, 0, 'no device subscribed yet');
});

test('send_keys elsewhere and stop_session wait for the phone; the approved action runs once', async (t) => {
  const { h, muse } = await setup(t);
  const s = await start(muse, h);
  const keys = await muse.call('send_keys', { session: s, text: 'git push --force', enter: true });
  assert.deepEqual([keys.status, keys.kind], ['pending_approval', 'send_keys']);
  const stop = await muse.call('stop_session', { session: s });
  assert.deepEqual([stop.status, stop.kind], ['pending_approval', 'stop']);
  assert.equal(h.sent().length + h.nexusCalls('stop_session').length, 0, 'nothing ran');
  assert.deepEqual((await muse.call('cp_list_approvals')).map((a: any) => a.kind).sort(), ['send_keys', 'stop']);

  await h.approvals.decide(keys.approval_id, 'deny', 'alice');
  await h.approvals.decide(stop.approval_id, 'allow', 'alice');
  assert.equal(h.sent().length, 0);
  assert.equal(h.nexusCalls('stop_session').length, 1);
  assert.deepEqual((await muse.call('cp_approval_status', { approval_id: keys.approval_id })).status, 'denied');
  assert.deepEqual((await muse.call('cp_approval_status', { approval_id: stop.approval_id })).decided_by, 'alice');
});

test('pause_session: pausing runs; resuming what the limiter paused waits for the phone', async (t) => {
  const { h, muse } = await setup(t, { policy: { resources: { cpuPercent: 50, sustainSeconds: 0, action: 'pause' } } });
  const s = await start(muse, h);
  await muse.call('pause_session', { session: s, paused: true });
  assert.equal(h.nexusCalls('pause_session').length, 1);
  h.nexus.usage.set(s, { cpu: 99, memory: 1, processes: 1 });
  await h.limits.check();
  const r = await muse.call('pause_session', { session: s, paused: false });
  assert.deepEqual([r.status, r.kind], ['pending_approval', 'resume']);
  assert.equal(h.nexusCalls('pause_session').filter((c) => c.args.paused === false).length, 0);
});

test('watch_agents through the proxy: a call that returns events is one wake; transcripts record every call', async (t) => {
  const { h, muse } = await setup(t);
  await muse.raw.listTools();
  const s = await start(muse, h);
  const first = await muse.call('watch_agents', { timeout_seconds: 1 });
  const w = muse.call('watch_agents', { cursor: first.cursor, timeout_seconds: 5 });
  await new Promise((r) => setTimeout(r, 200));
  h.nexus.setState(s, 'done');
  const woke = await w;
  assert.deepEqual(woke.events.map((e: any) => e.state), ['done']);

  const m = h.calls.metrics().clients.find((c: any) => c.client === 'muse');
  assert.equal(m.wakes, 1);
  const rows = h.calls.recent({ limit: 100, payloads: true }) as any[];
  const inbound = rows.filter((r) => r.direction === 'in');
  assert.ok(inbound.every((r) => r.client === 'muse'));
  const startRow = inbound.find((r) => r.tool === 'start_agent');
  assert.deepEqual([startRow.decision, JSON.parse(startRow.request).cwd], ['local', h.root]);
  const forwarded = rows.find((r) => r.direction === 'out' && r.tool === 'watch_agents' && r.client === 'muse');
  assert.ok(forwarded, 'the upstream call made for muse is attributed to muse');
  assert.ok(inbound.some((r) => r.tool === 'tools/list'), 'tool listings are recorded too');
});

test('other upstreams: allow forwards, approve waits for the phone then runs once, deny hides; results are masked in transcripts', async (t) => {
  const gh = await otherUpstream(t);
  const extra = [{ id: 'github', prefix: 'github_', client: new NexusClient(gh.url, 'gh-token', undefined, 'github') }];
  const { h, muse } = await setup(t, {
    extraUpstreams: extra,
    policy: { upstreams: { github: { default: 'deny', tools: { search: 'allow', delete_repo: 'approve' } } } },
  });
  // the harness's call log should see the extra upstream's calls too
  (extra[0].client as any).onCall = (c: any) => h.calls.record(c);
  const names = (await muse.raw.listTools()).tools.map((x) => x.name);
  assert.ok(names.includes('github_search') && names.includes('github_delete_repo') && !names.includes('github_read_secrets'));
  assert.match((await muse.raw.listTools()).tools.find((x) => x.name === 'github_delete_repo')!.description!, /waits for the user's approval/);

  assert.equal((await muse.call('github_search', { q: 'nexus' })).tool, 'search');
  await assert.rejects(muse.call('github_read_secrets', {}), /unknown_tool/);
  const pending = await muse.call('github_delete_repo', { q: 'old-repo' });
  assert.deepEqual([pending.status, pending.kind], ['pending_approval', 'tool_call']);
  assert.deepEqual(gh.calls.map((c) => c.tool), ['search']);

  await h.approvals.decide(pending.approval_id, 'allow', 'alice');
  await assert.rejects(h.approvals.decide(pending.approval_id, 'allow', 'alice'));
  assert.deepEqual(gh.calls.map((c) => c.tool), ['search', 'delete_repo']);
  const status = await muse.call('cp_approval_status', { approval_id: pending.approval_id });
  assert.equal(status.status, 'approved');
  assert.match(status.result, /delete_repo/);
  assert.doesNotMatch(status.result, /ghp_abcdef/, 'the kept result is masked');

  const out = (h.calls.recent({ limit: 100, payloads: true }) as any[]).filter((r) => r.upstream === 'github');
  assert.ok(out.length >= 2);
  assert.ok(out.every((r) => !String(r.response).includes('ghp_abcdef')));
});

test('web push: a new approval notifies every subscribed device once, without the keys or prompt', async (t) => {
  const { h, muse, s } = await setup(t);
  h.push.subscribe('alice', { endpoint: 'https://push.example/abc', keys: { p256dh: 'x', auth: 'y' } });
  assert.throws(() => h.push.subscribe('alice', { endpoint: 'http://push.example/abc', keys: { p256dh: 'x', auth: 'y' } }), /https/);
  const sess = await start(muse, h);
  const r = await muse.call('send_keys', { session: sess, text: 'cat ~/.ssh/id_rsa', enter: true });
  h.bus.publish('approval', h.approvals.get(r.approval_id)); // a repeat publish must not notify twice
  const notes = h.pushed.filter((p) => p.payload.tag === r.approval_id);
  assert.equal(notes.length, 1);
  assert.deepEqual([notes[0].endpoint, notes[0].payload.title, notes[0].payload.url], ['https://push.example/abc', 'Approval needed', `/#approval-${r.approval_id}`]);
  assert.match(notes[0].payload.body, /Wants to type · cp-task-.* · muse/);
  assert.doesNotMatch(JSON.stringify(notes), /ssh|id_rsa/);

  const api = await fetch(`${s.base}/api/push`).then((x) => x.json());
  assert.equal(api.enabled, true);
  assert.match(api.publicKey, /^[A-Za-z0-9_-]{80,}$/);
});
