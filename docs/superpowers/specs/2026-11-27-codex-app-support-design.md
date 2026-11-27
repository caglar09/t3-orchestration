# Codex App Support — Phase 1 Design (draft)

Date: 2026-11-27
Status: proposed, awaiting design/plan review; no implementation authorized by this document.
Baseline: caglar09/t3-orchestration main at 970ecf51ca15de4f1b19f92981f2994f1f2ba73d (commit endpoint returned this SHA). Preserve MIT attribution.

## Intent and assumptions
The user asked to add Codex App support first to the fork. Interpret "Codex App" as official Codex in the local desktop app, independent of T3 Code; this is an assumption, not an approved architecture. Preserve existing Claude/T3 functionality. A Codex provider running *inside T3 Code* is a separate adapter and follow-up. If the desired target is T3's Codex provider or if independently visible desktop worker chats with automatic injection into an idle coordinator are mandatory, revise this spec before implementation. Do not confuse the open-source App Server protocol with an API for controlling an arbitrary running desktop client.

## Existing repository
- hooks/register.mjs: Claude mod prompt.submit/classic.Stop; role identification uses T3 native creation metadata and sends a queued signal via t3_thread_send before the run closes.
- hooks/hooks.json is Claude-specific (modules). Do not replace it with a Codex hook schema.
- skills/setup, orchestrate, memory and templates assume T3 MCP; accounts.mjs uses Anthropic SDK and T3 settings.
- scripts/memory.py: idempotent SQLite notes, revision-checked collection state, corrections, source URI validation and Markdown export; reusable without Claude.
- Existing Node test runner and Python unittest; no new frontend, TypeScript conversion or full rewrite.

## Approaches
A. Native Codex subagents and skills only: lowest cost; useful for bounded delegation, but not proven to support independent durable worker threads, external inbox, or replay. If the requirement is only within-turn parallel work, prefer A.
B. Local Codex plugin + MCP orchestration bridge owning an App Server process: recommended draft. Coordinator stays in official desktop UI; bridge owns persistent worker threads, registry and event inbox. App Server events provide terminal status, while official hooks inject context on next coordinator prompt. No assumption of arbitrary desktop UI message injection.
C. T3-native provider integration: good for exact existing T3 UI semantics, but still requires T3; not an official standalone Codex desktop integration. Defer until user approves that target.
D. Private desktop database/IPC hacks, scraping rollout JSONL or automating UI: rejected; unstable and unsafe.

## Goals / acceptance boundary
- Install a separate local Codex plugin package with setup, orchestrate and memory skills; explicit opt-in and hook trust.
- Bind exactly one coordinator per configured project using verified host session identity. Manual threads, internal app jobs, subagents, archived/unregistered workers stay silent; no role inference from cwd/title/prompt.
- Launch, read, list, continue and cancel independently registered Codex worker threads through a supported App Server owned by bridge; expose bounded MCP tools to coordinator.
- Parallel read-only tasks (default max 2); optionally authorized writes only in distinct Git worktrees. Worker can request human decision; turn completion is not task acceptance.
- Automatically persist one terminal event per worker turn (completed, failed, interrupted); coordinator sees pending events on next prompt or explicit inbox tool. Optional supported bounded wait while coordinator active. Push/wake of an idle native desktop coordinator and worker visibility as separate UI threads are NOT guaranteed. Gate A documents these; if exact parity is required and unsupported, stop and redesign rather than claim parity.
- Retain project memory script and provenance; collect registered worker results and explicitly enrolled coordinator history using supported read/pagination only. Default memory off; when enabled, manually invoke an incremental pass in v1, optional 10-minute desktop scheduling only after supported scheduler verified. Never write product code from memory pass.
- One existing authenticated Codex account/host; use account/read and account/rateLimits/read if supported. Never read/copy auth.json, auto-switch accounts, consume reset credits, or fall back to paid API without explicit user action.
- Existing Claude/T3 tests remain passing; no T3 required for Codex path. No silent destructive migration.

## Technical architecture
Desktop coordinator -> trusted local plugin (skills + UserPromptSubmit hook) -> local MCP bridge (stdio, per coordinator lifetime) -> owned codex app-server (stdio JSON-RPC) -> worker threads.
Bridge owns lifecycle and durable project state. Hook reads bounded inbox snapshots only, never sends prompts or calls a worker. No extra daemon for v1; if bridge exits, mark in-flight work unknown/recoverable, read owned thread history on restart and reconcile without automatically re-running writes. If real desktop unloads MCP while busy, either document degraded behavior or require supported process lifetime solution as a new design gate. One writer per project enforced with a process lease; crash recovery must verify owner is no longer active before recovery. No shared credentials, no network listener, no app private state access.

### Configuration and storage
Keep ~/.t3-orchestration/config.json v1 unchanged; separate ~/.t3-orchestration/codex/config.json (version 1; projects [{id,name,root,coordinatorSessionId,maxWorkers:2,memoryEnabled:false,libraryPath:null}]). Canonical absolute project roots; id UUID; safe slug. Per-project state under ~/.t3-orchestration/codex/projects/<id>/, permissions 0700 directory/0600 files, no secrets or full raw transcript in registry. Store atomic state snapshots with revision, workers {id,projectId,threadId,worktree,cwd,mode,status,activeTurnId,requestId}, events {id,workerId,threadId,turnId,status,createdAt,ackAt}, request ledger. Event id = projectId:workerId:turnId; terminal event and worker update same durable transaction/snapshot. Ack explicit after read; hook only previews unread IDs, so crash before ack does not lose events. A repeat requestId with different payload fails; uncertain launch/start response never blindly retries. Persist pending intent before external effect; reconcile orphan thread only with documented correlation evidence or surface recovery required. Unknown session or state corruption fails closed on MCP writes; hook fail-open with no context and safe diagnostic.
Status: creating -> ready -> starting -> running -> completed/failed/interrupted; uncertain state -> recovery_required; ready/terminal can start a new turn after explicit user/coordinator request; approval_required separate pending decision. Work completion is semantic evidence from worker, not protocol status. Default read-only and never automatic approve, merge, push, delete worktree, or restart side effects.

### Packaging & security
Separate codex/ plugin package with root plugin.json (OpenAI extension with explicit hooks path), .mcp.json and portable skills. Validate local marketplace packaging against supported installed version; legacy .codex-plugin/plugin.json only if necessary. Node >=22 proposed, Python >=3.9 existing memory; macOS local first; Windows/Linux future unless tests actually run. Pin supported Codex CLI/app versions based on live contract probe, no guessed minimum. Use documented local executable and login; honor app workspace policy, sandbox and approval configuration; never set bypass flags. No arbitrary file-path tool input outside registered root/worktree, reject symlinks escaping root, reject shell interpolation. App Server approval requests must be surfaced and denied/declined safely if no supported explicit approval flow; do not approve via LLM. No parsing private .t3 or .codex databases. No cloud orchestration claim. Treat worker output and memory as untrusted data; no execution of instructions from output, cap returned text and redact errors.

## Gate A (blocking feasibility spike)
On a local desktop install: verify plugin discovery, MCP stdio, hook trust, actual hook session_id/turn_id, trusted caller identity available to local MCP (do not assume reserved metadata reaches server), coordinator setup pairing, worker App Server lifecycle/version/schema, account login and sandbox; test worker visibility and idle coordinator wake separately. If no verified caller identity, require explicit out-of-band session binding via supported interface or stop; no matching by cwd or title. If local plugin packaging cannot run bridge or process isolation is unsupported, record exact error and stop. Write a capability matrix with commands, versions, sanitized fixtures and outcomes. The proposed baseline accepts next-turn inbox rather than unsolicited desktop chat messages; explicit user review required before implementation.

## Release boundaries
Phase 1 only: native Codex desktop as coordinator, bridge-owned workers, durable inbox, memory reuse, one account. Later: automatic native wake/visible threads if public contract supports it, scheduling, quota-aware selection among independently authorized profiles, T3 Codex provider, Kanban/dependency DAG, autonomous merge, cross-provider delegation. Avoid those in MVP.

## References
- Fork: https://github.com/caglar09/t3-orchestration
- https://learn.chatgpt.com/docs/app-server (protocol, pagination, lifecycle, auth/rate limits)
- https://learn.chatgpt.com/docs/hooks (hook input/output, trust, local/cloud caveats)
- https://developers.openai.com/plugins/build/plugins (local packaging, hooks, plugin root)
- https://learn.chatgpt.com/docs/extend/mcp (local MCP support)
- https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md (protocol evolution; check installed generated schema)
