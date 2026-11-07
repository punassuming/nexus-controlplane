# Nexus Control Plane

Supervisor harness on top of [Nexus](https://github.com/punassuming/nexus). Nexus (`nexusd`) keeps owning
terminals, PTYs, process trees and agent detection. This service is an MCP **client** that adds task state, an
approval queue, a read-only diff view, event fan-out and a small web UI. If this service dies Nexus keeps running;
if `nexusd` dies the UI shows a stale-state banner and nothing is enforced.

Tracking issue: punassuming/nexus-controlplane#1. Nexus-side work (supervisor token, `get_state`,
`pause_session`, `resource_usage`) is punassuming/nexus#56.

## Run

```
npm install
NEXUS_SUPERVISOR_TOKEN=... npm start        # UI on http://127.0.0.1:8787
npm test                                     # against a mock of nexusd's MCP server, no real Nexus needed
```

| Variable | Default | |
|---|---|---|
| `NEXUS_MCP_URL` | nexusd's default, `http://127.0.0.1:<47000 + uid % 1000>/mcp` (`47821` on Windows) | Nexus MCP endpoint, or the bridge's `https://…/mcp` |
| `NEXUS_SUPERVISOR_TOKEN` | required | Bearer token of the Nexus supervisor access class |
| `CONTROLPLANE_HOST` / `_PORT` | `127.0.0.1` / `8787` | UI + API listener |
| `CONTROLPLANE_AUTH` | `none` | `none`, `tailscale` or `token` (below) |
| `CONTROLPLANE_ALLOWED_USERS` | any | `tailscale` mode: comma-separated tailnet logins allowed in |
| `CONTROLPLANE_UI_TOKEN` | | `token` mode: shared secret, 24+ characters |
| `CONTROLPLANE_DB` | `data/controlplane.db` | SQLite: tasks, approvals, audit, watch cursor |
| `APPROVAL_TTL_MS` | `900000` | Pending approvals expire; nothing is sent on expiry |
| `POLL_WAIT_SEC` | `50` | `watch_agents` long-poll (Nexus's own default and cap) |

## Web UI access

The UI can start, guide, approve and stop agents, so it is never unauthenticated on a network.

- **`none`**: only on loopback. Startup refuses any other `CONTROLPLANE_HOST`.
- **`tailscale`** (recommended for Muse): keep the listener on loopback and publish it with
  `tailscale serve --bg --https=8443 http://127.0.0.1:8787`. `tailscale serve` adds `Tailscale-User-Login`
  for tailnet users; set `CONTROLPLANE_ALLOWED_USERS` to restrict who gets in. Because the header is trusted,
  startup refuses a non-loopback host in this mode. Approvals and prompts are audited with that login.
- **`token`**: for anything else. Visit `/login?token=…` once (sets an HttpOnly, SameSite=Strict cookie) or send
  `Authorization: Bearer …`.

In every mode, POST endpoints accept only `application/json`, so a cross-site page cannot submit one without a CORS
preflight, which the server never grants.

## What it does

- **Tasks**: `POST /api/tasks {agent, cwd, name?, prompt?}` calls `start_agent` with `placement: background` and a
  generated `cp-<name>-<id>` label, and stores `task_id → session_id`. Only sessions started here are supervised.
- **Guide**: `POST /api/tasks/:id/prompt {text, force?}` calls `prompt_agent` and returns once the agent is working.
  A blocked agent answers `409 agent_blocked`: decide its approval first. Prompts are audited by length only.
- **Stop**: `POST /api/tasks/:id/stop` calls `stop_session`. A stopped task stays stopped.
- **Watch**: one long-poll loop on `watch_agents` for every state (`needs-input`, `working`, `idle`, `done`,
  `error`, `exited`) with a persisted integer cursor. A `missed` answer (cursor fell out of nexusd's buffer), a
  restart or an outage triggers a resync from each live task's current state.
- **Approvals**: a `needs-input` event becomes one pending approval per session with the question, the screen tail
  and the choices. Typed choices (`key`, `kind: approve|deny|other`) come from `get_state` (#56); without it they are
  derived from the watch event's numbered labels. Nothing is answered until someone decides.
  - **Allow once** presses the first `approve` choice that isn't persistent ("always", "don't ask again", "all …",
    "this session"). If there is none it refuses: pick a choice explicitly.
  - **Deny** presses the `deny` choice, or Escape when the menu has none.
  - Before typing anything the live state is checked: if the agent is no longer on that same prompt (answered in
    the app, a different question), nothing is sent and the approval is closed as `stale`.
  - Decisions are claimed atomically (no double send); failed delivery reopens the approval. Every step is in
    `audit` with who decided.
  - Answered elsewhere, superseded by a new question or expired: closed without sending anything.
- **Diff**: `GET /api/tasks/:id/diff` runs fixed read-only git commands in the task `cwd` (works before the first
  commit) and includes previews of new untracked files. It never stages or locks anything.
- **Events**: `GET /api/events` (SSE, supports `Last-Event-ID`) carries agent, approval, task and Nexus-health events.
- **Without #56**: `get_state` falls back to `list_sessions` (no typed options); `pause_session` reports
  `unsupported`. A token Nexus doesn't accept gets nexusd's empty server, reported as `unauthorized`.

## Tailnet bridge

When the control plane runs on another machine, Nexus stays loopback-only and the bridge runs on the Nexus host. It
terminates TLS on the tailnet address, requires the same supervisor token, and forwards `POST /mcp` to loopback
nexusd with a loopback `Host` and no `Origin`, which nexusd's checks require:

```
tailscale cert <nexus-host>.<tailnet>.ts.net
BRIDGE_HOST=100.x.y.z BRIDGE_PORT=7778 BRIDGE_CERT=<host>.crt BRIDGE_KEY=<host>.key \
NEXUS_SUPERVISOR_TOKEN=... npm run bridge      # upstream defaults to nexusd's own port
```

It refuses to start on anything other than a `100.64.0.0/10` or loopback address. Restrict who can reach it with a
tailnet ACL (Muse and the Nexus host only). Point the control plane at it with
`NEXUS_MCP_URL=https://<nexus-host>.<tailnet>.ts.net:7778/mcp`.

## Token setup

Create the supervisor token in Nexus per its `docs/security.md` (punassuming/nexus#56). The supervisor drives the
agents it starts; grant it pre-existing sessions with `agents.allowControl` / `session.grant`. Revoke it in Nexus to
cut the harness off without restarting anything.

## Tests

`test/mock-nexus.ts` mirrors nexusd's MCP server at punassuming/nexus@631bd52: the same tool names and zod input
schemas, `summary()` output, loopback Host/Origin checks, the empty server for unknown tokens, and `watch_agents`
cursor/`missed` semantics, plus the #56 tools as specified. When Nexus changes its MCP surface, update the mock first.
