import { timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

/**
 * none:      loopback only, every caller is "local".
 * tailscale: behind `tailscale serve`, which sets Tailscale-User-Login for tailnet users. Loopback only,
 *            so nothing but tailscaled can supply that header. Optional allowlist of logins.
 * token:     shared secret as a Bearer header or a cookie set by /login?token=.
 */
export type AuthMode = 'none' | 'tailscale' | 'token';

export const COOKIE = 'cp_token';
/** Set only by the gateway: the internal secret, and the orchestrator client it authenticated. */
export const GATEWAY_SECRET_HEADER = 'x-cp-gateway';
export const CLIENT_HEADER = 'x-cp-client';

export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

export function isTailnetOrLoopback(addr: string): boolean {
  if (isLoopback(addr)) return true;
  const m = addr.match(/^100\.(\d+)\.\d+\.\d+$/);
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

export function secretMatches(got: string | undefined, want: string): boolean {
  const a = Buffer.from(got ?? '');
  const b = Buffer.from(want);
  return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

export function bearer(header: string | undefined): string | undefined {
  return /^bearer\s+(\S+)$/i.exec(header ?? '')?.[1];
}

function cookie(headers: IncomingHttpHeaders, name: string): string | undefined {
  for (const part of (headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
}

export type Identity = { user: string } | { status: number; error: string };

export function identify(headers: IncomingHttpHeaders, auth: { mode: AuthMode; token: string; allowedUsers: string[] }): Identity {
  if (auth.mode === 'none') return { user: 'local' };
  if (auth.mode === 'token') {
    const got = bearer(headers.authorization) ?? cookie(headers, COOKIE);
    return secretMatches(got, auth.token) ? { user: 'token' } : { status: 401, error: 'sign in at /login?token=…' };
  }
  const login = headers['tailscale-user-login'];
  if (typeof login !== 'string' || !login) return { status: 401, error: 'no tailnet identity (reach this through tailscale serve)' };
  if (auth.allowedUsers.length && !auth.allowedUsers.includes(login)) return { status: 403, error: `${login} is not allowed` };
  return { user: login };
}
