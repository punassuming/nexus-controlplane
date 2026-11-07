# Nexus Control Plane

Supervisor harness on top of [Nexus](https://github.com/punassuming/nexus). Nexus (`nexusd`) keeps owning terminals,
PTYs, process trees and agent detection. This repo adds two processes:

- **Control plane** (`npm start`). It holds the Nexus supervisor token and owns:
  - task state;
  - the policy and limits;
  - the approval queue;
  - the call log;
  - the web UI, which is also the phone approval channel.
- **Gateway** (`npm run gateway`). The locked door for outside orchestrator agents (Muse, a Codex agent, …): one key
  per orchestrator, TLS on the tailnet, forwarding only. It never holds the Nexus token.

```
orchestrator ──HTTPS, client key──▶ gateway ──loopback, internal secret──▶ control plane ──loopback MCP, supervisor token──▶ nexusd
                                                                           ▲
                                               phone / browser ── tailscale serve
```

If the control plane dies, Nexus keeps running. If `nexusd` dies, the UI shows a stale-state banner and nothing is
enforced. Revoking the supervisor token in Nexus cuts every orchestrator off at once.

Tracking issue: punassuming/nexus-controlplane#1. The Nexus side (supervisor token, `get_state`, `pause_session`,
`resource_usage`) is punassuming/nexus#56. Without those tools the control plane still runs; see
[Without #56](#without-56).

## Run

```
npm install
npm test                                        # against a mock of nexusd's MCP server; no real Nexus needed

# control plane (Hermes box)
NEXUS_SUPERVISOR_TOKEN=... npm start            # UI on http://127.0.0.1:8787

# an orchestrator key, shown once
npm run client -- add muse
npm run client -- list
npm run client -- revoke muse                   # takes effect on its next request

# gateway (Hermes box, tailnet address)
tailscale cert <host>.<tailnet>.ts.net
GATEWAY_HOST=100.x.y.z GATEWAY_CERT=<host>.crt GATEWAY_KEY=<host>.key npm run gateway
```

The orchestrator then uses `https://<host>.<tailnet>.ts.net:7778/mcp` with `Authorization: Bearer <its key>` as a
Streamable HTTP MCP server.

| Variable | Default | |
|---|---|---|
| `NEXUS_SUPERVISOR_TOKEN` | required | Nexus supervisor token. Keep it in an env file outside Git, never in chat |
| `NEXUS_MCP_URL` | nexusd's default `http://127.0.0.1:<47000 + uid % 1000>/mcp` | |
| `CONTROLPLANE_HOST` / `_PORT` | `127.0.0.1` / `8787` | Stays on loopback |
| `CONTROLPLANE_AUTH` | `none` | UI auth: `none`, `tailscale` or `token` (below) |
| `CONTROLPLANE_ALLOWED_USERS` / `_UI_TOKEN` | | For `tailscale` / `token` mode |
| `CONTROLPLANE_POLICY` | `data/policy.json` | Limits and allowlists (below) |
| `CONTROLPLANE_CLIENTS` | `data/clients.json` | Orchestrator key hashes (0600). Shared by the gateway and the `client` CLI |
| `CONTROLPLANE_GATEWAY_SECRET` | `data/gateway.secret` | Internal secret, created on first start (0600). Shared with the gateway |
| `CONTROLPLANE_DB` | `data/controlplane.db` | Tasks, approvals, audit, events, call log |
| `GATEWAY_HOST` / `_PORT` | required / `7778` | Tailnet (100.64.0.0/10) or loopback only |
| `GATEWAY_CERT` / `_KEY` | required | From `tailscale cert` |
| `CONTROLPLANE_URL` | `http://127.0.0.1:8787` | The gateway's upstream. Must be loopback |
| `GATEWAY_RATE_PER_MINUTE` | `120` | Per orchestrator |

`data/` is gitignored.

## Policy (`data/policy.json`)

Limits are data: thresholds are decided during the pilot, not in code. The file is reloaded on change. An invalid file
keeps the previous policy, and the UI shows why.

```json
{
  "agents": ["claude"],
  "roots": ["/srv/openclaw/development/sandbox"],
  "maxActiveTasks": 1,
  "approvalTtlMs": 900000,
  "resources": { "cpuPercent": 90, "memoryBytes": 4000000000, "sustainSeconds": 60, "action": "pause" },
  "lowRisk": [{ "id": "npm-test", "agent": "claude", "detail": "Bash\\(npm test\\)" }],
  "clients": { "muse": { "roots": ["/srv/openclaw/development/sandbox/muse"] } }
}
```

| Field | Default | Meaning |
|---|---|---|
| `agents` | `["claude"]` | Agents that may be started (Nexus accepts claude, codex, copilot, gemini, aider) |
| `roots` | `[]` | Directories tasks may run in. Symlinks are resolved first. **Empty means nothing can start.** |
| `maxActiveTasks` | `1` | Open task terminals at once, across the UI and every orchestrator |
| `approvalTtlMs` | 15 min | Unanswered approvals expire; nothing is sent |
| `resources` | no thresholds, `alert` | A sustained breach alerts, or pauses the task's whole process tree and asks the phone to resume |
| `lowRisk` | `[]` | Agent prompts an orchestrator may approve without the phone. `detail` must match the whole question (anchored) |
| `clients.<id>` | global scope | `agents` / `roots` narrow that orchestrator's scope; they never widen it. `enabled: false` locks it out |

Rules no policy can change:
- Refusing an agent prompt is always allowed.
- Persistent grants ("always", "don't ask again", "all …", "this session") are only ever picked by a person, by name.
- Typing keys and stopping a task always need the phone.

## What an orchestrator can do

The MCP server at `/orchestrator/mcp` is reachable only through the gateway. Every call is in the call log.

| Tool | |
|---|---|
| `whoami` | Its scope, the limits, and a cursor |
| `list_tasks`, `task_status`, `read_output`, `resources` | Its own tasks only. Another orchestrator's or the UI's tasks look like missing ones |
| `start_task {agent, cwd, prompt?, name?}` | Subject to the policy |
| `watch {cursor?, timeout_seconds≤50}` | The first call returns a snapshot plus a cursor. Later calls wake only when a task needs input, finishes, errors or exits, an approval is decided, or a limit trips. The screen tail comes only with a question, to save tokens |
| `guide {task, text}` | Typed prompt (`prompt_agent`). No approval needed. Returns `agent_blocked` while the agent waits on its menu |
| `answer_prompt {task, option_key \| refuse, reason?}` | Refusals run immediately. An approve choice runs immediately only on a low-risk rule match (audited as `policy:<rule>`); otherwise it waits for the phone with the proposal attached |
| `request_keys {task, text, enter, reason}` | Always waits for the phone |
| `request_stop {task, reason}` | Always waits for the phone |
| `approval_status {approval_id}` | |

Raw Nexus tools (`send_keys`, `stop_session`, `list_sessions`, `where`, …) are never exposed. Errors read
`<code>: <message>` (`policy_denied`, `not_found`, `agent_blocked`, `no_prompt`, `unsupported`, …).

## Approvals

An approval is a typed, single-use decision on one exact request. Each kind has one fixed executor:

| Kind | Raised by | On approval |
|---|---|---|
| `agent_prompt` | an agent's own approval menu, via `watch_agents` | Types the chosen option's key. Deny picks the deny option, or Escape if there is none |
| `send_keys` | `request_keys` | `send_keys {text, enter}` |
| `stop` | `request_stop` | `stop_session` |
| `resume` | the resource limiter | `pause_session {paused: false}` |

- **Claimed atomically:** a double tap can't execute twice, and `consumed_at` is set once.
- **Live state checked first:** the agent must still show that exact prompt, or the terminal must still be open.
  Otherwise nothing is sent and the approval becomes `stale`. A prompt answered in the Nexus app closes its approval;
  a closed terminal closes every pending request for it.
- **Failed delivery** reopens the approval.
- **Audited:** every step is in `audit` with who decided: a person's login, `client:<id>` (a refusal), or
  `policy:<rule>`.

## Web UI (the phone approval channel)

The UI shows:
- the approval cards: who asked, why, the exact action, and the orchestrator's proposal as a one-tap button;
- tasks with guide, diff and stop;
- the policy, plus warnings for anything not enforced;
- per-orchestrator metrics and the recent MCP calls.

UI auth modes:
- **`tailscale`** (recommended): keep the listener on loopback and run
  `tailscale serve --bg --https=8443 http://127.0.0.1:8787`. `tailscale serve` adds `Tailscale-User-Login`; restrict
  access with `CONTROLPLANE_ALLOWED_USERS`. The approver's login is recorded. Startup refuses a non-loopback host in
  this mode.
- **`token`**: visit `/login?token=…` once (sets an HttpOnly, SameSite=Strict cookie), or send `Authorization: Bearer`.
- **`none`**: loopback only.

POSTs accept only `application/json`, so a cross-site page can't submit one.

## Pilot metrics

`GET /api/metrics` gives, per orchestrator: calls, **wakes** (`watch` calls that returned events), answer bytes and
**≈ tokens** read (bytes / 4), and errors. Pass `?since=<ms>` to scope it to a run. It is what the Phase 2 check
("wakes ≤ 10, tokens < 20k") reads.

## Without #56

| Missing in Nexus | Effect here |
|---|---|
| `get_state` | Falls back to `list_sessions`. Approval choices come from the numbered labels in `watch_agents` |
| `resource_usage` | Limits are not enforced; the UI and `whoami` say so |
| `pause_session` | A `pause` limit only alerts |
| supervisor token | A terminal's own `NEXUS_TOKEN` works for trials. It supervises agents that terminal starts |

## Tests

`test/mock-nexus.ts` mirrors nexusd@631bd52's MCP server:
- tool names, zod input schemas and `summary()` output;
- loopback Host/Origin checks;
- the empty server for unknown tokens;
- `watch_agents` cursor/`missed` semantics.

It also implements the #56 tools as specified (`resource_usage`'s shape is a guess until #56 lands). When Nexus changes
its MCP surface, update the mock first.
