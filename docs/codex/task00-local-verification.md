# TASK-00 — Remaining local verification (macOS)

Status: diagnostic implementation ready for owner-run tests; NOT a production plugin, NOT a completed release gate. Tested environment previously reported: CLI 0.171.0 / desktop 26.1120.50957. Owner accepts delayed desktop UI refresh; no need to rerun the successful sequential wake probe unless versions change. Shared desktop transport is optional, but exclusive execution ownership or safe inbox fallback is required.

Run from the existing fork checkout on `docs/codex-app-support-plan`. Do not use real project conversations. These probes intentionally keep synthetic chats in history. No private Codex files, database or socket inspection.

## 1. Baseline, versions, schema (no model inference)

```bash
git switch docs/codex-app-support-plan
git pull --ff-only
git rev-parse HEAD
codex --version
node --version
python3 --version
npm ci
node --test hooks/register.test.mjs scripts/accounts.test.mjs
python3 scripts/test_memory.py
python3 -m unittest discover -s docs/codex -p 'test_*.py' -v
codex app-server --help
SCHEMA_DIR="$(mktemp -d)"
codex app-server generate-json-schema --out "$SCHEMA_DIR/json"
codex app-server generate-ts --out "$SCHEMA_DIR/ts"
```

Record the Node/Python versions, test counts and any command failures, and the desktop build from About. If the generator commands differ from installed CLI help, use only the documented options and report the difference. Do not commit the generated schema wholesale. Check that it includes the methods and parameters for thread/start, turn/start (toolOutput, sandboxPolicy), turn/interrupt, thread/resume, thread/turns/list, thread/items/list, thread/list, account/read, account/rateLimits/read, command/exec and turn/completed. Record missing fields/methods. The prior successful 0.171.0 probe is tested-version evidence, not a minimum-version claim.

## 2. Sandbox, worker independence, discovery and interrupt

```bash
python3 docs/codex/probe_lifecycle.py
python3 docs/codex/probe_lifecycle.py --live
```

First command sends no prompt. It uses a read-only command execution with a harmless echo as positive control and a touch of a disposable file as negative control. It fails closed if a write succeeds. This tests command/exec sandbox, not all model tools or desktop's actual permissions; inspect thread/start and turn/start policy in generated schema before enabling writes. If the API rejects the entire call, report BLOCKED rather than assuming sandbox enforcement.

Second command uses the existing authenticated ChatGPT account, may consume quota, starts two separately registered synthetic threads, observes their completion events, checks bounded appServer source discovery and requests interruption of a third synthetic turn on one of the same two owned threads. It never interrupts an existing real chat. If completion wins the race, INCONCLUSIVE is correct; rerun only if you want additional synthetic inference. If B starts before A terminal notification, this is evidence of overlapping pending turns, not a throughput benchmark. Return all terminal output and exit status. Failed terminal event remains untested unless actually observed; do not manufacture errors or consume quota to cause a rate-limit failure.

## 2b. Test C troubleshooting — direct project mode

Owner-run Test A/B passed on b9f3121; Test C showed missing marker and unavailable echo tool. This does not establish the plugin was installed or hooks trusted. Opening a project is not equivalent to installing a marketplace plugin. The earlier Interrupt timeout exceeded the documented three-second maximum; corrected in the generator. To isolate the plugin packaging layer, use a NEW temporary root:

```bash
git pull --ff-only
python3 -m unittest discover -s docs/codex -p 'test_*.py' -v
PROBE_ROOT="$(mktemp -d)/workspace"
python3 docs/codex/task00_remaining.py prepare "$PROBE_ROOT" --mode direct
git -C "$PROBE_ROOT" init -q
echo "$PROBE_ROOT"
(cd "$PROBE_ROOT" && codex mcp list)
```

Open this new project, review project trust and hook trust separately, and start a new local chat. Direct mode generates .codex/config.toml, .codex/hooks.json and .codex/probe.py, without a marketplace. Test echo and injection using section 3 prompts; collect the report using the new PROBE_ROOT. If CLI lists t3o_probe but app does not expose it, investigate desktop loading/trust; if CLI does not list it, investigate project config loading. If no event log, distinguish untrusted or undiscovered hooks from execution failure. Do not bypass trust or change global config. If plugin mode is retried, explicitly select the repo marketplace and install the plugin before opening a new chat. Direct mode is diagnostic only, not proof of plugin packaging or caller identity. New assertions are not yet executed in the assistant runtime.

## 3. Disposable native plugin / MCP / command hook and Stop MCP hook

```bash
PROBE_ROOT="$(mktemp -d)/workspace"
python3 docs/codex/task00_remaining.py prepare "$PROBE_ROOT"
git -C "$PROBE_ROOT" init -q
echo "$PROBE_ROOT"
```

Keep this terminal open or note the printed path. This creates a fresh folder only; the preparation command refuses to overwrite an existing folder. Generated layout:
```text
workspace/
  .agents/plugins/marketplace.json
  .codex/config.toml
  plugins/t3o-task00-probe/
    plugin.json
    mcp.json
    hooks/hooks.json
    probe.py
  salt
  events.jsonl (created after first event)
```

The root manifest and portable mcp.json follow the currently documented local marketplace packaging format. No writes to personal config, no auth copying, no external HTTP listener. The small Python stdio echo server is intentionally a protocol probe, not an SDK-based production MCP server. Paths are bound to the disposable workspace. The hook command records only within that exact cwd. The plugin's Stop MCP hook is configured independently; its server name may be namespaced on the installed build, which must be verified in the UI. If it fails, report the exact error and tool/server name; do not change unrelated settings. Explicitly enable/trust only this test project/plugin. Plugin command hooks are skipped until trusted.

In Codex App:
1. Add the printed folder as a local project. Restart app if necessary to discover the repo marketplace. Locate and enable **T3O TASK-00 Probe**. Record whether the app shows it and the MCP tool echo_probe. Do not enable globally.
2. In a fresh synthetic chat in this folder, BEFORE trusting the hook, ask: "Call the t3o probe echo_probe MCP tool with origin=direct and session_id=FAKE_TASK00_ID. Report only its marker and authenticated field." Expected if MCP is connected: TASK00_MCP_OK, authenticated=false. No hook event should be logged before trust. If the app requires an approval to call this harmless tool, review it; never bypass security policy.
3. Review hooks in Settings > Hooks or the composer and trust only the new probe hooks. Open a fresh chat in the same project. Send: "If a TASK00_HOOK_CONTEXT_OK marker is present in your injected context, repeat it. Then call echo_probe with origin=direct and session_id=FAKE_TASK00_ID. Do nothing else." Record whether the model reports the marker and echo result. Stop should log a command_hook and, if the MCP server is already connected, an MCP call with claimed_origin=hook.
4. Send another prompt in the same chat. Repeat in a second manually-created chat in the same project. Fork the first chat if the desktop exposes it. In one disposable chat ask for a native subagent with a harmless text-only task, if available. Finally send a harmless prompt in a new chat OUTSIDE the diagnostic project only if desired. Compare session/turn/agent digests and server PIDs. The diagnostic hook intentionally runs on both manual and candidate coordinator chats in the test folder; it has no registry or orchestration rights. Outside-folder command hook should record nothing.
5. In the candidate coordinator and manual chat deliberately call echo_probe with origin=hook and session_id=FAKE_TASK00_ID. This is a spoof test. Expected: authenticated=false for all calls; claimed origin/IDs are untrusted. Compare meta_keys and per-connection PIDs, not text returned by the model. Matching IDs alone do not establish trusted identity. If runtime supplies no verifiable root-thread metadata/connection binding, record IDENTITY BLOCKED. Do not authorize worker launch on this basis.
6. Switch to another chat, return, then close/reopen the app. Repeat echo in the same synthetic conversation. Record whether the same MCP server PID remains or restarts; inspect event ordering. This checks host lifetime, not execution ownership.

Collect sanitized evidence:
```bash
python3 docs/codex/task00_remaining.py report "$PROBE_ROOT"
```

This emits event name, field names, local salted ID digests, claimed origin, timestamp and PID. It never intentionally captures prompt text, cwd, raw identifiers, transcript paths or metadata values. Review before sharing; field names are supplied by runtime and could include custom identifiers. Never send salt, raw hook JSON, private app data or credentials. PIDs are diagnostics, not identity proof.

## 4. Gate interpretation and safe ownership

- UI refresh delay accepted; no production fix or app restart automation required.
- Sequential external toolOutput wake is proven only when the probe owns the thread and prior executor has stopped. No simultaneous desktop/bridge writes in these tests. If the desktop cannot attest that the coordinator is idle *and* release execution ownership, use durable inbox on its next turn; do not rely on a different server's idle snapshot as a global lock.
- The temporary plugin deliberately grants no worker-launch privileges. Native MCP and hook success does not prove root coordinator identity. If an authenticated root binding is absent, investigate supported out-of-band pairing / a bridge-owned coordinator with scoped execution ownership; otherwise keep TASK-01 blocked. Do not accept agent-supplied IDs, hook origin claims, cwd or title as credentials. An actual desktop-to-worker launch test follows safe identity establishment.
- No extra scheduler, shared endpoint, busy desktop wake, or force-failure experiment is needed for read-only diagnostic packaging; those capabilities remain unknown. Production recovery/failure and concurrent ownership are still required to approve automatic delivery; no bypass.
- If plugin manifest/hook names differ on the installed version, return the exact error; don't alter your global configuration to make a probe pass.

## 5. Results to send

Paste the three sets of terminal output (baseline/schema, lifecycle, sanitized plugin report) and answer:
- Plugin listed and echo tool callable? yes/no
- Hook disabled before trust and marker after trust? yes/no
- Stop command hook and native MCP hook observed? yes/no
- Root/manual/fork/subagent digest patterns and MCP server lifetime?
- Any unexpected approval prompts or errors?

Disable/uninstall only the disposable probe plugin via the app, then remove the diagnostic folder only after collecting evidence and if you no longer need it. No automatic deletion is performed.

## Offline verification (assistant, 2026-11-27)

Six new unit/protocol-double tests passed locally (4 packaging/echo/hook tests + 2 lifecycle helper tests), syntax checks exit 0. Before implementation, the test imports failed for missing modules. This is not a full behavioral RED cycle or a live integration pass. Local Git blob hashes checked against the exact fetched GitHub files. Real Codex absent; GitHub clone blocked by DNS (exit 128); legacy suite still not run in this environment. No independent reviewer or real desktop execution available. All files are isolated under docs/codex, no production code changes.

Sources: https://learn.chatgpt.com/docs/hooks ; https://developers.openai.com/plugins/build/plugins ; https://learn.chatgpt.com/docs/app-server ; https://learn.chatgpt.com/docs/extend/mcp .
