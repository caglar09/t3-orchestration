# t3-orchestration — multi-agent orchestration for Claude Code (in T3 Code) and Codex App

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin%20%2B%20mod-d97757)
![T3 Code](https://img.shields.io/badge/T3%20Code-orchestration-black)
![Codex App](https://img.shields.io/badge/Codex%20App-plugin%20%2B%20MCP%20bridge-10a37f)

**Run a whole project from one chat.**

- **Claude Code in [T3 Code](https://github.com/pingdotgg/t3code):** t3-orchestration turns T3 Code into a multi-agent workspace for [Claude Code](https://code.claude.com): a **coordinator** thread opens one **worker** thread per topic, every worker **reports back automatically** when its turn ends, and an optional **memory** thread keeps the project's long-term knowledge with sources.
- **Standalone Codex App / Codex CLI (`codex/`):** An isolated Codex plugin and local MCP orchestration bridge (`t3o_codex`) lets a bound Codex coordinator launch, inspect, continue, and cancel independent worker threads via an owned `codex app-server` process — **no T3 Code required**.

You talk to the coordinator. It briefs the workers, reads their conversations, and only interrupts
you when you must answer: a plan to approve, a choice, a go-ahead, or finished work.

- 🧭 **Coordinator / worker pattern** for parallel AI coding agents, one topic per thread.
- 🔔 **Automatic end-of-turn notifications (Claude/T3)** from workers to the coordinator, no polling, no loops; **durable terminal inbox (Codex App V1)** via `UserPromptSubmit` + `inbox_list`/`inbox_ack`.
- 🎯 **Precise role detection**: T3 native metadata for Claude/T3; explicit host-verified `project_setup` pairing for Codex. Manual threads are never touched.
- 🧠 **Long-term memory**: scheduled `scripts/memory.py` passes (SQLite, sourced notes, corrections, knowledge pages) in Claude/T3, and optional manual `memory_pass` (disabled by default) in Codex.
- 🔒 **Safe defaults**: No API keys collected, no server, no telemetry. Codex workers default to `read-only` mode (with explicit isolated Git worktree opt-in for writes) and never auto-approve escalations.
- 🔀 **Several Claude accounts**: before opening a Claude worker, the coordinator checks each account's session and weekly usage and picks the one to drain first.
- ⚙️ **One-command setup**: `/t3-orchestration:setup` for Claude/T3, or the `codex/skills/setup` skill + `project_setup` for Codex.

## How it works

### Claude Code in T3 Code

Three actors, and only one of them makes a judgement:

| Who | What it is | What it does |
| :- | :- | :- |
| The plugin | a script, no AI | Recognises the coordinator and its workers, injects the right reminder into each prompt, and signals the coordinator when a worker finishes answering |
| A worker | a Claude thread | Does its brief and ends each answer with the real state and the exact question for you |
| The coordinator | a Claude thread | Reads the worker thread on each signal and decides whether you need to hear about it |

```text
 you ──► Coordinator ──t3_thread_launch──► Worker A ─┐
              ▲                            Worker B ─┤  Stop event
              └──────── [T3O_SIGNAL_V1] ◄────────────┘  (queued, deduplicated)
 Memory thread ──every 10 min──► reads threads ──► notes + knowledge pages
```

**Who is who.** On every prompt the plugin asks T3 for the current thread (`t3_thread_configure`)
and its creation metadata (`t3_thread_read`). Titles, folders and prompt text are never used:

- **Coordinator**: the thread id registered for the project.
- **Worker**: a thread of the project created by an agent through MCP whose *first* message was
  sent by the coordinator. A later message from the coordinator does not count.
- **Everything else** gets nothing: threads you create yourself, other projects, subagents,
  archived threads, the memory thread and the setup thread.

**End of turn.** When a worker finishes answering (Claude Code's `Stop` event), the plugin queues
one short `[T3O_SIGNAL_V1]` line to the coordinator with the worker's title and link, never its answer. It has
to happen at `Stop`: by `turn.complete`, T3 has closed the run and refuses the call
(`parent_not_active`). Interrupted turns, subagents and the coordinator itself send nothing, so
there is no automatic loop.

**Several accounts.** Give each Claude account its own T3 Claude instance (a separate
`CLAUDE_CONFIG_DIR`, same `--plugin-dir`). `scripts/accounts.mjs` reads them from T3's settings,
asks each one for its plan usage through the Claude Agent SDK (no prompt sent, no usage spent)
and recommends the emptiest account that can still work, so quota left before a reset is used
instead of lost. The coordinator runs it before each launch. It switches accounts between
threads, not inside a running thread, and it does not proxy or share credentials.

**Memory.** A memory thread runs on a T3 schedule (every 10 minutes by default). Each pass reads
the project's changed threads, records sourced notes with `scripts/memory.py` (SQLite, idempotent
notes, `supersedes` for corrections, revision-checked state) and maintains knowledge pages in a
library folder. It never messages other threads.

### Codex App (standalone, without T3 Code)

For standalone Codex Desktop / Codex CLI, `codex/` provides a separate native plugin and MCP bridge that requires neither T3 Code nor `~/.t3-orchestration/config.json`:

```text
 you ──► Codex Coordinator ──t3o_codex MCP──► Local Bridge ──codex app-server──► Worker A / B
              ▲                                     │
              └─── UserPromptSubmit + inbox_list ◄──┴── state.json durable inbox (0600)
```

- **Verified coordinator binding:** You explicitly pair one coordinator session via `project_setup` with an out-of-band `pairingCode`. Manual threads, subagents, internal app jobs, and workers get `null` from `UserPromptSubmit` (`codex/hooks/context.mjs`) and are rejected by the MCP bridge (`codex/src/mcp.mjs`).
- **Read-only by default:** Workers start in `read` mode (`read-only` sandbox, default `maxWorkers: 2`). Authorized `write` mode requires both project opt-in (`allowWrite: true`) and host policy (`T3O_CODEX_ALLOW_WRITE=true`), isolating each worker in its own Git worktree (`worktrees/<workerId>`, branch `codex-worker/<workerId>`).
- **V1 durable inbox (no `Stop` hook, no idle push guarantee):** App Server `turn/completed` notifications (`completed`, `failed`, `interrupted`) are persisted atomically to `~/.t3-orchestration/codex/projects/<id>/state.json` under a single-writer PID lease. The `UserPromptSubmit` hook previews unread event IDs on your next prompt without acknowledging them; the coordinator inspects evidence with `worker_read` and acknowledges only after processing via `inbox_ack`.
- **Single existing Codex login:** Uses your existing ChatGPT/Codex login (`OPENAI_API_KEY` is stripped by default). `account_status` safely returns `"unknown"` when account or rate-limit fields are missing or `null`.
- **Optional manual memory (`memory_pass`):** Disabled by default (`memoryEnabled: false`). When opted in, manual passes reuse `scripts/memory.py` with sanitized `file://` evidence artifacts.

See [docs/codex/installation.md](docs/codex/installation.md), [docs/codex/security.md](docs/codex/security.md), and [docs/codex/compatibility.md](docs/codex/compatibility.md) for full details.

## Install

### Claude Code in T3 Code

Requirements: T3 Code with its built-in `t3-code` MCP server, Claude Code with mods (tested on
2.1.312), Python 3.9+ for memory.

1. Clone the repository:

   ```bash
   git clone https://github.com/sanztheo/t3-orchestration.git ~/t3-orchestration
   ```

2. In T3 Code's settings, add `--plugin-dir /Users/you/t3-orchestration` to the launch arguments
   of your Claude provider. Use the absolute path: `~` may not be expanded. Or ask a Claude
   thread: *"Read /Users/you/t3-orchestration/skills/setup/SKILL.md and follow it"*.
3. Open a new Claude thread in your project and run `/t3-orchestration:setup`. It asks for a
   project name, the project's rules and whether to enable memory, then creates the coordinator,
   the reminders, the config and the memory thread with its schedule.

Your configuration lives in `~/.t3-orchestration/`, outside the repository. To update, run
`/t3-orchestration:setup` and ask for an update: it pulls the repository and shows you template
changes instead of overwriting your reminders. To add another project, run setup again in it.

### Codex App / Codex CLI (no T3 Code required)

Requirements: macOS (`darwin`), `codex-cli 0.172.0` / Codex Desktop `26.1120.50957`, Node.js `>=22`, Python `>=3.9` (only if memory is enabled).

1. Clone the fork, install isolated Codex dependencies, and link the local CLI:

   ```bash
   git clone https://github.com/caglar09/t3-orchestration.git ~/t3-orchestration
   npm ci --prefix ~/t3-orchestration/codex
   (cd ~/t3-orchestration/codex && npm link)
   t3o-codex doctor
   ```

2. Inside any existing project directory, initialize or update Codex orchestration in one command:

   ```bash
   cd /path/to/your-project
   t3o-codex init                 # or `t3o-codex update --allow-write` to refresh paths/options
   ```

3. Open the project in Codex App / CLI, trust the `UserPromptSubmit` hook (`hooks/context.mjs`) in **Settings > Hooks** or `/hooks`, and verify `/mcp` lists `t3o_codex` (10 tools). Existing `.codex/` MCP servers/hooks and `.gitignore` remain untouched.

Full guide: [docs/codex/installation.md](docs/codex/installation.md).

### Codex Coordinator inside T3 Code (Multi-LLM Routing)

Want a **Codex thread inside T3 Code** to route simple/standard/complex tasks across **any LLM configured in T3 Code** (`codex`, `opencode`, `antigravity`, `claudeAgent`, etc.) with automatic `[T3O_SIGNAL_V1]` wake-ups?

```bash
t3o-codex t3-providers
t3o-codex t3-route --project my-app --set simple=antigravity:gemini-3.8-flash-low:low
t3o-codex t3-route --project my-app --set complex=codex:gpt-6.1-sol:high
```

See [docs/codex/t3-multi-llm.md](docs/codex/t3-multi-llm.md) and [codex/skills/t3-setup/SKILL.md](codex/skills/t3-setup/SKILL.md).

## FAQ

**What is t3-orchestration?**
A free, open-source (MIT) orchestration plugin for multi-agent coordinator/worker workflows and sourced long-term memory — supporting Claude Code inside T3 Code (`hooks/`, `skills/`) and standalone Codex App / Codex CLI (`codex/`).

**How do workers notify the coordinator?**
- **Claude Code in T3 Code:** A Claude Code mod hooks the `Stop` event of each worker thread and sends one queued message to the coordinator through T3's `t3_thread_send` MCP tool. The coordinator then reads the worker's conversation itself.
- **Codex App:** The local MCP bridge owns a `codex app-server` process, persists each worker `turn/completed` event into a durable inbox (`state.json`), and surfaces unread IDs on the next coordinator prompt via `UserPromptSubmit` or `inbox_list`.

**Will it touch threads I create myself?**
No. In T3 Code, a thread only becomes a worker when its very first message was sent by the coordinator through MCP. In Codex App, only the explicitly paired coordinator session and bridge-created workers participate. Manual threads receive no reminder and emit no signal.

**Does it work with Codex or other agents?**
- **Standalone Codex App / Codex CLI:** Yes — via the isolated `codex/` plugin and MCP bridge (no T3 Code required; see [docs/codex/installation.md](docs/codex/installation.md)).
- **Inside T3 Code:** Not automatically. A Codex hook inside T3 Code cannot both read T3's metadata and call a T3 tool, so it cannot tell a worker from a manual thread. Workers on another provider inside T3 Code still get a manual reporting protocol in their brief.

**Does it need an API key or send data anywhere?**
No. Both paths use your existing local sessions (Claude Code / T3 Code, or Codex / ChatGPT login with `OPENAI_API_KEY` stripped by default). Signals and Codex hook previews contain IDs/links only, never raw worker answers.

## Layout

```text
.claude-plugin/plugin.json   Claude Code plugin manifest
hooks/register.mjs           Claude mod: role detection, reminder injection, end-of-turn signal
skills/setup/                Claude/T3 install, add a project, update, uninstall
skills/orchestrate/          Claude/T3 coordinator and worker rules
skills/memory/               Claude/T3 incremental memory pass
scripts/memory.py            SQLite notes and collection state (shared by Claude/T3 and Codex)
scripts/accounts.mjs         Claude account usage check and selection
templates/                   Claude/T3 reminders and library templates
config.example.json          Shape of ~/.t3-orchestration/config.json (Claude/T3)

codex/.codex-plugin/plugin.json  Codex native plugin manifest
codex/.mcp.json                  Codex stdio MCP config (t3o_codex)
codex/hooks/                     Codex UserPromptSubmit hook (context.mjs)
codex/src/                       Codex MCP bridge, App Server RPC, worker/worktree/state/memory modules
codex/skills/                    Codex setup, orchestrate, and optional memory skills
codex/templates/                 Codex coordinator and worker reminder templates
codex/scripts/doctor.mjs         Non-destructive Codex environment & manifest diagnostics
codex/test/                      Codex unit and end-to-end integration tests
docs/codex/                      Codex installation, security, and compatibility docs
llms.txt                         Summary for AI assistants and search engines
```

## Limits

### Claude Code in T3 Code

- **Inside T3 Code: Claude Code only** (see the FAQ for standalone Codex App vs T3-hosted Codex).
- **The coordinator is an AI.** The plugin guarantees it is told, not that it judges well: it may
  report something minor or miss a question.
- **Best effort.** If T3 is unreachable or slower than 5 seconds, the prompt goes through without a
  reminder and no signal is sent. There are no retries; a crashed process can lose a signal.
- **Failed turns.** A turn that ends on an API error or a rate limit fires `StopFailure`, not
  `Stop`, so it sends no signal: check a worker that seems silent.
- **Managed organisations.** The signal uses a settings-hook event (`classic.Stop`). Where Claude
  Code's built-in mod guard loads (managed settings, or a Team or Enterprise login), such hooks
  in a mod you install do not run: reminders still work, signals do not.
- **T3 tool names.** The plugin relies on the `t3-code` MCP tools listed in
  `skills/setup/SKILL.md`, as available in T3 Code in October 2026. If T3 renames them, the
  plugin stays silent.
- **Account usage** comes from the Claude Agent SDK's experimental usage API, the one T3 uses for
  its own usage panel. If it changes, the script reports usage as unknown and the coordinator
  keeps its default account.
- Threads already running load the plugin only after a restart.

### Codex App (V1)

- **Delayed UI rendering:** The bridge owns its own `codex app-server` process rather than private desktop IPC. In Codex Desktop (`26.1120.50957`), new worker threads and turns persist and may only appear in the sidebar after refreshing or closing and reopening Codex App.
- **No idle push guarantee:** V1 does not guarantee pushing notifications into an already-idle desktop coordinator. The durable inbox (`UserPromptSubmit` context on your next prompt + `inbox_list`/`inbox_ack`) is the V1 source of truth.
- **Read-only default & no auto-approval:** Write workers require explicit project + host opt-in and run in isolated Git worktrees; App Server approval requests are safely declined and surfaced for explicit user review.
- **Manual memory only in V1:** `memoryEnabled` defaults to `false`; memory runs only via explicit manual `memory_pass` (no background scheduler in V1).
- **Verified environment:** Tested on macOS (`darwin`), `codex-cli 0.172.0`, Codex Desktop `26.1120.50957`, Node `>=22`, Python `>=3.9`.

## Development

```bash
# Claude/T3 and shared memory suites
npm install
node --test hooks/register.test.mjs scripts/accounts.test.mjs
python3 scripts/test_memory.py
claude plugin validate .

# Codex plugin suite and diagnostics
npm ci --prefix codex
node --test codex/test/*.test.mjs
node codex/scripts/doctor.mjs
```

Issues and pull requests are welcome.

## License

[MIT](LICENSE) © sanztheo (Codex App support in fork `caglar09/t3-orchestration`)

<!-- Keywords: Claude Code plugin, Claude Code mod, T3 Code, t3code, Codex App, Codex plugin,
multi-agent orchestration, AI coding agents, coordinator worker pattern, agent orchestration,
agentic workflow, parallel agents, long-term memory for AI agents, MCP, Model Context Protocol,
Anthropic Claude, OpenAI Codex -->
