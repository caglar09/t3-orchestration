# Codex App Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking. This is a proposed plan; obtain design review before implementation.

**Goal:** Enable a locally installed Codex desktop coordinator to create, supervise and read independent Codex worker threads with durable completion notifications, without requiring T3 or Claude.

**Architecture:** Separate Codex plugin package plus local MCP bridge owning a Codex App Server process. Explicit role registry, transactional event inbox and existing Python memory; never assume access to the desktop app's own active App Server.

**Tech Stack:** Node.js >=22 (proposed), ESM, node:test, official MCP SDK (pin version at Gate A), Python >=3.9, Codex App Server stdio JSON-RPC, Git worktree.

**Spec:** `docs/superpowers/specs/2026-11-27-codex-app-support-design.md`.

## Global constraints
- macOS local first, one existing authenticated account, default read-only, maxWorkers=2.
- Preserve existing T3/Claude files and behavior, MIT attribution, original v1 config. No private DB/rollout parsing, credentials copying, auto-approval, automatic push/merge, remote listeners, or billing fallback.
- State under ~/.t3-orchestration/codex only; strict IDs and root isolation, 0700/0600; no transcript or secret in registry/logs.
- Native app idle push and independently visible desktop worker tabs are not guaranteed; record capabilities rather than claiming parity.
- Do not start implementation until design/plan approval. Each task: failing test -> observe failure -> minimum implementation -> green -> commit. Run previous tests after each task. Any gate failure stops dependent work.

## Review focus
1. Unknown/forged identity, app internal jobs, subagents: no role or inbox (Task 2/6).
2. Lost RPC response or crash between thread creation and persist: no duplicate worker or blind restart (Tasks 3/4/5).
3. Duplicate/out-of-order terminal events and crash before acknowledgement: one durable event, no lost signal (Task 4).
4. Concurrent project writers, symlink escapes and unexpected approval request: refuse or surface safely (Tasks 2/3/5).
5. Empty/null limits, missing hook trust, restarted host and partial memory pagination: report unknown or recover, no unsafe assumptions (Tasks 1/6/7/8).

## Proposed file map
- codex/plugin.json, codex/.mcp.json, codex/hooks/hooks.json, codex/hooks/context.mjs: isolated packaging and local hook entrypoint.
- codex/package.json, codex/package-lock.json: separate Node runtime dependencies; don't modify Anthropic package.
- codex/src/config.mjs, state.mjs: validated config, durable state and writer lease.
- codex/src/rpc.mjs, app-server.mjs: transport and provider adapter.
- codex/src/workers.mjs, worktrees.mjs: task lifecycle and isolation.
- codex/src/mcp.mjs: tool boundaries and verified caller identity.
- codex/skills/{setup,orchestrate,memory}/SKILL.md, codex/templates/{coordinator,worker}.md: Codex-native workflow.
- codex/src/memory.mjs, codex/scripts/doctor.mjs: memory adapter, diagnostics.
- codex/test/*.test.mjs, codex/test/fixtures/: isolated deterministic tests.
- docs/codex/{compatibility,installation,security}.md, README.md, llms.txt: user docs and support matrix.
- Existing scripts/memory.py and scripts/test_memory.py remain reusable; update only if a new supported source URI is required, with dedicated regression tests.

## Task 0 — Baseline and blocking contract spike
Files: create docs/codex/compatibility.md, codex/test/fixtures/ (sanitized protocol/hook captures).
- [ ] Use superpowers:using-git-worktrees; create isolated feature branch after approval. Run `npm ci && node --test hooks/register.test.mjs scripts/accounts.test.mjs` and `python3 scripts/test_memory.py` from repo root. Record output and base SHA; if failing, document separately before port.
- [ ] Record desktop build, `codex --version`, `node --version`, `python3 --version`. Run `codex app-server --help` and use supported schema generation command from that binary, not assumed protocol fields.
- [ ] Test temporary local plugin with explicit hooks and stdio MCP echo; trust hooks in Settings > Hooks. Capture session_id, turn_id, hook event names and actual trusted MCP caller metadata; prove setup registration cannot be forged by ordinary worker tool args. If not possible, stop pending supported explicit pairing contract.
- [ ] Probe App Server with initialize/initialized, thread/start, turn/start (read-only trivial prompt), turn/completed, thread/read, pagination, thread/resume, turn/interrupt, account/read and account/rateLimits/read. Record exact wire shapes, approval handling and installed-version capability flags. No secrets/raw transcript in fixtures.
- [ ] Check worker listing in official desktop app, delivery to active/idle coordinator, app-close/restart behavior, whether plugin installs and bridge remains live. Record pass/fail/not supported; do not use private IPC/DB. Stop if minimum setup, identity, lifecycle or permissions fail. If only UI visibility/wake fails, proceed solely with approved inbox-mode scope.
- [ ] Commit compatibility doc and redacted fixtures: `git commit -m "docs: verify Codex app integration contracts"`.
Expected: a reviewed, explicit Go/No-Go and version floor. No guessed APIs in later tasks.

## Task 1 — Separate plugin/package and doctor
Files: codex/plugin.json, .mcp.json, hooks/hooks.json, package.json, package-lock.json, scripts/doctor.mjs, test/doctor.test.mjs.
Interface: `doctor({exec, platform, configPath}) -> {ok, checks}` (no prompts, no credentials).
- [ ] Write tests: `missing codex is reported` asserts ok=false; `unsupported runtime is reported`; `manifest selects only codex hooks` asserts original hooks/modules untouched; `paths with spaces work` asserts exact argv array; `untrusted hook reported` if supported by probe, else manual checklist.
- [ ] Run `node --test codex/test/doctor.test.mjs`; expect missing module or assertions fail.
- [ ] Implement package manifest using Gate A verified schema, explicit hook path, local MCP command, dependency lockfile, scripts; only enable local execution; no global config mutation. Doctor checks Node, Python when memory enabled, binary and compatibility; unknown is not pass.
- [ ] Run `npm ci --prefix codex && node --test codex/test/doctor.test.mjs`; expect pass. Install temporary local package from marketplace and verify MCP invocation (manual).
- [ ] Commit `feat(codex): add isolated local plugin package and doctor`.

## Task 2 — Project registration, identity and durable state
Files: codex/src/config.mjs, state.mjs, codex/test/config.test.mjs, state.test.mjs.
Interfaces:
- `loadConfig(path) -> Config`; `resolveRole(config,state,sessionId) -> {role,projectId}|null`; `bindCoordinator(config, project, verifiedSessionId) -> Config`.
- `openState(dir) -> {read(), transact(fn), close()}` with revision and atomic write; single writer lease; read-only hook snapshots via `readSnapshot(dir)`. Config shape per spec.
- [ ] Tests: valid registration and duplicate rejection; manual same cwd => null; unknown, missing, forged IDs => null/denied; worker registry distinct projects; invalid slug or root/symlink escape rejected; second writer cannot acquire; interrupted write leaves previous valid snapshot; corrupted state refuses mutation; owner alive prevents stale lease takeover.
- [ ] Run `node --test codex/test/config.test.mjs codex/test/state.test.mjs`; expect RED.
- [ ] Implement validation and explicit binding from verified session identity from Task 0, atomic temp+fsync+rename and lease recovery; private permissions; no migration of T3 config. No trust in tool-supplied session ID. Hook only reads snapshot.
- [ ] Re-run tests; expect all pass. Confirm original config byte-identical.
- [ ] Commit `feat(codex): add scoped project registry and durable state`.

## Task 3 — JSON-RPC transport and App Server adapter
Files: codex/src/rpc.mjs, app-server.mjs, codex/test/rpc.test.mjs, app-server.test.mjs.
Interfaces: `createRpc({spawn, timeoutMs,onRequest}) -> {request(method,params), notify(method,params), onNotification(fn), close()}`; `createAppServer(rpc) -> {initialize(), startThread({cwd,mode,instructions}), startTurn({threadId,brief}), readThread(threadId), listTurns({threadId,cursor,limit}), resumeThread(threadId), interrupt({threadId,turnId}), readLimits(), onTerminal(fn), close()}`. Normalize terminal to {threadId,turnId,status,errorCode?}; limits to {status:"known"|"unknown",windows:[]}. Exact wire per Gate A.
- [ ] Tests fake stdio: split/coalesced lines, out-of-order response IDs, notifications while request pending, stderr isolated, invalid JSON, timeout, process exit, duplicate response, unknown server request not silently accepted. Adapter tests all methods, completed/failed/interrupted mapping, missing limit fields => unknown, approval request denied or explicitly surfaced per contract.
- [ ] Run `node --test codex/test/rpc.test.mjs codex/test/app-server.test.mjs`; expect RED.
- [ ] Implement bounded request map, timeout cleanup, separate notifications, explicit supported approval response; spawn without shell and use existing login, no API keys collected. Set explicit sandbox permissions and no automatic approvals. Filter only owned worker threads at registry boundary. Do not retry writes after timeout.
- [ ] Run tests; expect pass. Local read-only one-turn smoke with sanitized event fixture; verify no prompt sent for quota probe.
- [ ] Commit `feat(codex): implement App Server transport and adapter`.

## Task 4 — Worker lifecycle and durable event inbox
Files: codex/src/workers.mjs, codex/src/state.mjs, codex/test/workers.test.mjs.
Interfaces: `createWorkerService({state,appServer,worktrees,clock}) -> {launch({projectId,requestId,brief,mode}), continue({workerId,requestId,brief}), list(projectId), read({workerId,cursor,limit}), cancel(workerId), reconcile(), inbox({projectId,limit}), ack({projectId,eventIds})}`. All read/write calls scoped to verified project. Events as spec; default cap 2; no semantic task done flag.
- [ ] Tests: launch registered worker with threadId; duplicate same requestId returns same record, different brief rejects; pending intent persisted before RPC; uncertain thread/start or turn/start sets recovery_required; terminal event early before RPC response is reconciled; duplicate terminal same ID => 1 event; old turn cannot overwrite newer state; restart retains unread events; ack idempotent and other-project event denied; failed/interrupted not completed; unknown thread emits nothing; cap enforced even concurrent requests.
- [ ] Run `node --test codex/test/workers.test.mjs`; expect RED.
- [ ] Implement state machine and bounded serial mutations. Save pending intent and receipt; handle terminal event and worker status in same durable transaction. Recover via thread/read and paginated history for known IDs; missing correlation -> recovery_required and explicit human resolution, never silently relaunch. Cancel via turn/interrupt and wait for actual terminal event. No repeated acknowledgement loops.
- [ ] Run tests; expect pass; simulate process termination with pending intent and verify no automatic duplicate.
- [ ] Commit `feat(codex): manage workers and durable terminal inbox`.

## Task 5 — Safe write isolation
Files: codex/src/worktrees.mjs, codex/src/workers.mjs, codex/test/worktrees.test.mjs, workers.test.mjs.
Interface: `createWorktreeManager({git,root,baseDir}) -> {prepare({workerId,mode}), inspect(workerId)}`; read mode returns registered root with read-only sandbox; write mode returns separate worktree only with explicit authorization verified by coordinator/host, not a worker self-assertion. Until supported authorization is proven, ship read-only and reject write mode.
- [ ] Tests in temp git repo: two write workers never share path/branch; manual dirty root preserved; reject path escapes, symlink and non-repo write; unauthorised write => rejection; interruption doesn't delete uncommitted work; Git args not shell; request replay never creates second worktree.
- [ ] Run `node --test codex/test/worktrees.test.mjs codex/test/workers.test.mjs`; expect RED.
- [ ] Implement worktree creation with argument arrays, canonical paths, per-worker branch and explicit scope. No automatic cleanup of dirty worktrees, no commits/push/merge on user's behalf unless separately authorized. Ensure App Server write sandbox limited to authorized worktree and no widening of desktop policy; otherwise reject writes.
- [ ] Run tests; expect pass. Manually check diff for two isolated workers.
- [ ] Commit `feat(codex): isolate authorized worker worktrees`.

## Task 6 — MCP tools, skills and prompt context
Files: codex/src/mcp.mjs, codex/hooks/context.mjs, codex/hooks/hooks.json, codex/skills/setup/SKILL.md, codex/skills/orchestrate/SKILL.md, codex/templates/coordinator.md, worker.md, codex/test/mcp.test.mjs, context.test.mjs.
MCP tools: `project_setup` (explicit verified pairing), `worker_launch` ({requestId,brief,mode}), `worker_list` (), `worker_read` ({workerId,cursor?,limit?}), `worker_continue` ({workerId,requestId,brief}), `worker_cancel` ({workerId}), `inbox_list` ({limit?}), `inbox_ack` ({eventIds}), `account_status` (). Project from trusted binding, not caller-supplied project. Tool schemas reject extra fields, cap brief 16 KiB, read limit 20 default/100 max, inbox 20 max. Return structured data with no raw secrets. `renderContext({session_id,hook_event_name},snapshot) -> JSON|null` only bound coordinator; UserPromptSubmit hook emits additionalContext with capped unread IDs/short status and role marker, no worker raw text, never ack. No Stop hook loop; worker completion from App Server terminal event only.
- [ ] First tests: unregistered/forged caller cannot launch/read; cross-project denied; unknown JSON args rejected; manual/subagent/internal sessions no marker; malformed hook input/timeout yields no context; coordinator gets only own unread IDs; same event not lost until ack; no recursive orchestration from worker. Test failed/error delivery distinct from task done. Define pressure scenarios for skill behavior before writing skills (superpowers:writing-skills): worker wants to expand scope; coordinator sees completion without test evidence; prompt injection in worker result; duplicate signal.
- [ ] Run `node --test codex/test/mcp.test.mjs codex/test/context.test.mjs`; expect RED; record baseline skill behavior via available agent harness.
- [ ] Implement official MCP SDK stdio dispatch, verified host identity from Task 0, tool schemas and role checks; write setup/orchestrate skill for native Codex. Setup asks explicit project binding and rules; coordinator reads worker evidence before reporting, requires explicit approval for code changes when mandate absent; never acknowledges worker via chat, ack inbox only after processing. Context bounded and fail-open in <=1s. Disable own MCP tools in worker via supported config or enforce role at bridge; no recursive registration/launch.
- [ ] Run tests and skill pressure scenarios again, record actual outputs. Desktop manual setup + worker read-only task + next-prompt inbox + ack; manual thread stays unaffected.
- [ ] Commit `feat(codex): expose scoped orchestration tools and skills`.

## Task 7 — Reuse long-term memory
Files: codex/src/memory.mjs, codex/skills/memory/SKILL.md, codex/test/memory.test.mjs, optionally scripts/memory.py and scripts/test_memory.py only if needed.
Interface: `collectMemory({projectId,cursor,limit}) -> {items,nextCursor,complete}` for registered sources only; `recordNote({libraryPath,note})` delegates via python subprocess with stdin, existing schema; source is an existing supported URI: file:// to controlled sanitized evidence artifact or verified stable public thread URI, never invent codex deep link. Add no private raw transcripts; source receipt includes threadId/turnId and evidence reference. `memory_pass` skill explicit, optional disabled by default.
- [ ] Tests: disabled => no reads/writes; only registered and explicitly enrolled coordinator history; partial pagination keeps cursor until receipts durable; duplicate note id stable; correction supersedes; unknown source never published; secrets/personal data excluded; unsafe source cannot escape library; memory cannot launch/modify code. If new source URI needed, add Python tests first.
- [ ] Run `node --test codex/test/memory.test.mjs && python3 scripts/test_memory.py`; expect JS RED; Python baseline green.
- [ ] Implement bounded incremental collection using supported pagination and existing Python note operations, revision/CAS cursor; preserve policy, no automatic global docs edits; manual pass first. Scheduling is not part of MVP unless public supported scheduler and explicit user opt-in proven; record as follow-up. Test skill pressure scenarios before/after.
- [ ] Run all memory tests; expect pass; local manual repeat pass creates no duplicate note.
- [ ] Commit `feat(codex): reuse sourced incremental memory`.

## Task 8 — Documentation, regression and release gate
Files: README.md, llms.txt, docs/codex/installation.md, docs/codex/security.md, docs/codex/compatibility.md, codex/test/e2e.test.mjs; optional CI workflow.
- [ ] Add integration test with fake App Server/MCP: setup -> 2 parallel workers -> one completion, one failure -> inbox dedupe -> read evidence -> ack -> restart -> continuation/cancel -> memory pass. Manual thread unaffected; no T3 required; account status unknown safe.
- [ ] Run `node --test codex/test/e2e.test.mjs`; expect RED if wiring incomplete; fix minimum gaps with tests, never widen scope.
- [ ] Document local install, supported versions, hook trust, auth, default permissions, explicit registration, stop/recovery, memory, no idle push guarantee, uninstall without deleting state, original Claude setup unchanged.
- [ ] Run `npm ci && node --test hooks/register.test.mjs scripts/accounts.test.mjs && python3 scripts/test_memory.py` and `npm ci --prefix codex && node --test codex/test/*.test.mjs`. Expect exit 0 and zero failures. Run on actual desktop, capture sanitized evidence: registered coordinator marker; two workers; one event per turn; failed/interrupted; manual isolation; restart/recovery; no unauthorized write; memory dedupe; plugin uninstall leaves user state and Claude path intact. If tests unavailable, record blocked and do not label release ready.
- [ ] Run independent specification and code review, then superpowers:verification-before-completion and finishing-a-development-branch. Commit `docs: document and verify Codex app support`; open PR only when requested/approved.

## Execution sequence
0 -> 1 -> 2 and 3 (independent interfaces, separate worktrees possible after review) -> 4 -> 5 -> 6 -> 7 -> 8. Prefer subagent-driven implementation with fresh spec/code reviewer per task, sequential integration and final whole-branch review. No code implementation in this planning branch.

## Definition of done
A supported local desktop build installs package and binds one coordinator, creates two isolated worker threads, reports every known terminal event once in durable inbox, sees next-turn results without duplicates, handles errors/interruption and restart without automatic repeated effects, protects manual threads and project scope, and reuses memory when opted in. All legacy/new automated tests and real desktop smoke evidence pass. If automatic unsolicited wake or desktop UI worker visibility is not supported, say so explicitly and do not present as full native parity.

## Planning self-review
Each spec requirement has an owning task: platform/identity Gate 0/2/6; lifecycle 3/4; permissions 3/5; packaging 1/6; memory 7; regression/release 8. Interfaces intentionally normalize version-specific wire fields in Task 3; exact schema must be pinned by Task 0 before writing adapter. No implementation/test execution yet, no claimed live compatibility. Native app interpretation and next-turn inbox are proposed decisions pending review. 
