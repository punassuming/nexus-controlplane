import { isLoopback, type AuthMode } from './auth.ts';

export interface Config {
  nexusUrl: string;
  nexusToken: string;
  host: string;
  port: number;
  dbPath: string;
  /** Limits and allowlists (JSON, outside Git; reloaded on change). */
  policyPath: string;
  /** Orchestrator keys, shared with the gateway (0600). */
  clientsPath: string;
  /** The internal secret only the gateway presents (0600, created on first start). */
  gatewaySecretPath: string;
  /** Other MCP servers to proxy (JSON, outside Git). Nexus is always proxied. */
  upstreamsPath: string;
  /** Web Push keys (0600, created on first start). */
  vapidPath: string;
  /** VAPID subject: a mailto: or https: contact for push services. */
  pushSubject: string;
  pollWaitSec: number;
  auth: { mode: AuthMode; token: string; allowedUsers: string[] };
}

/** nexusd's own default: 47000 + uid % 1000 on POSIX, 47821 on Windows (mcp-gate.ts). */
export function defaultNexusUrl(): string {
  const port = process.getuid ? 47000 + (process.getuid() % 1000) : 47821;
  return `http://127.0.0.1:${port}/mcp`;
}

export function loadConfig(env = process.env): Config {
  return {
    nexusUrl: env.NEXUS_MCP_URL ?? defaultNexusUrl(),
    nexusToken: env.NEXUS_SUPERVISOR_TOKEN ?? '',
    host: env.CONTROLPLANE_HOST ?? '127.0.0.1',
    port: Number(env.CONTROLPLANE_PORT ?? 8787),
    dbPath: env.CONTROLPLANE_DB ?? 'data/controlplane.db',
    policyPath: env.CONTROLPLANE_POLICY ?? 'data/policy.json',
    clientsPath: env.CONTROLPLANE_CLIENTS ?? 'data/clients.json',
    gatewaySecretPath: env.CONTROLPLANE_GATEWAY_SECRET ?? 'data/gateway.secret',
    upstreamsPath: env.CONTROLPLANE_UPSTREAMS ?? 'data/upstreams.json',
    vapidPath: env.CONTROLPLANE_VAPID ?? 'data/vapid.json',
    pushSubject: env.CONTROLPLANE_PUSH_SUBJECT ?? 'mailto:nexus-controlplane@localhost',
    // Nexus's watch_agents default; most MCP clients allow a call about a minute.
    pollWaitSec: Math.min(Number(env.POLL_WAIT_SEC ?? 50), 50),
    auth: {
      mode: (env.CONTROLPLANE_AUTH ?? 'none') as AuthMode,
      token: env.CONTROLPLANE_UI_TOKEN ?? '',
      allowedUsers: (env.CONTROLPLANE_ALLOWED_USERS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    },
  };
}

/**
 * Refuse configurations that would put an unauthenticated (or header-trusting) UI on the network. The control
 * plane itself never needs a non-loopback listener: orchestrators come through the gateway, phones through
 * `tailscale serve`.
 */
export function assertSafeConfig(cfg: Config) {
  const { mode, token } = cfg.auth;
  if (!['none', 'tailscale', 'token'].includes(mode)) throw new Error(`CONTROLPLANE_AUTH must be none, tailscale or token, not ${mode}`);
  // 'tailscale' trusts identity headers that only `tailscale serve` may set: nothing else may reach the port.
  if (mode !== 'token' && !isLoopback(cfg.host)) {
    throw new Error(`CONTROLPLANE_AUTH=${mode} requires CONTROLPLANE_HOST on loopback; use tailscale serve or CONTROLPLANE_AUTH=token`);
  }
  if (mode === 'token' && token.length < 24) throw new Error('CONTROLPLANE_UI_TOKEN must be at least 24 characters');
}
