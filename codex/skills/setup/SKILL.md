---
name: setup
description: In Codex desktop/CLI, install, pair, configure, update, or uninstall the isolated t3-orchestration-codex plugin for a project. Use when the user asks to set up Codex orchestration on a project, add another project, verify diagnostics, or uninstall it.
---

# Set up t3-orchestration (Codex)

Run this inside the repository to orchestrate using the local `codex/` plugin package
(`t3-orchestration-codex`, MIT License — Copyright (c) 2026 sanztheo).
Show each configuration change to the user before applying it, and never touch the legacy T3/Claude
state at `~/.t3-orchestration/config.json`.

All Codex orchestration user state lives separately under `~/.t3-orchestration/codex/`:

```text
~/.t3-orchestration/codex/
├── config.json                  # version 1 registry of Codex-orchestrated projects
└── projects/<projectId>/
    ├── state.json               # durable worker registry and event inbox (0600)
    ├── lease.json               # single-writer PID lease
    ├── worktrees/               # isolated per-worker Git worktrees (only when write enabled)
    └── library/                 # optional sourced long-term memory (disabled by default)
```

## 1. Fast one-command setup (`t3o-codex` CLI — recommended)

1. Install Node dependencies and link the CLI once:
   `npm ci --prefix <pluginRoot> && (cd <pluginRoot> && npm link)` (or invoke `node <pluginRoot>/scripts/cli.mjs` directly).
2. Run diagnostics first: `t3o-codex doctor`. Confirm Node `>=22`, `codex` CLI detection, `darwin` platform check, and manifest validation pass.
3. Inside the target project directory, run:
   `t3o-codex init` (add `--allow-write`, `--max-workers <1..4>`, or `--memory` as needed; run `t3o-codex update` later to refresh paths/options without overwriting unrelated `.codex/` entries or `project.id`).
4. **Explicit hook trust:** In Codex Settings -> Hooks (or `/hooks` in CLI), explicitly review and
   trust the `UserPromptSubmit` hook (`hooks/context.mjs`). There is no `Stop` hook.
5. The hook and MCP bridge stay inert in unrelated or manual sessions.

## 2. Collect explicit project decisions and out-of-band pairing

Ask the user for:
1. Project `name` (`^[a-z0-9][a-z0-9-]*$`, <= 64 chars) and canonical `root` path (absolute, no symlinks).
2. Project rules for coordinator and workers (short bullet list: repositories, guardrails, review policy, reply language).
3. `maxWorkers` (default `2`, range `1..4`).
4. `allowWrite` (default `false` — **read-only by default**; enable only if the user explicitly wants isolated Git worktree writes).
5. `memoryEnabled` (default `false` — **disabled by default**; if enabled, choose `libraryPath` inside `~/.t3-orchestration/codex/projects/<projectId>/library` or another canonical non-symlink path).
6. Generate a single-use out-of-band pairing ticket via `node <pluginRoot>/scripts/pair.mjs` (writes `0600` `~/.t3-orchestration/codex/pairing.json` and prints the single-use `pairingCode`). Ensure the coordinator MCP session receives verified `T3O_CODEX_HOST_SESSION_ID` (and optional `T3O_CODEX_HOST_THREAD_ID`). Do not invent or hardcode pairing codes in model prompts.

## 3. Bind the coordinator via `project_setup`

In the target coordinator Codex session:
1. Call `project_setup` with `{ name, root, pairingCode, maxWorkers, memoryEnabled, libraryPath, allowWrite }`.
2. The bridge binds the host-verified coordinator session identity (`coordinatorSessionId` / `coordinatorThreadId`). Never pass `coordinatorSessionId` or `projectId` in tool arguments.
3. Prepare project reminder files from `<pluginRoot>/templates/coordinator.md` and
   `<pluginRoot>/templates/worker.md`, filling `{{PROJECT_NAME}}`, `{{PROJECT_ID}}`,
   `{{PLUGIN_ROOT}}`, and `{{PROJECT_RULES}}`.
4. If `memoryEnabled: true`, copy `templates/library/` (from repo root) into `libraryPath`, replace
   `{{PROJECT_NAME}}`, and verify Python `>=3.9` with:
   `python3 <repoRoot>/scripts/memory.py --library "<libraryPath>" status`.

## 4. Verify end-to-end

1. Send a prompt in the bound coordinator thread: the `UserPromptSubmit` hook injects `[T3O_CODEX_COORDINATOR_V1]`.
2. Launch a read-only probe via `worker_launch` (`mode: "read"`). Verify `worker_list`, `worker_read`, and `inbox_list` / `inbox_ack`.
3. Open a manual thread in the same workspace: verify `[T3O_CODEX_COORDINATOR_V1]` does NOT appear and `worker_list` fails closed.

## 5. Update and Uninstall

- **Update:** Pull the repository, inspect template diffs without overwriting user files, run `npm ci --prefix <pluginRoot>`, and re-run `node <pluginRoot>/scripts/doctor.mjs`.
- **Uninstall:** On explicit user request only, remove the project entry from `~/.t3-orchestration/codex/config.json` and disable the plugin in Codex settings. **Do NOT delete** `~/.t3-orchestration/codex/projects/` or the memory library unless the user explicitly asks to purge state. Leave `~/.t3-orchestration/config.json` and Claude/T3 hooks untouched.
