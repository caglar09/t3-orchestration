---
name: t3-setup
description: Inside T3 Code, configure a Codex (or any LLM) thread as a multi-LLM project coordinator that routes tasks by complexity (simple, standard, complex) across any enabled T3 Code provider (codex, opencode, antigravity, claudeAgent, etc.). Use when the user wants Codex inside T3 Code to orchestrate other T3 Code LLMs.
---

# Set up T3 Code Multi-LLM Orchestration (Codex Coordinator)

Run this inside a **T3 Code** thread inside the target project. Show each configuration change before applying it, and keep `~/.t3-orchestration/config.json` 100% compatible with existing Claude/T3 threads.

## Requirements

- T3 Code's built-in `t3-code` MCP server exposing `orchestrator_capabilities`, `t3_thread_configure`, `t3_thread_read`, `t3_thread_launch`, `t3_thread_send`, and `t3_project_list`.
- `t3o-codex` CLI linked globally (`(cd <repo>/codex && npm link)`) or invoked via `node <repo>/codex/scripts/cli.mjs`.

## 1. Discover T3 Project and Enabled LLMs

1. Identify the current thread and project via `t3_thread_configure` followed by `t3_thread_read` (or `t3_project_list`).
2. Inspect all configured T3 Code LLMs using both:
   - `orchestrator_capabilities` (live T3 provider instances, models, and effort options), and
   - `t3o-codex t3-providers --json` (enabled instances from `~/.t3/userdata/settings.json` + tier classification).
3. Present the enabled providers to the user and ask for:
   - `name`: lowercase project slug (`^[a-z0-9][a-z0-9-]*$`, <= 64 chars)
   - `simple` tier target (fast/economical model, `low` effort — reading, research, small fixes)
   - `standard` tier target (balanced model, `medium` effort — scoped bug fixes, tests, refactors)
   - `complex` tier target (strongest model, `high` / `xhigh` effort, never `max` — architecture, multi-file features)
   - short project rules bullet list (guardrails, review policy, reply language).

## 2. Save Complexity Routing Policy

Persist the user's tier routing into `~/.t3-orchestration/t3-routing.json` (0600, atomic, separate from `config.json`):

```bash
t3o-codex t3-route --project <name> --set simple=<instanceId>:<model>:low
t3o-codex t3-route --project <name> --set standard=<instanceId>:<model>:medium
t3o-codex t3-route --project <name> --set complex=<instanceId>:<model>:high
```

Verify with `t3o-codex t3-route --project <name> --tier simple --json` and `--tier complex --json`.

## 3. Create the Coordinator Thread & Register Project

1. Check `~/.t3-orchestration/config.json` first; if this `projectId` or `name` is already registered, ask whether to replace it instead of creating a duplicate coordinator.
2. Create an idle Coordinator thread in T3 Code using `t3_thread_launch` (`projectId`, title `Orchestration`, no `message`, and `modelSelection` pointing to the user's chosen Codex instance). Keep the returned `threadId` and link, and suggest pinning it.
3. Create `~/.t3-orchestration/projects/<name>/`:
   - Fill `codex/templates/t3-coordinator.md` → `~/.t3-orchestration/projects/<name>/coordinator.md`, replacing `{{PROJECT_NAME}}`, `{{COORDINATOR_THREAD_ID}}`, `{{PLUGIN_ROOT}}` (absolute path to the `codex/` directory containing `skills/t3-orchestrate/SKILL.md`), and `{{PROJECT_RULES}}`.
   - Fill `codex/templates/t3-worker-non-claude.md` → `~/.t3-orchestration/projects/<name>/worker.md`.
4. Back up `~/.t3-orchestration/config.json` if it exists, then add the project entry (`name`, `projectId`, `coordinatorThreadId`, `memoryThreadId: null`, `excludedThreadIds: [<setup thread id>]`, `libraryPath: null`).
   - **Mandatory `projectId` verification:** Read back the newly launched `Orchestration` thread with `t3_thread_read` and copy its exact `thread.projectId` verbatim into `config.json`. Never transcribe or guess UUIDs by hand.
   - **Avoid MCP collision:** If the project directory also has standalone `t3o_codex` in `.codex/config.toml` and the user wants T3 Code orchestration only, advise running `t3o-codex uninstall <projectDir>` so the Codex coordinator only sees `t3-code` MCP tools.
   - **Enable per-prompt coordinator reminder hook:** Run `t3o-codex t3-hook <projectDir> --project <name>` so `.codex/hooks.json` injects a fail-closed `UserPromptSubmit` reminder on every turn (preventing the coordinator from drifting into direct code exploration or Codex native subagents). Remind the user to trust `UserPromptSubmit` in Codex `/hooks` if prompted.
   - Because `coordinatorThreadId` lives in `~/.t3-orchestration/config.json`, any **Claude worker** launched by this Codex coordinator automatically fires `hooks/register.mjs` (`Stop` hook) and wakes up the Codex coordinator via `t3_thread_send`.
   - Any **non-Claude worker** (Codex, Antigravity, OpenCode, etc.) wakes up the Codex coordinator using the mandatory `t3_thread_send` protocol embedded by `t3o-codex t3-brief`.

## 4. Verify End-to-End

1. Open the pinned `Orchestration` (Codex) thread and send a small read-only task.
2. Confirm the coordinator verifies its own `threadId` with `t3_thread_configure`, selects the `simple` tier model via `t3o-codex t3-route`, generates the wake-up brief via `t3o-codex t3-brief`, and launches the worker with `t3_thread_launch`.
3. Confirm the worker reports back with `[T3O_SIGNAL_V1]` via `t3_thread_send` (or Claude `Stop` hook) and wakes up the coordinator.
