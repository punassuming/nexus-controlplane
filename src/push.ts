/**
 * Web Push for pending approvals, sent by the control plane itself: no Hermes, no third-party account. The phone
 * installs the UI as a home-screen app (HTTPS via `tailscale serve`) and subscribes; the browser vendor's push
 * service relays an end-to-end encrypted message it can't read.
 *
 * A notification only says that something waits and where. It never carries the keys to type, the prompt, or
 * buttons that decide: deciding stays in the signed-in UI, where it is single-use and audited.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import * as webpush from 'web-push';
import type { Approval } from './approvals.ts';
import { audit } from './db.ts';
import type { Bus, BusEvent } from './events.ts';
import type { TaskStore } from './tasks.ts';

export interface PushSubscriptionJSON {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

const KIND: Record<string, string> = {
  agent_prompt: 'Agent is asking', send_keys: 'Wants to type', stop: 'Wants to stop', resume: 'Paused by limit', tool_call: 'Tool call',
};

export class Push {
  private keys: { publicKey: string; privateKey: string };
  private notified = new Set<string>();

  /** `send` is replaceable for tests; by default it is web-push's. */
  constructor(
    private db: DatabaseSync,
    keysPath: string,
    private subject: string,
    private send: typeof webpush.sendNotification = webpush.sendNotification,
  ) {
    if (existsSync(keysPath)) {
      this.keys = JSON.parse(readFileSync(keysPath, 'utf8'));
    } else {
      this.keys = webpush.generateVAPIDKeys();
      mkdirSync(dirname(keysPath), { recursive: true });
      writeFileSync(keysPath, JSON.stringify(this.keys) + '\n', { mode: 0o600 });
      chmodSync(keysPath, 0o600);
    }
  }

  publicKey(): string {
    return this.keys.publicKey;
  }

  subscribe(user: string, sub: PushSubscriptionJSON) {
    let url: URL;
    try { url = new URL(sub?.endpoint); } catch { throw new Error('bad subscription endpoint'); }
    if (url.protocol !== 'https:') throw new Error('push endpoints must be https');
    if (typeof sub.keys?.p256dh !== 'string' || typeof sub.keys?.auth !== 'string') throw new Error('bad subscription keys');
    this.db.prepare('INSERT INTO push_subs (endpoint, user, keys, created_at) VALUES (?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user=excluded.user, keys=excluded.keys')
      .run(sub.endpoint, user, JSON.stringify(sub.keys), Date.now());
    audit(this.db, 'push.subscribe', user, { host: url.host });
  }

  /** With `user`, only that person's own device; without, a subscription the push service dropped. */
  unsubscribe(endpoint: string, user?: string) {
    if (user === undefined) this.db.prepare('DELETE FROM push_subs WHERE endpoint=?').run(endpoint);
    else this.db.prepare('DELETE FROM push_subs WHERE endpoint=? AND user=?').run(endpoint, user);
  }

  count(user?: string): number {
    return Number((user
      ? this.db.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE user=?').get(user)
      : this.db.prepare('SELECT COUNT(*) AS n FROM push_subs').get() as any)?.n ?? 0);
  }

  /** To every subscribed device. Subscriptions the push service says are gone (404/410) are dropped. */
  async notify(p: PushPayload): Promise<{ sent: number; failed: number }> {
    const subs = this.db.prepare('SELECT endpoint, keys FROM push_subs').all() as any[];
    let sent = 0, failed = 0;
    await Promise.all(subs.map(async (s) => {
      try {
        await this.send({ endpoint: s.endpoint, keys: JSON.parse(s.keys) }, JSON.stringify(p), {
          vapidDetails: { subject: this.subject, publicKey: this.keys.publicKey, privateKey: this.keys.privateKey },
          TTL: 3600, urgency: 'high', topic: p.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32),
        });
        sent++;
      } catch (e: any) {
        failed++;
        if (e?.statusCode === 404 || e?.statusCode === 410) this.unsubscribe(s.endpoint);
      }
    }));
    return { sent, failed };
  }

  /** Notify once for each new approval and each resource-limit action. */
  attach(bus: Bus, tasks: TaskStore) {
    bus.on('event', (e: BusEvent) => {
      if (e.type === 'approval') {
        const a = e.data as Approval;
        if (a.status !== 'pending' || this.notified.has(a.id)) return;
        this.notified.add(a.id);
        const task = a.task_id ? tasks.get(a.task_id)?.name : undefined;
        const by = a.requested_by === 'agent' ? '' : a.requested_by === 'limits' ? '' : ` · ${a.requested_by}`;
        void this.notify({
          title: 'Approval needed', body: `${KIND[a.kind] ?? a.kind}${task ? ` · ${task}` : ''}${by}`,
          url: `/#approval-${a.id}`, tag: a.id,
        }).catch(() => {});
      } else if (e.type === 'limit') {
        const task = e.task_id ? tasks.get(e.task_id)?.name : undefined;
        void this.notify({
          title: 'Resource limit', body: `${e.data.action === 'paused' ? 'Paused' : 'Over the limit'}${task ? ` · ${task}` : ''}`,
          url: '/', tag: `limit-${e.task_id ?? ''}`,
        }).catch(() => {});
      }
    });
  }
}
