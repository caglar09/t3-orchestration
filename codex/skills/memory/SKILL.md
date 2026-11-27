---
name: memory
description: In Codex desktop/CLI, run one optional manual incremental memory pass for a configured project using codex/src/memory.mjs and scripts/memory.py. Disabled by default; never edits product code or launches workers.
---

# Long-term memory pass (Codex, optional)

Run this skill **only** when the user explicitly requests a memory pass AND the project in
`~/.t3-orchestration/codex/config.json` has `memoryEnabled: true` and a valid canonical `libraryPath`.
If `memoryEnabled` is `false` (the default) or `libraryPath` is `null`, stop immediately and inform
the user without reading threads or writing files.
MIT License — Copyright (c) 2026 sanztheo.

## Strict boundaries

- **Disabled by default:** never enable memory or create a library automatically.
- **No scheduling in MVP:** runs strictly as an explicit manual incremental pass (`memory_pass`). Do not register background timers, daemons, or cron jobs.
- **Read-only toward code:** never edit product code, never call `worker_launch` / `worker_continue` / `worker_cancel`, and never steer active work.
- **Sourced evidence only:** every recorded note must reference either `https://` or a canonical `file://` URI pointing to a sanitized evidence artifact inside `<libraryPath>/evidence/` (never invent `codex://` deep links, never copy raw transcripts, secrets, emails, phone numbers, tokens, or private Codex databases).

## Incremental pass procedure

1. Verify project config in `~/.t3-orchestration/codex/config.json`: confirm `memoryEnabled === true`,
   `libraryPath` is canonical and symlink-free, and check `<libraryPath>/MEMORY.md` and `<libraryPath>/POLICY.md`.
2. Inspect current memory state via `scripts/memory.py`:
   `python3 <repoRoot>/scripts/memory.py --library "<libraryPath>" status`
   and `state-get "codex-memory:<projectId>"`.
3. Run bounded incremental collection via the read-only CLI (`node <pluginRoot>/src/memory.mjs --project <name-or-id> [--limit 20]`, which uses `readSnapshot` without acquiring the writer lease and invokes `collectMemory`), which:
   - collects only from registered project worker threads (`state.workers`) and the explicitly enrolled `coordinatorThreadId` (respecting `excludedThreadIds`),
   - redacts secrets/PII and omits raw transcripts/item arrays,
   - writes `0o600` sanitized evidence JSON files under `<libraryPath>/evidence/` with `{ threadId, turnId }` provenance and `file://` source URIs,
   - records observations via `scripts/memory.py` (`shell: false`, JSON on stdin), and
   - updates the pagination cursor with CAS `expected_revision` only after receipts are durable.
4. Review pending notes (`scripts/memory.py --library "<libraryPath>" pending`), search existing notes (`search`) to avoid duplicates, use `supersedes` for corrections, and `publish <id>` only for durable decisions, pitfalls, contracts, or procedures (skip one-off approvals or progress noise).
5. Update topic pages and `<libraryPath>/MEMORY.md` links when needed; never hand-edit generated `NOTES.md`.
6. Report briefly to the user: notes recorded/published, evidence paths written, whether pagination is `complete` or paused at `nextCursor`, and any missing/unreadable sources.
