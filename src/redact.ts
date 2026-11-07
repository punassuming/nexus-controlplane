/**
 * Best-effort secret masking for stored MCP transcripts. Terminal output and prompts can carry credentials; these
 * patterns catch the common shapes. Like Nexus's own redaction, it is a guardrail, not a guarantee: the transcript
 * store stays 0600 on this machine and is pruned after the retention period.
 */
const MASK = '«redacted»';

const PATTERNS: Array<[RegExp, string | ((...m: string[]) => string)]> = [
  // PEM private keys, whole block
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, MASK],
  // Authorization headers and bearer tokens
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, (_m, scheme) => `${scheme} ${MASK}`],
  // Well-known token formats
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g, MASK],                     // Anthropic / OpenAI keys
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, MASK],                  // GitHub tokens
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, MASK],                              // Slack
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],                                        // AWS access key id
  [/\bAIza[0-9A-Za-z_-]{30,}/g, MASK],                                    // Google API key
  [/\bcpk_[A-Za-z0-9_-]{20,}/g, MASK],                                    // this repo's orchestrator keys
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK], // JWTs
  // key=value / key: value for secret-sounding names (env files, CLI flags, JSON)
  [/\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)s?)(["']?\s*[:=]\s*["']?)([^\s"',;}]{4,})/gi,
    (_m, k, sep) => `${k}${sep}${MASK}`],
  // URLs with embedded credentials
  [/\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@/]+)@/gi, (_m, scheme, user) => `${scheme}${user}:${MASK}@`],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep as any);
  return out;
}

/** Mask, then cap the size; marks what was cut. */
export function redactCapped(value: unknown, maxBytes: number): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  const masked = redact(text);
  return masked.length > maxBytes ? `${masked.slice(0, maxBytes)}… [${masked.length - maxBytes} more bytes not kept]` : masked;
}
