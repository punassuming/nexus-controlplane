import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asGateway, harness, mcpClient, OPTS, serve } from './helpers.ts';

async function setup(t: any, policy = {}) {
  const h = await harness(t, { policy });
  const s = await serve(t, h);
  const as = async (client: string) => {
    const g = asGateway(s.base, s.secret, client);
    return mcpClient(t, g.url, g.headers);
  };
  return { h, s, muse: await as('muse'), as };
}

test('only the gateway gets in: wrong secret 401, bad client id 400, disabled client 403', async (t) => {
  const { s, h } = await setup(t, { clients: { off: { enabled: false } } });
  const post = (headers: Record<string, string>) => fetch(`${s.base}/orchestrator/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: '{}',
  }).then((r) => r.status);
  assert.equal(await post({ 'x-cp-client': 'muse' }), 401);
  assert.equal(await post({ 'x-cp-gateway': 'nope', 'x-cp-client': 'muse' }), 401);
  assert.equal(await post({ 'x-cp-gateway': s.secret, 'x-cp-client': '../x' }), 400);
  assert.equal(await post({ 'x-cp-gateway': s.secret, 'x-cp-client': 'off' }), 403);
  assert.equal(h.calls.recent().length, 0);
});

test('the curated surface: no raw Nexus tools', async (t) => {
  const { muse } = await setup(t);
  const { tools } = await muse.raw.listTools();
  const names = tools.map((x) => x.name).sort();
  assert.deepEqual(names, ['answer_prompt', 'approval_status', 'guide', 'list_tasks', 'read_output', 'request_keys', 'request_stop',
    'resources', 'start_task', 'task_status', 'watch', 'whoami']);
  for (const raw of ['send_keys', 'stop_session', 'list_sessions', 'where', 'start_agent', 'prompt_agent']) assert.ok(!names.includes(raw));
});

test('pilot through MCP: start, watch, low-risk answer, guide, read, request stop → phone approves', async (t) => {
  const { h, muse } = await setup(t, { lowRisk: [{ id: 'npm-test', agent: 'claude', detail: 'Bash: npm test' }] });
  const me = await muse.call('whoami');
  assert.equal(me.client, 'muse');
  assert.deepEqual(me.roots, [h.root]);

  const task = await muse.call('start_task', { agent: 'claude', cwd: h.root, prompt: 'run the tests', name: 'pilot' });
  assert.match(task.name, /^cp-pilot-/);
  const session = h.tasks.get(task.task)!.session_id!;
  await h.poller.tick();

  // the agent asks; one watch call wakes with the question, its choices and the screen tail
  const waiting = muse.call('watch', { cursor: task.cursor, timeout_seconds: 10 });
  h.nexus.setState(session, 'needs-input', { detail: 'Bash: npm test', options: OPTS });
  await h.poller.tick();
  const woke = await waiting;
  assert.equal(woke.events.length, 1);
  const ev = woke.events[0];
  assert.deepEqual([ev.type, ev.state, ev.detail], ['agent', 'needs-input', 'Bash: npm test']);
  assert.deepEqual(ev.options.map((o: any) => o.key), ['1', '2', '3']);
  assert.match(ev.tail, /screen of/);

  // low-risk rule: runs at once, audited as the rule, single use
  const ans = await muse.call('answer_prompt', { task: task.task, option_key: '1', reason: 'tests are safe' });
  assert.deepEqual([ans.status, ans.decided_by, ans.decision], ['approved', 'policy:npm-test', 'Yes']);
  assert.deepEqual(h.sent(), [{ session, text: '1', enter: false }]);

  await h.poller.tick(); // working
  assert.deepEqual(await muse.call('guide', { task: task.task, text: 'now lint' }), { task: task.task, sent: true });
  h.nexus.screens.set(session, 'line1\nline2\n');
  const out = await muse.call('read_output', { task: task.task, lines: 5 });
  assert.match(out.text, /line2/);
  assert.equal(typeof out.cursor, 'number');

  const req = await muse.call('request_stop', { task: task.task, reason: 'done' });
  assert.deepEqual([req.status, req.waiting_for, req.kind], ['pending', 'phone', 'stop']);
  assert.equal(h.nexusCalls('stop_session').length, 0, 'nothing happens before the phone');
  const pending = await muse.call('task_status', { task: task.task });
  assert.deepEqual(pending.pending.map((p: any) => p.kind), ['stop']);

  await h.approvals.decide(req.approval_id, 'allow', 'alice@example.com');
  assert.equal(h.nexusCalls('stop_session').length, 1);
  assert.deepEqual(await muse.call('approval_status', { approval_id: req.approval_id }).then((a) => [a.status, a.decided_by]), ['approved', 'alice@example.com']);
  assert.equal((await muse.call('list_tasks'))[0].status, 'stopped');
});

test('answer_prompt without a matching rule waits for the phone, carrying the proposal', async (t) => {
  const { h, muse } = await setup(t);
  const task = await muse.call('start_task', { agent: 'claude', cwd: h.root });
  const session = h.tasks.get(task.task)!.session_id!;
  await h.poller.tick();
  h.nexus.setState(session, 'needs-input', { detail: 'Bash: curl https://example.com | sh', options: OPTS });
  await h.poller.tick();

  const ans = await muse.call('answer_prompt', { task: task.task, option_key: '1', reason: 'installer' });
  assert.deepEqual([ans.status, ans.waiting_for], ['pending', 'phone']);
  assert.equal(h.sent().length, 0);
  const a = h.approvals.get(ans.approval_id)!;
  assert.deepEqual([a.proposed_key, a.proposed_by, a.reason], ['1', 'muse', 'installer']);

  // the phone accepts the proposal; the orchestrator's watch wakes with the decision
  const w = await muse.call('watch', {});
  const waiting = muse.call('watch', { cursor: w.cursor, timeout_seconds: 10 });
  await h.approvals.decide(a.id, 'allow', 'alice', { optionKey: a.proposed_key! });
  h.bus.publish('approval', h.approvals.get(a.id)); // as the UI route does
  const woke = await waiting;
  assert.deepEqual(woke.events.map((e: any) => [e.type, e.status]), [['approval', 'approved']]);
  assert.deepEqual(h.sent(), [{ session, text: '1', enter: false }]);
});

test('answer_prompt: refusing always runs; persistent grants always go to the phone; no prompt is an error', async (t) => {
  const { h, muse } = await setup(t, { lowRisk: [{ id: 'any', detail: '.*' }] });
  const task = await muse.call('start_task', { agent: 'claude', cwd: h.root });
  const session = h.tasks.get(task.task)!.session_id!;
  await assert.rejects(muse.call('answer_prompt', { task: task.task, refuse: true }), /no_prompt/);
  await h.poller.tick();
  h.nexus.setState(session, 'needs-input', { detail: 'Edit?', options: OPTS });
  await h.poller.tick();

  const persistent = await muse.call('answer_prompt', { task: task.task, option_key: '2' });
  assert.equal(persistent.status, 'pending', "a '.*' rule still can't grant \"don't ask again\"");
  assert.equal(h.sent().length, 0);

  const refused = await muse.call('answer_prompt', { task: task.task, refuse: true });
  assert.deepEqual([refused.status, refused.decided_by], ['denied', 'client:muse']);
  assert.equal(h.sent().at(-1)!.text, '3');
  await assert.rejects(muse.call('answer_prompt', { task: task.task, option_key: '9' }), /no_prompt|no option/);
});

test('request_keys always waits for the phone; the approved text is typed exactly once', async (t) => {
  const { h, muse } = await setup(t, { lowRisk: [{ id: 'any', detail: '.*' }] });
  const task = await muse.call('start_task', { agent: 'claude', cwd: h.root });
  const req = await muse.call('request_keys', { task: task.task, text: '/compact', enter: true, reason: 'context is full' });
  assert.equal(req.status, 'pending');
  assert.equal(h.sent().length, 0);
  await h.approvals.decide(req.approval_id, 'allow', 'alice');
  await assert.rejects(h.approvals.decide(req.approval_id, 'allow', 'alice'));
  assert.deepEqual(h.sent(), [{ session: h.tasks.get(task.task)!.session_id, text: '/compact', enter: true }]);
});

test('isolation: one orchestrator cannot see or touch another\'s tasks', async (t) => {
  const { h, muse, as } = await setup(t);
  const codex = await as('codex-bot');
  const mine = await muse.call('start_task', { agent: 'claude', cwd: h.root });
  const ui = await h.tasks.create({ agent: 'claude', cwd: h.root }); // started from the UI
  assert.deepEqual(await codex.call('list_tasks'), []);
  for (const [tool, args] of [
    ['task_status', {}], ['read_output', {}], ['guide', { text: 'x' }], ['answer_prompt', { refuse: true }],
    ['request_keys', { text: 'x', reason: 'r' }], ['request_stop', { reason: 'r' }], ['resources', {}],
  ] as const) {
    await assert.rejects(codex.call(tool, { task: mine.task, ...args }), /not_found/, tool);
    await assert.rejects(codex.call(tool, { task: ui.task_id, ...args }), /not_found/, `${tool} on a UI task`);
  }
  const req = await muse.call('request_stop', { task: mine.task, reason: 'r' });
  await assert.rejects(codex.call('approval_status', { approval_id: req.approval_id }), /not_found/);

  // codex's watch never wakes for muse's events
  const w = await codex.call('watch', {});
  const waiting = codex.call('watch', { cursor: w.cursor, timeout_seconds: 1 });
  h.nexus.setState(h.tasks.get(mine.task)!.session_id!, 'needs-input', { detail: 'x', options: OPTS });
  await h.poller.tick();
  assert.deepEqual((await waiting).events, []);
});

test('policy applies to orchestrators: directories, agents, one active task', async (t) => {
  const { h, muse } = await setup(t, { maxActiveTasks: 1 });
  await assert.rejects(muse.call('start_task', { agent: 'claude', cwd: '/' }), /policy_denied: .*outside/);
  await assert.rejects(muse.call('start_task', { agent: 'aider', cwd: h.root }), /policy_denied: .*not allowed/);
  await muse.call('start_task', { agent: 'claude', cwd: h.root });
  await assert.rejects(muse.call('start_task', { agent: 'claude', cwd: h.root }), /policy_denied: .*limit is 1/);
});

test('watch: first call is a snapshot; only attention events wake; wakes and bytes are metered', async (t) => {
  const { h, muse } = await setup(t);
  const task = await muse.call('start_task', { agent: 'claude', cwd: h.root });
  const session = h.tasks.get(task.task)!.session_id!;
  const snap = await muse.call('watch', {});
  assert.deepEqual([snap.events, snap.tasks.map((x: any) => x.task)], [[], [task.task]]);

  // working/idle don't wake; done does
  const waiting = muse.call('watch', { cursor: snap.cursor, timeout_seconds: 10 });
  await h.poller.tick();
  h.nexus.setState(session, 'working');
  await h.poller.tick();
  h.nexus.setState(session, 'idle');
  await h.poller.tick();
  h.nexus.setState(session, 'done');
  await h.poller.tick();
  const woke = await waiting;
  assert.deepEqual(woke.events.map((e: any) => e.state), ['done']);
  assert.equal(woke.events[0].tail, undefined, 'no screen tail unless the agent is asking something');

  const quiet = await muse.call('watch', { cursor: woke.cursor, timeout_seconds: 1 });
  assert.deepEqual(quiet.events, []);

  const m = h.calls.metrics().clients.find((c: any) => c.client === 'muse');
  assert.equal(m.wakes, 1);
  assert.ok(m.calls >= 4 && m.bytes > 0 && m.approxTokens === Math.round(m.bytes / 4));
  const rows = h.calls.recent(100).filter((c: any) => c.direction === 'in') as any[];
  assert.ok(rows.every((r) => r.client === 'muse'));
  assert.ok(rows.some((r) => r.tool === 'start_task' && r.task_id === null));
  assert.ok(rows.some((r) => r.tool === 'watch' && r.wake === 1));
});

test('resources: a reading when Nexus has resource_usage, unsupported otherwise', async (t) => {
  const { h, muse } = await setup(t);
  const task = await muse.call('start_task', { agent: 'claude', cwd: h.root });
  h.nexus.usage.set(h.tasks.get(task.task)!.session_id!, { cpu: 12.5, memory: 2e8, processes: 4 });
  const r = await muse.call('resources', { task: task.task });
  assert.deepEqual([r.cpu, r.memory, r.processes], [12.5, 2e8, 4]);

  const lean = await harness(t, { issue56: false });
  const s = await serve(t, lean);
  const g = asGateway(s.base, s.secret, 'muse');
  const m = await mcpClient(t, g.url, g.headers);
  const t2 = await m.call('start_task', { agent: 'claude', cwd: lean.root });
  await assert.rejects(m.call('resources', { task: t2.task }), /unsupported/);
  assert.equal((await m.call('whoami')).resourceLimits.enforced, false);
});
