import Fastify, { type FastifyReply } from 'fastify';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { StaleApprovalError, type ApprovalQueue } from './approvals.ts';
import { COOKIE, identify, secretMatches, type AuthMode } from './auth.ts';
import { gitDiff } from './diff.ts';
import type { Bus } from './events.ts';
import { NexusError } from './nexus/client.ts';
import type { TaskStore } from './tasks.ts';

export interface Deps {
  tasks: TaskStore;
  approvals: ApprovalQueue;
  bus: Bus;
  status: () => { online: boolean; lastError?: string; tools?: string[] };
  auth: { mode: AuthMode; token: string; allowedUsers: string[] };
}

declare module 'fastify' {
  interface FastifyRequest { user: string }
}

const indexHtml = () => readFile(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');

/** Nexus refusals (permission_denied, agent_blocked, …) are the caller's problem; outages are a 502. */
function fail(reply: FastifyReply, e: any) {
  if (e instanceof StaleApprovalError) return reply.code(409).send({ error: e.message, stale: true });
  if (e instanceof NexusError) return reply.code(e.code === 'offline' ? 502 : 409).send({ error: e.message, code: e.code });
  if (/^unknown /.test(e?.message)) return reply.code(404).send({ error: e.message });
  return reply.code(409).send({ error: String(e?.message ?? e) });
}

export function buildServer({ tasks, approvals, bus, status, auth }: Deps) {
  const app = Fastify();
  app.decorateRequest('user', '');

  // Token mode: trade the token for an HttpOnly, SameSite=Strict cookie so the page and SSE work.
  app.get('/login', async (req, reply) => {
    const token = (req.query as any).token;
    if (auth.mode !== 'token' || !secretMatches(token, auth.token)) return reply.code(401).send({ error: 'bad token' });
    return reply
      .header('set-cookie', `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`)
      .redirect('/');
  });

  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/login')) return;
    const id = identify(req.headers, auth);
    if ('error' in id) return reply.code(id.status).send({ error: id.error });
    req.user = id.user;
    // Mutations take JSON only: a cross-site form or text/plain POST can't be sent without a CORS preflight,
    // which this server never answers.
    if (req.method === 'POST' && !/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      return reply.code(415).send({ error: 'content-type must be application/json' });
    }
  });

  app.get('/', async (_req, reply) => reply.type('text/html').send(await indexHtml()));
  app.get('/api/status', async (req) => ({ ...status(), user: req.user }));
  app.get('/api/tasks', async () => tasks.list());
  app.get('/api/approvals', async (req) => approvals.list((req.query as any).status));

  app.post('/api/tasks', async (req, reply) => {
    const b = (req.body ?? {}) as any;
    if (typeof b.cwd !== 'string' || !b.cwd) return reply.code(400).send({ error: 'cwd required' });
    if (typeof b.agent !== 'string' || !b.agent) return reply.code(400).send({ error: 'agent required (claude, codex, copilot, gemini, aider)' });
    try {
      const t = await tasks.create({ agent: b.agent, cwd: b.cwd, prompt: b.prompt || undefined, name: b.name });
      bus.publish('task', t);
      return t;
    } catch (e) { return fail(reply, e); }
  });

  app.post('/api/tasks/:id/prompt', async (req, reply) => {
    const b = (req.body ?? {}) as any;
    if (typeof b.text !== 'string' || !b.text.trim()) return reply.code(400).send({ error: 'text required' });
    try { return await tasks.prompt((req.params as any).id, b.text, req.user, b.force === true); }
    catch (e) { return fail(reply, e); }
  });

  app.post('/api/tasks/:id/stop', async (req, reply) => {
    try {
      const t = await tasks.stop((req.params as any).id, req.user);
      bus.publish('task', t);
      return t;
    } catch (e) { return fail(reply, e); }
  });

  // Diff is keyed by task so callers cannot point git at arbitrary paths.
  app.get('/api/tasks/:id/diff', async (req, reply) => {
    const t = tasks.get((req.params as any).id);
    if (!t) return reply.code(404).send({ error: 'unknown task' });
    try { return await gitDiff(t.cwd); }
    catch (e: any) { return reply.code(422).send({ error: String(e?.stderr || e?.message || e) }); }
  });

  app.post('/api/approvals/:id/:decision', async (req, reply) => {
    const { id, decision } = req.params as any;
    if (decision !== 'allow' && decision !== 'deny') return reply.code(404).send({ error: 'bad decision' });
    const optionKey = (req.body as any)?.optionKey;
    try {
      const a = await approvals.decide(id, decision, req.user, typeof optionKey === 'string' ? optionKey : undefined);
      bus.publish('approval', a);
      return a;
    } catch (e) {
      const a = approvals.get(id);
      if (a) bus.publish('approval', a);
      return fail(reply, e);
    }
  });

  app.get('/api/events', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (e: { seq: number; type: string; data: unknown }) =>
      res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
    const last = Number(req.headers['last-event-id'] ?? 0);
    for (const e of bus.since(last)) send(e);
    res.write(`event: status\ndata: ${JSON.stringify(status())}\n\n`);
    const on = (e: any) => send(e);
    bus.on('event', on);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.raw.on('close', () => { clearInterval(ping); bus.off('event', on); });
  });

  return app;
}
