import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalQueue, ESCAPE, optionsFromChoices, pickOption } from '../src/approvals.ts';
import { identify, isTailnetOrLoopback } from '../src/auth.ts';
import { createBridge } from '../src/bridge.ts';
import { assertSafeConfig, loadConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { gitDiff } from '../src/diff.ts';
import { Bus, Poller } from '../src/events.ts';
import { NexusClient, NexusError } from '../src/nexus/client.ts';
import type { PromptOption } from '../src/nexus/types.ts';
import { buildServer } from '../src/server.ts';
import { TaskStore } from '../src/tasks.ts';
import { MockNexus } from './mock-nexus.ts';

/** Typed options as get_state returns them for a Claude Code permission prompt. */
const OPTS: PromptOption[] = [
  { key: '1', label: 'Yes', kind: 'approve', selected: true },
  { key: '2', label: "Yes, and don't ask again for npm test", kind: 'approve' },
  { key: '3', label: 'No, and tell Claude what to do differently', kind: 'deny' },
];

async function harness(t: TestContext, o: { ttl?: number; issue56?: boolean } = {}) {
  const nexus = new MockNexus('sup-token', o.issue56 ?? true);
  await nexus.start();
  t.after(() => nexus.stop());
  const db = openDb(':memory:');
  const client = new NexusClient(nexus.url, nexus.token);
  await client.listTools();
  const bus = new Bus();
  const tasks = new TaskStore(db, client);
  const approvals = new ApprovalQueue(db, client, o.ttl ?? 60_000);
  const poller = new Poller(db, client, tasks, approvals, bus, 1);
  const sent = () => nexus.calls.filter((c) => c.tool === 'send_keys').map((c) => c.args);
  const auditKinds = () => (db.prepare('SELECT kind FROM audit ORDER BY id').all() as any[]).map((r) => r.kind);
  return { nexus, db, client, bus, tasks, approvals, poller, sent, auditKinds };
}

/** Start a task and bring it to an approval prompt the poller has seen. */
async function atPrompt(h: Awaited<ReturnType<typeof harness>>, detail = 'Bash: npm test', options = OPTS) {
  const task = await h.tasks.create({ agent: 'claude', cwd: '/tmp', prompt: 'run the tests', name: 'pilot' });
  await h.poller.tick(); // establishes the cursor
  h.nexus.setState(task.session_id!, 'needs-input', { detail, options });
  await h.poller.tick();
  const [approval] = h.approvals.list('pending');
  return { task, approval };
}

test('client: tools listed; a rejected token gets the empty server and is reported as unauthorized', async (t) => {
  const h = await harness(t);
  assert.ok(h.client.hasTool('watch_agents') && h.client.hasTool('get_state'));
  const bad = new NexusClient(h.nexus.url, 'wrong');
  await assert.rejects(bad.listTools(), (e: any) => e instanceof NexusError && e.code === 'unauthorized');
  assert.equal(bad.online, false);
});

test('client: unreachable Nexus is an offline NexusError, not a crash', async () => {
  const c = new NexusClient('http://127.0.0.1:9/mcp', 'x');
  await assert.rejects(c.listTools(), (e: any) => e instanceof NexusError && e.code === 'offline');
  assert.equal(c.online, false);
});

test('pilot: start → watch → typed approval → allow once → guide → stop, audited', async (t) => {
  const h = await harness(t);
  const { task, approval } = await atPrompt(h);

  const start = h.nexus.calls.find((c) => c.tool === 'start_agent')!.args;
  assert.equal(start.agent, 'claude');
  assert.equal(start.placement, 'background');
  assert.match(start.name, /^cp-pilot-/);

  assert.equal(h.tasks.get(task.task_id)!.status, 'needs-input');
  assert.equal(approval.detail, 'Bash: npm test');
  assert.match(approval.tail!, /screen of cp-pilot/);
  assert.deepEqual(approval.options, OPTS, 'typed options come from get_state');
  assert.equal(h.sent().length, 0, 'nothing is answered before a human decides');

  const decided = await h.approvals.decide(approval.id, 'allow', 'alice@example.com');
  assert.deepEqual(h.sent(), [{ session: task.session_id, text: '1', enter: false }], 'one-shot Yes, not "don\'t ask again"');
  assert.equal(decided.decision, 'Yes');
  assert.equal(decided.decided_by, 'alice@example.com');
  await assert.rejects(h.approvals.decide(approval.id, 'allow', 'x'), /already approved/);

  await h.poller.tick(); // the agent's "working" event
  assert.equal(h.tasks.get(task.task_id)!.status, 'working');

  await h.tasks.prompt(task.task_id, 'also run lint', 'alice@example.com');
  const p = h.nexus.calls.findLast((c) => c.tool === 'prompt_agent')!.args;
  assert.deepEqual([p.session, p.text, p.wait, p.timeout_seconds, p.force], [task.session_id, 'also run lint', 'working', 30, false]);

  await h.tasks.stop(task.task_id, 'alice@example.com');
  await h.poller.tick(); // late exited event must not overwrite "stopped"
  assert.equal(h.tasks.get(task.task_id)!.status, 'stopped');
  assert.ok(h.nexus.sessions.get(task.session_id!)!.exited);
  assert.deepEqual(h.auditKinds(), ['task.start', 'approval.created', 'approval.allow', 'task.prompt', 'task.stop']);
  // prompts are audited by length only
  assert.doesNotMatch(JSON.stringify(h.db.prepare('SELECT data FROM audit').all()), /also run lint/);
});

test('race: a prompt answered in the app before the decision is not typed into', async (t) => {
  const h = await harness(t);
  const { task, approval } = await atPrompt(h);
  h.nexus.setState(task.session_id!, 'working', { emit: false }); // answered elsewhere; event not yet polled
  await assert.rejects(h.approvals.decide(approval.id, 'allow', 'ui'), /answered elsewhere; nothing was sent/);
  assert.equal(h.sent().length, 0);
  assert.equal(h.approvals.get(approval.id)!.status, 'expired');
  assert.equal(h.approvals.get(approval.id)!.decision, 'stale');
});

test('race: a different prompt now on screen is not answered with the old decision', async (t) => {
  const h = await harness(t);
  const { task, approval } = await atPrompt(h, 'Bash: npm test');
  h.nexus.setState(task.session_id!, 'needs-input', { detail: 'Bash: rm -rf build', options: OPTS, emit: false });
  await assert.rejects(h.approvals.decide(approval.id, 'allow', 'ui'), /nothing was sent/);
  assert.equal(h.sent().length, 0);
});

test('answered in the app: the watch event supersedes the pending approval', async (t) => {
  const h = await harness(t);
  const { task, approval } = await atPrompt(h);
  h.nexus.setState(task.session_id!, 'working');
  await h.poller.tick();
  assert.equal(h.approvals.get(approval.id)!.status, 'expired');
  assert.equal(h.approvals.get(approval.id)!.decision, 'superseded');
});

test('a new, different prompt replaces the pending one; a repeat dedupes', async (t) => {
  const h = await harness(t);
  const { task, approval } = await atPrompt(h, 'first');
  h.nexus.setState(task.session_id!, 'needs-input', { detail: 'first', options: OPTS });
  await h.poller.tick();
  assert.equal(h.approvals.list('pending')[0].id, approval.id);
  h.nexus.setState(task.session_id!, 'needs-input', { detail: 'second', options: OPTS });
  await h.poller.tick();
  const pending = h.approvals.list('pending');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].detail, 'second');
  assert.equal(h.approvals.get(approval.id)!.status, 'expired');
});

test('deny presses the deny option, or Escape when the menu has none', async (t) => {
  const h = await harness(t);
  const { task, approval } = await atPrompt(h);
  await h.approvals.decide(approval.id, 'deny', 'ui');
  assert.equal(h.sent().at(-1)!.text, '3');

  await h.poller.tick();
  h.nexus.setState(task.session_id!, 'needs-input', { detail: 'Proceed?', options: [{ key: '1', label: 'Yes', kind: 'approve' }] });
  await h.poller.tick();
  const b = h.approvals.list('pending')[0];
  const d = await h.approvals.decide(b.id, 'deny', 'ui');
  assert.equal(h.sent().at(-1)!.text, ESCAPE);
  assert.equal(d.decision, 'Escape');
});

test('explicit option choice, and allow refuses when only persistent approvals exist', async (t) => {
  const h = await harness(t);
  const only = [{ key: '2', label: 'Yes, allow all edits during this session', kind: 'approve' as const }];
  const { approval } = await atPrompt(h, 'Edit file', only);
  await assert.rejects(h.approvals.decide(approval.id, 'allow', 'ui'), /no one-shot allow option/);
  assert.equal(h.approvals.get(approval.id)!.status, 'pending', 'refusal reopens the approval');
  await h.approvals.decide(approval.id, 'allow', 'ui', '2');
  assert.equal(h.sent().at(-1)!.text, '2');
});

test('without #56 tools: options are derived from watch choices; pause is unsupported', async (t) => {
  const h = await harness(t, { issue56: false });
  assert.ok(!h.client.hasTool('get_state'));
  const { approval } = await atPrompt(h);
  assert.deepEqual(approval.options.map((o) => [o.key, o.kind]), [['1', 'approve'], ['2', 'approve'], ['3', 'deny']]);
  await h.approvals.decide(approval.id, 'allow', 'ui'); // state verified through list_sessions
  assert.equal(h.sent().at(-1)!.text, '1');
  await assert.rejects(h.client.pauseSession('s1', true), (e: any) => e.code === 'unsupported');
});

test('optionsFromChoices honours numbered labels and pickOption skips persistent grants', () => {
  const o = optionsFromChoices(['1. Yes', "2. Yes, and don't ask again", '3. No (esc)']);
  assert.deepEqual(o.map((x) => [x.key, x.label, x.kind]), [['1', 'Yes', 'approve'], ['2', "Yes, and don't ask again", 'approve'], ['3', 'No (esc)', 'deny']]);
  assert.equal(pickOption(optionsFromChoices(['Always allow', 'Allow once', 'Deny']), 'allow')!.key, '2');
});

test('missed cursor: the poller resyncs from live state and still raises the approval', async (t) => {
  const h = await harness(t);
  const task = await h.tasks.create({ agent: 'claude', cwd: '/tmp', name: 'm' });
  await h.poller.tick();
  h.nexus.setState(task.session_id!, 'needs-input', { detail: 'lost prompt', options: OPTS });
  h.nexus.dropEvents();
  await h.poller.tick();
  const [a] = h.approvals.list('pending');
  assert.equal(a.detail, 'lost prompt');
  assert.deepEqual(a.options, OPTS);
  assert.ok(h.auditKinds().includes('nexus.missed'));
});

test('poller ignores sessions it did not start and resumes from its stored integer cursor', async (t) => {
  const h = await harness(t);
  await h.poller.tick();
  h.nexus.sessions.set('foreign', { id: 'foreign', name: 'f', agent: { id: 'codex', state: 'idle' }, cwd: '/', exited: false, paused: false });
  h.nexus.setState('foreign', 'needs-input', { detail: 'x', options: OPTS });
  await h.poller.tick();
  assert.equal(h.approvals.list().length, 0);
  const cursor = Number((h.db.prepare("SELECT v FROM kv WHERE k='watch_cursor'").get() as any).v);
  assert.ok(cursor > 0);
  await h.poller.tick();
  assert.equal(h.nexus.calls.filter((c) => c.tool === 'watch_agents').at(-1)!.args.cursor, cursor);
});

test('failed key delivery reopens the approval; expired approvals cannot be decided', async (t) => {
  const h = await harness(t, { ttl: 200 });
  const { approval } = await atPrompt(h);
  h.nexus.failSend = true;
  await assert.rejects(h.approvals.decide(approval.id, 'allow', 'ui'), (e: any) => e.code === 'session_gone');
  assert.equal(h.approvals.get(approval.id)!.status, 'pending');
  await new Promise((r) => setTimeout(r, 220));
  await assert.rejects(h.approvals.decide(approval.id, 'allow', 'ui'), /expired/);
});

test('guide while the agent is blocked surfaces agent_blocked', async (t) => {
  const h = await harness(t);
  const { task } = await atPrompt(h);
  await assert.rejects(h.tasks.prompt(task.task_id, 'hi', 'ui'), (e: any) => e.code === 'agent_blocked');
});

test('diff: unborn repo, tracked changes and untracked files', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'cp-repo-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: repo });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  g('add', 'a.txt');
  writeFileSync(join(repo, 'new.ts'), 'export const x = 1;\n');
  writeFileSync(join(repo, 'blob.bin'), Buffer.from([0, 1, 2]));
  const unborn = await gitDiff(repo);
  assert.match(unborn.diff, /\+one/);
  assert.deepEqual(unborn.untracked.find((f) => f.path === 'new.ts')?.content, 'export const x = 1;\n');
  assert.equal(unborn.untracked.find((f) => f.path === 'blob.bin')?.binary, true);

  g('commit', '-qm', 'init');
  writeFileSync(join(repo, 'a.txt'), 'two\n');
  assert.match((await gitDiff(repo)).diff, /-one\n\+two/);
  assert.ok(!readFileSync(join(repo, '.git', 'index')).includes('new.ts'), 'diff never stages anything');
});

test('HTTP API: start, guide, approve with identity, stop; JSON-only mutations', async (t) => {
  const h = await harness(t);
  const repo = mkdtempSync(join(tmpdir(), 'cp-api-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const app = buildServer({
    tasks: h.tasks, approvals: h.approvals, bus: h.bus, status: () => ({ online: true }),
    auth: { mode: 'tailscale', token: '', allowedUsers: ['alice@example.com'] },
  });
  t.after(() => app.close());
  const as = { 'tailscale-user-login': 'alice@example.com' };
  const post = (url: string, payload: object, headers: object = as) => app.inject({ method: 'POST', url, payload, headers: { ...headers } });

  assert.equal((await app.inject({ url: '/api/tasks' })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/tasks', headers: { 'tailscale-user-login': 'mallory@example.com' } })).statusCode, 403);
  assert.equal((await app.inject({ url: '/api/status', headers: as })).json().user, 'alice@example.com');

  assert.equal((await post('/api/tasks', { cwd: repo })).statusCode, 400, 'agent is required');
  const created = await post('/api/tasks', { cwd: repo, agent: 'claude', name: 'api', prompt: 'go' });
  assert.equal(created.statusCode, 200);
  const { task_id, session_id } = created.json();
  assert.equal((await post('/api/tasks', { cwd: repo, agent: 'vim' })).statusCode, 409, 'Nexus rejects unknown agents');

  assert.equal((await post(`/api/tasks/${task_id}/prompt`, { text: 'more' })).statusCode, 200);
  await h.poller.tick();
  h.nexus.setState(session_id, 'needs-input', { detail: 'ok?', options: OPTS });
  await h.poller.tick();
  assert.equal((await post(`/api/tasks/${task_id}/prompt`, { text: 'more' })).json().code, 'agent_blocked');

  const [a] = (await app.inject({ url: '/api/approvals?status=pending', headers: as })).json();
  // cross-site style POSTs are refused before reaching the handler
  const plain = await app.inject({ method: 'POST', url: `/api/approvals/${a.id}/allow`, payload: '{}', headers: { ...as, 'content-type': 'text/plain' } });
  assert.equal(plain.statusCode, 415);
  assert.equal(h.sent().length, 0);
  const ok = await post(`/api/approvals/${a.id}/allow`, {});
  assert.equal(ok.json().decided_by, 'alice@example.com');

  h.nexus.setState(session_id, 'needs-input', { detail: 'again?', options: OPTS });
  await h.poller.tick();
  const [b] = h.approvals.list('pending');
  h.nexus.setState(session_id, 'idle', { emit: false });
  const stale = await post(`/api/approvals/${b.id}/allow`, {});
  assert.deepEqual([stale.statusCode, stale.json().stale], [409, true]);

  assert.match((await app.inject({ url: `/api/tasks/${task_id}/diff`, headers: as })).json().status, /No commits yet|##/);
  assert.equal((await post(`/api/tasks/${task_id}/stop`, {})).json().status, 'stopped');
  assert.equal((await post(`/api/tasks/${task_id}/stop`, {})).statusCode, 409, 'already stopped');
});

test('HTTP API: token mode login cookie', async (t) => {
  const h = await harness(t);
  const token = 'x'.repeat(32);
  const app = buildServer({ tasks: h.tasks, approvals: h.approvals, bus: h.bus, status: () => ({ online: true }), auth: { mode: 'token', token, allowedUsers: [] } });
  t.after(() => app.close());
  assert.equal((await app.inject({ url: '/api/tasks' })).statusCode, 401);
  assert.equal((await app.inject({ url: '/login?token=nope' })).statusCode, 401);
  const login = await app.inject({ url: `/login?token=${token}` });
  const cookie = String(login.headers['set-cookie']);
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  assert.equal((await app.inject({ url: '/api/tasks', headers: { cookie: cookie.split(';')[0] } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/tasks', headers: { authorization: `Bearer ${token}` } })).statusCode, 200);
});

test('config refuses unsafe UI exposure', () => {
  const cfg = (env: Record<string, string>) => loadConfig({ NEXUS_SUPERVISOR_TOKEN: 't', ...env });
  assert.throws(() => assertSafeConfig(cfg({ CONTROLPLANE_HOST: '0.0.0.0' })), /requires CONTROLPLANE_HOST on loopback/);
  assert.throws(() => assertSafeConfig(cfg({ CONTROLPLANE_HOST: '100.70.1.2', CONTROLPLANE_AUTH: 'tailscale' })), /loopback/);
  assert.throws(() => assertSafeConfig(cfg({ CONTROLPLANE_AUTH: 'token', CONTROLPLANE_UI_TOKEN: 'short' })), /24 characters/);
  assert.doesNotThrow(() => assertSafeConfig(cfg({ CONTROLPLANE_HOST: '100.70.1.2', CONTROLPLANE_AUTH: 'token', CONTROLPLANE_UI_TOKEN: 'y'.repeat(32) })));
  assert.match(cfg({}).nexusUrl, /^http:\/\/127\.0\.0\.1:47\d{3}\/mcp$/);
  assert.equal(identify({}, { mode: 'none', token: '', allowedUsers: [] }).hasOwnProperty('user'), true);
});

test('bridge: TLS, token required, forwards to loopback nexusd past its Host/Origin checks', async (t) => {
  const h = await harness(t);
  const dir = mkdtempSync(join(tmpdir(), 'cp-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'),
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const bridge = createBridge({ upstream: new URL(h.nexus.url), token: h.nexus.token, tls: { key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) } });
  await new Promise<void>((r) => bridge.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { bridge.closeAllConnections(); bridge.close(r); }));
  const url = `https://127.0.0.1:${(bridge.address() as any).port}/mcp`;
  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  t.after(() => { if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev; });

  const through = new NexusClient(url, h.nexus.token);
  assert.ok((await through.listTools()).includes('watch_agents'));
  assert.ok((await through.getState('nope').catch((e) => e)) === undefined);
  const rejected = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(rejected.status, 401);
  const wrongPath = await fetch(url.replace('/mcp', '/other'), { method: 'POST', headers: { authorization: `Bearer ${h.nexus.token}` } });
  assert.equal(wrongPath.status, 404);
  assert.ok(isTailnetOrLoopback('100.101.2.3') && !isTailnetOrLoopback('0.0.0.0') && !isTailnetOrLoopback('100.200.0.1'));
});
