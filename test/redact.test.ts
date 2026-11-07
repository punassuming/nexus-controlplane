import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactCapped } from '../src/redact.ts';

test('redact masks common secret shapes and leaves ordinary text alone', () => {
  const cases: [string, RegExp][] = [
    ['Authorization: Bearer abcdefghijklmnop.qrs', /Bearer «redacted»/],
    ['export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz', /ANTHROPIC_API_KEY=«redacted»/],
    ['token ghp_abcdefghijklmnopqrstuvwxyz0123456789', /token «redacted»/],
    ['{"password": "hunter2hunter2"}', /"password": "«redacted»"/],
    ['--db-password=s3cr3t-value', /db-password=«redacted»/],
    ['postgres://app:pa55word@db.internal:5432/x', /postgres:\/\/app:«redacted»@db/],
    ['AKIAABCDEFGHIJKLMNOP', /«redacted»/],
    ['-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY-----', /^«redacted»$/],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', /^«redacted»$/],
    ['key cpk_abcdefghijklmnopqrstuvwxyz012345', /key «redacted»/],
  ];
  for (const [input, want] of cases) assert.match(redact(input), want, input);
  for (const plain of ['npm test passed (42 tests)', 'Bash: git status', 'tokens used: 1234', 'the secret sauce is tests']) {
    assert.equal(redact(plain), plain);
  }
});

test('redactCapped caps size and says how much was cut', () => {
  const out = redactCapped({ text: 'x'.repeat(1000) }, 300);
  assert.equal(out.slice(0, 300).length, 300);
  assert.match(out, /more bytes not kept\]$/);
});
