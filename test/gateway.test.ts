import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGateway, fileSecret } from '../src/gateway.ts';
import { harness, mcpClient, serve, tmp } from './helpers.ts';

async function setup(t: any) {
  const h = await harness(t);
  const s = await serve(t, h);
  const dir = tmp('cp-gw-');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'),
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const lines: any[] = [];
  const gw = createGateway({
    registry: s.clients, upstream: new URL('/orchestrator/mcp', s.base), secret: () => s.secret,
    tls: { key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) }, ratePerMinute: 30, log: (l) => lines.push(l),
  });
  await new Promise<void>((r) => gw.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { gw.closeAllConnections(); gw.close(r); }));
  // The test's self-signed certificate; scoped to this test.
  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  t.after(() => { if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev; });
  const url = `https://127.0.0.1:${(gw.address() as any).port}/mcp`;
  return { h, s, url, lines };
}

const post = (url: string, headers: Record<string, string>, body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}') =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body });

test('gateway: a client key gets the orchestrator tools over TLS; the Nexus token is never involved', async (t) => {
  const { h, s, url, lines } = await setup(t);
  const key = s.clients.add('muse');
  assert.match(key, /^cpk_/);
  assert.equal(statSync(join(s.clientsDir, 'clients.json')).mode & 0o777, 0o600);
  assert.ok(!readFileSync(join(s.clientsDir, 'clients.json'), 'utf8').includes(key), 'only the hash is stored');

  const muse = await mcpClient(t, url, { authorization: `Bearer ${key}` });
  assert.equal((await muse.call('whoami')).client, 'muse');
  const task = await muse.call('start_task', { agent: 'claude', cwd: h.root });
  assert.equal(h.tasks.get(task.task)!.client_id, 'muse');
  assert.ok(lines.some((l) => l.client === 'muse' && l.tool === 'start_task' && l.status === 200), 'one log line per request, with the tool');
  assert.ok(!JSON.stringify(lines).includes(h.nexus.token));
});

test('gateway: unknown, revoked and missing keys get 401; revocation needs no restart', async (t) => {
  const { s, url } = await setup(t);
  assert.equal((await post(url, {})).status, 401);
  assert.equal((await post(url, { authorization: 'Bearer cpk_nope' })).status, 401);
  const key = s.clients.add('muse');
  assert.equal((await post(url, { authorization: `Bearer ${key}` })).status, 200);
  s.clients.revoke('muse');
  assert.equal((await post(url, { authorization: `Bearer ${key}` })).status, 401);

  // the gateway also notices a registry edited by another process (the CLI)
  const key2 = s.clients.add('codex-bot');
  const file = join(s.clientsDir, 'clients.json');
  const j = JSON.parse(readFileSync(file, 'utf8'));
  j.clients[0].enabled = false;
  writeFileSync(file, JSON.stringify(j));
  assert.equal((await post(url, { authorization: `Bearer ${key2}` })).status, 401);
});

test('gateway: a client cannot claim another identity or reach other paths', async (t) => {
  const { h, s, url } = await setup(t);
  const key = s.clients.add('muse');
  const spoof = await post(url, { authorization: `Bearer ${key}`, 'x-cp-client': 'admin', 'x-cp-gateway': 'guess' },
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }));
  const body = await spoof.text();
  assert.match(body, /\\"client\\":\\"muse\\"/, 'x-cp-* from the client are replaced');
  assert.equal((await post(url.replace('/mcp', '/api/tasks'), { authorization: `Bearer ${key}` })).status, 404, 'only /mcp is forwarded');
  assert.equal((await fetch(url, { headers: { authorization: `Bearer ${key}` } })).status, 405);
  assert.equal(h.tasks.list().length, 0);
});

test('gateway: rate limit and body cap', async (t) => {
  const { s, url } = await setup(t);
  const key = s.clients.add('muse');
  assert.equal((await post(url, { authorization: `Bearer ${key}` }, 'x'.repeat(1024 * 1024 + 1))).status, 413);
  const statuses: number[] = [];
  for (let i = 0; i < 31; i++) statuses.push((await post(url, { authorization: `Bearer ${key}` })).status);
  assert.ok(statuses.includes(429));
});

test('fileSecret re-reads a rotated secret', () => {
  const f = join(tmp('cp-sec-'), 'gateway.secret');
  const read = fileSecret(f);
  assert.equal(read(), '');
  writeFileSync(f, 'one\n');
  assert.equal(read(), 'one');
  writeFileSync(f, 'two\n');
  const later = new Date(Date.now() + 5000);
  utimesSync(f, later, later);
  assert.equal(read(), 'two');
});
