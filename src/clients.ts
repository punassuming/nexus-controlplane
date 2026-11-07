/**
 * Orchestrator client keys for the gateway. Each outside orchestrator (Muse, a Codex agent, …) gets its own key;
 * only a SHA-256 of it is stored (0600, outside Git). Revoking or disabling a client takes effect on its next request,
 * without a restart.
 *
 *   npm run client -- add <id>       prints the new key once
 *   npm run client -- revoke <id>
 *   npm run client -- list
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface ClientEntry {
  id: string;
  keyHash: string;
  enabled: boolean;
  created: number;
}

const ID = /^[A-Za-z0-9][\w.-]{0,63}$/;
const sha256 = (s: string) => createHash('sha256').update(s).digest();

export class ClientRegistry {
  private entries: ClientEntry[] = [];
  private mtime = -1;

  constructor(private path: string) {}

  private load() {
    const mtime = existsSync(this.path) ? statSync(this.path).mtimeMs : 0;
    if (mtime === this.mtime) return;
    this.mtime = mtime;
    this.entries = mtime ? (JSON.parse(readFileSync(this.path, 'utf8')).clients ?? []) : [];
  }

  private save() {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify({ clients: this.entries }, null, 2) + '\n', { mode: 0o600 });
    chmodSync(this.path, 0o600);
    this.mtime = statSync(this.path).mtimeMs;
  }

  list(): Omit<ClientEntry, 'keyHash'>[] {
    this.load();
    return this.entries.map(({ keyHash: _k, ...e }) => e);
  }

  /** The enabled client this key belongs to, if any. Compares every entry in constant time. */
  lookup(key: string | undefined): string | undefined {
    if (!key) return undefined;
    this.load();
    const got = sha256(key);
    let found: string | undefined;
    for (const e of this.entries) {
      const want = Buffer.from(e.keyHash, 'hex');
      if (want.length === got.length && timingSafeEqual(want, got) && e.enabled) found = e.id;
    }
    return found;
  }

  add(id: string): string {
    if (!ID.test(id)) throw new Error('client id: letters, digits, . _ - (max 64)');
    this.load();
    if (this.entries.some((e) => e.id === id)) throw new Error(`client ${id} exists; revoke it first`);
    const key = `cpk_${randomBytes(32).toString('base64url')}`;
    this.entries.push({ id, keyHash: sha256(key).toString('hex'), enabled: true, created: Date.now() });
    this.save();
    return key;
  }

  revoke(id: string): boolean {
    this.load();
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length !== before) this.save();
    return this.entries.length !== before;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const reg = new ClientRegistry(process.env.CONTROLPLANE_CLIENTS ?? 'data/clients.json');
  const [cmd, id] = process.argv.slice(2);
  if (cmd === 'add' && id) {
    const key = reg.add(id);
    console.log(`client ${id} added. Its key (shown once; give it only to that orchestrator):\n${key}`);
  } else if (cmd === 'revoke' && id) {
    console.log(reg.revoke(id) ? `client ${id} revoked` : `no client ${id}`);
  } else if (cmd === 'list') {
    for (const c of reg.list()) console.log(`${c.id}\t${c.enabled ? 'enabled' : 'disabled'}\t${new Date(c.created).toISOString()}`);
  } else {
    console.error('usage: npm run client -- add <id> | revoke <id> | list');
    process.exit(2);
  }
}
