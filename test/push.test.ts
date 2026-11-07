import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createECDH, randomBytes } from 'node:crypto';
import { createServer } from 'node:https';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import { Push } from '../src/push.ts';
import { tmp } from './helpers.ts';

test('web push through the real library: VAPID-signed, encrypted, and gone subscriptions are dropped', async (t) => {
  const dir = tmp('cp-push-');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'),
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const got: { path: string; headers: any; body: Buffer }[] = [];
  const service = createServer({ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) }, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    got.push({ path: req.url!, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(req.url === '/gone' ? 410 : 201).end();
  });
  await new Promise<void>((r) => service.listen(0, '127.0.0.1', r));
  t.after(() => { service.closeAllConnections(); service.close(); });
  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  t.after(() => { if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev; });

  const db = openDb(':memory:');
  const keysPath = join(dir, 'vapid.json');
  const push = new Push(db, keysPath, 'mailto:test@example.invalid');
  assert.equal(statSync(keysPath).mode & 0o777, 0o600);
  assert.equal(new Push(db, keysPath, 'mailto:x@y.invalid').publicKey(), push.publicKey(), 'keys persist across restarts');

  // A browser's subscription keys.
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const keys = { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
  const base = `https://127.0.0.1:${(service.address() as any).port}`;
  push.subscribe('alice', { endpoint: `${base}/ok`, keys });
  push.subscribe('alice', { endpoint: `${base}/gone`, keys });
  assert.equal(push.count('alice'), 2);

  const r = await push.notify({ title: 'Approval needed', body: 'Wants to stop · cp-x', url: '/#approval-1', tag: 'a1' });
  assert.deepEqual(r, { sent: 1, failed: 1 });
  const ok = got.find((g) => g.path === '/ok')!;
  assert.equal(ok.headers['content-encoding'], 'aes128gcm');
  assert.match(ok.headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
  assert.equal(ok.headers.urgency, 'high');
  assert.ok(!ok.body.toString('latin1').includes('Approval needed'), 'payload is encrypted');
  assert.equal(push.count('alice'), 1, 'the 410 subscription is gone');

  push.unsubscribe(`${base}/ok`, 'mallory');
  assert.equal(push.count(), 1, 'someone else cannot remove your device');
  push.unsubscribe(`${base}/ok`, 'alice');
  assert.equal(push.count(), 0);
});
