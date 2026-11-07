import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Policy } from '../src/policy.ts';
import { atPrompt, harness, OPTS, tmp } from './helpers.ts';

test('start: agent and directory allowlists, symlink escapes, client scopes narrow but never widen', async () => {
  const root = tmp('cp-pol-');
  const outside = tmp('cp-out-');
  mkdirSync(join(root, 'repo'));
  symlinkSync(outside, join(root, 'escape'));
  mkdirSync(join(root, '..dots'));
  const p = new Policy(undefined, {
    agents: ['claude', 'codex'], roots: [root],
    clients: { muse: { agents: ['claude', 'gemini'], roots: [join(root, 'repo')] }, off: { enabled: false } },
  });
  const start = (o: { client?: string; agent?: string; cwd: string; active?: number }) =>
    p.checkStart({ agent: 'claude', active: 0, ...o }).then((d) => d.verdict === 'allow' ? 'allow' : d.reason);

  assert.equal(await start({ cwd: join(root, 'repo') }), 'allow');
  assert.equal(await start({ cwd: join(root, '..dots') }), 'allow', 'a directory named ..dots is inside');
  assert.match(await start({ cwd: join(root, 'escape') }), /outside the allowed roots/, 'symlink pointing outside');
  assert.match(await start({ cwd: outside }), /outside the allowed roots/);
  assert.match(await start({ cwd: join(root, 'nope') }), /does not exist/);
  assert.match(await start({ cwd: root, agent: 'aider' }), /not allowed/);
  assert.match(await start({ cwd: root, active: 1 }), /limit is 1/, 'default: one active task');

  assert.equal(await start({ client: 'muse', cwd: join(root, 'repo') }), 'allow');
  assert.match(await start({ client: 'muse', cwd: root }), /outside this client's roots/);
  assert.match(await start({ client: 'muse', cwd: join(root, 'repo'), agent: 'gemini' }), /not allowed/, 'client list cannot widen the global one');
  assert.match(await start({ client: 'muse', cwd: join(root, 'repo'), agent: 'codex' }), /not allowed/, 'client list narrows');
  assert.match(await start({ client: 'off', cwd: root }), /disabled/);
  assert.equal(await start({ client: 'codex-bot', cwd: root }), 'allow', 'unlisted clients get the global scope');
});

test('answer: refusals always pass; persistent grants never; approvals only on an exact low-risk match', () => {
  const p = new Policy(undefined, { lowRisk: [{ id: 'npm-test', agent: 'claude', detail: 'Bash: npm test' }] });
  const [yes, always, no] = OPTS;
  const answer = (detail: string, option = yes, agent = 'claude') => p.checkAnswer({ agent, detail, option });
  assert.deepEqual(answer('Bash: npm test'), { verdict: 'allow', rule: 'npm-test' });
  assert.equal(answer('Bash: npm test && rm -rf /').verdict, 'approval', 'anchored: no prefix matches');
  assert.equal(answer('Bash: npm test', yes, 'codex').verdict, 'approval', 'rule is per agent');
  assert.equal(answer('Bash: npm test', always).verdict, 'approval', 'persistent grant needs a person even when the rule matches');
  assert.equal(answer('anything', no).verdict, 'allow');
  assert.equal(p.checkAnswer({ agent: 'claude', detail: 'x', option: undefined }).verdict, 'allow', 'Escape is a refusal');
  assert.equal(answer('x', { key: '4', label: 'Something else', kind: 'other' }).verdict, 'approval');
});

test('policy file: reloaded on change; an invalid file keeps the last good policy', () => {
  const dir = tmp('cp-polfile-');
  const file = join(dir, 'policy.json');
  writeFileSync(file, JSON.stringify({ maxActiveTasks: 2, roots: [dir] }));
  const p = new Policy(file);
  assert.equal(p.get().maxActiveTasks, 2);
  writeFileSync(file, JSON.stringify({ maxActiveTasks: 3, roots: [dir] }));
  utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.equal(p.get().maxActiveTasks, 3);
  writeFileSync(file, '{ "maxActiveTasks": 0 }');
  utimesSync(file, new Date(), new Date(Date.now() + 10_000));
  assert.equal(p.get().maxActiveTasks, 3);
  assert.match(p.error!, /rejected/);
});

test('one active task: a second start is refused until the first is closed, and racing starts cannot both win', async (t) => {
  const h = await harness(t, { policy: { maxActiveTasks: 1 } });
  const results = await Promise.allSettled([
    h.tasks.create({ agent: 'claude', cwd: h.root, name: 'a' }),
    h.tasks.create({ agent: 'claude', cwd: h.root, name: 'b' }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  const first = (results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>).value;
  await assert.rejects(h.tasks.create({ agent: 'claude', cwd: h.root }), /limit is 1/);
  await h.tasks.stop(first.task_id, 'ui');
  await h.tasks.create({ agent: 'claude', cwd: h.root });
  assert.ok(h.auditKinds().includes('task.denied'));
});

test('resource limits: a sustained breach pauses the tree and asks the phone to resume', async (t) => {
  const h = await harness(t, { policy: { resources: { cpuPercent: 50, sustainSeconds: 0, action: 'pause' } } });
  assert.deepEqual(h.limits.status(), { enforced: true });
  const task = await h.tasks.create({ agent: 'claude', cwd: h.root });
  h.nexus.usage.set(task.session_id!, { cpu: 20, memory: 1e8, processes: 3 });
  await h.limits.check();
  assert.equal(h.nexusCalls('pause_session').length, 0);
  assert.equal(h.limits.reading(task.task_id)!.cpu, 20);

  h.nexus.usage.set(task.session_id!, { cpu: 95, memory: 1e8, processes: 3 });
  await h.limits.check();
  await h.limits.check(); // no second pause or second approval
  assert.deepEqual(h.nexusCalls('pause_session').map((c) => c.args), [{ session: task.session_id, paused: true }]);
  const [resume] = h.approvals.list('pending');
  assert.deepEqual([resume.kind, resume.requested_by], ['resume', 'limits']);
  assert.match(resume.reason!, /cpu 95%/);

  await h.approvals.decide(resume.id, 'allow', 'alice');
  assert.deepEqual(h.nexusCalls('pause_session').at(-1)!.args, { session: task.session_id, paused: false });
  assert.ok(h.auditKinds().includes('limit.pause'));
});

test('resource limits: alert-only by default, and honest about not enforcing', async (t) => {
  const h = await harness(t);
  assert.match(h.limits.status().reason!, /no thresholds/);
  h.policy.get().resources.memoryBytes = 1000; // in-memory tweak for the test
  const task = await h.tasks.create({ agent: 'claude', cwd: h.root });
  h.nexus.usage.set(task.session_id!, { cpu: 1, memory: 5000, processes: 1 });
  const ev: any[] = [];
  h.bus.on('event', (e) => ev.push(e));
  await h.limits.check(Date.now() + 60_000);
  await h.limits.check(Date.now() + 120_000);
  assert.equal(ev.filter((e) => e.type === 'limit').length, 1, 'one alert per breach');
  assert.equal(h.nexusCalls('pause_session').length, 0);
});

test('approval executors: each kind sends exactly its one Nexus call, once', async (t) => {
  const h = await harness(t);
  const task = await h.tasks.create({ agent: 'claude', cwd: h.root });
  const s = task.session_id!;
  const keys = h.approvals.request('send_keys', { session_id: s, task_id: task.task_id, requested_by: 'muse', request: { text: 'git status', enter: true }, reason: 'look' });
  assert.equal(h.approvals.request('send_keys', { session_id: s, task_id: task.task_id, requested_by: 'muse', request: { text: 'git status', enter: true } }).id, keys.id, 'same request dedupes');
  await h.approvals.decide(keys.id, 'allow', 'alice');
  assert.deepEqual(h.sent(), [{ session: s, text: 'git status', enter: true }]);
  await assert.rejects(h.approvals.decide(keys.id, 'allow', 'alice'));
  assert.equal(h.sent().length, 1);

  const denied = h.approvals.request('send_keys', { session_id: s, task_id: task.task_id, requested_by: 'muse', request: { text: 'rm -rf /', enter: true } });
  await h.approvals.decide(denied.id, 'deny', 'alice');
  assert.equal(h.sent().length, 1, 'a denied request sends nothing');
  assert.equal(h.approvals.get(denied.id)!.consumed_at, null);

  const stop = h.approvals.request('stop', { session_id: s, task_id: task.task_id, requested_by: 'muse' });
  await h.approvals.decide(stop.id, 'allow', 'alice');
  assert.equal(h.nexusCalls('stop_session').length, 1);
  assert.equal(h.tasks.get(task.task_id)!.status, 'stopped');

  const late = h.approvals.request('send_keys', { session_id: s, task_id: task.task_id, requested_by: 'muse', request: { text: 'x' } });
  await assert.rejects(h.approvals.decide(late.id, 'allow', 'alice'), /terminal is gone/);
  assert.equal(h.approvals.get(late.id)!.status, 'stale');
  assert.equal(h.sent().length, 1);
});

test('a closed terminal takes its pending requests along', async (t) => {
  const h = await harness(t);
  const { task } = await atPrompt(h);
  const keys = h.approvals.request('send_keys', { session_id: task.session_id!, task_id: task.task_id, requested_by: 'muse', request: { text: 'x' } });
  h.nexus.sessions.get(task.session_id!)!.exited = true;
  h.nexus.setState(task.session_id!, 'idle', { emit: false });
  (h.nexus as any).emit(h.nexus.sessions.get(task.session_id!), 'exited');
  await h.poller.tick();
  assert.equal(h.approvals.get(keys.id)!.status, 'stale');
  assert.equal(h.approvals.list('pending').length, 0);
});
