/**
 * The MCP servers the proxy fronts. Nexus is always there (`nexus`, with the supervisor token). Others are listed
 * in a JSON file outside Git, with credentials taken from environment variables, never from the file:
 *
 *   [{ "id": "github", "url": "http://127.0.0.1:9100/mcp", "tokenEnv": "GITHUB_MCP_TOKEN", "prefix": "github_" }]
 *
 * Their tools are re-exposed as `<prefix><tool>` and governed by the policy's `upstreams.<id>` rules
 * (default: hidden). Nexus's tools keep their own names, so agents' existing Nexus knowledge applies.
 */
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import type { CallRecord } from './calls.ts';
import { NexusClient } from './nexus/client.ts';

const UpstreamSchema = z.array(z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/).refine((id) => id !== 'nexus' && id !== 'cp', 'reserved id'),
  url: z.string().url(),
  tokenEnv: z.string().optional(),
  prefix: z.string().regex(/^[A-Za-z0-9_-]*$/).optional(),
}));

export interface Upstream {
  id: string;
  prefix: string;
  client: NexusClient;
}

export class Upstreams {
  private list: Upstream[];

  constructor(nexus: NexusClient, extra: Upstream[] = []) {
    this.list = [{ id: 'nexus', prefix: '', client: nexus }, ...extra];
  }

  static load(nexus: NexusClient, path: string | undefined, onCall: (c: CallRecord) => void, env = process.env): Upstreams {
    if (!path || !existsSync(path)) return new Upstreams(nexus);
    const cfg = UpstreamSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    return new Upstreams(nexus, cfg.map((u) => ({
      id: u.id,
      prefix: u.prefix ?? `${u.id.replace(/-/g, '_')}_`,
      client: new NexusClient(u.url, (u.tokenEnv && env[u.tokenEnv]) || '', onCall, u.id),
    })));
  }

  all(): Upstream[] {
    return this.list;
  }

  get(id: string): Upstream | undefined {
    return this.list.find((u) => u.id === id);
  }

  /** Learn every upstream's tools. One that is down stays listed with no tools until the next refresh. */
  async refresh(): Promise<Record<string, string>> {
    const errors: Record<string, string> = {};
    await Promise.all(this.list.map((u) => u.client.listTools().catch((e) => { errors[u.id] = e.message; })));
    return errors;
  }

  /** Which upstream and tool an exposed name belongs to. */
  resolve(exposed: string): { upstream: Upstream; tool: string } | undefined {
    // Longest prefix first, so 'nexus' (no prefix) is the fallback.
    for (const u of [...this.list].sort((a, b) => b.prefix.length - a.prefix.length)) {
      if (exposed.startsWith(u.prefix) && u.client.toolDefs().some((t) => t.name === exposed.slice(u.prefix.length))) {
        return { upstream: u, tool: exposed.slice(u.prefix.length) };
      }
    }
  }
}
