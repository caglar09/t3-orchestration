import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { renderContext } from "../hooks/context.mjs";
import { createAppServer } from "../src/app-server.mjs";
import { loadConfig } from "../src/config.mjs";
import { createMcpBridge } from "../src/mcp.mjs";
import { collectMemory } from "../src/memory.mjs";
import { createRpc } from "../src/rpc.mjs";
import { openState, projectStateDir, readSnapshot } from "../src/state.mjs";
import { createWorkerService } from "../src/workers.mjs";
import { createWorktreeManager } from "../src/worktrees.mjs";

const execFile = promisify(execFileCallback);
const MEMORY_SCRIPT = fileURLToPath(new URL("../../scripts/memory.py", import.meta.url));

const tempDirs = [];
const openHandles = [];

function makeTempDir(prefix = "t3o-e2e-") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function trackHandle(handle) {
  openHandles.push(handle);
  return handle;
}

afterEach(async () => {
  while (openHandles.length > 0) {
    const handle = openHandles.pop();
    try {
      await handle.close?.();
    } catch {
      // Ignore cleanup errors.
    }
    try {
      handle.dispose?.();
    } catch {
      // Ignore cleanup errors.
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function initTempGitRepo(parentDir, name = "repo") {
  const repoDir = path.join(parentDir, name);
  fs.mkdirSync(repoDir, { recursive: true });
  await execFile("git", ["init", "-b", "main"], { cwd: repoDir });
  await execFile("git", ["config", "user.email", "test@example.invalid"], { cwd: repoDir });
  await execFile("git", ["config", "user.name", "Test User"], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, "README.md"), "# E2E Repo\n", "utf8");
  await execFile("git", ["add", "README.md"], { cwd: repoDir });
  await execFile("git", ["commit", "-m", "initial"], { cwd: repoDir });
  return fs.realpathSync(repoDir);
}

async function runMemoryCli(libraryPath, ...args) {
  const { stdout } = await execFile("python3", [MEMORY_SCRIPT, "--library", libraryPath, ...args], {
    encoding: "utf8",
  });
  return JSON.parse(stdout);
}

/**
 * Persistent fake Codex App Server backend spanning multiple spawned stdio JSONL
 * processes so restart + reconcile + thread/turns/list reflect durable server state.
 */
function createFakeAppServerBackend() {
  let threadSeq = 0;
  let turnSeq = 0;
  const threads = new Map();
  const activeProcesses = new Set();

  let accountResponse = {
    account: {
      type: "chatgpt",
      email: "owner@example.invalid",
      planType: "plus",
      workspaceName: "Private Workspace",
    },
    requiresOpenaiAuth: true,
    userId: "user-secret-001",
  };
  let rateLimitsResponse = {
    rateLimits: {
      planType: "plus",
      primary: { usedPercent: 18, resetsAt: 1764260000, windowDurationMins: 300 },
      secondary: null,
    },
  };
  let accountError = null;
  let rateLimitsError = null;

  function emitNotification(method, params) {
    const line = `${JSON.stringify({ method, params })}\n`;
    for (const procState of activeProcesses) {
      procState.emitStdout(line);
    }
  }

  function finishTurn(threadId, turnId, { status, summary, error } = {}) {
    const thread = threads.get(threadId);
    if (!thread) {
      throw new Error(`Unknown fake thread ${threadId}`);
    }
    const turn = thread.turns.find((t) => t.id === turnId);
    if (!turn) {
      throw new Error(`Unknown fake turn ${turnId} on ${threadId}`);
    }
    turn.status = status;
    if (summary !== undefined) turn.summary = summary;
    if (error !== undefined) turn.error = error;

    emitNotification("turn/completed", {
      threadId,
      turn: {
        id: turn.id,
        status: turn.status,
        items: [],
        ...(turn.summary ? { summary: turn.summary } : {}),
        ...(turn.error ? { error: turn.error } : {}),
      },
    });
  }

  function seedThread(threadId, turns = []) {
    threads.set(threadId, {
      id: threadId,
      cwd: "/tmp",
      sandbox: "read-only",
      turns: turns.map((t) => ({ ...t })),
    });
  }

  function spawnFakeProcess() {
    const proc = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    let stdinBuffer = "";
    let closed = false;

    const procState = {
      emitStdout(text) {
        if (!closed) {
          stdout.emit("data", Buffer.from(text, "utf8"));
        }
      },
    };
    activeProcesses.add(procState);

    function writeReply(payload) {
      queueMicrotask(() => {
        procState.emitStdout(`${JSON.stringify(payload)}\n`);
      });
    }

    function handleMessage(msg) {
      if (!msg || typeof msg !== "object") return;
      if (msg.id === undefined || msg.id === null) {
        return;
      }

      const { id, method, params = {} } = msg;
      try {
        if (method === "initialize") {
          writeReply({
            id,
            result: {
              codexHome: "/tmp/codex-home",
              platformFamily: "unix",
              platformOs: "macos",
              userAgent: "codex/0.172.0",
            },
          });
          return;
        }

        if (method === "thread/start") {
          threadSeq += 1;
          const threadId = `thr_e2e_${threadSeq}`;
          const thread = {
            id: threadId,
            sessionId: `sess_worker_${threadSeq}`,
            cwd: params.cwd,
            sandbox: params.sandbox,
            approvalPolicy: params.approvalPolicy,
            modelProvider: "openai",
            status: { type: "idle" },
            turns: [],
          };
          threads.set(threadId, thread);
          writeReply({
            id,
            result: {
              approvalPolicy: params.approvalPolicy,
              approvalsReviewer: "user",
              cwd: params.cwd,
              model: "gpt-5.4",
              modelProvider: "openai",
              sandbox: params.sandbox,
              thread,
            },
          });
          return;
        }

        if (method === "turn/start") {
          const thread = threads.get(params.threadId);
          if (!thread) {
            writeReply({ id, error: { code: -32000, message: `Unknown thread ${params.threadId}` } });
            return;
          }
          turnSeq += 1;
          const turnId = `turn_e2e_${turnSeq}`;
          const turn = {
            id: turnId,
            threadId: thread.id,
            status: "inProgress",
            items: [],
            summary: `Turn ${turnId} started`,
          };
          thread.turns.push(turn);
          writeReply({ id, result: { turn } });
          return;
        }

        if (method === "thread/read") {
          const thread = threads.get(params.threadId);
          if (!thread) {
            writeReply({ id, error: { code: -32000, message: `Unknown thread ${params.threadId}` } });
            return;
          }
          writeReply({
            id,
            result: {
              thread: {
                ...thread,
                turns: params.includeTurns ? thread.turns.map((t) => ({ ...t })) : [],
              },
            },
          });
          return;
        }

        if (method === "thread/turns/list") {
          const thread = threads.get(params.threadId);
          if (!thread) {
            writeReply({ id, error: { code: -32000, message: `Unknown thread ${params.threadId}` } });
            return;
          }
          const offset = params.cursor ? Number.parseInt(params.cursor, 10) : 0;
          const limit = Number.isInteger(params.limit) && params.limit > 0 ? params.limit : 20;
          const slice = thread.turns.slice(offset, offset + limit).map((t) => ({ ...t }));
          const nextOffset = offset + slice.length;
          const nextCursor = nextOffset < thread.turns.length ? String(nextOffset) : null;
          writeReply({
            id,
            result: {
              data: slice,
              nextCursor,
              backwardsCursor: offset > 0 ? String(Math.max(0, offset - limit)) : null,
            },
          });
          return;
        }

        if (method === "turn/interrupt") {
          const thread = threads.get(params.threadId);
          const turn = thread?.turns.find((t) => t.id === params.turnId);
          writeReply({ id, result: {} });
          if (thread && turn) {
            setTimeout(() => {
              finishTurn(thread.id, turn.id, {
                status: "interrupted",
                summary: `Turn ${turn.id} interrupted cleanly on user cancel.`,
              });
            }, 10);
          }
          return;
        }

        if (method === "account/read") {
          if (accountError) {
            writeReply({ id, error: { code: -32000, message: accountError.message } });
            return;
          }
          writeReply({ id, result: accountResponse });
          return;
        }

        if (method === "account/rateLimits/read") {
          if (rateLimitsError) {
            writeReply({ id, error: { code: -32000, message: rateLimitsError.message } });
            return;
          }
          writeReply({ id, result: rateLimitsResponse });
          return;
        }

        writeReply({ id, error: { code: -32601, message: `Method not found: ${method}` } });
      } catch (err) {
        writeReply({ id, error: { code: -32000, message: err.message } });
      }
    }

    proc.stdin = {
      writable: true,
      write(chunk) {
        if (closed) return false;
        stdinBuffer += String(chunk);
        while (true) {
          const idx = stdinBuffer.indexOf("\n");
          if (idx === -1) break;
          const line = stdinBuffer.slice(0, idx).trim();
          stdinBuffer = stdinBuffer.slice(idx + 1);
          if (!line) continue;
          handleMessage(JSON.parse(line));
        }
        return true;
      },
      end() {
        this.writable = false;
      },
    };
    proc.stdout = stdout;
    proc.stderr = stderr;
    proc.kill = () => {
      closed = true;
      activeProcesses.delete(procState);
      return true;
    };

    return proc;
  }

  return {
    spawnFakeProcess,
    seedThread,
    finishTurn,
    emitRawNotification: emitNotification,
    setAccountResponse(next) {
      accountResponse = next;
      accountError = null;
    },
    setRateLimitsResponse(next) {
      rateLimitsResponse = next;
      rateLimitsError = null;
    },
    setAccountFailure(err) {
      accountError = err;
    },
    setRateLimitsFailure(err) {
      rateLimitsError = err;
    },
  };
}

async function connectMcpClient(bridge) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "codex-e2e-client", version: "0.1.0" });
  await Promise.all([bridge.connect(serverTransport), client.connect(clientTransport)]);
  let closed = false;
  return {
    client,
    async close() {
      if (closed) return;
      closed = true;
      await client.close();
      await bridge.close();
    },
  };
}

function parseToolJson(result) {
  assert.equal(result.isError ?? false, false, `Unexpected MCP tool error: ${JSON.stringify(result)}`);
  assert.ok(result.structuredContent);
  const textBlock = result.content.find((block) => block.type === "text");
  assert.ok(textBlock);
  assert.deepEqual(JSON.parse(textBlock.text), result.structuredContent);
  return result.structuredContent;
}

test("full end-to-end orchestration lifecycle without T3 config", async () => {
  const base = makeTempDir();
  const homeDir = path.join(base, "home");
  fs.mkdirSync(homeDir, { recursive: true });
  const t3LegacyConfigPath = path.join(homeDir, ".t3-orchestration", "config.json");
  const codexRoot = path.join(homeDir, ".t3-orchestration", "codex");
  const configPath = path.join(codexRoot, "config.json");
  const libraryPath = path.join(codexRoot, "libraries", "e2e-app");
  fs.mkdirSync(libraryPath, { recursive: true, mode: 0o700 });
  const repoRoot = await initTempGitRepo(base, "sample-project");

  assert.equal(fs.existsSync(t3LegacyConfigPath), false);

  const backend = createFakeAppServerBackend();
  backend.seedThread("thr-coord-e2e", [
    {
      id: "turn_coord_1",
      threadId: "thr-coord-e2e",
      status: "completed",
      summary: "Coordinator agreed to run parallel read-only checks first.",
    },
  ]);

  const makeBridge = () =>
    createMcpBridge({
      configPath,
      stateRoot: codexRoot,
      hostIdentity: { sessionId: "sess-coord-e2e", threadId: "thr-coord-e2e" },
      pairingCode: "pair-e2e-991",
      appServerFactory: async () => {
        const rpc = createRpc({ spawn: () => backend.spawnFakeProcess(), timeoutMs: 2_000 });
        const srv = createAppServer(rpc);
        await srv.initialize();
        return srv;
      },
    });

  // --- Phase 1: project_setup -> 2 parallel workers -> terminal events + dedupe -> context -> read -> ack ---
  const bridge1 = trackHandle(makeBridge());
  const conn1 = trackHandle(await connectMcpClient(bridge1));

  // Unpaired operational call is denied
  const preSetupList = await conn1.client.callTool({ name: "worker_list", arguments: {} });
  assert.equal(preSetupList.isError, true);

  // Invalid pairing code fails
  const badSetup = await conn1.client.callTool({
    name: "project_setup",
    arguments: {
      name: "e2e-app",
      root: repoRoot,
      pairingCode: "wrong-code",
    },
  });
  assert.equal(badSetup.isError, true);

  // Verified pairing succeeds and creates private config without touching legacy T3 config
  const setupRes = parseToolJson(
    await conn1.client.callTool({
      name: "project_setup",
      arguments: {
        name: "e2e-app",
        root: repoRoot,
        pairingCode: "pair-e2e-991",
        maxWorkers: 2,
        memoryEnabled: true,
        libraryPath,
      },
    }),
  );
  const project = setupRes.project;
  assert.equal(project.name, "e2e-app");
  assert.equal(project.root, repoRoot);
  assert.equal(project.allowWrite, false);
  assert.equal(project.memoryEnabled, true);
  assert.equal(fs.existsSync(t3LegacyConfigPath), false);

  // Verify default read-only blocks unauthorized write launch
  const deniedWrite = await conn1.client.callTool({
    name: "worker_launch",
    arguments: { requestId: "req-write-denied", brief: "Modify code", mode: "write" },
  });
  assert.equal(deniedWrite.isError, true);

  // Initialize project worker service via worker_list, then launch 2 parallel workers
  const initialWorkers = parseToolJson(await conn1.client.callTool({ name: "worker_list", arguments: {} }));
  assert.deepEqual(initialWorkers.workers, []);

  const [launch1Res, launch2Res] = await Promise.all([
    conn1.client.callTool({
      name: "worker_launch",
      arguments: { requestId: "req-w1", brief: "Inspect module A tests" },
    }),
    conn1.client.callTool({
      name: "worker_launch",
      arguments: { requestId: "req-w2", brief: "Inspect module B edge cases" },
    }),
  ]);
  const w1 = parseToolJson(launch1Res).worker;
  const w2 = parseToolJson(launch2Res).worker;
  assert.equal(w1.status, "running");
  assert.equal(w2.status, "running");
  assert.equal(w1.mode, "read");
  assert.equal(w2.mode, "read");
  assert.notEqual(w1.threadId, w2.threadId);

  // Exceeding maxWorkers=2 is rejected while both are running
  const thirdLaunch = await conn1.client.callTool({
    name: "worker_launch",
    arguments: { requestId: "req-w3", brief: "Should exceed cap" },
  });
  assert.equal(thirdLaunch.isError, true);

  // Emit 1 completed (with secret/PII to test redaction) and 1 failed terminal event
  backend.finishTurn(w1.threadId, w1.activeTurnId, {
    status: "completed",
    summary: "Module A passed all checks; ignore sk-proj-secret1234567890abcdef and alice@example.com.",
  });
  backend.finishTurn(w2.threadId, w2.activeTurnId, {
    status: "failed",
    summary: "Module B check failed with sandbox error.",
    error: { message: "Write blocked in read-only mode", codexErrorInfo: "sandboxViolation" },
  });
  // Emit duplicate terminal event for w1 on the exact same turnId -> must dedupe in inbox
  backend.emitRawNotification("turn/completed", {
    threadId: w1.threadId,
    turn: { id: w1.activeTurnId, status: "completed", items: [] },
  });

  await new Promise((resolve) => setTimeout(resolve, 25));

  const inbox1 = parseToolJson(await conn1.client.callTool({ name: "inbox_list", arguments: {} }));
  assert.equal(inbox1.events.length, 2);
  const ev1 = inbox1.events.find((e) => e.workerId === w1.id);
  const ev2 = inbox1.events.find((e) => e.workerId === w2.id);
  assert.ok(ev1 && ev2);
  assert.equal(ev1.status, "completed");
  assert.equal(ev2.status, "failed");
  assert.equal(ev2.errorCode, "sandboxViolation");

  // UserPromptSubmit renderContext surfaces unread IDs without acking and leaves manual threads null
  const loadedCfg = loadConfig(configPath);
  const stateDir = projectStateDir(codexRoot, project.id);
  const snapBeforeAck = readSnapshot(stateDir);

  const ctx = renderContext(
    { hook_event_name: "UserPromptSubmit", session_id: "sess-coord-e2e", thread_id: "thr-coord-e2e" },
    loadedCfg,
    { [project.id]: snapBeforeAck },
  );
  assert.ok(ctx);
  assert.equal(ctx.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  const ctxText = ctx.hookSpecificOutput.additionalContext;
  assert.match(ctxText, /\[T3O_CODEX_COORDINATOR_V1\]/);
  assert.ok(ctxText.includes(ev1.id));
  assert.ok(ctxText.includes(ev2.id));
  assert.ok(!ctxText.includes("sk-proj-secret1234567890abcdef"));
  assert.ok(!ctxText.includes("Module A passed all checks"));

  // Manual thread in same repoRoot stays completely unaffected
  const manualCtx = renderContext(
    { hook_event_name: "UserPromptSubmit", session_id: "sess-manual-user", cwd: repoRoot },
    loadedCfg,
    { [project.id]: snapBeforeAck },
  );
  assert.equal(manualCtx, null);

  // Confirm renderContext never acked events
  const snapStillUnread = readSnapshot(stateDir);
  assert.equal(snapStillUnread.events.filter((e) => e.ackAt === null).length, 2);

  // worker_read inspects evidence and redacts secrets/PII
  const read1 = parseToolJson(
    await conn1.client.callTool({ name: "worker_read", arguments: { workerId: w1.id } }),
  );
  assert.equal(read1.worker.status, "completed");
  assert.equal(read1.turns.length, 1);
  const read1Serialized = JSON.stringify(read1);
  assert.ok(!read1Serialized.includes("sk-proj-secret1234567890abcdef"));
  assert.ok(!read1Serialized.includes("alice@example.com"));

  const read2 = parseToolJson(
    await conn1.client.callTool({ name: "worker_read", arguments: { workerId: w2.id } }),
  );
  assert.equal(read2.worker.status, "failed");
  assert.equal(read2.worker.errorCode, "sandboxViolation");

  // Ack only ev1 before restart so we also verify unread ev2 persists cleanly across restart
  const ack1 = parseToolJson(
    await conn1.client.callTool({ name: "inbox_ack", arguments: { eventIds: [ev1.id] } }),
  );
  assert.deepEqual(ack1.acked, [ev1.id]);
  assert.equal(ack1.newlyAckedCount, 1);

  await conn1.close();

  // --- Phase 2: Simulated restart with explicit openState + createWorkerService + reconcile ---
  {
    const restartedState = openState(stateDir);
    const restartedRpc = createRpc({ spawn: () => backend.spawnFakeProcess(), timeoutMs: 2_000 });
    const restartedApp = createAppServer(restartedRpc);
    await restartedApp.initialize();
    const restartedWorktrees = createWorktreeManager({
      root: repoRoot,
      baseDir: path.join(stateDir, "worktrees"),
      allowWrite: false,
    });
    const restartedService = createWorkerService({
      state: restartedState,
      appServer: restartedApp,
      worktrees: restartedWorktrees,
      maxWorkers: 2,
    });

    try {
      const reconciled = await restartedService.reconcile(project.id);
      assert.equal(reconciled.workers.length, 2);
      const inboxAfterRestart = await restartedService.inbox({ projectId: project.id });
      assert.equal(inboxAfterRestart.length, 1);
      assert.equal(inboxAfterRestart[0].id, ev2.id);
      assert.equal(inboxAfterRestart[0].status, "failed");
    } finally {
      restartedService.dispose();
      restartedApp.close();
      restartedState.close();
    }
  }

  // --- Phase 3: Reconnect MCP bridge -> ack remaining event -> worker_continue + worker_cancel (interrupted) ---
  const bridge2 = trackHandle(makeBridge());
  const conn2 = trackHandle(await connectMcpClient(bridge2));

  const inboxAfterReconnect = parseToolJson(
    await conn2.client.callTool({ name: "inbox_list", arguments: {} }),
  );
  assert.equal(inboxAfterReconnect.events.length, 1);
  assert.equal(inboxAfterReconnect.events[0].id, ev2.id);

  const ack2 = parseToolJson(
    await conn2.client.callTool({ name: "inbox_ack", arguments: { eventIds: [ev2.id] } }),
  );
  assert.deepEqual(ack2.acked, [ev2.id]);
  assert.equal(ack2.newlyAckedCount, 1);

  const continuedRes = parseToolJson(
    await conn2.client.callTool({
      name: "worker_continue",
      arguments: {
        workerId: w1.id,
        requestId: "req-w1-cont",
        brief: "Run extended check that will be cancelled",
      },
    }),
  );
  const continued = continuedRes.worker;
  assert.equal(continued.status, "running");
  assert.ok(continued.activeTurnId);

  const cancelledRes = parseToolJson(
    await conn2.client.callTool({
      name: "worker_cancel",
      arguments: { workerId: w1.id },
    }),
  );
  const cancelled = cancelledRes.worker;
  assert.equal(cancelled.status, "interrupted");
  assert.equal(cancelled.activeTurnId, null);

  const inboxCancelled = parseToolJson(
    await conn2.client.callTool({ name: "inbox_list", arguments: {} }),
  );
  assert.equal(inboxCancelled.events.length, 1);
  assert.equal(inboxCancelled.events[0].status, "interrupted");
  assert.equal(inboxCancelled.events[0].workerId, w1.id);

  parseToolJson(
    await conn2.client.callTool({
      name: "inbox_ack",
      arguments: { eventIds: [inboxCancelled.events[0].id] },
    }),
  );

  // --- Phase 4: account_status handles unknown/null limits and RPC unavailability safely ---
  const knownAcct = parseToolJson(await conn2.client.callTool({ name: "account_status", arguments: {} }));
  assert.equal(knownAcct.authenticated, true);
  assert.equal(knownAcct.accountType, "chatgpt");
  assert.equal(knownAcct.planType, "plus");
  assert.equal(knownAcct.limits.status, "known");
  assert.equal(JSON.stringify(knownAcct).includes("owner@example.invalid"), false);

  backend.setRateLimitsResponse({ rateLimits: { primary: null, secondary: null, planType: null } });
  const nullLimitsAcct = parseToolJson(
    await conn2.client.callTool({ name: "account_status", arguments: {} }),
  );
  assert.equal(nullLimitsAcct.authenticated, true);
  assert.deepEqual(nullLimitsAcct.limits, { status: "unknown", windows: [] });

  backend.setAccountResponse({ account: null, requiresOpenaiAuth: true });
  backend.setRateLimitsFailure(new Error("rate limits unavailable"));
  const unauthAcct = parseToolJson(
    await conn2.client.callTool({ name: "account_status", arguments: {} }),
  );
  assert.equal(unauthAcct.authenticated, false);
  assert.equal(unauthAcct.accountType, "unknown");
  assert.equal(unauthAcct.planType, "unknown");
  assert.deepEqual(unauthAcct.limits, { status: "unknown", windows: [] });

  backend.setAccountFailure(new Error("account unavailable"));
  const unknownAcct = parseToolJson(
    await conn2.client.callTool({ name: "account_status", arguments: {} }),
  );
  assert.equal(unknownAcct.authenticated, "unknown");
  assert.equal(unknownAcct.accountType, "unknown");
  assert.equal(unknownAcct.planType, "unknown");
  assert.deepEqual(unknownAcct.limits, { status: "unknown", windows: [] });

  await conn2.close();

  // --- Phase 5: collectMemory incremental pass + repeat pass creates no duplicate in SQLite/NOTES.md ---
  const memRpc = createRpc({ spawn: () => backend.spawnFakeProcess(), timeoutMs: 2_000 });
  const memApp = createAppServer(memRpc);
  await memApp.initialize();
  try {
    const finalCfg = loadConfig(configPath);
    const finalProject = finalCfg.projects[0];
    const finalSnap = readSnapshot(stateDir);

    const pass1 = await collectMemory({
      project: finalProject,
      state: finalSnap,
      appServer: memApp,
      libraryPath,
      limit: 20,
    });
    // 1 coordinator turn + 2 turns on w1 + 1 turn on w2 = 4 turns
    assert.equal(pass1.complete, true);
    assert.equal(pass1.items.length, 4);
    assert.equal(pass1.recorded.length, 4);
    assert.ok(pass1.items.every((item) => item.source.startsWith("file://")));

    const statusAfterPass1 = await runMemoryCli(libraryPath, "status");
    assert.equal(statusAfterPass1.notes, 4);

    // Publish recorded notes so NOTES.md is generated
    for (const rec of pass1.recorded) {
      const pub = await runMemoryCli(libraryPath, "publish", rec.id);
      assert.equal(pub.status, "published");
    }
    const notesMdAfterPublish = fs.readFileSync(path.join(libraryPath, "NOTES.md"), "utf8");
    const publishedLinksBefore = notesMdAfterPublish
      .split("\n")
      .filter((line) => line.startsWith("- ["));
    assert.equal(publishedLinksBefore.length, 4);

    // Repeat collectMemory pass + publish must create zero duplicates in SQLite and NOTES.md
    const pass2 = await collectMemory({
      project: finalProject,
      state: finalSnap,
      appServer: memApp,
      libraryPath,
      limit: 20,
    });
    assert.equal(pass2.complete, true);
    assert.deepEqual(
      pass2.recorded.map((r) => r.id),
      pass1.recorded.map((r) => r.id),
    );
    const statusAfterPass2 = await runMemoryCli(libraryPath, "status");
    assert.equal(statusAfterPass2.notes, 4);

    await runMemoryCli(libraryPath, "refresh");
    const notesMdAfterRepeat = fs.readFileSync(path.join(libraryPath, "NOTES.md"), "utf8");
    assert.equal(notesMdAfterRepeat, notesMdAfterPublish);
    assert.equal(notesMdAfterRepeat.includes("sk-proj-secret1234567890abcdef"), false);
    assert.equal(notesMdAfterRepeat.includes("alice@example.com"), false);
  } finally {
    memApp.close();
  }

  // Final verification: legacy T3 config remains absent and private permissions hold
  assert.equal(fs.existsSync(t3LegacyConfigPath), false);
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(stateDir, "state.json")).mode & 0o777, 0o600);
});
