# Nexus Control Plane

A supervising **MCP proxy** in front of [Nexus](https://github.com/punassuming/nexus). Outside orchestrator agents
(Muse, a Codex agent, …) sign on through it and see Nexus's own tools. The proxy keeps each orchestrator to its own
agents, sends anything that types into or closes a terminal to your phone for approval, enforces limits, and records
every MCP transaction in both directions.

Two processes:

- **Control plane** (`npm start`). Holds the Nexus supervisor token and does the work:
  - the proxy;
  - task state;
  - policy and limits;
  - approvals;
  - transcripts;
  - Web Push;
  - the web UI, which is also the phone approval channel.
- **Gateway** (`npm run gateway`). The locked door: one key per orchestrator, TLS on the tailnet, forwarding only. It
  never holds the Nexus token.

```
orchestrator ──HTTPS, client key──▶ gateway ──loopback, internal secret──▶ control plane (proxy) ──supervisor token──▶ nexusd
                                                                            │        └──────────── other MCP servers (optional)
                                                     phone ◀── Web Push ────┤
                                                     phone ── tailscale serve ──▶ web UI (approve / deny)
```

If the control plane dies, Nexus keeps running. If `nexusd` dies, the UI shows a stale-state banner and nothing is
enforced. Revoking the supervisor token in Nexus cuts every orchestrator off at once.

Tracking issue: punassuming/nexus-controlplane#1. The Nexus side (supervisor token, `get_state`, `pause_session`,
`resource_usage`) is punassuming/nexus#56. Without those tools the proxy still runs; see [Without #56](#without-56).

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

# the UI for your phone (HTTPS, needed for notifications)
tailscale serve --bg --https=8443 http://127.0.0.1:8787
```

An orchestrator connects to `https://<host>.<tailnet>.ts.net:7778/mcp` as a Streamable HTTP MCP server, with
`Authorization: Bearer <its key>`.

| Variable | Default | |
|---|---|---|
| `NEXUS_SUPERVISOR_TOKEN` | required | Nexus supervisor token. Keep it in an env file outside Git, never in chat |
| `NEXUS_MCP_URL` | nexusd's default `http://127.0.0.1:<47000 + uid % 1000>/mcp` | |
| `CONTROLPLANE_HOST` / `_PORT` | `127.0.0.1` / `8787` | Stays on loopback |
| `CONTROLPLANE_AUTH` | `none` | UI auth: `none`, `tailscale` or `token` (below) |
| `CONTROLPLANE_ALLOWED_USERS` / `_UI_TOKEN` | | For `tailscale` / `token` mode |
| `CONTROLPLANE_POLICY` | `data/policy.json` | Limits, allowlists, transcript settings, upstream tool rules |
| `CONTROLPLANE_UPSTREAMS` | `data/upstreams.json` | Other MCP servers to proxy (optional) |
| `CONTROLPLANE_CLIENTS` | `data/clients.json` | Orchestrator key hashes (0600). Shared with the gateway and the `client` CLI |
| `CONTROLPLANE_GATEWAY_SECRET` | `data/gateway.secret` | Internal secret, created on first start (0600). Shared with the gateway |
| `CONTROLPLANE_VAPID` | `data/vapid.json` | Web Push keys, created on first start (0600) |
| `CONTROLPLANE_PUSH_SUBJECT` | `mailto:nexus-controlplane@localhost` | Contact for push services. Use a real `mailto:` or `https:` (Apple requires one) |
| `CONTROLPLANE_DB` | `data/controlplane.db` | Tasks, approvals, audit, events, transcripts (0600) |
| `GATEWAY_HOST` / `_PORT` | required / `7778` | Tailnet (100.64.0.0/10) or loopback only |
| `GATEWAY_CERT` / `_KEY` | required | From `tailscale cert` |
| `CONTROLPLANE_URL` | `http://127.0.0.1:8787` | The gateway's upstream. Must be loopback |
| `GATEWAY_RATE_PER_MINUTE` | `120` | Per orchestrator |

`data/` is gitignored.

## What an orchestrator sees

On sign-on the proxy lists Nexus's own tools, with Nexus's own schemas and a note about how the proxy handles each.
All orchestrators share one supervisor token, so Nexus can't tell them apart. The proxy keeps them apart: every
session argument must be one of the caller's own tasks, and every list is filtered.

| Nexus tool | Through the proxy |
|---|---|
| `whoami` | Answered by the proxy: the orchestrator, its scope and limits |
| `list_sessions`, `where`, `resource_usage` | Forwarded; results filtered to the caller's sessions (overlaps naming someone else's terminal are dropped) |
| `read_session`, `get_state`, `wait_for` | Own sessions only; waits capped at 50 s (MCP clients give up near 60) |
| `watch_agents` | Own sessions only. A call that returns events counts as one **wake** |
| `start_agent` | Policy-checked: agent, directory and active-task limit. Always `background`. Extra CLI `args` are refused, since they could switch off the agent's own permission prompts. `cwd` required |
| `prompt_agent` | Guidance, no approval. `force` is refused, because it would type into a blocked approval menu |
| `send_keys` | On the agent's approval menu it counts as an answer: a refusal, or an approve choice matching a low-risk rule, runs at once; anything else waits for the phone. Any other typing waits for the phone |
| `stop_session` | Waits for the phone |
| `pause_session` | Pausing runs; resuming a task the resource limiter paused waits for the phone |
| anything newer | Hidden unless `upstreams.nexus.tools.<name>` allows it (session arguments still checked) |

Plus `cp_approval_status {approval_id}` and `cp_list_approvals`. A request that waits answers
`{status: "pending_approval", approval_id, why, expires_at}`. Errors read `<code>: <message>` (`not_found`,
`policy_denied`, `unknown_tool`, `stale`, …).

### Other MCP servers

`data/upstreams.json` adds more servers behind the same proxy. Credentials come from environment variables, never the
file:

```json
[{ "id": "github", "url": "http://127.0.0.1:9100/mcp", "tokenEnv": "GITHUB_MCP_TOKEN", "prefix": "github_" }]
```

Their tools are exposed as `<prefix><tool>` and governed by the policy's `upstreams.<id>`:
- `allow` forwards;
- `approve` waits for the phone, then runs that exact call once;
- `deny` hides.

Tools not listed get `default`, which is `deny` unless set.

## Policy (`data/policy.json`)

Limits are data, decided during the pilot. The file is reloaded on change. An invalid file keeps the previous policy,
and the UI shows why.

```json
{
  "agents": ["claude"],
  "roots": ["/srv/openclaw/development/sandbox"],
  "maxActiveTasks": 1,
  "approvalTtlMs": 3600000,
  "resources": { "cpuPercent": 90, "memoryBytes": 4000000000, "sustainSeconds": 60, "action": "pause" },
  "lowRisk": [{ "id": "npm-test", "agent": "claude", "detail": "Bash\\(npm test\\)" }],
  "clients": { "muse": { "roots": ["/srv/openclaw/development/sandbox/muse"] } },
  "transcripts": { "level": "full", "retentionDays": 14, "maxPayloadBytes": 65536 },
  "upstreams": { "github": { "default": "deny", "tools": { "search": "allow", "delete_repo": "approve" } } }
}
```

| Field | Default | Meaning |
|---|---|---|
| `agents` | `["claude"]` | Agents that may be started |
| `roots` | `[]` | Directories tasks may run in. Symlinks are resolved first. **Empty means nothing can start.** |
| `maxActiveTasks` | `1` | Open task terminals at once, across the UI and every orchestrator |
| `approvalTtlMs` | 15 min | Unanswered approvals expire; nothing is sent |
| `resources` | no thresholds, `alert` | A sustained breach alerts, or pauses the whole process tree and asks the phone to resume |
| `lowRisk` | `[]` | Agent prompts an orchestrator may approve via `send_keys` without the phone. `detail` must match the whole question |
| `clients.<id>` | global scope | `agents` / `roots` narrow one orchestrator's scope; they never widen it. `enabled: false` locks it out |
| `transcripts` | full, 14 days, 64 KB | `full` keeps masked requests and responses; `metadata` keeps who/what/how only |
| `upstreams.<id>` | deny | Tool rules for other MCP servers (and for Nexus tools the proxy doesn't know yet) |

Rules no policy can change:
- Refusing an agent prompt is always allowed.
- Persistent grants ("always", "don't ask again", "all …", "this session") are only ever picked by a person, by name.
- Typing keys and stopping a task always need the phone.

## Approvals

An approval is a typed, single-use decision on one exact request:

| Kind | Raised by | On approval |
|---|---|---|
| `agent_prompt` | an agent's approval menu (via `watch_agents`), possibly with an orchestrator's proposed choice | Types the chosen option's key. Deny picks the deny option, or Escape |
| `send_keys` | `send_keys` outside an approval menu | `send_keys {text, enter}` |
| `stop` | `stop_session` | `stop_session` |
| `resume` | the resource limiter, or `pause_session {paused: false}` on a task it paused | `pause_session {paused: false}` |
| `tool_call` | an upstream tool marked `approve` | That exact call; the masked result is kept for `cp_approval_status` |

- **Claimed atomically:** a double tap can't execute twice, and `consumed_at` is set once.
- **Live state checked first:** the agent must still show that exact prompt, or the terminal must still be open.
  Otherwise nothing is sent and the approval becomes `stale`.
- **Failed delivery** reopens the approval.
- **Audited:** every step is recorded with who decided: a person's login, `client:<id>` (a refusal), or
  `policy:<rule>`.

## Notifications (Web Push)

The control plane sends its own push notifications. There's no Hermes or Telegram, and no third-party account.

1. Publish the UI with `tailscale serve` (HTTPS is required).
2. Open it on the phone. On iPhone, use **Share → Add to Home Screen** and open it from there (iOS 16.4+).
3. Tap **Enable notifications**, then **Test**.

Each new approval and each resource-limit action notifies every subscribed device once. A notification says only the
kind of request, the task and who asked; never the keys to type, the prompt or the command. Tapping it opens that
approval in the UI. Deciding always happens in the signed-in UI.

The browser vendor's push service relays an encrypted message it cannot read. Opening the UI from a notification
still needs the tailnet. Subscriptions the push service reports gone are dropped.

## Telemetry and transcripts

- **Every MCP transaction is stored:** orchestrator → proxy, and proxy → upstream, attributed to the orchestrator it
  was made for. Each records who, tool, task/session, what the proxy did (`forwarded`, `answered here`, `approval`,
  `denied`), ok, duration and size.
- **Full payloads** (the default) are kept with secrets masked: tokens, keys, passwords, bearer headers, private keys,
  JWTs, credentials in URLs. Masking is best effort; the store is 0600 on this machine and pruned after
  `retentionDays`.
- **In the UI:** under **Policy, orchestrators and calls**, filter by orchestrator and tap a row to see its request
  and response.
- **Metrics:** `GET /api/metrics?since=<ms>` gives, per orchestrator, calls, **wakes**, **≈ tokens read**
  (bytes / 4), approvals, denials and errors. This is the Phase 2 check ("wakes ≤ 10, tokens < 20k").
- **API:** `GET /api/calls?client=&task=&limit=` and `GET /api/calls/:id`.

## Web UI access

- **`tailscale`** (recommended): listener on loopback behind `tailscale serve`, which adds `Tailscale-User-Login`.
  Restrict access with `CONTROLPLANE_ALLOWED_USERS`. The approver's login is recorded. Startup refuses a non-loopback
  host in this mode.
- **`token`**: visit `/login?token=…` once (sets an HttpOnly, SameSite=Strict cookie), or send `Authorization: Bearer`.
- **`none`**: loopback only.

POSTs accept only `application/json`, so a cross-site page can't submit one.

## Without #56

| Missing in Nexus | Effect here |
|---|---|
| `get_state` | Falls back to `list_sessions`; approval choices come from the numbered labels in `watch_agents`. The tool is simply not listed to orchestrators |
| `resource_usage` | Limits are not enforced; the UI and `whoami` say so |
| `pause_session` | A `pause` limit only alerts |
| supervisor token | A terminal's own `NEXUS_TOKEN` works for trials. It supervises agents that terminal starts |

## Tests

`test/mock-nexus.ts` mirrors nexusd@631bd52's MCP server:
- tool names, zod input schemas and `summary()` output;
- loopback Host/Origin checks;
- the empty server for unknown tokens;
- `watch_agents` cursor/`missed` semantics.

It also implements the #56 tools as specified (`resource_usage`'s shape is a guess until #56 lands). The proxy tests run
a real MCP client against the proxy, plus a second MCP server for the generic upstream rules. The push test goes through
the real `web-push` library to a local HTTPS endpoint. When Nexus changes its MCP surface, update the mock first.
