import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, test } from "node:test";
import { renderContext, runHookCli } from "../hooks/context.mjs";

const tempDirs = [];

function makeTempDir(prefix = "t3o-ctx-") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const PROJECT_A_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_B_ID = "22222222-2222-4222-8222-222222222222";

function makeConfig(rootA = "/tmp/repo-a", rootB = "/tmp/repo-b") {
  return {
    version: 1,
    projects: [
      {
        id: PROJECT_A_ID,
        name: "project-a",
        root: rootA,
        coordinatorSessionId: "sess-coord-a",
        coordinatorThreadId: "thr-coord-a",
        maxWorkers: 2,
        memoryEnabled: false,
        libraryPath: null,
        allowWrite: false,
      },
      {
        id: PROJECT_B_ID,
        name: "project-b",
        root: rootB,
        coordinatorSessionId: "sess-coord-b",
        coordinatorThreadId: "thr-coord-b",
        maxWorkers: 2,
        memoryEnabled: false,
        libraryPath: null,
        allowWrite: false,
      },
    ],
  };
}

function makeSnapshotA() {
  return {
    version: 1,
    revision: 4,
    workers: {
      "w-1": {
        id: "w-1",
        projectId: PROJECT_A_ID,
        threadId: "thr-worker-a1",
        sessionId: "sess-worker-a1",
        status: "completed",
      },
    },
    events: [
      {
        id: `${PROJECT_A_ID}:w-1:turn-1`,
        projectId: PROJECT_A_ID,
        workerId: "w-1",
        threadId: "thr-worker-a1",
        turnId: "turn-1",
        status: "completed",
        summary: "SECRET_TRANSCRIPT_SHOULD_NOT_APPEAR",
        transcript: "RAW_TRANSCRIPT_SHOULD_NOT_APPEAR",
        createdAt: "2026-11-27T10:00:00.000Z",
        ackAt: null,
      },
      {
        id: `${PROJECT_A_ID}:w-2:turn-2`,
        projectId: PROJECT_A_ID,
        workerId: "w-2",
        threadId: "thr-worker-a2",
        turnId: "turn-2",
        status: "failed",
        errorMessage: "RAW_ERROR_DETAIL_SHOULD_NOT_LEAK",
        createdAt: "2026-11-27T10:01:00.000Z",
        ackAt: null,
      },
      {
        id: `${PROJECT_A_ID}:w-3:turn-3`,
        projectId: PROJECT_A_ID,
        workerId: "w-3",
        threadId: "thr-worker-a3",
        turnId: "turn-3",
        status: "interrupted",
        createdAt: "2026-11-27T10:02:00.000Z",
        ackAt: "2026-11-27T10:03:00.000Z",
      },
    ],
    requests: {},
  };
}

test("renderContext returns null for non-UserPromptSubmit events and malformed inputs", () => {
  const config = makeConfig();
  const snapshot = { [PROJECT_A_ID]: makeSnapshotA() };

  assert.equal(renderContext(null, config, snapshot), null);
  assert.equal(renderContext(undefined, config, snapshot), null);
  assert.equal(renderContext("not-an-object", config, snapshot), null);
  assert.equal(
    renderContext({ hook_event_name: "Stop", session_id: "sess-coord-a" }, config, snapshot),
    null,
  );
  assert.equal(
    renderContext({ hook_event_name: "SessionStart", session_id: "sess-coord-a" }, config, snapshot),
    null,
  );
  assert.equal(
    renderContext({ hook_event_name: "UserPromptSubmit" }, config, snapshot),
    null,
  );
});

test("renderContext excludes manual, subagent, internal, worker, and forged sessions", () => {
  const config = makeConfig();
  const snapshot = { [PROJECT_A_ID]: makeSnapshotA() };

  // Manual thread in same cwd
  assert.equal(
    renderContext(
      { hook_event_name: "UserPromptSubmit", session_id: "sess-manual", cwd: "/tmp/repo-a" },
      config,
      snapshot,
    ),
    null,
  );

  // Worker session
  assert.equal(
    renderContext(
      { hook_event_name: "UserPromptSubmit", session_id: "sess-worker-a1", thread_id: "thr-worker-a1" },
      config,
      snapshot,
    ),
    null,
  );

  // Subagent using coordinator session_id
  assert.equal(
    renderContext(
      { hook_event_name: "UserPromptSubmit", session_id: "sess-coord-a", agent_id: "subagent-1" },
      config,
      snapshot,
    ),
    null,
  );
  assert.equal(
    renderContext(
      { hook_event_name: "UserPromptSubmit", session_id: "sess-coord-a", is_subagent: true },
      config,
      snapshot,
    ),
    null,
  );

  // App internal job
  assert.equal(
    renderContext(
      { hook_event_name: "UserPromptSubmit", session_id: "sess-coord-a", internal: true },
      config,
      snapshot,
    ),
    null,
  );

  // Forged thread_id mismatch
  assert.equal(
    renderContext(
      { hook_event_name: "UserPromptSubmit", session_id: "sess-coord-a", thread_id: "thr-forged" },
      config,
      snapshot,
    ),
    null,
  );
});

test("renderContext emits bounded coordinator context with unread IDs, short statuses, no raw text, and never acks", () => {
  const config = makeConfig();
  const snapA = makeSnapshotA();
  const snapB = {
    version: 1,
    revision: 1,
    workers: {},
    events: [
      {
        id: `${PROJECT_B_ID}:wb-1:turn-1`,
        projectId: PROJECT_B_ID,
        workerId: "wb-1",
        threadId: "thr-wb-1",
        turnId: "turn-1",
        status: "completed",
        createdAt: "2026-11-27T10:00:00.000Z",
        ackAt: null,
      },
    ],
    requests: {},
  };

  const result = renderContext(
    { hook_event_name: "UserPromptSubmit", session_id: "sess-coord-a", thread_id: "thr-coord-a" },
    config,
    { [PROJECT_A_ID]: snapA, [PROJECT_B_ID]: snapB },
  );

  assert.ok(result);
  assert.equal(result.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.match(ctx, /\[T3O_CODEX_COORDINATOR_V1\]/);
  assert.match(ctx, /worker_read/);
  assert.match(ctx, /inbox_ack/);
  assert.match(ctx, /11111111-1111-4111-8111-111111111111:w-1:turn-1/);
  assert.match(ctx, /11111111-1111-4111-8111-111111111111:w-2:turn-2/);
  assert.match(ctx, /completed/);
  assert.match(ctx, /failed/);

  // Must not include already-acked event, cross-project event, or raw transcript/error details
  assert.equal(ctx.includes("w-3:turn-3"), false);
  assert.equal(ctx.includes(PROJECT_B_ID), false);
  assert.equal(ctx.includes("SECRET_TRANSCRIPT_SHOULD_NOT_APPEAR"), false);
  assert.equal(ctx.includes("RAW_TRANSCRIPT_SHOULD_NOT_APPEAR"), false);
  assert.equal(ctx.includes("RAW_ERROR_DETAIL_SHOULD_NOT_LEAK"), false);

  // Must never mutate/ack events
  assert.equal(snapA.events[0].ackAt, null);
  assert.equal(snapA.events[1].ackAt, null);
});

test("renderContext caps unread inbox preview at 20 items", () => {
  const config = makeConfig();
  const events = Array.from({ length: 25 }, (_, i) => ({
    id: `${PROJECT_A_ID}:w-${i}:turn-${i}`,
    projectId: PROJECT_A_ID,
    workerId: `w-${i}`,
    threadId: `thr-${i}`,
    turnId: `turn-${i}`,
    status: i % 2 === 0 ? "completed" : "approval_required",
    createdAt: "2026-11-27T10:00:00.000Z",
    ackAt: null,
  }));

  const result = renderContext(
    { hook_event_name: "UserPromptSubmit", session_id: "sess-coord-a", thread_id: "thr-coord-a" },
    config,
    { [PROJECT_A_ID]: { version: 1, revision: 1, workers: {}, events, requests: {} } },
  );

  const ctx = result.hookSpecificOutput.additionalContext;
  assert.equal(ctx.includes(":w-0:turn-0"), true);
  assert.equal(ctx.includes(":w-19:turn-19"), true);
  assert.equal(ctx.includes(":w-20:turn-20"), false);
  assert.equal(ctx.includes(":w-24:turn-24"), false);
  assert.match(ctx, /25/);
});

test("runHookCli fails open on malformed stdin, missing/corrupt config/state, and stdin timeout <= 1s", async () => {
  const base = makeTempDir();
  const cfgPath = path.join(base, "config.json");
  const stateRoot = base;

  // 1. Corrupt stdin JSON
  {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let out = "";
    stdout.on("data", (chunk) => {
      out += chunk.toString("utf8");
    });
    const pending = runHookCli({ stdin, stdout, configPath: cfgPath, stateRoot, timeoutMs: 200 });
    stdin.end("{bad json");
    await pending;
    assert.deepEqual(JSON.parse(out), {});
  }

  // 2. Hung stdin times out fail-open quickly
  {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let out = "";
    stdout.on("data", (chunk) => {
      out += chunk.toString("utf8");
    });
    const start = Date.now();
    await runHookCli({ stdin, stdout, configPath: cfgPath, stateRoot, timeoutMs: 100 });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 900, `Expected fail-open < 900ms, got ${elapsed}ms`);
    assert.deepEqual(JSON.parse(out), {});
    stdin.destroy();
  }

  // 3. Corrupt config file still fails open without throwing
  {
    fs.writeFileSync(cfgPath, "{corrupt", "utf8");
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let out = "";
    stdout.on("data", (chunk) => {
      out += chunk.toString("utf8");
    });
    const pending = runHookCli({ stdin, stdout, configPath: cfgPath, stateRoot, timeoutMs: 200 });
    stdin.end(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "sess-coord-a" }));
    await pending;
    assert.deepEqual(JSON.parse(out), {});
  }

  // 4. Valid config + corrupt state still emits coordinator marker fail-open without crashing
  {
    const repoA = path.join(base, "repo-a");
    fs.mkdirSync(repoA, { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify(makeConfig(repoA, repoA).projects[0] ? {
      version: 1,
      projects: [{
        id: PROJECT_A_ID,
        name: "project-a",
        root: repoA,
        coordinatorSessionId: "sess-coord-a",
        coordinatorThreadId: "thr-coord-a",
        maxWorkers: 2,
        memoryEnabled: false,
        libraryPath: null,
        allowWrite: false,
      }],
    } : {}), "utf8");
    const stateDir = path.join(stateRoot, "projects", PROJECT_A_ID);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "state.json"), "{corrupt-state", "utf8");

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let out = "";
    stdout.on("data", (chunk) => {
      out += chunk.toString("utf8");
    });
    const pending = runHookCli({ stdin, stdout, configPath: cfgPath, stateRoot, timeoutMs: 200 });
    stdin.end(JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "sess-coord-a",
      thread_id: "thr-coord-a",
    }));
    await pending;
    const parsed = JSON.parse(out);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(parsed.hookSpecificOutput.additionalContext, /\[T3O_CODEX_COORDINATOR_V1\]/);
  }
});
