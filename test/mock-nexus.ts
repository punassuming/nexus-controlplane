/**
 * Stand-in for nexusd's MCP server, mirroring punassuming/nexus@631bd52 so contract drift fails here:
 * - tool names, zod input schemas and the `summary()` output of packages/daemon/src/mcp-server.ts
 * - loopback Host check, POST-only stateless Streamable HTTP
 * - the "empty server" (no tools, no 401) for any token it doesn't accept (mcp-gate.ts)
 * - watch_agents' cursor/seq/tail/choices/missed (protocol WatchEvent)
 * plus get_state / pause_session / resource_usage as specified in punassuming/nexus#56.
 */
import { createServer, type Server } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { AgentState, PromptOption, WatchEvent } from '../src/nexus/types.ts';

const AGENTS = ['claude', 'codex', 'copilot', 'gemini', 'aider'] as const;
const WAIT_STATES = ['settled', 'attention', 'idle', 'working', 'needs-input', 'done', 'error', 'command', 'exited'] as const;
const session = z.string().describe('Session id, name, unique name prefix, or "self"');

interface MockSession {
  id: string;
  name: string;
  agent: { id: string; state: AgentState; detail?: string; options?: PromptOption[] };
  cwd: string;
  exited: boolean;
  paused: boolean;
}

/** mcp-gate.ts emptyReply, verbatim in behaviour. */
function emptyReply(m: any): object | undefined {
  if (typeof m?.method !== 'string' || m.id === undefined) return undefined;
  const reply = (body: object) => ({ jsonrpc: '2.0', id: m.id, ...body });
  switch (m.method) {
    case 'initialize':
      return reply({ result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: {}, serverInfo: { name: 'Nexus', version: '0.10.0' } } });
    case 'ping': return reply({ result: {} });
    case 'tools/list': return reply({ result: { tools: [] } });
    default: return reply({ error: { code: -32601, message: 'Nexus tools are only available in a Nexus terminal' } });
  }
}

export class MockNexus {
  sessions = new Map<string, MockSession>();
  events: WatchEvent[] = [];
  calls: { tool: string; args: any }[] = [];
  /** Events with seq <= this were dropped from the buffer (a cursor below it gets `missed`). */
  droppedThrough = 0;
  failSend = false;
  private seq = 0;
  private waiters: (() => void)[] = [];
  server!: Server;
  port = 0;
  url = '';

  constructor(public token = 'sup-token', public withIssue56Tools = true) {}

  private emit(s: MockSession, state: AgentState | 'exited') {
    const ev: WatchEvent = {
      seq: ++this.seq, sessionId: s.id, name: s.name, agent: s.agent.id, state,
      ...(s.agent.detail ? { detail: s.agent.detail } : {}),
      ...(s.agent.options ? { choices: s.agent.options.map((o) => o.label) } : {}),
      tail: `… screen of ${s.name} (${state})`, at: Date.now(),
    };
    this.events.push(ev);
    this.waiters.splice(0).forEach((w) => w());
  }

  /** Change an agent's state; `emit: false` simulates a change the harness hasn't seen yet. */
  setState(id: string, state: AgentState, o: { detail?: string; options?: PromptOption[]; emit?: boolean } = {}) {
    const s = this.sessions.get(id)!;
    s.agent = { id: s.agent.id, state, ...(o.detail ? { detail: o.detail } : {}), ...(o.options ? { options: o.options } : {}) };
    if (o.emit !== false) this.emit(s, state);
  }

  /** Simulate nexusd's event buffer rolling over. */
  dropEvents() { this.droppedThrough = this.seq; }

  private find(target: string): MockSession {
    const s = this.sessions.get(target) ?? [...this.sessions.values()].find((x) => x.name === target);
    if (!s) throw new Error(`not_found: no session ${target}`);
    return s;
  }

  /** mcp-server.ts summary(). */
  private summary(s: MockSession) {
    return { id: s.id, name: s.name, agent: { id: s.agent.id, state: s.agent.state, ...(s.agent.detail ? { detail: s.agent.detail } : {}) }, cwd: s.cwd, exited: s.exited };
  }

  private build(): McpServer {
    const mcp = new McpServer({ name: 'Nexus', version: '0.10.0' });
    const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
    const reg = (name: string, inputSchema: any, fn: (a: any) => unknown) =>
      mcp.registerTool(name, { inputSchema }, async (a: any) => { this.calls.push({ tool: name, args: a }); return text(await fn(a)); });

    reg('whoami', {}, () => ({ session: null, access: 'supervisor' }));
    reg('list_sessions', {}, () => [...this.sessions.values()].map((s) => this.summary(s)));
    reg('start_agent', {
      agent: z.enum(AGENTS), prompt: z.string().optional(), name: z.string().optional(),
      placement: z.enum(['split', 'tab', 'background']).default('split'), cwd: z.string().optional(), args: z.array(z.string()).optional(),
    }, (a) => {
      const id = `s${this.sessions.size + 1}`;
      const s: MockSession = { id, name: a.name ?? id, agent: { id: a.agent, state: a.prompt ? 'working' : 'idle' }, cwd: a.cwd ?? '/', exited: false, paused: false };
      this.sessions.set(id, s);
      return this.summary(s);
    });
    reg('prompt_agent', {
      session, text: z.string(), wait: z.enum(WAIT_STATES).optional().default('settled'),
      timeout_seconds: z.number().int().min(1).default(900), force: z.boolean().default(false),
    }, (a) => {
      const s = this.find(a.session);
      if (s.agent.state === 'needs-input' && !a.force) throw new Error(`agent_blocked: ${s.name} is waiting on a question`);
      this.setState(s.id, 'working');
      return { session: this.summary(s), waited_seconds: 0 };
    });
    reg('send_keys', { session, text: z.string(), enter: z.boolean().default(false) }, (a) => {
      const s = this.find(a.session);
      if (this.failSend) throw new Error(`session_gone: ${s.id}`);
      if (s.agent.state === 'needs-input') this.setState(s.id, a.text === '\x1b' ? 'idle' : 'working');
      return `sent to ${s.id}`;
    });
    reg('stop_session', { session }, (a) => {
      const s = this.find(a.session);
      s.exited = true;
      this.emit(s, 'exited');
      return `closed ${s.id}`;
    });
    reg('watch_agents', {
      sessions: z.array(session).optional(), include: z.enum(['children', 'descendants']).default('children'),
      for: z.array(z.enum(['needs-input', 'error', 'done', 'idle', 'working', 'exited'])).default(['needs-input', 'error', 'done']),
      cursor: z.number().int().min(0).optional(), timeout_seconds: z.number().int().min(1).max(3600).default(50),
    }, async (a) => {
      const after = a.cursor ?? this.seq;
      const missed = a.cursor !== undefined && a.cursor < this.droppedThrough;
      const pending = () => this.events.filter((e) => e.seq > Math.max(after, this.droppedThrough) && a.for.includes(e.state));
      if (!pending().length && !missed) {
        // Tests don't wait the full long-poll.
        await new Promise<void>((res) => {
          const t = setTimeout(res, Math.min(a.timeout_seconds, 1) * 1000);
          this.waiters.push(() => { clearTimeout(t); res(); });
        });
      }
      const events = pending();
      return { events, cursor: Math.max(this.seq, after), ...(missed ? { missed: true } : {}) };
    });
    if (this.withIssue56Tools) {
      reg('get_state', { session }, (a) => {
        const s = this.find(a.session);
        return { id: s.id, agent: { ...s.agent }, cwd: s.cwd, running: !s.exited };
      });
      reg('pause_session', { session, paused: z.boolean() }, (a) => {
        this.find(a.session).paused = a.paused;
        return { processes: 1 };
      });
      reg('resource_usage', { session: session.optional() }, () => ({ sessions: [] }));
    }
    return mcp;
  }

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      const deny = (status: number, error: string) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error }));
      const host = req.headers.host ?? '';
      if (!['127.0.0.1', 'localhost', '[::1]'].some((h) => host === h || host === `${h}:${this.port}`)) return deny(403, 'forbidden host');
      if (req.headers.origin !== undefined) return deny(403, 'forbidden origin');
      if ((req.url ?? '').split('?')[0] !== '/mcp') return deny(404, 'not found');
      if (req.method !== 'POST') return deny(405, 'method not allowed');
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString() || 'null');
      const token = /^bearer\s+(\S+)/i.exec(req.headers.authorization ?? '')?.[1];
      if (token !== this.token) {
        const reply = Array.isArray(body) ? body.map(emptyReply).filter(Boolean) : emptyReply(body);
        if (!reply || (Array.isArray(reply) && !reply.length)) return void res.writeHead(202).end();
        return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const mcp = this.build();
      res.on('close', () => { void transport.close(); void mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as any).port;
    this.url = `http://127.0.0.1:${this.port}/mcp`;
  }

  async stop() {
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }
}
