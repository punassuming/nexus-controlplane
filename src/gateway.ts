/**
 * The gateway: the locked door for outside orchestrators. It runs on the Hermes box, listens with TLS on the
 * tailnet (or loopback) only, checks each orchestrator's own key, and forwards its MCP requests to the control
 * plane's orchestrator endpoint on loopback, naming the client. It holds no Nexus token and makes no decisions:
 * the control plane decides what each request may do.
 */
import { createServer, type Server } from 'node:https';
import { request } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { bearer, CLIENT_HEADER, GATEWAY_SECRET_HEADER, isLoopback, isTailnetOrLoopback } from './auth.ts';
import { ClientRegistry } from './clients.ts';

const MAX_BODY = 1024 * 1024;
/** Only what an MCP exchange needs crosses; everything else (cookies, x-cp-*, forwarding headers) is dropped. */
const PASS = ['content-type', 'accept', 'mcp-protocol-version', 'user-agent'];

export interface GatewayOptions {
  registry: ClientRegistry;
  /** The control plane's orchestrator endpoint, e.g. http://127.0.0.1:8787/orchestrator/mcp. */
  upstream: URL;
  /** The internal secret the control plane expects (re-read, so a control plane restart that rotates it is fine). */
  secret: () => string;
  tls: { key: Buffer | string; cert: Buffer | string };
  /** Requests per client per minute. */
  ratePerMinute?: number;
  log?: (line: Record<string, unknown>) => void;
}

/** A secret file read again whenever it changes. */
export function fileSecret(path: string): () => string {
  let mtime = -1;
  let value = '';
  return () => {
    const m = existsSync(path) ? statSync(path).mtimeMs : 0;
    if (m !== mtime) { mtime = m; value = m ? readFileSync(path, 'utf8').trim() : ''; }
    return value;
  };
}

export function createGateway(o: GatewayOptions): Server {
  const rate = o.ratePerMinute ?? 120;
  const buckets = new Map<string, { tokens: number; at: number }>();
  const allow = (client: string) => {
    const now = Date.now();
    const b = buckets.get(client) ?? { tokens: rate, at: now };
    b.tokens = Math.min(rate, b.tokens + ((now - b.at) / 60_000) * rate);
    b.at = now;
    buckets.set(client, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
  const log = o.log ?? ((l) => console.log(JSON.stringify(l)));

  return createServer(o.tls, async (req, res) => {
    const started = Date.now();
    const entry: Record<string, unknown> = { ts: new Date(started).toISOString() };
    const end = (status: number, body?: string) => {
      res.writeHead(status, body ? { 'content-type': 'application/json' } : {}).end(body);
      log({ ...entry, status, ms: Date.now() - started });
    };
    if ((req.url ?? '').split('?')[0] !== '/mcp') return end(404);
    if (req.method !== 'POST') return end(405);

    const client = o.registry.lookup(bearer(req.headers.authorization));
    if (!client) return end(401, JSON.stringify({ error: 'unknown or revoked key' }));
    entry.client = client;
    if (!allow(client)) return end(429, JSON.stringify({ error: 'rate limited' }));

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req as AsyncIterable<Buffer>) {
      size += c.length;
      if (size > MAX_BODY) return end(413, JSON.stringify({ error: 'request too large' }));
      chunks.push(c);
    }
    const body = Buffer.concat(chunks);
    try {
      const msg = JSON.parse(body.toString('utf8'));
      const first = Array.isArray(msg) ? msg[0] : msg;
      entry.method = first?.method;
      if (first?.method === 'tools/call') entry.tool = first.params?.name;
    } catch { /* the control plane answers malformed JSON */ }

    const headers: Record<string, string> = { 'content-length': String(body.length) };
    for (const h of PASS) {
      const v = req.headers[h];
      if (typeof v === 'string') headers[h] = v;
    }
    headers[CLIENT_HEADER] = client;
    headers[GATEWAY_SECRET_HEADER] = o.secret();
    const up = request(
      { host: o.upstream.hostname, port: o.upstream.port, path: o.upstream.pathname, method: 'POST', headers },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
        r.on('end', () => log({ ...entry, status: r.statusCode, ms: Date.now() - started }));
      },
    );
    up.on('error', (e) => {
      if (!res.headersSent) end(502, JSON.stringify({ error: 'control plane unreachable' }));
      else res.destroy();
      log({ ...entry, error: e.message });
    });
    up.end(body);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.GATEWAY_HOST ?? '';
  const port = Number(process.env.GATEWAY_PORT ?? 7778);
  if (!isTailnetOrLoopback(host)) throw new Error("GATEWAY_HOST must be this machine's tailnet (100.x) or loopback address");
  if (!process.env.GATEWAY_KEY || !process.env.GATEWAY_CERT) throw new Error('GATEWAY_KEY and GATEWAY_CERT are required (tailscale cert)');
  const cp = new URL(process.env.CONTROLPLANE_URL ?? 'http://127.0.0.1:8787');
  if (!isLoopback(cp.hostname)) throw new Error('CONTROLPLANE_URL must be on loopback');
  createGateway({
    registry: new ClientRegistry(process.env.CONTROLPLANE_CLIENTS ?? 'data/clients.json'),
    upstream: new URL('/orchestrator/mcp', cp),
    secret: fileSecret(process.env.CONTROLPLANE_GATEWAY_SECRET ?? 'data/gateway.secret'),
    tls: { key: readFileSync(process.env.GATEWAY_KEY), cert: readFileSync(process.env.GATEWAY_CERT) },
    ratePerMinute: Number(process.env.GATEWAY_RATE_PER_MINUTE ?? 120),
  }).listen(port, host, () => console.log(`gateway https://${host}:${port}/mcp -> ${cp.origin}/orchestrator/mcp`));
}
