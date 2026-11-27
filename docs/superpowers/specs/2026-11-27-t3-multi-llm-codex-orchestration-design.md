# T3 Code Multi-LLM Orchestration (Codex Coordinator + Any T3 LLM Worker) — Design Spec

**Date:** 2026-11-27  
**Status:** Approved for Implementation  
**Scope:** Add T3 Code multi-LLM routing, Codex Coordinator orchestration skills, and deterministic CLI tooling so a Codex thread inside T3 Code can orchestrate any T3-configured LLM provider (`codex`, `opencode`, `antigravity`, `claudeAgent`, etc.) with complexity-based model selection and automatic wake-up signaling.

---

## 1. Problem & Goal

The original `t3-orchestration` plugin works inside T3 Code only when the coordinator is Claude Code (relying on Claude's `hooks/register.mjs` mod and `scripts/accounts.mjs`, which filters exclusively for `driver === "claudeAgent"`). Meanwhile, the standalone `codex/` package orchestrates Codex-to-Codex threads via `codex app-server` without T3 Code.

Users running T3 Code with multiple configured LLM providers (e.g., `codex`, `opencode`, `antigravity`, `antigravity_2`, `claudeAgent`) want the exact same T3 Code coordinator/worker workflow using a **Codex coordinator** that routes:
- **Simple tasks** (reading, search, small fixes, reports) → fast/economical T3 LLMs (`low` effort)
- **Standard tasks** (scoped bug fixes, tests, refactors) → balanced T3 LLMs (`medium` effort)
- **Complex tasks** (architecture, multi-file features, deep debugging) → strongest T3 LLMs (`high` / `xhigh` effort, never `max`)

And when any worker finishes, gets blocked, or needs user approval, it wakes up the Coordinator thread inside T3 Code automatically:
- **Claude workers** continue using the existing `hooks/register.mjs` `Stop` hook (which already targets `project.coordinatorThreadId` regardless of whether the coordinator is Claude or Codex).
- **Non-Claude workers** (Codex, Antigravity, OpenCode, Gemini, etc.) receive a standardized `[T3O_WORKER_V1]` reporting block in their launch brief instructing them to call `t3_thread_send` (`mode: "queue"`, deterministic `clientRequestId`, `[T3O_SIGNAL_V1]`).

---

## 2. Non-Goals & Compatibility Invariants

1. **Zero breaking changes to legacy Claude/T3 files:** Do not modify `hooks/register.mjs`, `hooks/hooks.json`, `scripts/accounts.mjs`, `scripts/memory.py`, or `.claude-plugin/plugin.json`.
2. **Zero breaking changes to standalone Codex CLI/MCP:** Existing `t3o-codex` commands (`init`, `update`, `status`, `uninstall`, `doctor`, `pair`) and `codex/src/mcp.mjs` remain intact.
3. **Never read or emit credentials:** Reading `~/.t3/userdata/settings.json` and `~/.t3/userdata/model-manifest.json` must extract only non-sensitive metadata (`instanceId`, `driver`, `displayName`, `enabled`, model slugs/names/status). Never read or output keys such as `apiKey`, `token`, `secret`, `auth`, or `env`.
4. **Fail-closed coordinator identity:** Inside T3 Code, a Codex thread must verify its own `threadId` via `t3_thread_configure` against `~/.t3-orchestration/config.json` (`coordinatorThreadId`) before acting as coordinator. Manual threads must never be treated as coordinators or workers.
5. **Effort safety:** Allowed efforts are `"low"`, `"medium"`, `"high"`, `"xhigh"`. `"max"` is rejected.
6. **Zero new npm dependencies:** Pure Node.js (`>=22`, ESM).

---

## 3. Architecture

### 3.1 T3 Provider Discovery & Complexity Router (`codex/src/t3-providers.mjs`)

- `readT3Providers({ settingsPath, manifestPath })`
  - Reads `~/.t3/userdata/settings.json` (default) and returns all `providerInstances` where `enabled !== false`.
  - Optionally reads `~/.t3/userdata/model-manifest.json` (tolerates missing/malformed manifest gracefully with empty model list).
  - For each enabled instance, resolves available models from `manifest.providers[driver].models` and `manifest.currentModels[driver]` (if present).
  - Strips all config values; exposes only `{ instanceId, driver, label, enabled, models }`.
- `classifyModelTier(modelSlug)`
  - Deterministic tier classification:
    - `simple`: matches `/\b(flash|mini|haiku|nano|lite|small|fast|low)\b/i` or `-low$`
    - `complex`: matches `/\b(opus|pro|carbon|sol|astra|fable|xhigh|high)\b/i` or `-high$`
    - `standard`: everything else (e.g., `sonnet`, `argon`, `luna`, `medium`, generic models)
- `selectModelForTask({ providers, tier, preferredDriver, routingPolicy })`
  - Validates `tier` in `["simple", "standard", "complex"]`.
  - Default effort by tier: `simple -> "low"`, `standard -> "medium"`, `complex -> "high"`.
  - Priority order:
    1. Explicit `routingPolicy.tiers[tier]` if its `instanceId` exists in enabled `providers` (`source: "policy"`).
    2. Heuristic match across enabled `providers` (optionally filtered/boosted by `preferredDriver`) matching `classifyModelTier(slug) === tier`, preferring `currentModels` order (`source: "heuristic"`).
    3. Graceful fallback to any enabled provider/model (or `{ instanceId, model: null, options }` if a custom provider like `opencode` has no manifest models) (`source: "fallback"`).
  - Returns `{ tier, source, reason, provider: { instanceId, driver, label }, modelSelection: { instanceId, model, options: [{ id: "effort", value }] } }`.
- `buildWorkerBrief({ projectName, coordinatorThreadId, taskTitle, brief, isClaudeWorker, routing, projectRules })`
  - Builds a self-contained worker launch message:
    - Header with `[T3O_WORKER_V1]`, project name, coordinator thread ID, and selected tier/model.
    - Task title & brief body.
    - Reporting protocol:
      - If `isClaudeWorker`: notes that the Claude `Stop` hook notifies the coordinator automatically (do not send a duplicate `t3_thread_send`).
      - If non-Claude worker: embeds the exact `t3_thread_send` JSON call template (`threadId: coordinatorThreadId`, `mode: "queue"`, `clientRequestId: "t3o-report:<slug>:<phase>"`, short 3–5 line status ending with `[T3O_SIGNAL_V1]`) so the worker wakes up the coordinator when finished, blocked, or awaiting approval.

### 3.2 Persistent T3 Routing Policy (`codex/src/t3-routing.mjs`)

Stored separately at `~/.t3-orchestration/t3-routing.json` (`0600`, atomic temp-file + rename) so `~/.t3-orchestration/config.json` remains 100% compatible with `hooks/register.mjs`:

```json
{
  "version": 1,
  "projects": {
    "my-app": {
      "root": "/abs/canonical/path",
      "tiers": {
        "simple": { "instanceId": "antigravity", "model": "gemini-3.8-flash-low", "effort": "low" },
        "standard": { "instanceId": "codex", "model": "gpt-6-luna", "effort": "medium" },
        "complex": { "instanceId": "codex", "model": "gpt-6.1-sol", "effort": "high" }
      },
      "updatedAt": "2026-11-27T20:15:00.000Z"
    }
  }
}
```

Validation rules:
- `projectName`: `^[a-z0-9][a-z0-9-]*$` (<= 64 chars)
- `tier`: `"simple" | "standard" | "complex"`
- `effort`: `"low" | "medium" | "high" | "xhigh"` (reject `"max"` and unknown values)
- `instanceId`, `model`: non-empty strings without control characters.

### 3.3 `t3o-codex` CLI Extensions (`codex/src/cli.mjs`)

Add three subcommands without altering existing commands:
- `t3o-codex t3-providers [--settings <path>] [--manifest <path>] [--json]`
- `t3o-codex t3-route [--project <slug>] [--tier simple|standard|complex] [--driver <driver>] [--set <tier>=<instanceId>:<model>[:<effort>]] [--routing <path>] [--settings <path>] [--manifest <path>] [--json]`
- `t3o-codex t3-brief --project <slug> --coordinator <threadId> --title <title> --brief <text> [--tier simple|standard|complex] [--driver <driver>] [--routing <path>] [--settings <path>] [--manifest <path>] [--json]`

### 3.4 T3 Code Codex Skills & Templates

- `codex/skills/t3-setup/SKILL.md`: Step-by-step setup inside T3 Code to inspect providers (`orchestrator_capabilities` + `t3o-codex t3-providers`), configure `simple`/`standard`/`complex` routing (`t3o-codex t3-route --set ...`), create an idle Codex Coordinator thread, and register it in `~/.t3-orchestration/config.json`.
- `codex/skills/t3-orchestrate/SKILL.md`: Operating rules for a Codex Coordinator inside T3 Code — fail-closed `t3_thread_configure` verification, complexity-based `modelSelection` routing, `t3_thread_launch` with standardized wake-up briefs for any LLM, and `t3_thread_read` evidence verification on `[T3O_SIGNAL_V1]`.
- `codex/templates/t3-coordinator.md` and `codex/templates/t3-worker-non-claude.md`: Ready-to-use reminder templates.
- `docs/codex/t3-multi-llm.md` + `README.md`: Concise operator documentation.
