# T3 Code Multi-LLM Orchestration (Codex Coordinator + Any T3 LLM Worker) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Note: Do NOT run `git commit` (user reviews working tree before committing).

**Goal:** Enable a Codex Coordinator thread inside T3 Code to route tasks by complexity (`simple`, `standard`, `complex`) to any T3-configured LLM provider (`codex`, `opencode`, `antigravity`, `claudeAgent`, etc.) with deterministic `modelSelection` and automatic wake-up signaling back to the coordinator.

**Architecture:** Add two pure Node ESM modules (`codex/src/t3-providers.mjs` and `codex/src/t3-routing.mjs`) that read T3 Code's non-sensitive provider/model metadata, manage per-project routing policy in `~/.t3-orchestration/t3-routing.json`, and generate `modelSelection` + wake-up worker briefs. Expose them via `t3o-codex` subcommands (`t3-providers`, `t3-route`, `t3-brief`) and package T3 Code Codex skills and templates (`codex/skills/t3-setup/`, `codex/skills/t3-orchestrate/`, `codex/templates/`).

**Tech Stack:** Node.js >=22 (ESM), `node:test`, `node:assert/strict`. Zero new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-27-t3-multi-llm-codex-orchestration-design.md`

## Global Constraints

- Node.js `>=22`, zero new npm packages.
- Do NOT modify `hooks/register.mjs`, `hooks/hooks.json`, `scripts/accounts.mjs`, `scripts/memory.py`, or `.claude-plugin/plugin.json`.
- Never read or emit secrets (`apiKey`, `token`, `secret`, `auth`, `env`) from `~/.t3/userdata/settings.json`.
- Effort values strictly limited to `low`, `medium`, `high`, `xhigh` (`max` rejected).
- All routing files written atomically with `0600` permissions.
- Do NOT run `git commit`.

## Review Focus

1. Missing or malformed `~/.t3/userdata/model-manifest.json` must not crash `readT3Providers` — it should still return enabled providers with empty model lists.
2. Disabled provider instances (`enabled: false`) in `settings.json` must never be selected even if named in a stale routing policy (fall back cleanly to enabled providers).
3. Secret fields inside `providerInstances[id].config` (e.g., `apiKey`, `token`) must never appear in `readT3Providers` or CLI `--json` output.
4. Invalid `--set` specifiers, unknown tiers, or `effort: "max"` must fail fast with clear error messages and non-zero CLI exit code.
5. Non-Claude worker briefs must include an unambiguous `t3_thread_send` instruction with `[T3O_SIGNAL_V1]` and deterministic `clientRequestId`, while Claude worker briefs must explicitly suppress duplicate `t3_thread_send` calls.

---

### Task 1: T3 Provider Discovery, Tier Classifier, Model Router & Brief Builder

**Files:**
- Create: `codex/src/t3-providers.mjs`
- Test: `codex/test/t3-providers.test.mjs`

**Interfaces:**
- Produces:
  - `defaultT3SettingsPath(): string`
  - `defaultT3ManifestPath(): string`
  - `readT3Providers({ settingsPath?, manifestPath? }): { providers: Array<{ instanceId, driver, label, enabled, models }> }`
  - `classifyModelTier(modelSlug: string): "simple" | "standard" | "complex"`
  - `selectModelForTask({ providers, tier, preferredDriver?, routingPolicy? }): { tier, source, reason, provider, modelSelection }`
  - `buildWorkerBrief({ projectName, coordinatorThreadId, taskTitle, brief, isClaudeWorker, routing?, projectRules? }): string`

- [x] **Step 1: Write failing tests in `codex/test/t3-providers.test.mjs`**
  - Tests: reads all enabled providers (`codex`, `opencode`, `antigravity`, `claudeAgent`), skips `enabled: false`, strips secret config fields (`apiKey`, `token`), tolerates missing manifest, classifies `simple`/`standard`/`complex` models, honors explicit `routingPolicy` when enabled, ignores stale/disabled policy entries and falls back, rejects invalid tier, builds distinct briefs for Claude vs non-Claude workers with `[T3O_WORKER_V1]` and `[T3O_SIGNAL_V1]`.
- [x] **Step 2: Run test to verify it fails**
  - Run: `node --test codex/test/t3-providers.test.mjs`
  - Expected: FAIL (`ERR_MODULE_NOT_FOUND`).
- [x] **Step 3: Implement `codex/src/t3-providers.mjs`**
  - Implement all exported functions cleanly with strict input validation and zero secret leakage.
- [x] **Step 4: Run test to verify it passes**
  - Run: `node --test codex/test/t3-providers.test.mjs`
  - Expected: PASS (all tests).

---

### Task 2: Persistent T3 Routing Policy Store

**Files:**
- Create: `codex/src/t3-routing.mjs`
- Test: `codex/test/t3-routing.test.mjs`

**Interfaces:**
- Produces:
  - `defaultT3RoutingPath(): string`
  - `ALLOWED_TIERS`, `ALLOWED_EFFORTS`
  - `parseTierAssignment(spec: string): { tier, instanceId, model, effort }`
  - `loadT3Routing(routingPath?): { version: 1, projects: Record<string, object> }`
  - `saveT3RoutingAtomic(routingPath, data): void`
  - `setProjectTierRoute({ routingPath, projectName, tier, instanceId, model, effort, root? }): object`
  - `getProjectRouting(routingPath, projectName): object | null`

- [x] **Step 1: Write failing tests in `codex/test/t3-routing.test.mjs`**
  - Tests: returns default empty structure when file missing, parses `simple=antigravity:gemini-3.8-flash-low:low` and omits effort defaulting by tier, rejects `max` effort / invalid tier / invalid slug, saves atomically with `0600` mode, preserves unrelated projects when updating one project's tier.
- [x] **Step 2: Run test to verify it fails**
  - Run: `node --test codex/test/t3-routing.test.mjs`
  - Expected: FAIL (`ERR_MODULE_NOT_FOUND`).
- [x] **Step 3: Implement `codex/src/t3-routing.mjs`**
  - Implement strict validation, `0600` atomic write (`tmp` + `renameSync`), and clean read/update helpers.
- [x] **Step 4: Run test to verify it passes**
  - Run: `node --test codex/test/t3-routing.test.mjs`
  - Expected: PASS.

---

### Task 3: `t3o-codex` CLI Integration (`t3-providers`, `t3-route`, `t3-brief`)

**Files:**
- Modify: `codex/src/cli.mjs`
- Modify: `codex/test/cli.test.mjs`

**Interfaces:**
- Consumes: `codex/src/t3-providers.mjs`, `codex/src/t3-routing.mjs`
- Produces: CLI subcommands `t3-providers`, `t3-route`, `t3-brief` inside `runCli(argv, options)`.

- [x] **Step 1: Add failing CLI tests in `codex/test/cli.test.mjs`**
  - Tests: `t3-providers --json` lists enabled providers and hides secrets; `t3-route --project demo --set simple=antigravity:gemini-3.8-flash-low:low --json` persists and returns policy route; `t3-route --project demo --tier simple --json` returns `modelSelection`; invalid `--set` with `max` effort exits non-zero; `t3-brief --project demo --coordinator th_1 --title "Check logs" --brief "Inspect auth" --tier simple --json` returns `{ modelSelection, brief, isClaudeWorker }`.
- [x] **Step 2: Run test to verify new tests fail**
  - Run: `node --test codex/test/cli.test.mjs`
  - Expected: FAIL (unknown command).
- [x] **Step 3: Wire `t3-providers`, `t3-route`, `t3-brief` into `codex/src/cli.mjs` and update `--help`**
- [x] **Step 4: Run test to verify all CLI tests pass**
  - Run: `node --test codex/test/cli.test.mjs`
  - Expected: PASS.

---

### Task 4: T3 Code Codex Skills, Templates & Documentation

**Files:**
- Create: `codex/skills/t3-setup/SKILL.md`
- Create: `codex/skills/t3-orchestrate/SKILL.md`
- Create: `codex/templates/t3-coordinator.md`
- Create: `codex/templates/t3-worker-non-claude.md`
- Create: `docs/codex/t3-multi-llm.md`
- Modify: `README.md`

- [x] **Step 1: Author `codex/skills/t3-setup/SKILL.md` and `codex/skills/t3-orchestrate/SKILL.md`**
  - Include fail-closed `t3_thread_configure` check, `orchestrator_capabilities` + `t3o-codex t3-route` complexity routing, `t3o-codex t3-brief` wake-up protocol, and `t3_thread_read` evidence rule.
- [x] **Step 2: Author `codex/templates/t3-coordinator.md` and `codex/templates/t3-worker-non-claude.md`**
- [x] **Step 3: Author `docs/codex/t3-multi-llm.md` and link it in `README.md`**
- [x] **Step 4: Run full verification suite across entire repository + live read-only smoke test against local T3 Code settings**
  - Run:
    - `node --test hooks/register.test.mjs scripts/accounts.test.mjs`
    - `python3 scripts/test_memory.py`
    - `python3 -m unittest discover -s docs/codex -p 'test_*.py' -v`
    - `node --test codex/test/*.test.mjs`
    - `t3o-codex t3-providers` (read-only live check on user's machine)
    - `t3o-codex t3-route --tier simple --json && t3o-codex t3-route --tier complex --json`
  - Expected: 100% PASS, zero regressions, zero untracked temp artifacts.
