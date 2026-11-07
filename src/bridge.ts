/**
 * Tailnet bridge. Runs on the Nexus host. Terminates TLS on the tailnet interface only, requires the
 * caller's supervisor token, and forwards POST /mcp to loopback nexusd. Not an open port: it refuses
 * to start unless bound to a tailnet (100.64.0.0/10) or loopback address.
 */
import { createServer, type Server } from 'node:https';
import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { bearer, isTailnetOrLoopback, secretMatches } from './auth.ts';

export { isTailnetOrLoopback };

/** Headers that describe this hop, not the request. */
const HOP = ['host', 'origin', 'connection', 'keep-alive', 'proxy-authorization', 'te', 'trailer', 'upgrade', 'forwarded'];

export function createBridge(o: { upstream: URL; token: string; tls: { key: Buffer | string; cert: Buffer | string } }): Server {
  return createServer(o.tls, (req, res) => {
    if ((req.url ?? '').split('?')[0] !== o.upstream.pathname || req.method !== 'POST') { res.writeHead(404).end(); return; }
    if (!secretMatches(bearer(req.headers.authorization), o.token)) { res.writeHead(401).end(); return; }
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined && !HOP.includes(k) && !k.startsWith('x-forwarded-')) headers[k] = v;
    }
    // nexusd accepts only a loopback Host and no foreign Origin: present its own Host, no Origin.
    headers.host = o.upstream.host;
    const up = request(
      { host: o.upstream.hostname, port: o.upstream.port, path: o.upstream.pathname, method: 'POST', headers },
      (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); },
    );
    up.on('error', () => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy(); });
    req.pipe(up);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.BRIDGE_HOST ?? '';
  const port = Number(process.env.BRIDGE_PORT ?? 7778);
  const token = process.env.NEXUS_SUPERVISOR_TOKEN ?? '';
  const uid = process.getuid ? 47000 + (process.getuid() % 1000) : 47821;
  const upstream = new URL(process.env.NEXUS_UPSTREAM ?? `http://127.0.0.1:${uid}/mcp`);
  if (!isTailnetOrLoopback(host)) throw new Error("BRIDGE_HOST must be this machine's tailnet (100.x) or loopback address");
  if (!token) throw new Error('NEXUS_SUPERVISOR_TOKEN is required');
  if (!process.env.BRIDGE_KEY || !process.env.BRIDGE_CERT) throw new Error('BRIDGE_KEY and BRIDGE_CERT are required (tailscale cert)');
  const tls = { key: readFileSync(process.env.BRIDGE_KEY), cert: readFileSync(process.env.BRIDGE_CERT) };
  createBridge({ upstream, token, tls }).listen(port, host, () => console.log(`bridge https://${host}:${port} -> ${upstream.href}`));
}
