# Codex Project Integration CLI (`t3o-codex`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a one-command local CLI (`t3o-codex init`, `update`, `status`, `uninstall`, `doctor`, `pair`) that safely integrates and updates Codex orchestration in any project directory without overwriting unrelated `.codex/` settings or tracked Git files.

**Architecture:** Pure, testable core module `codex/src/cli.mjs` implementing `initProject`, `updateProject`, `getProjectStatus`, `uninstallProject`, and `runCli`, paired with an executable wrapper `codex/scripts/cli.mjs` wired via `codex/package.json` `"bin": { "t3o-codex": "./scripts/cli.mjs" }`. Reuses existing `config.mjs`, `doctor.mjs`, and `pair.mjs` with zero new dependencies.

**Tech Stack:** Node.js >=22, ESM, `node:test`, `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-11-27-codex-cli-init-update-design.md`.

## Global Constraints
- Preserve existing Claude/T3 files and `~/.t3-orchestration/config.json`; zero new dependencies.
- Never mutate global `~/.codex/` or target repo `.gitignore`; use `.git/info/exclude` only when `.git/` exists.
- Non-destructive merging for `.codex/config.toml` and `.codex/hooks.json`; fail closed on malformed JSON or symlink escapes.
- `uninstall` must never delete `~/.t3-orchestration/codex/projects/<id>/` user state.
- Do not create git commits (user will review and commit manually).

## Review Focus
1. Target project already has unrelated `[mcp_servers.*]` in `.codex/config.toml` and unrelated hooks in `.codex/hooks.json`: `init`, `update`, and `uninstall` must preserve them byte-safely.
2. Target project has malformed `.codex/hooks.json` or symlink-escaping root: fail closed without corrupting files.
3. Repeated `init` on already-registered project rejects cleanly and directs user to `update`; `update` on unregistered project directs user to `init`.
4. Paths containing spaces or quotes in `targetDir`, `nodeExec`, or `pluginRoot` serialize as valid TOML strings and properly quoted hook commands.
5. `uninstall` removes project from `config.json` and strips only `t3o_codex` config/hook entries while leaving project state/memory directory intact.

---

### Task 1: Core CLI module (`init`, `update`, `status`, `uninstall`) and unit tests

**Files:**
- Create: `codex/src/cli.mjs`
- Create: `codex/scripts/cli.mjs`
- Modify: `codex/package.json`
- Test: `codex/test/cli.test.mjs`

**Interfaces:**
- Consumes: `loadConfig`, `saveConfigAtomic`, `bindCoordinator`, `defaultConfigPath` from `codex/src/config.mjs`; `doctor` from `codex/scripts/doctor.mjs`; `createPairingTicket` from `codex/scripts/pair.mjs`.
- Produces: `initProject(opts)`, `updateProject(opts)`, `getProjectStatus(opts)`, `uninstallProject(opts)`, `runCli(argv, io)` from `codex/src/cli.mjs`; executable `t3o-codex` bin in `codex/scripts/cli.mjs`.

- [x] **Step 1: Write failing tests in `codex/test/cli.test.mjs`** covering `initProject` (fresh git repo, `.codex/config.toml`, `.codex/hooks.json`, `.git/info/exclude`, `config.json` registration, duplicate rejection, preserving unrelated MCP/hook entries, spaces in paths, symlink escape rejection), `updateProject` (refreshing paths & toggling `allowWrite`/`maxWorkers`/`memoryEnabled`, preserving `id`/`coordinatorSessionId` and unrelated config/hooks, rejecting unregistered project), `getProjectStatus`, `uninstallProject` (cleanly stripping only `t3o_codex` entries and preserving project state dir), and `runCli` subprocess/argv dispatch.
- [x] **Step 2: Run `node --test codex/test/cli.test.mjs`**; Expected: FAIL (`ERR_MODULE_NOT_FOUND` for `codex/src/cli.mjs`).
- [x] **Step 3: Implement `codex/src/cli.mjs`, `codex/scripts/cli.mjs`, and add `"bin": { "t3o-codex": "./scripts/cli.mjs" }` to `codex/package.json`**.
- [x] **Step 4: Run `node --test codex/test/cli.test.mjs`**; Expected: all PASS.

### Task 2: Documentation and full verification

**Files:**
- Modify: `docs/codex/installation.md`
- Modify: `README.md`
- Modify: `codex/skills/setup/SKILL.md`

- [x] **Step 1: Document `t3o-codex init`, `update`, `status`, `uninstall` (and `npm link --prefix codex`)** in `docs/codex/installation.md`, `README.md`, and `codex/skills/setup/SKILL.md`.
- [x] **Step 2: Run full test suites** (`node --test hooks/register.test.mjs scripts/accounts.test.mjs`, `python3 scripts/test_memory.py`, `python3 -m unittest discover -s docs/codex -p 'test_*.py' -v`, `node --test codex/test/*.test.mjs`) and smoke-test `node codex/scripts/cli.mjs --help` + `init`/`update`/`status`/`uninstall` in a temp directory. Expected: exit 0, 0 failures.
