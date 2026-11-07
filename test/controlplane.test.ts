import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ESCAPE, optionsFromChoices, pickOption } from '../src/approvals.ts';
import { identify } from '../src/auth.ts';
import { assertSafeConfig, loadConfig } from '../src/config.ts';
import { gitDiff } from '../src/diff.ts';
import { NexusClient, NexusError } from '../src/nexus/client.ts';
import { atPrompt, harness, OPTS, serve, tmp } from './helpers.ts';

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

  const start = h.nexusCalls('start_agent')[0].args;
  assert.equal(start.agent, 'claude');
  assert.equal(start.placement, 'background');
  assert.match(start.name, /^cp-pilot-/);

  assert.equal(h.tasks.get(task.task_id)!.status, 'needs-input');
  assert.equal(approval.kind, 'agent_prompt');
  assert.equal(approval.requested_by, 'agent');
  assert.equal(approval.detail, 'Bash: npm test');
  assert.match(approval.tail!, /screen of cp-pilot/);
  assert.deepEqual(approval.options, OPTS, 'typed options come from get_state');
  assert.equal(h.sent().length, 0, 'nothing is answered before a human decides');

  const decided = await h.approvals.decide(approval.id, 'allow', 'alice@example.com');
  assert.deepEqual(h.sent(), [{ session: task.session_id, text: '1', enter: false }], 'one-shot Yes, not "don\'t ask again"');
  assert.equal(decided.decision, 'Yes');
  assert.equal(decided.decided_by, 'alice@example.com');
  assert.ok(decided.consumed_at, 'single use: consumed');
  await assert.rejects(h.approvals.decide(approval.id, 'allow', 'x'), /already approved/);
  assert.equal(h.sent().length, 1);

  await h.poller.tick(); // the agent's "working" event
  assert.equal(h.tasks.get(task.task_id)!.status, 'working');

  await h.tasks.prompt(task.task_id, 'also run lint', 'alice@example.com');
  const p = h.nexusCalls('prompt_agent').at(-1)!.args;
  assert.deepEqual([p.session, p.text, p.wait, p.timeout_seconds, p.force], [task.session_id, 'also run lint', 'working', 30, false]);

  await h.tasks.stop(task.task_id, 'alice@example.com');
  await h.poller.tick(); // late exited event must not overwrite "stopped"
  assert.equal(h.tasks.get(task.task_id)!.status, 'stopped');
  assert.ok(h.nexus.sessions.get(task.session_id!)!.exited);
  assert.deepEqual(h.auditKinds(), ['task.start', 'approval.created', 'approval.allow', 'task.prompt', 'task.stop']);
  assert.doesNotMatch(JSON.stringify(h.db.prepare('SELECT data FROM audit').all()), /also run lint/, 'prompts audited by length only');
});

test('race: a prompt answered in the app before the decision is not typed into', async (t) => {
  const h = await harness(t);
  const { task, approval } = await atPrompt(h);
  h.nexus.setState(task.session_id!, 'working', { emit: false }); // answered elsewhere; event not yet polled
  await assert.rejects(h.approvals.decide(approval.id, 'allow', 'ui'), /answered elsewhere; nothing was sent/);
  assert.equal(h.sent().length, 0);
  assert.equal(h.approvals.get(approval.id)!.status, 'stale');
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
  assert.deepEqual([h.approvals.get(approval.id)!.status, h.approvals.get(approval.id)!.decision], ['stale', 'superseded']);
});

test('a new, different prompt replaces the pending one; a repeat dedupes', async (t) => {
  const h = await harness(t);
  const { task, approval } = await atPrompt(h, 'first');
  h.nexus.setState(task.session_id!, 'needs-input', { detail: 'first', options: OPTS });
  await h.poller.tick();
  assert.equal(h.approvals.pendingPrompt(task.session_id!)!.id, approval.id);
  h.nexus.setState(task.session_id!, 'needs-input', { detail: 'second', options: OPTS });
  await h.poller.tick();
  const pending = h.approvals.list('pending');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].detail, 'second');
  assert.equal(h.approvals.get(approval.id)!.status, 'stale');
});

test('deny presses the deny option, or Escape when the menu has none', async (t) => {
  const h = await harness(t);
  const { task, approval } = await atPrompt(h);
  await h.approvals.decide(approval.id, 'deny', 'ui');
  assert.equal(h.sent().at(-1)!.text, '3');

  await h.poller.tick();
  h.nexus.setState(task.session_id!, 'needs-input', { detail: 'Proceed?', options: [{ key: '1', label: 'Yes', kind: 'approve' }] });
  await h.poller.tick();
  const b = h.approvals.pendingPrompt(task.session_id!)!;
  const d = await h.approvals.decide(b.id, 'deny', 'ui');
  assert.equal(h.sent().at(-1)!.text, ESCAPE);
  assert.equal(d.decision, 'Escape');
});

test('persistent grants: a person may pick one explicitly; machines and "allow once" never do', async (t) => {
  const h = await harness(t);
  const only = [{ key: '2', label: 'Yes, allow all edits during this session', kind: 'approve' as const }];
  const { approval } = await atPrompt(h, 'Edit file', only);
  await assert.rejects(h.approvals.decide(approval.id, 'allow', 'ui'), /no one-shot allow option/);
  assert.equal(h.approvals.get(approval.id)!.status, 'pending', 'refusal reopens the approval');
  await assert.rejects(h.approvals.decide(approval.id, 'allow', 'policy:x', { optionKey: '2' }), /only chosen explicitly by a person/);
  assert.equal(h.sent().length, 0);
  await h.approvals.decide(approval.id, 'allow', 'ui', { optionKey: '2' });
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
  assert.match(h.limits.status().reason!, /lacks resource_usage/);
});

test('optionsFromChoices honours numbered labels and pickOption skips persistent grants', () => {
  const o = optionsFromChoices(['1. Yes', "2. Yes, and don't ask again", '3. No (esc)']);
  assert.deepEqual(o.map((x) => [x.key, x.label, x.kind]), [['1', 'Yes', 'approve'], ['2', "Yes, and don't ask again", 'approve'], ['3', 'No (esc)', 'deny']]);
  assert.equal(pickOption(optionsFromChoices(['Always allow', 'Allow once', 'Deny']), 'allow')!.key, '2');
});

test('missed cursor: the poller resyncs from live state and still raises the approval', async (t) => {
  const h = await harness(t);
  const task = await h.tasks.create({ agent: 'claude', cwd: h.root, name: 'm' });
  await h.poller.tick();
  h.nexus.setState(task.session_id!, 'needs-input', { detail: 'lost prompt', options: OPTS });
  h.nexus.dropEvents();
  await h.poller.tick();
  const a = h.approvals.pendingPrompt(task.session_id!)!;
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
  assert.equal(h.nexusCalls('watch_agents').at(-1)!.args.cursor, cursor);
});

test('failed key delivery reopens the approval; expired approvals cannot be decided', async (t) => {
  const h = await harness(t, { policy: { approvalTtlMs: 1000 } });
  const { approval } = await atPrompt(h);
  h.nexus.failSend = true;
  await assert.rejects(h.approvals.decide(approval.id, 'allow', 'ui'), (e: any) => e.code === 'session_gone');
  assert.equal(h.approvals.get(approval.id)!.status, 'pending');
  assert.equal(h.approvals.get(approval.id)!.consumed_at, null);
  await new Promise((r) => setTimeout(r, 1050));
  await assert.rejects(h.approvals.decide(approval.id, 'allow', 'ui'), /expired/);
});

test('guide while the agent is blocked surfaces agent_blocked', async (t) => {
  const h = await harness(t);
  const { task } = await atPrompt(h);
  await assert.rejects(h.tasks.prompt(task.task_id, 'hi', 'ui'), (e: any) => e.code === 'agent_blocked');
});

test('every Nexus call is in the call log, without prompt text', async (t) => {
  const h = await harness(t);
  const { task } = await atPrompt(h);
  await h.poller.tick();
  const out = h.calls.recent(1000).filter((c: any) => c.direction === 'out') as any[];
  for (const tool of ['start_agent', 'watch_agents', 'get_state']) assert.ok(out.some((c) => c.tool === tool), tool);
  assert.ok(out.some((c) => c.tool === 'start_agent' && c.ok === 1));
  assert.ok(out.some((c) => c.session_id === task.session_id));
  assert.doesNotMatch(JSON.stringify(h.calls.recent(1000)), /run the tests/);
});

test('diff: unborn repo, tracked changes and untracked files', async () => {
  const repo = tmp('cp-repo-');
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

test('HTTP API: start, guide, approve with identity, stop; JSON-only mutations; policy refusals', async (t) => {
  const h = await harness(t);
  execFileSync('git', ['init', '-q'], { cwd: h.root });
  const { app } = await serve(t, h, { mode: 'tailscale', token: '', allowedUsers: ['alice@example.com'] });
  const as = { 'tailscale-user-login': 'alice@example.com' };
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload, headers: { ...as } });

  assert.equal((await app.inject({ url: '/api/tasks' })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/tasks', headers: { 'tailscale-user-login': 'mallory@example.com' } })).statusCode, 403);
  assert.equal((await app.inject({ url: '/api/status', headers: as })).json().user, 'alice@example.com');

  assert.equal((await post('/api/tasks', { cwd: h.root })).statusCode, 400, 'agent is required');
  const outside = await post('/api/tasks', { cwd: '/', agent: 'claude' });
  assert.deepEqual([outside.statusCode, outside.json().code], [403, 'policy_denied']);
  assert.equal((await post('/api/tasks', { cwd: h.root, agent: 'gemini' })).statusCode, 403, 'agent not in the allowlist');
  const created = await post('/api/tasks', { cwd: h.root, agent: 'claude', name: 'api', prompt: 'go' });
  assert.equal(created.statusCode, 200);
  const { task_id, session_id } = created.json();

  assert.equal((await post(`/api/tasks/${task_id}/prompt`, { text: 'more' })).statusCode, 200);
  await h.poller.tick();
  h.nexus.setState(session_id, 'needs-input', { detail: 'ok?', options: OPTS });
  await h.poller.tick();
  assert.equal((await post(`/api/tasks/${task_id}/prompt`, { text: 'more' })).json().code, 'agent_blocked');

  const [a] = (await app.inject({ url: '/api/approvals?status=pending', headers: as })).json();
  const plain = await app.inject({ method: 'POST', url: `/api/approvals/${a.id}/allow`, payload: '{}', headers: { ...as, 'content-type': 'text/plain' } });
  assert.equal(plain.statusCode, 415, 'cross-site style POSTs are refused before the handler');
  assert.equal(h.sent().length, 0);
  assert.equal((await post(`/api/approvals/${a.id}/allow`, {})).json().decided_by, 'alice@example.com');

  h.nexus.setState(session_id, 'needs-input', { detail: 'again?', options: OPTS });
  await h.poller.tick();
  const b = h.approvals.pendingPrompt(session_id)!;
  h.nexus.setState(session_id, 'idle', { emit: false });
  const stale = await post(`/api/approvals/${b.id}/allow`, {});
  assert.deepEqual([stale.statusCode, stale.json().stale], [409, true]);

  assert.match((await app.inject({ url: `/api/tasks/${task_id}/diff`, headers: as })).json().status, /No commits yet|##/);
  assert.equal((await app.inject({ url: '/api/policy', headers: as })).json().policy.maxActiveTasks, 5);
  assert.equal((await post(`/api/tasks/${task_id}/stop`, {})).json().status, 'stopped');
  assert.equal((await post(`/api/tasks/${task_id}/stop`, {})).statusCode, 409, 'already stopped');
});

test('HTTP API: token mode login cookie; the orchestrator endpoint ignores UI auth and needs the gateway secret', async (t) => {
  const h = await harness(t);
  const token = 'x'.repeat(32);
  const { app } = await serve(t, h, { mode: 'token', token, allowedUsers: [] });
  assert.equal((await app.inject({ url: '/api/tasks' })).statusCode, 401);
  assert.equal((await app.inject({ url: '/login?token=nope' })).statusCode, 401);
  const cookie = String((await app.inject({ url: `/login?token=${token}` })).headers['set-cookie']);
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  assert.equal((await app.inject({ url: '/api/tasks', headers: { cookie: cookie.split(';')[0] } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/tasks', headers: { authorization: `Bearer ${token}` } })).statusCode, 200);
  // a UI token is not a way in for orchestrators
  const viaUi = await app.inject({ method: 'POST', url: '/orchestrator/mcp', payload: {}, headers: { authorization: `Bearer ${token}`, 'x-cp-client': 'muse' } });
  assert.equal(viaUi.statusCode, 401);
});

test('config refuses unsafe UI exposure', () => {
  const cfg = (env: Record<string, string>) => loadConfig({ NEXUS_SUPERVISOR_TOKEN: 't', ...env });
  assert.throws(() => assertSafeConfig(cfg({ CONTROLPLANE_HOST: '0.0.0.0' })), /requires CONTROLPLANE_HOST on loopback/);
  assert.throws(() => assertSafeConfig(cfg({ CONTROLPLANE_HOST: '100.70.1.2', CONTROLPLANE_AUTH: 'tailscale' })), /loopback/);
  assert.throws(() => assertSafeConfig(cfg({ CONTROLPLANE_AUTH: 'token', CONTROLPLANE_UI_TOKEN: 'short' })), /24 characters/);
  assert.doesNotThrow(() => assertSafeConfig(cfg({ CONTROLPLANE_HOST: '100.70.1.2', CONTROLPLANE_AUTH: 'token', CONTROLPLANE_UI_TOKEN: 'y'.repeat(32) })));
  assert.match(cfg({}).nexusUrl, /^http:\/\/127\.0\.0\.1:47\d{3}\/mcp$/);
  assert.ok('user' in identify({}, { mode: 'none', token: '', allowedUsers: [] }));
});
