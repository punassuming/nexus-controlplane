import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ApprovalQueue } from './approvals.ts';
import { CallLog } from './calls.ts';
import { ClientRegistry } from './clients.ts';
import { assertSafeConfig, loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { Bus, Poller } from './events.ts';
import { fileSecret } from './gateway.ts';
import { Limits } from './limits.ts';
import { NexusClient } from './nexus/client.ts';
import { Policy } from './policy.ts';
import { Push } from './push.ts';
import { buildServer } from './server.ts';
import { TaskStore } from './tasks.ts';
import { Upstreams } from './upstreams.ts';

const cfg = loadConfig();
if (!cfg.nexusToken) throw new Error('NEXUS_SUPERVISOR_TOKEN is required');
assertSafeConfig(cfg);

// The secret only the gateway presents. Created once, 0600, never logged.
if (!existsSync(cfg.gatewaySecretPath)) {
  mkdirSync(dirname(cfg.gatewaySecretPath), { recursive: true });
  writeFileSync(cfg.gatewaySecretPath, randomBytes(32).toString('base64url') + '\n', { mode: 0o600 });
  chmodSync(cfg.gatewaySecretPath, 0o600);
}

const db = openDb(cfg.dbPath);
if (cfg.dbPath !== ':memory:') chmodSync(cfg.dbPath, 0o600); // transcripts live here
const policy = new Policy(cfg.policyPath);
if (!existsSync(cfg.policyPath)) console.warn(`no policy at ${cfg.policyPath}: defaults apply, and with no roots nothing can start`);
const calls = new CallLog(db, policy);
const record = (c: Parameters<CallLog['record']>[0]) => calls.record(c);
const nexus = new NexusClient(cfg.nexusUrl, cfg.nexusToken, record);
const upstreams = Upstreams.load(nexus, cfg.upstreamsPath, record);
const bus = new Bus(db);
const tasks = new TaskStore(db, nexus, policy);
let limits: Limits;
const approvals = new ApprovalQueue(db, nexus, () => policy.get().approvalTtlMs, {
  stopped: (session) => tasks.markStopped(session, 'approval'),
  resumed: (session) => limits.resumed(session),
  callUpstream: async (upstream, tool, args) => {
    const u = upstreams.get(upstream);
    if (!u) throw new Error(`no upstream ${upstream}`);
    const r = await u.client.callRaw(tool, args);
    return r.content?.map((c: any) => c.text ?? '').join('') ?? '';
  },
});
limits = new Limits(db, nexus, tasks, approvals, bus, policy);
const poller = new Poller(db, nexus, tasks, approvals, bus, cfg.pollWaitSec);
const push = new Push(db, cfg.vapidPath, cfg.pushSubject);
push.attach(bus, tasks);
let tools: string[] = [];

// On start: sign on to Nexus with the supervisor token, learn every upstream's tools, then watch.
const connect = async (): Promise<void> => {
  try {
    tools = await nexus.listTools();
    console.log('nexus tools:', tools.join(', '));
    for (const [id, err] of Object.entries(await upstreams.refresh())) if (id !== 'nexus') console.warn(`upstream ${id}: ${err}`);
    poller.start();
    limits.start();
    const l = limits.status();
    if (!l.enforced) console.warn(l.reason);
  } catch (e: any) {
    console.warn(`nexus not usable yet (${e.message}); retrying in 15 s`);
    setTimeout(connect, 15_000);
  }
};
void connect();
// Upstream tool lists change (a Nexus upgrade adds tools); transcripts age out.
setInterval(() => void upstreams.refresh().then(() => { tools = nexus.toolDefs().map((t) => t.name); }), 5 * 60_000);
setInterval(() => calls.prune(), 60 * 60_000);
calls.prune();

const app = buildServer({
  db, upstreams, tasks, approvals, bus, policy, limits, calls, push, auth: cfg.auth,
  clients: new ClientRegistry(cfg.clientsPath),
  gatewaySecret: fileSecret(cfg.gatewaySecretPath),
  status: () => ({ online: nexus.online, lastError: nexus.lastError, tools }),
});
// Loopback by default: phones reach it through `tailscale serve`, orchestrators through the gateway.
await app.listen({ host: cfg.host, port: cfg.port });
console.log(`control plane on http://${cfg.host}:${cfg.port} (auth: ${cfg.auth.mode}) -> ${cfg.nexusUrl}`);
