# TASK-00 — Codex App compatibility and contract verification

Date: 2026-11-27
Status: IN PROGRESS — owned-server lifecycle, sequential cross-process idle wake, API restart persistence and refreshed desktop visibility PASS (user-reported, CLI 0.171.0 / App 26.1120.50957); live desktop synchronization FAIL (restart required in observed run); shared endpoint, trusted identity and other gates pending. **NO-GO for TASK-01**.
Base: main `970ecf51ca15de4f1b19f92981f2994f1f2ba73d`; planning branch at `39317f06e29cfd13b35667cc5401700d139a2b1a` before this task. Source review and local test runbook only; no product implementation.

## Evidence actually collected
- GitHub compare confirmed planning branch is two commits ahead of main before TASK-00, containing only design and plan. Re-read TASK-00 in the saved plan.
- Execution environment: Linux x86_64; Node v22.16.0; Python 3.13.5; Git 2.47.3. `command -v codex` returned no executable. `git ls-remote https://github.com/caglar09/t3-orchestration.git refs/heads/docs/codex-app-support-plan` failed (exit 128: Could not resolve host: github.com).
- No authenticated local Mac desktop, installed CLI schema or desktop version available in this execution environment. Repository baseline test suite could not be run because checkout failed. No claim of a clean baseline. No live hooks, MCP, App Server turns or UI observations occurred in that execution environment. Subsequent user-run evidence is recorded separately below.
- Official documentation checked on this date. Public contract evidence is not a runtime PASS. Minimum version remains UNVERIFIED.

## Offline probe verification
The companion probe was syntax-checked with `python3 -m py_compile` (exit 0). Running with no installed Codex returned `BLOCKED: FileNotFoundError` (exit 1), as intended. Both account-only and --live paths executed against a locally written synthetic stdio test double, returning exit 0. The mock emitted terminal notifications before turn/start replies, and the probe correlated them correctly. It exercised two turns, toolOutput request construction, read, two-page cursor and resume; no real inference, real account access, permissions or desktop functionality was tested. The mock is deliberately not a protocol oracle and returns synthetic responses; it is NOT a live capture. The uploaded probe blob SHA `56f22aa683ef3462a667089922ef2cf970a908bd` matches the locally executed file. The mock blob SHA `72da13b7b2babe8e512526b3d24a996a0af16b6b` matches the test double.

Reproduce offline (no Codex login or network required):
```sh
python3 -m py_compile docs/codex/probe_app_server.py
MOCK="$(mktemp)"
cp docs/codex/fixtures/mock_app_server.py "$MOCK"
chmod 700 "$MOCK"
python3 docs/codex/probe_app_server.py --codex "$MOCK"
python3 docs/codex/probe_app_server.py --codex "$MOCK" --live
rm "$MOCK"
```
Expected: both probe runs exit 0; no mock email in output. These tests are not a substitute for the repository baseline or macOS Gate A.

## User-run live evidence — Codex CLI 0.171.0
Source: terminal output supplied by the repository owner in this conversation, not an independently executed test in the assistant environment. Local Node/Python versions, generated schema, shell exit codes and baseline suite remain unreported. Desktop build and UI results are recorded separately below. CLI 0.171.0 is a tested version, not a minimum supported version.

Commands and sanitized output:
```text
codex --version
codex-cli 0.171.0
python3 docs/codex/probe_app_server.py
PASS RPC initialize
PASS RPC account/read
PASS RPC account/rateLimits/read
rate-limit response present: True
Account-only probe; no threads created.
python3 docs/codex/probe_app_server.py --live
PASS RPC initialize
PASS RPC account/read
PASS RPC account/rateLimits/read
rate-limit response present: True
PASS RPC thread/start
Local synthetic thread ID: [REDACTED]
PASS RPC turn/start
terminal status: completed
PASS RPC turn/start
terminal status: completed
PASS RPC thread/read
PASS RPC thread/turns/list
PASS RPC thread/turns/list
PASS RPC thread/resume
Owned-server probe finished. Desktop visibility, identity, idle cross-client wake and restart are still manual gates.
```

Interpretation: the owned stdio server accepted initialization, ChatGPT account check, rate-limit read, persistent thread creation, first text turn and second toolOutput-only turn; both emitted completed terminal notifications. The probe observed a nonempty nextCursor and successfully requested a second page, then resumed the thread in the same process. This does not validate semantic response contents, exact approval/sandbox enforcement, restart recovery, failed/interrupted events, cross-client delivery, busy-turn queuing or official desktop rendering. It also does not establish that the app exposes a shared endpoint. No real thread identifiers or account details retained.

## User-run native desktop visibility evidence
Date: 2026-11-27. CLI 0.171.0; official Codex App build 26.1120.50957 (user-reported).
- The synthetic persistent thread created by the independently owned stdio App Server became visible in the native sidebar after refresh.
- Both turns were visible when opening the conversation.
- The thread remained visible after closing and reopening Codex App.
- The owner also supplied a screenshot in the conversation as supporting evidence; the image is not committed to avoid exposing local identifiers or unrelated chats.

Result: PASS for refreshed native visibility, two-turn history display and desktop restart persistence in this tested environment. Immediate sidebar visibility, real-time stream synchronization, simultaneous ownership, API restart recovery, external wake of an already open desktop coordinator, supported shared endpoint, plugin/MCP trust and verified identity remain unproven. Do not infer a shared live App Server from discoverability of persisted sessions. No minimum version claim.

The sequential cross-process follow-up has now been performed; see the evidence below. No concurrent writes to a running thread were tested.

## User-run sequential cross-process coordinator wake evidence
Date: 2026-11-27; same reported CLI 0.171.0 and desktop build 26.1120.50957. Repository owner supplied terminal output and a supporting screenshot; screenshot not committed because it includes unrelated projects/conversations. Synthetic nonce omitted.

Command: `python3 docs/codex/probe_coordinator_wakeup.py --live`; interactive confirmation WAKE.
Sanitized evidence:
```text
PASS RPC initialize
PASS RPC account/read
PASS RPC thread/start
PASS RPC turn/start
terminal status: completed
PASS RPC thread/turns/list
PASS server A closed; coordinator persisted.
[synthetic coordinator opened in desktop; WAKE confirmed]
PASS RPC initialize
PASS RPC account/read
PASS RPC thread/read
PASS RPC thread/turns/list
PASS fresh server read persisted coordinator.
PASS RPC thread/start
PASS RPC turn/start
terminal status: completed
PASS RPC thread/turns/list
PASS independent worker completed.
PASS RPC thread/resume
PASS RPC thread/turns/list
Sending one toolOutput wake; watch the open desktop chat.
PASS RPC turn/start
terminal status: completed
PASS RPC thread/turns/list
PASS external wake: new completed turn with exact reply marker.
PASS RPC initialize
PASS RPC account/read
PASS RPC thread/turns/list
PASS fresh server sees exactly two completed coordinator turns.
API probe complete.
No shared desktop endpoint or simultaneous-write safety is established by this probe.
```

- PASS: server A closed, server B read and resumed the same synthetic idle coordinator, completed an independent worker and delivered a toolOutput-only wake that produced the exact unique response marker. Server C observed exactly two completed coordinator turns.
- PASS: desktop screenshot shows initial and wake markers, and the distinct worker in Recents after reopening the app.
- FAIL for live desktop synchronization in this run: owner reports new session appeared only after closing and reopening Codex App. In-place refresh alone and live streaming were not separately established.
- This verifies sequential cross-process execution and persistence, not safe simultaneous ownership, shared server attachment, busy-turn queuing, crash recovery after lost responses, or exactly-once delivery under retries. The coordinator was created by the probe, not an arbitrary existing desktop-created thread. The UI symptom is consistent with stale client state or independent server event streams, but root cause is not proven.

Decision: do not change the architecture or claim full native parity yet. Next run baseline and installed CLI schema/help checks; verify documented shared transport with two clients on a disposable server; separately establish whether the official desktop supports attachment to that server, and then test identity/permissions. If no supported live desktop attachment exists, consider an explicit degraded UI mode with durable inbox and externally executed turns only under exclusive ownership, or an independent UI using a shared owned server. No private IPC, storage mutation, or automatic app restart workaround. TASK-01 remains NO-GO pending required gates and architecture review.

## Capability matrix

| Capability | Documentation result | Runtime result / gate |
| --- | --- | --- |
| Local marketplace / plugin | root plugin.json; extensions.com.openai hooks; local installation; user trust separate | BLOCKED: install and trust on desktop |
| MCP local stdio | command/args/env/cwd; lazy startup can defer connection | BLOCKED: real desktop calls, connection lifetime |
| Hook context | UserPromptSubmit with session_id, turn_id; additionalContext | BLOCKED: capture IDs and output on actual build |
| Native MCP hook | type:mcp_tool; event-field expansion; existing connection only; no SessionEnd support | BLOCKED: check support and caller isolation |
| Reliable coordinator identity | thread.sessionId and thread.id are distinct for forks; subagent hooks use parent session ID | BLOCKED: trusted thread/call identity required; no session-only authorization |
| App Server handshake / schema | stdio JSONL; initialize + initialized; generate-json-schema, generate-ts | PASS (user-run owned stdio handshake on 0.171.0); schema generation pending |
| Worker lifecycle | thread/start, turn/start, turn/completed (completed/interrupted/failed), thread/read, thread/resume, turn/interrupt | PARTIAL PASS: start, completed turns, read and sequential fresh-process resume; interrupt/failure, permissions and exact wire captures pending |
| History / pagination | thread/turns/list, thread/items/list; thread/read metadata; opaque cursors | PARTIAL PASS: thread/turns/list two pages and history persisted across A/B/C; items pagination and crash recovery pending |
| Account / limits | account/read, account/rateLimits/read; account may be null; secondary may be null | PASS (user-run): ChatGPT login check and rate-limit response present; exact nullable-field schema pending |
| Worker discoverability | persistent root threads; thread/list sourceKinds includes appServer; default filter interactive sources only | PASS (user-reported): sidebar after refresh, worker and coordinator visible after reopen; immediate refresh-free discovery FAIL in wake run; explicit thread/list probe pending |
| Coordinator notification | turn/start with toolOutput (empty input); active turn queues output; thread/inject_items persists context but does not start a turn; turn/steer requires active turn | PASS for sequential external idle wake of probe-owned coordinator with exact marker; FAIL for live desktop synchronization (restart required); shared-server delivery, busy queue, dedupe pending |
| Shared server access | documented Unix socket and remote CLI; TCP WebSocket experimental/unsupported | BLOCKED: supported desktop-owned/shared server endpoint, permissions, attachment semantics |
| App lifetime / restart | resume by thread ID, no automatic duplicate turn | PARTIAL PASS: sequential fresh-process resume/read and desktop reopen persistence; crash recovery, MCP lifetime and simultaneous ownership pending |
| Native scheduler | not assessed in this execution; defer | BLOCKED / optional |
| Legacy baseline | commands specified in plan | BLOCKED: checkout DNS failure |

## Findings that change the proposed design
1. Native MCP tool hooks now exist: the original README's stated limitation (a Codex hook cannot both inspect T3 metadata and call a T3 tool) needs re-evaluation relative to current docs; MCP invocation is now documented, but the complete T3-specific workflow is not verified. Test a trusted hook on UserPromptSubmit and Stop with event field templates. The server must already be connected, so lazy startup and fail-open behavior matter. A model-callable tool accepting an arbitrary session_id is **not** trusted identity; direct invocation can forge the argument. Require a distinct trusted channel, connection-level proof or explicit host-side pairing. Never rely on hook failure to enforce server authorization.
2. Session IDs are not sufficient to distinguish root/fork/subagent in current App Server documentation. A fork may share the root session ID, and subagent hooks report the parent session ID. Store coordinatorThreadId separately and prove the exact caller is the designated root. Reject ambiguity. Test same cwd, manual, fork, native subagent, app-internal job and forged IDs.
3. A shared App Server is more promising than assuming independent processes can push into the desktop. Public Unix socket transport exists, but docs do not establish that the official desktop exposes its own server to arbitrary local plugins or that desktop can attach to our server. Only use a supported endpoint the user explicitly configured, not process inspection/private IPC. Test two clients on an explicitly owned Unix socket first, then separately test official desktop support.
4. Prefer investigating `turn/start` with `toolOutput` over synthetic user messages. The documented contract starts a turn from a tool result, queues output when a regular turn is active, and does not mix nonempty user input. `thread/inject_items` is context-only, `turn/steer` requires an active expectedTurnId. Do not assume a delivery idempotency key exists; keep durable inbox/outbox with event id, correlate history before retry, never re-send after uncertain response blindly. Use only an enrolled synthetic coordinator in probes.
5. `thread/list` defaults to interactive sources (cli/vscode). Explicit `sourceKinds:["appServer"]` is required for a meaningful positive discovery probe; it does not prove sidebar filtering. Use persistent non-ephemeral workers and test separately whether desktop lists them and can safely reopen them.
6. Keep design and plan unchanged until live contract results are reviewed. If shared server, trusted identity and native wake prove supported, propose an ADR revising the separate-owned-bridge architecture. Otherwise retain durable next-prompt inbox only if identity and core lifecycle pass. If identity cannot be verified, stop rather than ship an unsafe port.

## Local verification runbook

Use a disposable checkout and synthetic chats. Never change existing user/project settings without consent; do not read credential files, private databases or raw rollout logs. No auto-approval, no external calls in probe prompts, no secrets in committed evidence. Inference can consume existing plan quota/credits; only run inference after confirming the intended account and model.

### A. Legacy baseline and installed versions
From the repository:
```sh
git fetch origin
git worktree add --detach ../t3o-task00 origin/docs/codex-app-support-plan
cd ../t3o-task00
git rev-parse HEAD
npm ci
node --test hooks/register.test.mjs scripts/accounts.test.mjs
python3 scripts/test_memory.py
codex --version
node --version
python3 --version
codex app-server --help
SCHEMA_DIR="$(mktemp -d)"
codex app-server generate-json-schema --out "$SCHEMA_DIR/json"
codex app-server generate-ts --out "$SCHEMA_DIR/ts"
```
Record desktop version via About, CLI version separately, exit codes and test counts. Compare generated methods and exact field types to documentation, including permission policy and notification shapes. Do not commit entire generated schema or raw account data. If commands differ, use installed CLI help; record differences.

### B. Isolated App Server
Run the companion `python3 docs/codex/probe_app_server.py` for handshake/account-only checks, then (explicit opt-in, may use quota) `python3 docs/codex/probe_app_server.py --live`. It opens a disposable empty cwd and only creates its own test thread. Record whether it completes, whether the toolOutput starts a second turn, whether pagination, read and resume work; test interrupt separately as below. It prints only sanitized summaries and local test thread ID. Never paste raw stdout of App Server or account/read response into GitHub. Probe passed offline smoke tests and the repository owner's reported live run on CLI 0.171.0. Remaining live tests below are still pending.
- Verify exact server sandbox/approval policy from generated schema and response before live test. Use read-only and never escalate. If managed policy rejects, record and stop.
- Interrupt test: create another synthetic turn, send turn/interrupt using the exact returned threadId/turnId. Match terminal status interrupted. If task completed first, mark inconclusive, not failure. Do not interrupt a user session.
- Restart: after owned server exits, start a fresh process and initialize, read the synthetic worker via thread/read then resume with excludeTurns:true. Verify no extra turns; inspect list history.
- Discovery: call thread/list explicitly with sourceKinds:["appServer"]; paginate until matching owned worker. Compare desktop sidebar, refresh, reopen, and title; record whether duplicate session or lost history occurs. Do not open same writable thread concurrently.

### C. Temporary local plugin and hook/MCP identity
Create a disposable marketplace with a minimal plugin according to official packaging docs. Include only an echo MCP tool (no writes) and hook(s) that produce a constant marker and record field presence, anonymized IDs and transport connection correlation. Use hookSpecificOutput.hookEventName and additionalContext for UserPromptSubmit. Explicitly trust hooks in app; test untrusted state first. Exercise:
- Coordinator root, second manual chat in identical cwd, fork of coordinator, native subagent and bridge-created worker.
- Hook call to echo via mcp_tool template (session_id, turn_id, event name); direct model call with forged IDs. Determine whether a host-attested distinction exists. Hook fields alone and ordinary MCP arguments are not sufficient.
- Compare real thread.id, thread.sessionId, hook session_id, and agent_id if present. Prove exact root binding across new turns/restart and no cross-project mutation. If no verified caller identity or supported explicit out-of-band pairing, stop.
- Check MCP process PID only in our probe, connection lifecycle during turn/idle and app close/reopen. Do not enumerate or access private desktop IPC; check supported settings only.

### D0. Sequential cross-process desktop wake probe (user-run API PASS; live UI FAIL)

The companion script `docs/codex/probe_coordinator_wakeup.py` uses the existing owned stdio transport. It creates a disposable coordinator in server A, verifies its exact initial response and closes A. After the user explicitly confirms that the synthetic chat is open and idle in Codex App, server B reads the persisted coordinator, creates and completes a separate worker, resumes the coordinator and sends exactly one toolOutput-only turn. A third fresh server reads history to verify exactly two completed coordinator turns and the unique expected reply marker. No arbitrary thread IDs are accepted from the command line. No inference without --live, no auto-retries, no approval requests accepted by the inherited transport. The temporary working directory exists for the whole probe; no existing project files or settings are intentionally changed. Existing Codex user configuration still applies. The synthetic conversations are retained.

```sh
git pull --ff-only
python3 docs/codex/probe_coordinator_wakeup.py
python3 docs/codex/probe_coordinator_wakeup.py --live
```

The live run uses three model turns (may consume quota/credits). When the script pauses, find the synthetic chat containing the printed TASK00_COORD_READY marker in the desktop app, refresh only if needed to locate it, open it and leave it idle. Do not send a message or change settings. Type WAKE in the terminal. Watch the chat without refreshing. Report terminal output, whether TASK00_WAKE_OK appeared automatically, whether the running state was visible, whether it appeared after refresh, and whether it is visible after app restart. If unable to locate the chat or it is active, abort with anything other than WAKE. If the RPC result is uncertain, do not retry delivery to the same chat.

This test distinguishes persistence and external idle-thread turn execution from live UI synchronization. A local status check in B does not attest ownership across other processes; the user must keep the synthetic chat idle. No shared desktop endpoint or concurrent write safety is established even if the UI updates immediately. Shared socket tests in D below, trusted identity, busy-turn queue, interruption, legacy baseline and plugin lifecycle remain separate gates.

Offline verification for this script: `python3 -m unittest discover -s docs/codex -p test_probe_coordinator_wakeup.py -v` (4 tests passed in the assistant sandbox using a protocol double for the helper functions, before upload); `python3 -m py_compile docs/codex/probe_coordinator_wakeup.py` and default dry run exit 0. Local and GitHub blob SHA matched for both files: probe `ac2f0fae19ce4bb955bb81d2e94daf532d5e005e`, tests `c3ac4820e950bd8b0f2494ff7b82cfae517ec52d`. Full real-process wake workflow was subsequently executed by the repository owner (see evidence above), not in the assistant environment; legacy baseline still blocked by DNS. The initial RED run failed importing the not-yet-created module; no claim of a full integration test. No product implementation or change to the main branch.

### D. Shared server / automatic wake feasibility
On a disposable local server started with documented Unix socket support, use two explicitly authorized clients, one synthetic coordinator and one synthetic worker. Verify generated protocol and socket ownership/permissions before use. Test:
- Worker root completion -> toolOutput to enrolled coordinator using input:[]; confirm new turn and visible tool output when idle.
- Send while coordinator has active turn; verify queued output rather than interruption, no duplicate turn. Check failed/interrupted worker events separately.
- thread/inject_items on enrolled coordinator (no wake), turn/steer with exact active turn ID (wrong ID rejected).
- Repeat event ID at bridge level and simulate response loss; verify no blind resend. Any UI client disconnect/reconnect behavior must be recorded.
- Separately verify official Codex desktop can connect to or share the same supported server, whether the test threads appear independently, and whether resulting turns are visible. Do not infer desktop behavior from remote CLI. If desktop does not expose a supported interface, mark native parity unavailable for this version; do not hack private sockets/storage or override policy.
- Close desktop and restart; check lifecycle, missed event recovery. Remove only disposable probe configuration with user's consent; retain test threads unless explicitly asked to archive.

### E. Evidence format and release decision
Record PASS/FAIL/BLOCKED/NOT SUPPORTED per capability, CLI + desktop version, date, exact commands, exit codes, sanitized request/response field names, expected/observed UI results. Redact account emails, plan identifiers, real thread IDs, paths, prompts, tokens, transcripts. Keep synthetic fixture IDs only. Store sanitized captures in codex/test/fixtures/ after execution; no fabricated capture. Re-run baseline if branch changes. Gate stays NO-GO until required tests pass and user reviews any architecture revision.

## Sources
- https://learn.chatgpt.com/docs/app-server — protocol, initialization, thread lifecycle, pagination, auth, toolOutput, socket.
- https://learn.chatgpt.com/docs/hooks — common fields, UserPromptSubmit, MCP tool hooks, subagent identity and limitations.
- https://learn.chatgpt.com/docs/extend/mcp — local stdio and lazy startup.
- https://developers.openai.com/plugins/build/plugins — manifest, marketplace, hook trust and plugin root.
- https://github.com/caglar09/t3-orchestration/blob/docs/codex-app-support-plan/docs/superpowers/plans/2026-11-27-codex-app-support.md — original task criteria.
