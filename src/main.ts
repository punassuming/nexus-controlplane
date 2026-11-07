import { ApprovalQueue } from './approvals.ts';
import { assertSafeConfig, loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { Bus, Poller } from './events.ts';
import { NexusClient } from './nexus/client.ts';
import { buildServer } from './server.ts';
import { TaskStore } from './tasks.ts';

const cfg = loadConfig();
if (!cfg.nexusToken) throw new Error('NEXUS_SUPERVISOR_TOKEN is required');
assertSafeConfig(cfg);

const db = openDb(cfg.dbPath);
const nexus = new NexusClient(cfg.nexusUrl, cfg.nexusToken);
const bus = new Bus();
const tasks = new TaskStore(db, nexus);
const approvals = new ApprovalQueue(db, nexus, cfg.approvalTtlMs);
const poller = new Poller(db, nexus, tasks, approvals, bus, cfg.pollWaitSec);
let tools: string[] = [];

// Learn which optional tools (get_state, pause_session, resource_usage) this Nexus has, then watch.
const connect = async (): Promise<void> => {
  try {
    tools = await nexus.listTools();
    console.log('nexus tools:', tools.join(', '));
    poller.start();
  } catch (e: any) {
    console.warn(`nexus not usable yet (${e.message}); retrying in 15 s`);
    setTimeout(connect, 15_000);
  }
};
void connect();

const app = buildServer({
  tasks, approvals, bus, auth: cfg.auth,
  status: () => ({ online: nexus.online, lastError: nexus.lastError, tools }),
});
// Loopback by default: publish over the tailnet with `tailscale serve`, not by binding 0.0.0.0.
await app.listen({ host: cfg.host, port: cfg.port });
console.log(`control plane on http://${cfg.host}:${cfg.port} (auth: ${cfg.auth.mode}) -> ${cfg.nexusUrl}`);
