import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import type { NexusApi, SessionState, WaitFor, WatchResult, WatchState } from './types.ts';

export class NexusError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

/** Every state, so a prompt answered elsewhere (working/idle) or a closed terminal (exited) is seen too. */
export const WATCH_ALL: WatchState[] = ['needs-input', 'error', 'done', 'idle', 'working', 'exited'];

/** Pull the JSON payload out of an MCP tool result. Nexus errors read "<code>: <message>". */
export function parseToolResult(res: any): any {
  const text = (res?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
  if (res?.isError) throw new NexusError(text || 'nexus tool error', /^([a-z_]+):/.exec(text)?.[1]);
  if (res?.structuredContent) return res.structuredContent;
  try { return JSON.parse(text); } catch { return text; }
}

/** list_sessions/start_agent return `exited`; get_state (#56) returns `running`. */
export function normalizeSession(s: any): SessionState {
  return { ...s, agent: s.agent ?? null, running: s.running ?? !s.exited };
}

export class NexusClient implements NexusApi {
  private client?: Client;
  private tools?: Set<string>;
  /** True while the last call to Nexus succeeded. When false the UI shows stale state. */
  online = false;
  lastError?: string;

  constructor(private url: string, private token: string) {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    const client = new Client({ name: 'nexus-controlplane', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: { headers: { Authorization: `Bearer ${this.token}` } },
    });
    await client.connect(transport);
    this.client = client;
    return client;
  }

  disconnect() {
    void this.client?.close().catch(() => {});
    this.client = undefined;
  }

  private offline(e: any) {
    this.online = false;
    this.lastError = e?.message ?? String(e);
    this.disconnect();
  }

  private async call(name: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<any> {
    let res;
    try {
      const c = await this.connect();
      res = await c.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
    } catch (e: any) {
      // A JSON-RPC error (bad params, unknown tool) is an answer, not an outage.
      if (e instanceof McpError) throw new NexusError(e.message, `mcp_${e.code}`);
      this.offline(e);
      throw new NexusError(`nexus unreachable: ${e?.message ?? e}`, 'offline');
    }
    this.online = true;
    this.lastError = undefined;
    return parseToolResult(res);
  }

  /**
   * Nexus never answers 401: a token it doesn't accept gets an "empty server" with no tools
   * (mcp-gate.ts). So no tools means the token was rejected.
   */
  async listTools(): Promise<string[]> {
    try {
      const { tools } = await (await this.connect()).listTools();
      if (!tools.length) throw new NexusError('Nexus returned an empty server: the supervisor token was not accepted', 'unauthorized');
      this.tools = new Set(tools.map((t) => t.name));
      this.online = true;
      this.lastError = undefined;
      return [...this.tools];
    } catch (e: any) {
      this.offline(e);
      throw e instanceof NexusError ? e : new NexusError(`nexus unreachable: ${e?.message ?? e}`, 'offline');
    }
  }

  hasTool(name: string): boolean {
    return this.tools?.has(name) ?? false;
  }

  async listSessions(): Promise<SessionState[]> {
    return ((await this.call('list_sessions')) as any[]).map(normalizeSession);
  }

  /** Prefers #56's get_state (typed approval options); falls back to list_sessions (no options). */
  async getState(session: string): Promise<SessionState | undefined> {
    if (this.hasTool('get_state')) {
      try {
        const r = await this.call('get_state', { session });
        return r && typeof r === 'object' ? normalizeSession(r) : undefined;
      } catch (e) {
        if (e instanceof NexusError && /not.?found|no session|unknown/i.test(e.message)) return undefined;
        throw e;
      }
    }
    return (await this.listSessions()).find((s) => s.id === session);
  }

  async startAgent(a: { agent: string; cwd: string; name: string; prompt?: string }): Promise<SessionState> {
    // No split next to a supervisor: it isn't a terminal. The app lists the session in its sidebar.
    return normalizeSession(await this.call('start_agent', { ...a, placement: 'background' }));
  }

  /** By default returns once the agent starts working, not when it settles (up to 900 s in Nexus). */
  async promptAgent(session: string, text: string, o: { wait?: WaitFor; timeoutSec?: number; force?: boolean } = {}) {
    const timeout_seconds = o.timeoutSec ?? 30;
    await this.call('prompt_agent', { session, text, wait: o.wait ?? 'working', timeout_seconds, force: o.force ?? false },
      (timeout_seconds + 15) * 1000);
  }

  async sendKeys(session: string, text: string, enter = false) {
    await this.call('send_keys', { session, text, enter });
  }

  async pauseSession(session: string, paused: boolean) {
    if (!this.hasTool('pause_session')) throw new NexusError('pause_session not available on this Nexus', 'unsupported');
    await this.call('pause_session', { session, paused });
  }

  async stopSession(session: string) {
    await this.call('stop_session', { session });
  }

  async watchAgents(cursor: number | undefined, waitSec: number): Promise<WatchResult> {
    const r = await this.call('watch_agents', { cursor, timeout_seconds: waitSec, for: WATCH_ALL }, (waitSec + 15) * 1000);
    return { events: r?.events ?? [], cursor: Number(r?.cursor ?? cursor ?? 0), ...(r?.missed ? { missed: true } : {}) };
  }
}
