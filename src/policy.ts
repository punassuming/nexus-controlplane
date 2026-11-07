/**
 * The harness's limits, as data. Thresholds are decided during the pilot, so everything tunable lives in a JSON file
 * outside Git; the invariants below do not. Decisions are pure and deterministic: no model is ever asked whether an
 * action is allowed.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { z } from 'zod';
import type { PromptOption } from './nexus/types.ts';

const ClientScope = z.object({
  agents: z.array(z.string()).optional(),
  roots: z.array(z.string()).optional(),
  enabled: z.boolean().default(true),
});

export const PolicySchema = z.object({
  /** Agents start_agent may launch. */
  agents: z.array(z.string()).default(['claude']),
  /** Directories tasks may run in (and below). Empty: nothing can start. */
  roots: z.array(z.string()).default([]),
  /** Open terminals at once, counted across the UI and every orchestrator. */
  maxActiveTasks: z.number().int().min(1).default(1),
  approvalTtlMs: z.number().int().min(1000).default(15 * 60_000),
  resources: z.object({
    cpuPercent: z.number().positive().optional(),
    memoryBytes: z.number().positive().optional(),
    sustainSeconds: z.number().int().min(0).default(30),
    action: z.enum(['alert', 'pause']).default('alert'),
  }).default({ sustainSeconds: 30, action: 'alert' }),
  /**
   * Agent prompts an orchestrator may approve without the phone. `detail` is matched against the whole question
   * (anchored), e.g. "Bash\\(npm test\\)". Only ever a one-shot approve choice on that exact prompt.
   */
  lowRisk: z.array(z.object({ id: z.string(), agent: z.string().optional(), detail: z.string() })).default([]),
  /** Per-orchestrator scope. Can narrow the global lists, never widen them. Unlisted clients get the global scope. */
  clients: z.record(z.string(), ClientScope).default({}),
  /** What the proxy keeps of each MCP transaction, both directions. Secrets are masked before storage. */
  transcripts: z.object({
    level: z.enum(['full', 'metadata']).default('full'),
    retentionDays: z.number().min(0).default(14),
    maxPayloadBytes: z.number().int().min(256).default(64 * 1024),
  }).default({ level: 'full', retentionDays: 14, maxPayloadBytes: 64 * 1024 }),
  /**
   * Tools of upstream MCP servers other than Nexus, per upstream: allow (forward), approve (phone first) or deny
   * (hidden). Tools not listed get `default`. Nexus's own tools have fixed rules (see proxy/nexus.ts); a Nexus tool
   * the proxy doesn't know yet is hidden unless listed under `nexus`.
   */
  upstreams: z.record(z.string(), z.object({
    default: z.enum(['allow', 'approve', 'deny']).default('deny'),
    tools: z.record(z.string(), z.enum(['allow', 'approve', 'deny'])).default({}),
  })).default({}),
});

export type ToolRule = 'allow' | 'approve' | 'deny';

export type PolicyConfig = z.infer<typeof PolicySchema>;
export type PolicyInput = z.input<typeof PolicySchema>;

export type Decision =
  | { verdict: 'allow'; rule?: string }
  | { verdict: 'approval'; reason: string }
  | { verdict: 'deny'; reason: string };

/** Choices that grant more than this one action. Never pressed by anyone but a human picking them explicitly. */
export const PERSISTENT = /\balways\b|don'?t ask|\bsession\b|\ball\b|\bevery|\bremember/i;

export class Policy {
  private config: PolicyConfig;
  private mtime = 0;
  error?: string;

  constructor(private path?: string, initial?: PolicyInput) {
    this.config = PolicySchema.parse(initial ?? {});
    this.reload();
  }

  /** Re-read the file when it changed. An invalid file keeps the last good policy and reports why. */
  reload() {
    if (!this.path || !existsSync(this.path)) return;
    const mtime = statSync(this.path).mtimeMs;
    if (mtime === this.mtime) return;
    this.mtime = mtime;
    try {
      this.config = PolicySchema.parse(JSON.parse(readFileSync(this.path, 'utf8')));
      this.error = undefined;
    } catch (e: any) {
      this.error = `policy file rejected, keeping the previous policy: ${e.message}`;
    }
  }

  get(): PolicyConfig {
    this.reload();
    return this.config;
  }

  /** The scope a client actually gets: the global lists, intersected with its own. */
  scope(client?: string): { enabled: boolean; agents: string[]; roots: string[]; clientRoots?: string[] } {
    const p = this.get();
    const c = client ? p.clients[client] : undefined;
    return {
      enabled: c?.enabled ?? true,
      agents: c?.agents ? p.agents.filter((a) => c.agents!.includes(a)) : p.agents,
      roots: p.roots,
      ...(c?.roots ? { clientRoots: c.roots } : {}),
    };
  }

  /**
   * May this caller start this agent here? `cwd` is resolved with realpath, so a symlink inside a root that points
   * outside it doesn't count as inside.
   */
  async checkStart(i: { client?: string; agent: string; cwd: string; active: number }): Promise<Decision> {
    const s = this.scope(i.client);
    if (!s.enabled) return { verdict: 'deny', reason: `client ${i.client} is disabled` };
    if (!s.agents.includes(i.agent)) return { verdict: 'deny', reason: `agent ${i.agent} is not allowed (allowed: ${s.agents.join(', ') || 'none'})` };
    const cwd = await realpath(i.cwd).catch(() => undefined);
    if (!cwd) return { verdict: 'deny', reason: `cwd ${i.cwd} does not exist` };
    if (!(await within(cwd, s.roots))) return { verdict: 'deny', reason: `cwd ${cwd} is outside the allowed roots` };
    if (s.clientRoots && !(await within(cwd, s.clientRoots))) return { verdict: 'deny', reason: `cwd ${cwd} is outside this client's roots` };
    const max = this.get().maxActiveTasks;
    if (i.active >= max) return { verdict: 'deny', reason: `${i.active} active task(s); the limit is ${max}` };
    return { verdict: 'allow' };
  }

  /** The rule for a tool of an upstream that isn't handled by a dedicated adapter. */
  toolRule(upstream: string, tool: string): ToolRule {
    const u = this.get().upstreams[upstream];
    return u?.tools[tool] ?? u?.default ?? 'deny';
  }

  /**
   * May an orchestrator answer this agent prompt with this choice on its own? Refusing is always allowed; a
   * persistent grant never is; a one-shot approval needs a matching low-risk rule, otherwise the phone decides.
   */
  checkAnswer(i: { agent: string; detail: string | null; option: PromptOption | undefined }): Decision {
    if (!i.option || i.option.kind === 'deny') return { verdict: 'allow' };
    if (PERSISTENT.test(i.option.label)) return { verdict: 'approval', reason: 'persistent grants are only chosen by a human' };
    if (i.option.kind !== 'approve') return { verdict: 'approval', reason: 'not a plain approve choice' };
    const rule = this.get().lowRisk.find((r) => (!r.agent || r.agent === i.agent) && anchored(r.detail).test(i.detail ?? ''));
    return rule ? { verdict: 'allow', rule: rule.id } : { verdict: 'approval', reason: 'no low-risk rule matches this prompt' };
  }
}

function anchored(pattern: string): RegExp {
  try { return new RegExp(`^(?:${pattern})$`); } catch { return /(?!)/; }
}

async function within(path: string, roots: string[]): Promise<boolean> {
  for (const root of roots) {
    const r = await realpath(root).catch(() => undefined);
    if (!r) continue;
    const rel = relative(r, path);
    if (!isAbsolute(rel) && rel.split(sep)[0] !== '..') return true;
  }
  return false;
}
