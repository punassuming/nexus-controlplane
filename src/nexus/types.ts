// Shapes of the Nexus MCP server (punassuming/nexus packages/daemon/src/mcp-server.ts and
// packages/protocol/src/messages.ts, v0.10.0), plus the get_state / pause_session / resource_usage
// tools specified in punassuming/nexus#56.

export type AgentState = 'none' | 'idle' | 'working' | 'needs-input' | 'done' | 'error';

/** One choice of an agent's approval prompt: typing `key` picks it. */
export interface PromptOption {
  /** What to type: a digit ("1") or a letter ("y"). */
  key: string;
  label: string;
  kind: 'approve' | 'deny' | 'other';
  selected?: boolean;
}

export interface AgentInfo {
  id: string;
  state: AgentState;
  detail?: string;
  /** Typed choices; only get_state returns them (list_sessions strips them). */
  options?: PromptOption[];
}

export interface SessionState {
  id: string;
  name?: string;
  agent: AgentInfo | null;
  cwd?: string;
  repo?: string;
  branch?: string;
  running: boolean;
}

export type WatchState = AgentState | 'exited';

export interface WatchEvent {
  seq: number;
  sessionId: string;
  name: string;
  agent?: string;
  state: WatchState;
  /** The question, for a prompt. */
  detail?: string;
  /** A prompt's choices, as the agent numbers them (labels only). */
  choices?: string[];
  /** The last lines of its screen. */
  tail: string;
  at: number;
}

export interface WatchResult {
  events: WatchEvent[];
  cursor: number;
  /** The cursor fell out of nexusd's buffer: events were lost, resync from current state. */
  missed?: boolean;
}

export type WaitFor = AgentState | 'settled' | 'attention' | 'command' | 'exited';

/** The surface of Nexus the control plane depends on. */
export interface NexusApi {
  listTools(): Promise<string[]>;
  hasTool(name: string): boolean;
  getState(session: string): Promise<SessionState | undefined>;
  startAgent(a: { agent: string; cwd: string; name: string; prompt?: string }): Promise<SessionState>;
  promptAgent(session: string, text: string, o?: { wait?: WaitFor; timeoutSec?: number; force?: boolean }): Promise<void>;
  sendKeys(session: string, text: string, enter?: boolean): Promise<void>;
  pauseSession(session: string, paused: boolean): Promise<void>;
  stopSession(session: string): Promise<void>;
  watchAgents(cursor: number | undefined, waitSec: number): Promise<WatchResult>;
}
