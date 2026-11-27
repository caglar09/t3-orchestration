# Installing t3-orchestration for Codex App

`codex/` is a self-contained Codex plugin package (`t3-orchestration-codex`) and local MCP orchestration bridge. It lets a Codex coordinator thread launch, inspect, continue, and cancel isolated Codex worker threads through an owned `codex app-server` process — **without requiring T3 Code or Claude Code**.

> **Original Claude Code / T3 Code setup is unchanged.** Installing or uninstalling the Codex plugin never touches `.claude-plugin/plugin.json`, `hooks/register.mjs`, `hooks/hooks.json`, or `~/.t3-orchestration/config.json`.

---

## Supported versions (V1)

Verified local target environment (recorded in [compatibility.md](./compatibility.md)):

| Component | Verified version / requirement | Notes |
| --- | --- | --- |
| Operating system | macOS (`darwin`) | V1 macOS local-first; Windows and Linux are unverified |
| Codex CLI | `codex-cli 0.172.0` | App Server JSON schema verified; `0.171.0` also probed |
| Codex Desktop App | Build `26.1120.50957` | Delayed sidebar/UI rendering accepted for V1 |
| Node.js | `>=22` (verified on `v22.23.0`) | Required by `codex/package.json` |
| Python | `>=3.9` (verified on `3.12.0`) | Required only if you opt into long-term memory |

These are the verified versions, not a claimed lower compatibility floor for older Codex builds.

---

## Local installation

### 1. Clone and install isolated Codex dependencies

```bash
git clone https://github.com/caglar09/t3-orchestration.git ~/t3-orchestration
npm ci --prefix ~/t3-orchestration/codex
```

Run non-destructive diagnostics first:

```bash
node ~/t3-orchestration/codex/scripts/doctor.mjs
```

`doctor.mjs` checks macOS (`darwin`), Node `>=22`, `codex --version`, Python `>=3.9` (only when a configured project has `memoryEnabled: true`), manifest validity, and prints a manual hook-trust checklist. It never reads credentials or mutates global Codex settings.

### 2. Load the plugin in Codex

The Codex package uses the native plugin layout in `codex/`:

- `codex/.codex-plugin/plugin.json` — native plugin manifest (`mcpServers: "./.mcp.json"`, `hooks: "./hooks/hooks.json"`, `skills: "./skills"`)
- `codex/.mcp.json` — relative local stdio MCP server (`command: "node"`, `args: ["src/mcp.mjs"]`, server name `t3o_codex`)
- `codex/hooks/hooks.json` — `UserPromptSubmit` command hook (`node hooks/context.mjs`, 3s timeout; no `Stop` hook)

> Do not place a root `codex/plugin.json` alongside `codex/.codex-plugin/plugin.json`, and do not change `codex/.mcp.json` to an absolute command path (Codex `0.171.0+` rejects absolute command paths in portable plugin configs).

Two supported local ways to load it:

1. **Local plugin / marketplace (recommended):** Point a local Codex marketplace or plugin configuration at `~/t3-orchestration/codex` and enable **T3 Orchestration (Codex)** in Codex Settings.
2. **Direct project-local setup (isolated testing fallback):** Configure project-local `.codex/config.toml` (with `t3o_codex` pointing to `node` + `~/t3-orchestration/codex/src/mcp.mjs` and `cwd` set to `~/t3-orchestration/codex`) and `.codex/hooks.json` for `UserPromptSubmit` inside a single trusted project workspace.

---

## Explicit hook trust

Codex treats plugin/project hooks as untrusted until you explicitly approve them:

1. Open **Settings > Hooks** in Codex Desktop, or run `/hooks` in Codex CLI.
2. Review and explicitly trust the `UserPromptSubmit` hook (`node hooks/context.mjs`).
3. Verify no `Stop` hook is registered for Codex (`hooks/hooks.json` intentionally has none; worker completion comes from App Server `turn/completed` events).

Without hook trust, prompts still work normally, but `[T3O_CODEX_COORDINATOR_V1]` context and unread inbox IDs will not be injected into your coordinator prompts (you can still inspect events manually with `inbox_list`).

---

## Authentication (existing ChatGPT login)

- t3-orchestration uses your **existing authenticated Codex / ChatGPT account** on the machine.
- **No API keys are collected or stored.** `codex/src/rpc.mjs` strips `OPENAI_API_KEY` from the spawned `codex app-server` child environment by default (`stripOpenAiApiKey: true`) so worker turns do not silently fall back to paid API billing.
- `account_status` queries `account/read` and `account/rateLimits/read`, strips `email`/`userId`/`workspaceName`, and reports `"unknown"` whenever account or limit fields are missing or `null`.

---

## Explicit project pairing (`project_setup`)

Codex orchestration never infers roles from working directory, thread title, or prompt text. Follow `codex/skills/setup/SKILL.md` in the thread you want to designate as coordinator:

1. Provide an out-of-band pairing code via the host environment (`T3O_CODEX_PAIRING_CODE`) or `~/.t3-orchestration/codex/pairing.json`, along with verified host identity (`T3O_CODEX_HOST_SESSION_ID` and optional `T3O_CODEX_HOST_THREAD_ID`).
2. Call `project_setup` with:
   - `name`: lowercase slug (`^[a-z0-9][a-z0-9-]*$`, <= 64 chars)
   - `root`: canonical absolute path to your project repository (no symlinks or `..`)
   - `pairingCode`: the out-of-band pairing secret
   - optional `maxWorkers` (`1..4`, default `2`), `allowWrite` (default `false`), `memoryEnabled` (default `false`), `libraryPath` (default `null`)
3. Never pass `coordinatorSessionId` or `projectId` in tool arguments; strict schemas reject them.

All Codex state is stored separately from Claude/T3 under `~/.t3-orchestration/codex/`:

```text
~/.t3-orchestration/codex/
├── config.json                     # Version 1 Codex project registry (0600)
└── projects/<projectId>/
    ├── state.json                  # Durable worker registry + event inbox (0600)
    ├── lease.json                  # Single-writer PID lease (0600)
    ├── worktrees/<workerId>/       # Isolated Git worktrees (only when write mode authorized)
    └── library/                    # Optional memory library (only when memoryEnabled: true)
```

Manual threads, subagents, internal app jobs, and worker threads remain completely unaffected (`UserPromptSubmit` returns `{}` / `null` and MCP tools reject calls).

---

## Default permissions and write opt-in

- **Read-only by default:** `allowWrite` defaults to `false` on projects and `worker_launch` defaults to `mode: "read"` (`sandbox: "read-only"`, `approvalPolicy: "on-request"`).
- **Authorized write opt-in:** Launching a worker with `mode: "write"` requires **all three**:
  1. Explicit user authorization (`project.allowWrite: true` in `project_setup`),
  2. Host write policy enabled (`T3O_CODEX_ALLOW_WRITE=true`), and
  3. An isolated per-worker Git worktree (`<stateDir>/worktrees/<workerId>` on branch `codex-worker/<workerId>`) with `sandboxPolicy: { type: "workspaceWrite", writableRoots: [worktree] }`.
- Workers never auto-commit, push, merge, or delete dirty worktrees.
- Any App Server approval request (command execution, file change, patch, elicitation, permissions escalation) is safely declined at the bridge and surfaced on the worker as `approval_required` for explicit user review.

---

## Stop, cancel, and `recovery_required`

- **Cancelling a turn:** `worker_cancel` sends `turn/interrupt` for the worker's active turn and waits for the actual `turn/completed` (`status: "interrupted"`) notification. It never fabricates completion and never discards uncommitted work in a worker worktree.
- **Failed turns:** `status: "failed"` (with optional `errorCode`) is recorded distinctly from `completed` and `interrupted`. Inspect details with `worker_read` before deciding to continue.
- **Restart & `recovery_required`:** If the MCP bridge or `codex app-server` exits while a worker turn is in flight (or `thread/start` / `turn/start` fails/times out), restarting opens `state.json` under the single-writer PID lease and runs `reconcile`:
  - Known `threadId`s are inspected via `thread/read` and `thread/turns/list` without blindly relaunching turns.
  - Any worker lacking correlation or left in an uncertain state is marked `status: "recovery_required"`. Inspect `worker_list` / `worker_read` and resolve explicitly with the user before starting new turns.

---

## Optional long-term memory (`memory_pass`)

- **Disabled by default:** `memoryEnabled` is `false` and `libraryPath` is `null` unless you explicitly opt in during setup.
- **Manual incremental pass only in V1:** When enabled, invoke `codex/skills/memory/SKILL.md` (`memory_pass` / `collectMemory`) manually. There is no background timer or cron scheduler in V1.
- **Sourced and sanitized:** Collects only bounded turn summaries from registered project workers and the explicitly enrolled coordinator thread, redacts secrets/PII, writes `0600` evidence JSON artifacts under `<libraryPath>/evidence/` with `file://` source URIs, and records idempotent notes in SQLite via `scripts/memory.py` using CAS `expected_revision` cursors. Never edits product code.

---

## V1 limitations (delayed UI & no idle push guarantee)

1. **Delayed desktop UI rendering:** The bridge owns its own `codex app-server` stdio process rather than injecting into a private desktop IPC socket. Worker threads and turns persist to Codex storage, and in Codex Desktop `26.1120.50957` they may only become visible in the sidebar after refreshing or closing and reopening Codex App.
2. **No idle push guarantee:** V1 does not guarantee pushing notifications into an already-idle Codex desktop chat. The **durable inbox** (`UserPromptSubmit` context on your next coordinator prompt + `inbox_list` / `inbox_ack`) is the authoritative V1 notification mechanism.
3. **Single-writer per project:** Only one active MCP bridge process may hold the `lease.json` writer lock for a project at a time.

---

## Uninstalling without losing user state

To remove the Codex integration while preserving your project history and memory libraries:

1. Disable or remove the `t3-orchestration-codex` plugin in Codex Settings (and remove any project-local `.codex/` overrides if you used direct mode).
2. Optionally remove the project entry from `~/.t3-orchestration/codex/config.json`.
3. **Leave `~/.t3-orchestration/codex/projects/` intact** unless you explicitly want to delete durable worker state, worktrees, and SQLite memory libraries.
4. Your original Claude Code / T3 Code setup (`~/.t3-orchestration/config.json`, root `hooks/register.mjs`, `skills/`) remains completely unchanged.
