# Codex Project Integration CLI (`t3o-codex`) — Design

Date: 2026-11-27
Status: approved by user (Option 1: one-command full local init & update).
Base: `docs/codex-app-support-plan` (builds on `codex/` isolated package; no git commits per user instruction).

## Intent and Why
Manually creating `.codex/config.toml`, `.codex/hooks.json`, `.git/info/exclude`, running `pair.mjs`, and invoking `project_setup` in chat is error-prone and high-friction. Users want a single local CLI (`t3o-codex`) they can run inside any existing project directory to initialize (`init`), safely update (`update`), inspect (`status`), or cleanly remove (`uninstall`) Codex orchestration without touching their repository's tracked files or clobbering unrelated `.codex/` MCP/hook entries.

## Goals / Non-Goals
- **Goals:**
  - Single-command `t3o-codex init [dir]` that validates the canonical project root, registers the project in `~/.t3-orchestration/codex/config.json` (`0700`/`0600`), merges a marked `t3o_codex` block into `<dir>/.codex/config.toml`, merges `UserPromptSubmit` (`context.mjs`) into `<dir>/.codex/hooks.json`, and adds `.codex/` to `.git/info/exclude` when inside a Git repo.
  - Safe, idempotent `t3o-codex update [dir]` that refreshes binary/script paths and explicit option flags (`--allow-write`/`--no-allow-write`, `--max-workers`, `--memory`/`--no-memory`, `--library-path`) while preserving existing `project.id`, `coordinatorSessionId`, and unrelated `.codex/` config/hooks.
  - `t3o-codex status [dir]` and `t3o-codex uninstall [dir]` (removes only `t3o_codex` entries and config registration; preserves `~/.t3-orchestration/codex/projects/<id>/` user state and never touches legacy `~/.t3-orchestration/config.json`).
  - Pass-through subcommands `doctor` and `pair` under the same binary.
  - Expose `"bin": { "t3o-codex": "./scripts/cli.mjs" }` in `codex/package.json`.
- **Non-Goals:**
  - Modifying global `~/.codex/config.toml` or bypassing Codex hook trust (`Settings > Hooks` / `/hooks` remains explicit user consent).
  - Editing the target repository's `.gitignore` or committing files.
  - Removing or weakening `project_setup` / `pair.mjs` (remains supported for chat-based pairing).

## Approaches Considered
1. **One-command full local CLI (`t3o-codex init/update`, selected):** CLI handles `.codex/` merge, `.git/info/exclude`, and direct `config.json` binding with a generated `coordinatorSessionId`. Trade-off: eliminates manual `pair.mjs` + `project_setup` steps for local single-user setup while keeping `0700`/`0600` isolation and hook trust intact.
2. **Two-step CLI + chat pairing (rejected):** CLI only writes `.codex/` and prints a pairing code, still requiring a manual `project_setup` prompt in Codex chat. Higher friction for the primary local workflow.

## Key Constraints
- Zero new npm dependencies; Node >=22 ESM, `node:test`.
- Non-destructive merge for `.codex/config.toml` (delimited `# BEGIN t3-orchestration-codex` / `# END t3-orchestration-codex` block) and `.codex/hooks.json` (array merge preserving all other hook entries and events).
- Fail closed on symlink-escaping roots, malformed existing `.codex/hooks.json`, duplicate `init` on already-registered roots, or `update` on unregistered roots.
- Never touch `~/.t3-orchestration/config.json` or Claude/T3 files.
