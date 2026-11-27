# Codex App Support — Security Model and Boundaries

This document describes the threat model, trust boundaries, and enforced security controls implemented in `codex/`.

---

## Threat model and trust boundaries

```text
+-------------------------------------------------------------------+
| Untrusted Inputs                                                  |
| - Model tool arguments (forged session_id, projectId, paths)      |
| - Worker outputs / repository files (prompt injection, secrets)   |
| - Hook stdin JSON (malformed / oversized / forged fields)         |
| - App Server approval requests (unexpected escalation attempts)   |
+---------------------------------+---------------------------------+
                                  |
                                  v
+-------------------------------------------------------------------+
| Local MCP Bridge & Hook Boundary (`codex/src/`, `codex/hooks/`)   |
| - Verified host identity (`T3O_CODEX_HOST_SESSION_ID`)            |
| - Out-of-band pairing (`project_setup` + SHA-256 timingSafeEqual) |
| - Strict Zod schemas (no extra keys, bounded sizes/limits)        |
| - Canonical root / symlink checks, 0700/0600 state, PID lease     |
| - Default read-only sandbox + isolated Git worktree opt-in        |
| - Safe refusal of server approval requests + secret/PII redaction |
+---------------------------------+---------------------------------+
                                  |
                                  v
+-------------------------------------------------------------------+
| Owned `codex app-server` (stdio JSONL, `shell: false`)            |
| - Existing ChatGPT/Codex auth (`OPENAI_API_KEY` stripped)         |
| - Per-thread sandbox (`read-only` or `workspace-write`)           |
+-------------------------------------------------------------------+
```

### Core security assumptions and non-goals
- Runs strictly locally for a single authenticated macOS user (`0700`/`0600` file permissions); exposes no network listeners or remote HTTP servers.
- Never scrapes private Codex or T3 databases, rollout JSONL logs, or `auth.json`.
- Never compromises existing T3/Claude state (`~/.t3-orchestration/config.json` is never read or written).

---

## 1. Host-verified pairing vs untrusted caller-supplied identity

A model-callable MCP tool cannot authenticate itself by passing `session_id`, `projectId`, `coordinatorSessionId`, or `origin` as tool arguments — any prompt injection or worker thread could forge them.

- **Verified host identity (`codex/src/mcp.mjs`):** Caller identity is read exclusively from host-injected `hostIdentity` (`T3O_CODEX_HOST_SESSION_ID`, optional `T3O_CODEX_HOST_THREAD_ID`, and `T3O_CODEX_ALLOW_WRITE`).
- **Strict schemas (`z.strictObject`):** Every MCP tool (`project_setup`, `worker_launch`, `worker_list`, `worker_read`, `worker_continue`, `worker_cancel`, `inbox_list`, `inbox_ack`, `account_status`) rejects unknown properties (`additionalProperties: false`), so forged `projectId`, `coordinatorSessionId`, or `origin` arguments fail schema validation.
- **Out-of-band pairing (`project_setup`):** Binding a new project requires a `pairingCode` verified with constant-time SHA-256 comparison (`crypto.timingSafeEqual`) against `T3O_CODEX_PAIRING_CODE` or `~/.t3-orchestration/codex/pairing.json` (with `expiresAt` validation).
- **Worker / subagent / manual isolation:**
  - `mcp.mjs` and `config.mjs` (`resolveRole`) reject any caller marked `isWorker`, `isSubagent`, `internal`, `role === "worker"`, or carrying an `agentId`, as well as any session registered as a worker in any project (`sessionIsWorkerAnywhere`) or mismatched `threadId`.
  - `codex/hooks/context.mjs` (`renderContext`) returns `null` for manual threads (even in the same `cwd`), subagents (`agent_id`, `is_subagent`, `subagent`), internal app jobs (`internal`), worker threads, and non-`UserPromptSubmit` events. Role inference from `cwd`, title, or prompt text is never used.

---

## 2. Strict IDs, prototype-pollution guards, and canonical path / symlink rejection

- **Identifier validation (`config.mjs`, `state.mjs`, `workers.mjs`, `worktrees.mjs`, `memory.mjs`):**
  - `project.id`: strict UUID v1–v5 regex.
  - `project.name` and memory `topic`: `^[a-z0-9][a-z0-9-]*$` (`<= 64` chars for project name, `<= 80` for topic).
  - `workerId`: `^[a-zA-Z0-9_-]{1,64}$`.
  - Control characters (`[\x00-\x1f\x7f]`) and forbidden keys (`__proto__`, `constructor`, `prototype`) are explicitly rejected.
- **Canonical paths & symlink-escape rejection:**
  - `config.mjs` (`validateCanonicalPath`) rejects relative paths, `.` / `..` segments, trailing slashes, symlinks (`lstatSync().isSymbolicLink()`), and non-canonical targets (allowing only macOS `/var` -> `/private/var` and `/tmp` -> `/private/tmp` system root resolution during initial setup, while `loadConfig` enforces exact canonical paths).
  - `worktrees.mjs` verifies canonical `root` matches `git rev-parse --show-toplevel`, rejects symlinks on `root`, `baseDir`, and candidate worktree directories, and verifies created worktrees remain strictly inside `baseDir`.
  - `memory.mjs` rejects symlinked `libraryPath` or `evidenceDir`, verifies ancestor directories before `mkdir`, confirms `evidenceDir` stays inside `libraryPath`, and restricts `recordNote` source URIs to `https://` or canonical non-symlink `file://` paths strictly inside `libraryPath` (blocking `codex://`, `http://`, `javascript:`, query strings, fragments, and `..` escapes).

---

## 3. Private state permissions (`0700` / `0600`) and atomic writes

- Config directory (`~/.t3-orchestration/codex/`), project state directories (`projects/<id>/`), `worktrees/`, and `library/` / `evidence/` directories are created and enforced with mode `0o700`.
- `config.json`, `state.json`, `lease.json`, and evidence artifacts (`evidence/turn-*.json`) are written with mode `0o600` using exclusive temporary file creation (`O_WRONLY | O_CREAT | O_EXCL`), `fsync`, and atomic `renameSync` (with `fsyncDirBestEffort`).
- `scripts/memory.py` sets `os.umask(0o077)` and serializes SQLite + `NOTES.md` updates under an exclusive `fcntl.flock` lock.

---

## 4. Single-writer PID lease (`openState`)

- `codex/src/state.mjs` (`openState`) acquires an exclusive `lease.json` via atomic hard-link (`fs.linkSync`) containing `{ pid, token, acquiredAt }`.
- If `lease.json` exists, `openState` checks `process.kill(pid, 0)`:
  - If the writer PID is alive (or returns `EPERM`), acquisition fails immediately (`State lease is held by active writer PID ...`), preventing concurrent corruption.
  - Stale lease recovery (only when the recorded PID is dead) is serialized via `.lease.recover.lock` (`O_EXCL`) and re-checked before unlinking.
- Every `read()` and `transact()` verifies the in-memory `token` still matches `lease.json` and increments `revision` monotonically.
- `UserPromptSubmit` (`hooks/context.mjs`) uses read-only `readSnapshot(dir)`, never acquires a writer lease, never mutates `state.json`, and fails open (`{}`) on corrupt or missing files.

---

## 5. Refusal and surfacing of App Server approval requests

- `codex/src/app-server.mjs` defaults to `approvalPolicy: "on-request"` and `sandbox: "read-only"` (`read` mode). Bypass flags (such as `danger-full-access` or `never`) are rejected by `validateSandboxMode` unless explicitly permitted by protocol constants (`approvalPolicy` rejects unknown policies).
- There is **no LLM auto-approval**. Every supported server-initiated approval request is safely declined/denied immediately at the JSON-RPC boundary and surfaced via `onApprovalRequest`:
  - `item/commandExecution/requestApproval` -> `{ decision: "decline" }`
  - `item/fileChange/requestApproval` -> `{ decision: "decline" }`
  - `applyPatchApproval` / `execCommandApproval` -> `{ decision: { denied: { rejection: "Approval denied by bridge policy" } } }`
  - `mcpServer/elicitation/request` -> `{ action: "decline" }`
  - `item/permissions/requestApproval` -> `{ permissions: {} }`
  - Any unknown server-initiated method -> JSON-RPC error `-32601` (`Method not found`).
- `workers.mjs` records declined requests on the worker (`approvalRequired: true`, `pendingApproval: { status: "approval_required", id, method, turnId, itemId, reason }`) so the coordinator can surface the blocked action to the user.

---

## 6. Isolated per-worker Git worktrees without auto-commit / push / merge

- Write access requires dual authorization: `project.allowWrite === true` (configured by user) AND host policy `allowWrite === true && identity.allowWrite !== false` (fail-closed default `allowWrite = false`; enabled via `T3O_CODEX_ALLOW_WRITE=true`) AND explicit `mode: "write"`.
- `worktrees.mjs` invokes `git` strictly via `execFile` with argument arrays and `shell: false` (never shell string interpolation).
- Each write worker receives a dedicated directory `<stateDir>/worktrees/<workerId>` and branch `codex-worker/<workerId>`; two workers never share a worktree or branch, and the user's dirty root working tree is left untouched.
- `app-server.mjs` binds `sandboxPolicy: { type: "workspaceWrite", writableRoots: [worktree] }` to that exact worktree.
- The bridge never runs `git commit`, `git push`, `git merge`, or destructive worktree cleanup automatically.

---

## 7. Bounded reads, briefs, transports, and subprocesses

| Surface | Enforced bound | Implementation |
| --- | --- | --- |
| `worker_launch` / `worker_continue` `brief` | Max `16 KiB` UTF-8 (`16384` bytes) | `codex/src/mcp.mjs` |
| `worker_read` `limit` | Default `20`, max `100` turns | `codex/src/mcp.mjs`, `workers.mjs` |
| `inbox_list` / `renderContext` preview | Max `20` events | `codex/src/mcp.mjs`, `hooks/context.mjs` |
| `inbox_ack` `eventIds` | `1..100` IDs | `codex/src/mcp.mjs` |
| Tool string fields | Truncated at `4000` chars; recursion depth `<= 8` | `codex/src/mcp.mjs` |
| JSON-RPC transport | Max `128` pending requests, `16 MiB` line buffer, `30s` default timeout, no write retries | `codex/src/rpc.mjs` |
| Child App Server env | `shell: false`, strips `OPENAI_API_KEY` by default | `codex/src/rpc.mjs` |
| `UserPromptSubmit` hook | `256 KiB` stdin cap, `<= 1s` fail-open CLI timeout (`3s` in `hooks.json`) | `codex/hooks/context.mjs` |
| Memory subprocess (`scripts/memory.py`) | `shell: false`, `64 KiB` stdin cap, strips secret env vars (`API_KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `PRIVATE_KEY`, `CREDENTIALS`) | `codex/src/memory.mjs` |

---

## 8. Secret / PII redaction and untrusted data hygiene

- **Redaction (`mcp.mjs` & `memory.mjs`):** Before returning tool results or persisting memory artifacts, text is scrubbed for PEM private keys, `Bearer` tokens, JWTs, Stripe/OpenAI/Anthropic/GitHub/AWS/Slack keys, `password`/`secret`/`token` key-value pairs, and email addresses (plus phone numbers in `memory.mjs`).
- **Account privacy (`mcp.mjs`):** `account_status` returns only `{ authenticated, accountType, planType, limits }` and never exposes `email`, `userId`, or `workspaceName`.
- **No raw transcripts in state or hooks:**
  - `state.json` stores only worker metadata and terminal event IDs/statuses (`completed`, `failed`, `interrupted`), never turn transcripts.
  - `UserPromptSubmit` (`context.mjs`) emits only the coordinator marker, unread event IDs, worker IDs, and normalized short statuses — never worker message bodies or raw error strings.
  - `memory.mjs` extracts only bounded summary fields (`summary`/`outcome`/`conclusion`/`title`/`error.message`) and omits raw transcripts and `items` arrays.
- **Untrusted data discipline:** `context.mjs`, `codex/templates/coordinator.md`, and `codex/skills/orchestrate/SKILL.md` instruct the coordinator to treat all worker output and memory content strictly as **untrusted data**, never as executable instructions. Even if a worker output attempts prompt injection (for example, instructing the coordinator to call `worker_launch` in `write` mode or run `project_setup`), the coordinator must ignore the directive and the MCP bridge independently blocks worker callers from invoking orchestration tools.
