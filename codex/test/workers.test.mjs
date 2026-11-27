import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";
import { createAppServer } from "../src/app-server.mjs";
import { openState } from "../src/state.mjs";
import { createWorkerService } from "../src/workers.mjs";
import { createWorktreeManager } from "../src/worktrees.mjs";

const execFile = promisify(execFileCallback);

const PROJECT_A = "11111111-1111-4111-8111-111111111111";
const PROJECT_B = "22222222-2222-4222-8222-222222222222";

const tempDirs = [];
const openHandles = [];

function makeTempDir(prefix = "t3o-workers-") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function trackHandle(handle) {
  openHandles.push(handle);
  return handle;
}

afterEach(() => {
  while (openHandles.length > 0) {
    const handle = openHandles.pop();
    try {
      handle.dispose?.();
    } catch {
      // Ignore cleanup errors.
    }
    try {
      handle.close?.();
    } catch {
      // Ignore cleanup errors.
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createMockRpc() {
  const calls = [];
  const notificationListeners = new Set();
  let requestHandler = null;
  const responses = new Map();

  return {
    calls,
    when(method, responder) {
      responses.set(method, responder);
    },
    async request(method, params) {
      calls.push({ type: "request", method, params });
      const responder = responses.get(method);
      if (typeof responder === "function") return responder(params);
      if (responder !== undefined) return responder;
      return {};
    },
    notify(method, params) {
      calls.push({ type: "notify", method, params });
    },
    onNotification(fn) {
      notificationListeners.add(fn);
      return () => notificationListeners.delete(fn);
    },
    onRequest(fn) {
      requestHandler = fn;
      return () => {
        if (requestHandler === fn) requestHandler = null;
      };
    },
    emitNotification(method, params) {
      for (const fn of [...notificationListeners]) {
        fn({ method, params });
      }
    },
    async simulateServerRequest(req) {
      if (!requestHandler) return { error: { code: -32601, message: "Method not found" } };
      const result = await requestHandler(req);
      return { result };
    },
    close() {},
  };
}

function createClock(startMs = Date.UTC(2026, 10, 27, 15, 0, 0)) {
  let tick = 0;
  return () => {
    const iso = new Date(startMs + tick * 1000).toISOString();
    tick += 1;
    return iso;
  };
}

async function initTempGitRepo(parentDir, name = "repo") {
  const repoDir = path.join(parentDir, name);
  fs.mkdirSync(repoDir, { recursive: true });
  await execFile("git", ["init", "-b", "main"], { cwd: repoDir });
  await execFile("git", ["config", "user.email", "test@example.invalid"], { cwd: repoDir });
  await execFile("git", ["config", "user.name", "Test User"], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, "README.md"), "# Test repo\n", "utf8");
  await execFile("git", ["add", "README.md"], { cwd: repoDir });
  await execFile("git", ["commit", "-m", "initial"], { cwd: repoDir });
  return fs.realpathSync(repoDir);
}

function createTestHarness({ allowWrite = false, maxWorkers = 2 } = {}) {
  const base = makeTempDir();
  const repoRoot = path.join(base, "repo");
  fs.mkdirSync(repoRoot, { recursive: true });
  const stateDir = path.join(base, "state");
  const worktreeBase = path.join(base, "worktrees");

  const state = trackHandle(openState(stateDir));
  const rpc = createMockRpc();
  const appServer = trackHandle(createAppServer(rpc));
  const worktrees = createWorktreeManager({
    root: repoRoot,
    baseDir: worktreeBase,
    allowWrite,
  });
  const service = trackHandle(
    createWorkerService({
      state,
      appServer,
      worktrees,
      clock: createClock(),
      maxWorkers,
    }),
  );

  return { base, repoRoot, stateDir, worktreeBase, state, rpc, appServer, worktrees, service };
}

test("1. launches registered worker with threadId and read mode, and reads paginated turns", async () => {
  const { repoRoot, rpc, service } = createTestHarness();
  rpc.when("thread/start", { thread: { id: "thr_read_1" } });
  rpc.when("turn/start", { turn: { id: "turn_read_1", status: "inProgress" } });
  rpc.when("thread/turns/list", {
    data: [{ id: "turn_read_1", status: "inProgress", items: [] }],
    nextCursor: "cur_2",
  });

  const worker = await service.launch({
    projectId: PROJECT_A,
    requestId: "req-1",
    brief: "Inspect repository structure",
    mode: "read",
  });

  assert.equal(worker.projectId, PROJECT_A);
  assert.equal(worker.threadId, "thr_read_1");
  assert.equal(worker.activeTurnId, "turn_read_1");
  assert.equal(worker.mode, "read");
  assert.equal(worker.status, "running");
  assert.equal(worker.cwd, repoRoot);
  assert.equal(worker.worktree, null);
  assert.deepEqual(worker.writableRoots, []);

  const listed = await service.list(PROJECT_A);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, worker.id);

  const threadStartCall = rpc.calls.find((c) => c.method === "thread/start");
  assert.equal(threadStartCall.params.sandbox, "read-only");
  assert.equal(threadStartCall.params.cwd, repoRoot);

  const turnStartCall = rpc.calls.find((c) => c.method === "turn/start");
  assert.deepEqual(turnStartCall.params.sandboxPolicy, { type: "readOnly" });

  const readRes = await service.read({
    projectId: PROJECT_A,
    workerId: worker.id,
    cursor: "cur_1",
    limit: 10,
  });
  assert.equal(readRes.worker.id, worker.id);
  assert.equal(readRes.turns.length, 1);
  assert.equal(readRes.nextCursor, "cur_2");
});

test("2. duplicate requestId with same payload returns same record without replay; different payload rejects", async () => {
  const { rpc, service } = createTestHarness();
  let threadCalls = 0;
  let turnCalls = 0;
  rpc.when("thread/start", () => {
    threadCalls += 1;
    return { thread: { id: `thr_${threadCalls}` } };
  });
  rpc.when("turn/start", () => {
    turnCalls += 1;
    return { turn: { id: `turn_${turnCalls}`, status: "inProgress" } };
  });

  const first = await service.launch({
    projectId: PROJECT_A,
    requestId: "req-idemp",
    brief: "Check tests",
    mode: "read",
  });
  const replay = await service.launch({
    projectId: PROJECT_A,
    requestId: "req-idemp",
    brief: "Check tests",
    mode: "read",
  });

  assert.deepEqual(replay, first);
  assert.equal(threadCalls, 1);
  assert.equal(turnCalls, 1);

  await assert.rejects(
    () =>
      service.launch({
        projectId: PROJECT_A,
        requestId: "req-idemp",
        brief: "Mutated brief",
        mode: "read",
      }),
    /requestId|mismatch|conflict/i,
  );
  await assert.rejects(
    () =>
      service.launch({
        projectId: PROJECT_A,
        requestId: "req-idemp",
        brief: "Check tests",
        mode: "write",
        authorized: true,
      }),
    /requestId|mismatch|conflict/i,
  );
  assert.equal(threadCalls, 1);
  assert.equal(turnCalls, 1);

  // Complete turn_1 and verify continue requestId idempotency too
  rpc.emitNotification("turn/completed", {
    threadId: "thr_1",
    turn: { id: "turn_1", status: "completed" },
  });

  const cont1 = await service.continue({
    projectId: PROJECT_A,
    workerId: first.id,
    requestId: "req-cont-1",
    brief: "Follow-up inspection",
  });
  const contReplay = await service.continue({
    projectId: PROJECT_A,
    workerId: first.id,
    requestId: "req-cont-1",
    brief: "Follow-up inspection",
  });
  assert.deepEqual(contReplay, cont1);
  assert.equal(turnCalls, 2);

  await assert.rejects(
    () =>
      service.continue({
        projectId: PROJECT_A,
        workerId: first.id,
        requestId: "req-cont-1",
        brief: "Different follow-up",
      }),
    /requestId|mismatch|conflict/i,
  );
  assert.equal(turnCalls, 2);
});

test("3. pending intent (status: creating) is persisted before worktrees.prepare and startThread RPC", async () => {
  const { state, rpc, worktrees, service } = createTestHarness();
  const observedStatuses = [];

  const wrappedWorktrees = {
    async prepare(args) {
      const snap = state.read();
      const pending = snap.workers[args.workerId];
      observedStatuses.push({ stage: "worktrees.prepare", status: pending?.status });
      return worktrees.prepare(args);
    },
    inspect: worktrees.inspect,
  };

  const appServer = trackHandle(createAppServer(rpc));
  const localService = trackHandle(
    createWorkerService({
      state,
      appServer,
      worktrees: wrappedWorktrees,
      clock: createClock(),
    }),
  );

  let releaseStartThread;
  const startThreadGate = new Promise((resolve) => {
    releaseStartThread = resolve;
  });

  rpc.when("thread/start", async () => {
    const snap = state.read();
    const workers = Object.values(snap.workers);
    observedStatuses.push({
      stage: "thread/start",
      count: workers.length,
      status: workers[0]?.status,
      threadId: workers[0]?.threadId,
    });
    await startThreadGate;
    return { thread: { id: "thr_pending_1" } };
  });

  rpc.when("turn/start", () => {
    const snap = state.read();
    const workers = Object.values(snap.workers);
    observedStatuses.push({
      stage: "turn/start",
      status: workers[0]?.status,
      threadId: workers[0]?.threadId,
    });
    return { turn: { id: "turn_pending_1", status: "inProgress" } };
  });

  const launchPromise = localService.launch({
    projectId: PROJECT_A,
    requestId: "req-pending",
    brief: "Observe creating intent",
  });

  // Yield briefly so launch reaches startThreadGate, then inspect via service.list()
  await new Promise((r) => setTimeout(r, 10));
  const liveList = await localService.list(PROJECT_A);
  assert.equal(liveList.length, 1);
  assert.equal(liveList[0].status, "creating");

  releaseStartThread();
  const launched = await launchPromise;
  assert.equal(launched.status, "running");

  assert.deepEqual(observedStatuses[0], { stage: "worktrees.prepare", status: "creating" });
  assert.deepEqual(observedStatuses[1], {
    stage: "thread/start",
    count: 1,
    status: "creating",
    threadId: null,
  });
  assert.deepEqual(observedStatuses[2], {
    stage: "turn/start",
    status: "starting",
    threadId: "thr_pending_1",
  });
});

test("4. uncertain thread/start or turn/start sets recovery_required without automatic duplicate", async () => {
  const { state, rpc, service } = createTestHarness();
  let startThreadAttempts = 0;
  let startTurnAttempts = 0;

  rpc.when("thread/start", () => {
    startThreadAttempts += 1;
    throw new Error("RPC connection dropped during thread/start");
  });

  await assert.rejects(
    () =>
      service.launch({
        projectId: PROJECT_A,
        requestId: "req-fail-thread",
        brief: "Crash on thread/start",
      }),
    /dropped|thread\/start/i,
  );
  assert.equal(startThreadAttempts, 1);

  const afterThreadFail = await service.list(PROJECT_A);
  assert.equal(afterThreadFail.length, 1);
  assert.equal(afterThreadFail[0].status, "recovery_required");
  assert.equal(afterThreadFail[0].threadId, null);

  // Replaying same requestId returns recovery_required record without calling startThread again
  const replayFailedThread = await service.launch({
    projectId: PROJECT_A,
    requestId: "req-fail-thread",
    brief: "Crash on thread/start",
  });
  assert.equal(replayFailedThread.status, "recovery_required");
  assert.equal(startThreadAttempts, 1);

  // Now simulate startThread succeeding and turn/start timing out
  rpc.when("thread/start", () => {
    startThreadAttempts += 1;
    return { thread: { id: "thr_turn_fail" } };
  });
  rpc.when("turn/start", () => {
    startTurnAttempts += 1;
    throw new Error("RPC timeout during turn/start");
  });

  await assert.rejects(
    () =>
      service.launch({
        projectId: PROJECT_A,
        requestId: "req-fail-turn",
        brief: "Crash on turn/start",
      }),
    /timeout|turn\/start/i,
  );
  assert.equal(startThreadAttempts, 2);
  assert.equal(startTurnAttempts, 1);

  const snap = state.read();
  const workers = Object.values(snap.workers);
  assert.equal(workers.length, 2);
  const secondWorker = workers.find((w) => w.threadId === "thr_turn_fail");
  assert.equal(secondWorker.status, "recovery_required");
  assert.equal(secondWorker.activeTurnId, null);
});

test("5. early terminal event arriving before turn/start response resolves is reconciled cleanly", async () => {
  const { rpc, service } = createTestHarness();
  rpc.when("thread/start", { thread: { id: "thr_early_1" } });
  rpc.when("turn/start", async () => {
    // Server emits turn/completed before RPC response to turn/start returns to caller
    rpc.emitNotification("turn/completed", {
      threadId: "thr_early_1",
      turn: { id: "turn_early_1", status: "completed" },
    });
    return { turn: { id: "turn_early_1", status: "inProgress" } };
  });

  const worker = await service.launch({
    projectId: PROJECT_A,
    requestId: "req-early",
    brief: "Fast turn completing before RPC reply",
  });

  assert.equal(worker.status, "completed");
  assert.equal(worker.activeTurnId, null);

  const events = await service.inbox({ projectId: PROJECT_A });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    id: `${PROJECT_A}:${worker.id}:turn_early_1`,
    projectId: PROJECT_A,
    workerId: worker.id,
    threadId: "thr_early_1",
    turnId: "turn_early_1",
    status: "completed",
    createdAt: events[0].createdAt,
    ackAt: null,
  });
});

test("6. duplicate terminal event for same turnId produces exactly 1 event", async () => {
  const { rpc, service } = createTestHarness();
  rpc.when("thread/start", { thread: { id: "thr_dup" } });
  rpc.when("turn/start", { turn: { id: "turn_dup", status: "inProgress" } });

  const worker = await service.launch({
    projectId: PROJECT_A,
    requestId: "req-dup",
    brief: "Check duplicate terminal events",
  });

  for (let i = 0; i < 3; i += 1) {
    rpc.emitNotification("turn/completed", {
      threadId: "thr_dup",
      turn: { id: "turn_dup", status: "completed" },
    });
  }

  const events = await service.inbox({ projectId: PROJECT_A });
  assert.equal(events.length, 1);
  assert.equal(events[0].id, `${PROJECT_A}:${worker.id}:turn_dup`);

  const workers = await service.list(PROJECT_A);
  assert.equal(workers[0].status, "completed");
});

test("7. old turn terminal event cannot overwrite newer active or completed turn state", async () => {
  const { rpc, service } = createTestHarness();
  let turnNum = 0;
  rpc.when("thread/start", { thread: { id: "thr_order" } });
  rpc.when("turn/start", () => {
    turnNum += 1;
    return { turn: { id: `turn_${turnNum}`, status: "inProgress" } };
  });

  const worker = await service.launch({
    projectId: PROJECT_A,
    requestId: "req-order-1",
    brief: "Turn 1",
  });
  rpc.emitNotification("turn/completed", {
    threadId: "thr_order",
    turn: { id: "turn_1", status: "completed" },
  });

  const continued = await service.continue({
    projectId: PROJECT_A,
    workerId: worker.id,
    requestId: "req-order-2",
    brief: "Turn 2",
  });
  assert.equal(continued.status, "running");
  assert.equal(continued.activeTurnId, "turn_2");

  // Stale terminal event for turn_1 with failed status must NOT overwrite running turn_2
  rpc.emitNotification("turn/completed", {
    threadId: "thr_order",
    turn: { id: "turn_1", status: "failed", error: { codexErrorInfo: "other" } },
  });

  let current = (await service.list(PROJECT_A))[0];
  assert.equal(current.status, "running");
  assert.equal(current.activeTurnId, "turn_2");

  // Complete turn_2, then send another late turn_1 failure
  rpc.emitNotification("turn/completed", {
    threadId: "thr_order",
    turn: { id: "turn_2", status: "completed" },
  });
  rpc.emitNotification("turn/completed", {
    threadId: "thr_order",
    turn: { id: "turn_1", status: "failed", error: { codexErrorInfo: "other" } },
  });

  current = (await service.list(PROJECT_A))[0];
  assert.equal(current.status, "completed");
  assert.equal(current.activeTurnId, null);

  const events = await service.inbox({ projectId: PROJECT_A });
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((e) => [e.turnId, e.status]),
    [
      ["turn_1", "completed"],
      ["turn_2", "completed"],
    ],
  );
});

test("8. restart reconcile retains unread events and reconciles known threadId without blind relaunch", async () => {
  const base = makeTempDir();
  const repoRoot = path.join(base, "repo");
  fs.mkdirSync(repoRoot, { recursive: true });
  const stateDir = path.join(base, "state");
  const worktreeBase = path.join(base, "worktrees");
  const worktrees = createWorktreeManager({ root: repoRoot, baseDir: worktreeBase, allowWrite: false });

  // Phase 1: initial service creates w1 (completed, unread), w2 (running before crash), w3 (creating without threadId)
  const state1 = openState(stateDir);
  const rpc1 = createMockRpc();
  const app1 = createAppServer(rpc1);
  const svc1 = createWorkerService({ state: state1, appServer: app1, worktrees, clock: createClock(), maxWorkers: 4 });

  let threadCounter = 0;
  let turnCounter = 0;
  rpc1.when("thread/start", () => {
    threadCounter += 1;
    return { thread: { id: `thr_rec_${threadCounter}` } };
  });
  rpc1.when("turn/start", () => {
    turnCounter += 1;
    return { turn: { id: `turn_rec_${turnCounter}`, status: "inProgress" } };
  });

  const w1 = await svc1.launch({ projectId: PROJECT_A, requestId: "rec-1", brief: "Completed before crash" });
  rpc1.emitNotification("turn/completed", {
    threadId: "thr_rec_1",
    turn: { id: "turn_rec_1", status: "completed" },
  });

  const w2 = await svc1.launch({ projectId: PROJECT_A, requestId: "rec-2", brief: "In-flight during crash" });
  // Simulate a third worker that crashed before thread/start returned
  state1.transact((draft) => {
    draft.workers["orphan-w3"] = {
      id: "orphan-w3",
      projectId: PROJECT_A,
      threadId: null,
      worktree: null,
      cwd: null,
      writableRoots: [],
      mode: "read",
      status: "creating",
      activeTurnId: null,
      lastTurnId: null,
      turnOrder: [],
      requestId: "rec-3",
      brief: "Orphan creating intent",
      createdAt: "2026-11-27T15:00:00.000Z",
      updatedAt: "2026-11-27T15:00:00.000Z",
    };
  });

  svc1.dispose();
  app1.close();
  state1.close();

  // Phase 2: restart with fresh state handle & appServer
  const state2 = trackHandle(openState(stateDir));
  const rpc2 = createMockRpc();
  const app2 = trackHandle(createAppServer(rpc2));
  const svc2 = trackHandle(
    createWorkerService({ state: state2, appServer: app2, worktrees, clock: createClock(), maxWorkers: 4 }),
  );

  rpc2.when("thread/read", ({ threadId }) => ({
    thread: { id: threadId, status: { type: "idle" }, turns: [] },
  }));
  rpc2.when("thread/turns/list", ({ threadId }) => {
    if (threadId === "thr_rec_2") {
      return {
        data: [{ id: "turn_rec_2", status: "completed", items: [] }],
        nextCursor: null,
      };
    }
    return { data: [], nextCursor: null };
  });

  await svc2.reconcile(PROJECT_A);
  // Idempotent second reconcile must not emit duplicate events
  await svc2.reconcile(PROJECT_A);

  // Never blindly relaunch
  assert.equal(rpc2.calls.some((c) => c.method === "thread/start" || c.method === "turn/start"), false);

  const workersAfter = await svc2.list(PROJECT_A);
  const afterW1 = workersAfter.find((w) => w.id === w1.id);
  const afterW2 = workersAfter.find((w) => w.id === w2.id);
  const afterW3 = workersAfter.find((w) => w.id === "orphan-w3");

  assert.equal(afterW1.status, "completed");
  assert.equal(afterW2.status, "completed");
  assert.equal(afterW2.activeTurnId, null);
  assert.equal(afterW3.status, "recovery_required");

  const unread = await svc2.inbox({ projectId: PROJECT_A });
  assert.equal(unread.length, 2);
  assert.deepEqual(
    unread.map((e) => e.turnId),
    ["turn_rec_1", "turn_rec_2"],
  );
});

test("9. ack is idempotent and cross-project worker/event access is denied", async () => {
  const { rpc, service } = createTestHarness();
  let n = 0;
  rpc.when("thread/start", () => {
    n += 1;
    return { thread: { id: `thr_iso_${n}` } };
  });
  rpc.when("turn/start", () => ({ turn: { id: `turn_iso_${n}`, status: "inProgress" } }));

  const wA = await service.launch({ projectId: PROJECT_A, requestId: "iso-a", brief: "Project A" });
  const wB = await service.launch({ projectId: PROJECT_B, requestId: "iso-b", brief: "Project B" });

  rpc.emitNotification("turn/completed", { threadId: "thr_iso_1", turn: { id: "turn_iso_1", status: "completed" } });
  rpc.emitNotification("turn/completed", { threadId: "thr_iso_2", turn: { id: "turn_iso_2", status: "completed" } });

  assert.deepEqual((await service.list(PROJECT_A)).map((w) => w.id), [wA.id]);
  assert.deepEqual((await service.list(PROJECT_B)).map((w) => w.id), [wB.id]);

  // Cross-project read / continue / cancel denied
  await assert.rejects(() => service.read({ projectId: PROJECT_A, workerId: wB.id }));
  await assert.rejects(() =>
    service.continue({ projectId: PROJECT_A, workerId: wB.id, requestId: "x-cont", brief: "Hijack" }),
  );
  await assert.rejects(() => service.cancel({ projectId: PROJECT_A, workerId: wB.id }));

  const inboxA = await service.inbox({ projectId: PROJECT_A });
  const inboxB = await service.inbox({ projectId: PROJECT_B });
  assert.equal(inboxA.length, 1);
  assert.equal(inboxB.length, 1);

  // Cross-project ack and unknown eventId rejected atomically
  await assert.rejects(() => service.ack({ projectId: PROJECT_A, eventIds: [inboxB[0].id] }));
  await assert.rejects(() => service.ack({ projectId: PROJECT_A, eventIds: [inboxA[0].id, "unknown:event:id"] }));
  assert.equal((await service.inbox({ projectId: PROJECT_A })).length, 1);
  assert.equal((await service.inbox({ projectId: PROJECT_B })).length, 1);

  // Owned ack works and is idempotent
  await service.ack({ projectId: PROJECT_A, eventIds: [inboxA[0].id] });
  assert.equal((await service.inbox({ projectId: PROJECT_A })).length, 0);
  await service.ack({ projectId: PROJECT_A, eventIds: [inboxA[0].id] });
  assert.equal((await service.inbox({ projectId: PROJECT_A })).length, 0);
  assert.equal((await service.inbox({ projectId: PROJECT_B })).length, 1);
});

test("10. failed and interrupted terminal statuses remain distinct from completed", async () => {
  const { rpc, service } = createTestHarness();
  let idx = 0;
  rpc.when("thread/start", () => {
    idx += 1;
    return { thread: { id: `thr_status_${idx}` } };
  });
  rpc.when("turn/start", () => ({ turn: { id: `turn_status_${idx}`, status: "inProgress" } }));

  const wFail = await service.launch({ projectId: PROJECT_A, requestId: "req-fail", brief: "Will fail" });
  const wInt = await service.launch({ projectId: PROJECT_A, requestId: "req-int", brief: "Will interrupt" });

  rpc.emitNotification("turn/completed", {
    threadId: "thr_status_1",
    turn: {
      id: "turn_status_1",
      status: "failed",
      error: { message: "Rate limit", codexErrorInfo: "rateLimitExceeded" },
    },
  });
  rpc.emitNotification("turn/completed", {
    threadId: "thr_status_2",
    turn: { id: "turn_status_2", status: "interrupted" },
  });

  const workers = await service.list(PROJECT_A);
  const failedWorker = workers.find((w) => w.id === wFail.id);
  const intWorker = workers.find((w) => w.id === wInt.id);

  assert.equal(failedWorker.status, "failed");
  assert.equal("taskDone" in failedWorker, false);
  assert.equal(intWorker.status, "interrupted");
  assert.equal("taskDone" in intWorker, false);

  const events = await service.inbox({ projectId: PROJECT_A });
  assert.equal(events.length, 2);
  assert.equal(events[0].status, "failed");
  assert.equal(events[0].errorCode, "rateLimitExceeded");
  assert.equal(events[1].status, "interrupted");
  assert.equal("taskDone" in events[0], false);
});

test("11. terminal event for unknown threadId emits nothing and mutates no worker", async () => {
  const { state, rpc, service } = createTestHarness();

  rpc.emitNotification("turn/completed", {
    threadId: "thr_unregistered_external",
    turn: { id: "turn_ext_1", status: "completed" },
  });

  assert.equal((await service.inbox({ projectId: PROJECT_A })).length, 0);
  assert.equal(state.read().events.length, 0);
  assert.equal(Object.keys(state.read().workers).length, 0);
});

test("12. maxWorkers (2) cap is enforced even under concurrent Promise.all launches", async () => {
  const { rpc, service } = createTestHarness({ maxWorkers: 2 });
  let threadSeq = 0;
  let turnSeq = 0;

  rpc.when("thread/start", async () => {
    await new Promise((r) => setTimeout(r, 15));
    threadSeq += 1;
    return { thread: { id: `thr_cap_${threadSeq}` } };
  });
  rpc.when("turn/start", async () => {
    await new Promise((r) => setTimeout(r, 15));
    turnSeq += 1;
    return { turn: { id: `turn_cap_${turnSeq}`, status: "inProgress" } };
  });

  const results = await Promise.allSettled([
    service.launch({ projectId: PROJECT_A, requestId: "cap-1", brief: "Worker 1" }),
    service.launch({ projectId: PROJECT_A, requestId: "cap-2", brief: "Worker 2" }),
    service.launch({ projectId: PROJECT_A, requestId: "cap-3", brief: "Worker 3" }),
    service.launch({ projectId: PROJECT_A, requestId: "cap-4", brief: "Worker 4" }),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 2);
  assert.equal(rejected.length, 2);
  assert.equal(threadSeq, 2);
  assert.equal((await service.list(PROJECT_A)).length, 2);

  // Completing one active worker frees a slot for a 3rd launch
  rpc.emitNotification("turn/completed", {
    threadId: fulfilled[0].value.threadId,
    turn: { id: fulfilled[0].value.activeTurnId, status: "completed" },
  });

  const third = await service.launch({ projectId: PROJECT_A, requestId: "cap-5", brief: "Worker 5" });
  assert.equal(third.status, "running");
  assert.equal((await service.list(PROJECT_A)).length, 3);
});

test("13. cancel sends turn/interrupt and waits for actual terminal event without fabricating completion", async () => {
  const { rpc, service } = createTestHarness();
  rpc.when("thread/start", { thread: { id: "thr_cancel" } });
  rpc.when("turn/start", { turn: { id: "turn_cancel", status: "inProgress" } });
  rpc.when("turn/interrupt", {});

  const worker = await service.launch({
    projectId: PROJECT_A,
    requestId: "req-cancel",
    brief: "Long running task",
  });

  let cancelSettled = false;
  const cancelPromise = service.cancel({ projectId: PROJECT_A, workerId: worker.id }).then((res) => {
    cancelSettled = true;
    return res;
  });

  await new Promise((r) => setTimeout(r, 15));
  const interruptCall = rpc.calls.find((c) => c.method === "turn/interrupt");
  assert.deepEqual(interruptCall.params, { threadId: "thr_cancel", turnId: "turn_cancel" });
  assert.equal(cancelSettled, false);
  assert.equal((await service.list(PROJECT_A))[0].status, "running");
  assert.equal((await service.inbox({ projectId: PROJECT_A })).length, 0);

  rpc.emitNotification("turn/completed", {
    threadId: "thr_cancel",
    turn: { id: "turn_cancel", status: "interrupted" },
  });

  const cancelled = await cancelPromise;
  assert.equal(cancelSettled, true);
  assert.equal(cancelled.status, "interrupted");
  assert.equal(cancelled.activeTurnId, null);

  const inbox = await service.inbox({ projectId: PROJECT_A });
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].status, "interrupted");
});

test("14. write mode rejects unless authorized, and authorized write uses worktrees.prepare and writableRoots", async () => {
  const base = makeTempDir();
  const repoRoot = await initTempGitRepo(base);
  const state = trackHandle(openState(path.join(base, "state")));
  const rpc = createMockRpc();
  const appServer = trackHandle(createAppServer(rpc));
  const worktrees = createWorktreeManager({
    root: repoRoot,
    baseDir: path.join(base, "worktrees"),
    allowWrite: true,
  });
  const service = trackHandle(
    createWorkerService({ state, appServer, worktrees, clock: createClock() }),
  );

  rpc.when("thread/start", { thread: { id: "thr_write_1" } });
  rpc.when("turn/start", { turn: { id: "turn_write_1", status: "inProgress" } });

  // Unauthorized write attempts reject BEFORE creating state or calling thread/start
  for (const auth of [false, undefined, null, "true", 1]) {
    await assert.rejects(
      () =>
        service.launch({
          projectId: PROJECT_A,
          requestId: `req-unauth-${String(auth)}`,
          brief: "Unauthorized write",
          mode: "write",
          authorized: auth,
        }),
      /authoriz/i,
    );
  }
  assert.equal((await service.list(PROJECT_A)).length, 0);
  assert.equal(rpc.calls.length, 0);

  // Authorized write prepares isolated worktree and passes writableRoots
  const worker = await service.launch({
    projectId: PROJECT_A,
    requestId: "req-auth-write",
    brief: "Modify README in isolated worktree",
    mode: "write",
    authorized: true,
  });

  assert.equal(worker.mode, "write");
  assert.ok(worker.worktree);
  assert.equal(worker.cwd, worker.worktree);
  assert.deepEqual(worker.writableRoots, [worker.worktree]);
  assert.notEqual(worker.worktree, repoRoot);

  const threadStartCall = rpc.calls.find((c) => c.method === "thread/start");
  assert.equal(threadStartCall.params.sandbox, "workspace-write");
  assert.equal(threadStartCall.params.cwd, worker.worktree);

  const turnStartCall = rpc.calls.find((c) => c.method === "turn/start");
  assert.deepEqual(turnStartCall.params.sandboxPolicy, {
    type: "workspaceWrite",
    writableRoots: [worker.worktree],
  });
});

test("15. onApprovalRequest records pending approval_required metadata without auto-approving", async () => {
  const { rpc, service } = createTestHarness();
  rpc.when("thread/start", { thread: { id: "thr_appr" } });
  rpc.when("turn/start", { turn: { id: "turn_appr", status: "inProgress" } });

  const worker = await service.launch({
    projectId: PROJECT_A,
    requestId: "req-appr",
    brief: "Task that triggers approval",
  });

  const serverRes = await rpc.simulateServerRequest({
    id: 42,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thr_appr",
      turnId: "turn_appr",
      itemId: "item_9",
      reason: "Needs shell execution",
    },
  });
  assert.deepEqual(serverRes, { result: { decision: "decline" } });

  const updated = (await service.list(PROJECT_A)).find((w) => w.id === worker.id);
  assert.equal(updated.approvalRequired, true);
  assert.equal(updated.pendingApproval.status, "approval_required");
  assert.equal(updated.pendingApproval.method, "item/commandExecution/requestApproval");
  assert.equal(updated.pendingApproval.turnId, "turn_appr");
});

test("16. launch persists worker.sessionId, passes worker developerInstructions and disables t3o_codex MCP in worker config", async () => {
  const { rpc, service } = createTestHarness();
  rpc.when("thread/start", { thread: { id: "thr_iso_1", sessionId: "sess_iso_1" } });
  rpc.when("turn/start", { turn: { id: "turn_iso_1", status: "inProgress" } });

  const worker = await service.launch({
    projectId: PROJECT_A,
    requestId: "req-iso-1",
    brief: "Read-only check",
  });

  assert.equal(worker.threadId, "thr_iso_1");
  assert.equal(worker.sessionId, "sess_iso_1");

  const startThreadCall = rpc.calls.find((c) => c.method === "thread/start");
  assert.match(startThreadCall.params.developerInstructions ?? "", /\[T3O_CODEX_WORKER_V1\]/);
  assert.equal(startThreadCall.params.config?.mcp_servers?.t3o_codex?.enabled, false);
});

test("17. pre-thread worktree failure marks failed (not recovery_required) and resolve frees recovery_required slots", async () => {
  const base = makeTempDir();
  const state = trackHandle(openState(path.join(base, "state")));
  const rpc = createMockRpc();
  const appServer = trackHandle(createAppServer(rpc));
  let shouldFailPrepare = true;
  const worktrees = {
    async prepare() {
      if (shouldFailPrepare) throw new Error("not a git repository");
      return { mode: "read", cwd: base, worktree: null, writableRoots: [] };
    },
  };
  const service = trackHandle(createWorkerService({ state, appServer, worktrees, maxWorkers: 1 }));

  await assert.rejects(
    () => service.launch({ projectId: PROJECT_A, requestId: "req-prep-fail", brief: "prep fail" }),
    /not a git repository/,
  );

  // Pre-thread prepare failure must NOT lock the maxWorkers=1 slot
  shouldFailPrepare = false;
  rpc.when("thread/start", async () => {
    throw new Error("RPC timeout");
  });
  await assert.rejects(
    () => service.launch({ projectId: PROJECT_A, requestId: "req-rpc-fail", brief: "rpc fail" }),
    /RPC timeout/,
  );

  const stuck = (await service.list(PROJECT_A)).find((w) => w.requestId === "req-rpc-fail");
  assert.equal(stuck.status, "recovery_required");

  // Slot is full until resolved
  await assert.rejects(
    () => service.launch({ projectId: PROJECT_A, requestId: "req-blocked", brief: "blocked" }),
    /Worker limit reached/,
  );

  const resolved = await service.resolve({
    projectId: PROJECT_A,
    workerId: stuck.id,
    resolution: "failed",
    reason: "Operator confirmed orphan thread absent",
  });
  assert.equal(resolved.status, "failed");

  rpc.when("thread/start", { thread: { id: "thr_after_resolve", sessionId: "sess_after" } });
  rpc.when("turn/start", { turn: { id: "turn_after_resolve", status: "inProgress" } });
  const fresh = await service.launch({ projectId: PROJECT_A, requestId: "req-after-resolve", brief: "works now" });
  assert.equal(fresh.status, "running");
});

test("18. early terminal event is reconciled even if turn/start times out, and non-terminal turn/completed is ignored", async () => {
  const { rpc, service } = createTestHarness();
  rpc.when("thread/start", { thread: { id: "thr_early_err", sessionId: "sess_early_err" } });
  rpc.when("turn/start", async () => {
    // Non-terminal notification must be ignored
    rpc.emitNotification("turn/completed", {
      threadId: "thr_early_err",
      turn: { id: "turn_early_err", status: "inProgress" },
    });
    // Real terminal arrives before RPC reply fails/times out
    rpc.emitNotification("turn/completed", {
      threadId: "thr_early_err",
      turn: { id: "turn_early_err", status: "completed" },
    });
    throw new Error("ETIMEDOUT waiting for turn/start");
  });

  const worker = await service.launch({
    projectId: PROJECT_A,
    requestId: "req-early-timeout",
    brief: "Early terminal with lost startTurn response",
  });
  assert.equal(worker.status, "completed");
  assert.equal(worker.lastTurnId, "turn_early_err");
  const inbox = await service.inbox({ projectId: PROJECT_A });
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].status, "completed");
});

test("19. cancel returns terminal worker if turn completes right before interrupt rejects, and reconcile fails closed on partial page error", async () => {
  const { rpc, service } = createTestHarness();
  rpc.when("thread/start", { thread: { id: "thr_race", sessionId: "sess_race" } });
  rpc.when("turn/start", { turn: { id: "turn_race", status: "inProgress" } });
  rpc.when("turn/interrupt", async () => {
    rpc.emitNotification("turn/completed", {
      threadId: "thr_race",
      turn: { id: "turn_race", status: "completed" },
    });
    throw new Error("turn already completed");
  });

  const worker = await service.launch({
    projectId: PROJECT_A,
    requestId: "req-cancel-race",
    brief: "Finish before interrupt",
  });
  const result = await service.cancel({ projectId: PROJECT_A, workerId: worker.id });
  assert.equal(result.status, "completed");

  // Reconcile page-2 failure must fail closed (recovery_required) and pass sortDirection: "asc"
  const { rpc: rpc2, service: svc2, state: state2 } = createTestHarness();
  rpc2.when("thread/start", { thread: { id: "thr_pg", sessionId: "sess_pg" } });
  rpc2.when("turn/start", { turn: { id: "turn_pg_1", status: "inProgress" } });
  await svc2.launch({ projectId: PROJECT_A, requestId: "req-pg", brief: "Paged" });

  let sawAsc = false;
  rpc2.when("thread/read", { thread: { id: "thr_pg", turns: [] } });
  rpc2.when("thread/turns/list", (params) => {
    if (params.sortDirection === "asc") sawAsc = true;
    if (!params.cursor) {
      return { data: [{ id: "turn_old", status: "completed" }], nextCursor: "page-2" };
    }
    throw new Error("page 2 transport failure");
  });

  const rec = await svc2.reconcile(PROJECT_A);
  assert.equal(sawAsc, true);
  assert.equal(rec.workers[0].status, "recovery_required");
  assert.equal(state2.read().events.length, 0);
});
