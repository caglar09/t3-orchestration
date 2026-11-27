import assert from "node:assert/strict";
import { test } from "node:test";
import { createAppServer } from "../src/app-server.mjs";

function createMockRpc() {
  const calls = [];
  const notifications = [];
  const notificationListeners = new Set();
  let requestHandler = null;
  let closed = false;
  const responses = new Map();

  return {
    calls,
    notifications,
    get closed() {
      return closed;
    },
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
      notifications.push({ method, params });
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
      for (const fn of notificationListeners) {
        fn({ method, params });
      }
    },
    async simulateServerRequest(req) {
      if (!requestHandler) return { error: { code: -32601, message: "Method not found" } };
      try {
        const result = await requestHandler(req);
        if (result === undefined) {
          return { error: { code: -32601, message: "Method not found" } };
        }
        return { result };
      } catch (err) {
        return { error: { code: typeof err.code === "number" ? err.code : -32601, message: err.message } };
      }
    },
    close() {
      closed = true;
    },
  };
}

test("initialize sends initialize with clientInfo followed by initialized notification", async () => {
  const rpc = createMockRpc();
  rpc.when("initialize", { userAgent: "codex/0.172.0", platformOs: "macos" });

  const server = createAppServer(rpc, { clientInfo: { name: "t3o_codex", version: "0.1.0" } });
  const initResult = await server.initialize();

  assert.equal(initResult.userAgent, "codex/0.172.0");
  assert.equal(rpc.calls.length, 2);
  assert.deepEqual(rpc.calls[0], {
    type: "request",
    method: "initialize",
    params: { clientInfo: { name: "t3o_codex", version: "0.1.0" } },
  });
  assert.deepEqual(rpc.calls[1], {
    type: "notify",
    method: "initialized",
    params: {},
  });
});

test("startThread enforces sandbox modes, non-ephemeral persistence, and explicit approvalPolicy", async () => {
  const rpc = createMockRpc();
  rpc.when("thread/start", { thread: { id: "thr_1", modelProvider: "openai" } });

  const server = createAppServer(rpc);
  const resRead = await server.startThread({
    cwd: "/tmp/repo",
    mode: "read",
    instructions: "Read only task",
    config: { model_reasoning_effort: "medium" },
  });

  assert.equal(resRead.thread.id, "thr_1");
  assert.deepEqual(rpc.calls[0].params, {
    cwd: "/tmp/repo",
    sandbox: "read-only",
    approvalPolicy: "on-request",
    developerInstructions: "Read only task",
    ephemeral: false,
    config: { model_reasoning_effort: "medium" },
  });

  await server.startThread({
    cwd: "/tmp/wt-1",
    mode: "write",
    approvalPolicy: "untrusted",
  });
  assert.equal(rpc.calls[1].params.sandbox, "workspace-write");
  assert.equal(rpc.calls[1].params.approvalPolicy, "untrusted");

  await assert.rejects(
    () => server.startThread({ cwd: "/tmp/repo", mode: "danger-full-access" }),
    /mode|sandbox/i,
  );
});

test("startTurn maps read/write sandboxPolicy, brief text input, and toolOutput", async () => {
  const rpc = createMockRpc();
  rpc.when("turn/start", { turn: { id: "turn_1", status: "inProgress" } });

  const server = createAppServer(rpc);

  const readTurn = await server.startTurn({
    threadId: "thr_1",
    brief: "Inspect RPC layer",
    mode: "read",
  });
  assert.equal(readTurn.turn.id, "turn_1");
  assert.deepEqual(rpc.calls[0].params, {
    threadId: "thr_1",
    input: [{ type: "text", text: "Inspect RPC layer" }],
    approvalPolicy: "on-request",
    sandboxPolicy: { type: "readOnly" },
  });

  await server.startTurn({
    threadId: "thr_1",
    brief: "Edit file in worktree",
    mode: "write",
    writableRoots: ["/tmp/wt-1"],
  });
  assert.deepEqual(rpc.calls[1].params.sandboxPolicy, {
    type: "workspaceWrite",
    writableRoots: ["/tmp/wt-1"],
  });

  // Write mode without writableRoots must reject.
  await assert.rejects(
    () => server.startTurn({ threadId: "thr_1", brief: "Unsafe write", mode: "write" }),
    /writableRoots/i,
  );

  // toolOutput wake uses empty input array.
  await server.startTurn({
    threadId: "thr_coord",
    toolOutput: { name: "worker_completed", output: "Worker finished", retain: true },
    mode: "read",
  });
  assert.deepEqual(rpc.calls[2].params, {
    threadId: "thr_coord",
    input: [],
    toolOutput: { name: "worker_completed", output: "Worker finished", retain: true },
    approvalPolicy: "on-request",
    sandboxPolicy: { type: "readOnly" },
  });
});

test("readThread, listTurns, resumeThread, interrupt, and readAccount match wire contract", async () => {
  const rpc = createMockRpc();
  rpc.when("thread/read", { thread: { id: "thr_1", status: { type: "idle" } } });
  rpc.when("thread/turns/list", { data: [{ id: "turn_1" }], nextCursor: "cur_2", backwardsCursor: "cur_0" });
  rpc.when("thread/resume", { thread: { id: "thr_1", modelProvider: "openai" } });
  rpc.when("turn/interrupt", {});
  rpc.when("account/read", { account: { type: "chatgpt", planType: "plus" }, requiresOpenaiAuth: true });

  const server = createAppServer(rpc);

  const thread = await server.readThread("thr_1", { includeTurns: false });
  assert.equal(thread.thread.id, "thr_1");
  assert.deepEqual(rpc.calls[0], { type: "request", method: "thread/read", params: { threadId: "thr_1", includeTurns: false } });

  const page = await server.listTurns({ threadId: "thr_1", cursor: "cur_1", limit: 20, itemsView: "summary" });
  assert.equal(page.nextCursor, "cur_2");
  assert.deepEqual(rpc.calls[1], {
    type: "request",
    method: "thread/turns/list",
    params: { threadId: "thr_1", cursor: "cur_1", limit: 20, itemsView: "summary" },
  });

  const resumed = await server.resumeThread("thr_1");
  assert.equal(resumed.thread.id, "thr_1");
  assert.deepEqual(rpc.calls[2], { type: "request", method: "thread/resume", params: { threadId: "thr_1" } });

  await server.interrupt({ threadId: "thr_1", turnId: "turn_1" });
  assert.deepEqual(rpc.calls[3], { type: "request", method: "turn/interrupt", params: { threadId: "thr_1", turnId: "turn_1" } });

  const acct = await server.readAccount();
  assert.equal(acct.account.type, "chatgpt");
  assert.deepEqual(rpc.calls[4], { type: "request", method: "account/read", params: {} });
});

test("readLimits normalizes known windows and reports unknown when fields are missing or null", async () => {
  const rpc = createMockRpc();
  const server = createAppServer(rpc);

  rpc.when("account/rateLimits/read", {
    rateLimits: {
      planType: "pro",
      primary: { usedPercent: 42, resetsAt: 1732700000, windowDurationMins: 300 },
      secondary: { usedPercent: 15, resetsAt: 1733200000, windowDurationMins: 10080 },
    },
    ordinaryUsageAllowed: true,
  });

  const known = await server.readLimits();
  assert.equal(known.status, "known");
  assert.equal(known.planType, "pro");
  assert.equal(known.windows.length, 2);
  assert.deepEqual(known.windows[0], {
    name: "primary",
    usedPercent: 42,
    resetsAt: 1732700000,
    windowDurationMins: 300,
  });

  // Missing / null limits must report unknown, never guess 0%.
  for (const payload of [
    {},
    { rateLimits: null },
    { rateLimits: { primary: null, secondary: null, planType: null } },
    { rateLimits: { primary: { usedPercent: null } } },
  ]) {
    rpc.when("account/rateLimits/read", payload);
    const res = await server.readLimits();
    assert.equal(res.status, "unknown");
    assert.deepEqual(res.windows, []);
  }
});

test("onTerminal normalizes completed, failed, and interrupted turn/completed events", () => {
  const rpc = createMockRpc();
  const server = createAppServer(rpc);
  const events = [];
  server.onTerminal((ev) => events.push(ev));

  rpc.emitNotification("turn/completed", {
    threadId: "thr_1",
    turn: { id: "turn_1", status: "completed", items: [] },
  });
  rpc.emitNotification("turn/completed", {
    threadId: "thr_1",
    turn: {
      id: "turn_2",
      status: "failed",
      items: [],
      error: { message: "Rate limited", codexErrorInfo: "rateLimitExceeded" },
    },
  });
  rpc.emitNotification("turn/completed", {
    threadId: "thr_1",
    turn: {
      id: "turn_3",
      status: "failed",
      items: [],
      error: { message: "Upstream 502", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } } },
    },
  });
  rpc.emitNotification("turn/completed", {
    threadId: "thr_1",
    turn: { id: "turn_4", status: "interrupted", items: [] },
  });
  // Unrelated / malformed notifications ignored
  rpc.emitNotification("item/started", { threadId: "thr_1" });
  rpc.emitNotification("turn/completed", { threadId: "thr_1" });

  assert.deepEqual(events, [
    { threadId: "thr_1", turnId: "turn_1", status: "completed" },
    { threadId: "thr_1", turnId: "turn_2", status: "failed", errorCode: "rateLimitExceeded" },
    { threadId: "thr_1", turnId: "turn_3", status: "failed", errorCode: "httpConnectionFailed" },
    { threadId: "thr_1", turnId: "turn_4", status: "interrupted" },
  ]);
});

test("server-initiated approval requests are safely declined/denied, surfaced via onApprovalRequest, and unknown requests return -32601", async () => {
  const rpc = createMockRpc();
  const server = createAppServer(rpc);
  const approvals = [];
  server.onApprovalRequest((ev) => approvals.push(ev));

  const cmdRes = await rpc.simulateServerRequest({
    id: 1,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thr_1", turnId: "turn_1", itemId: "item_1", command: "rm -rf /", reason: "Need shell" },
  });
  assert.deepEqual(cmdRes, { result: { decision: "decline" } });

  const fileRes = await rpc.simulateServerRequest({
    id: 2,
    method: "item/fileChange/requestApproval",
    params: { threadId: "thr_1", turnId: "turn_1", itemId: "item_2", reason: "Outside root" },
  });
  assert.deepEqual(fileRes, { result: { decision: "decline" } });

  const patchRes = await rpc.simulateServerRequest({
    id: 3,
    method: "applyPatchApproval",
    params: { conversationId: "thr_1", callId: "call_1", fileChanges: {} },
  });
  assert.equal(typeof patchRes.result.decision?.denied?.rejection, "string");

  const execRes = await rpc.simulateServerRequest({
    id: 4,
    method: "execCommandApproval",
    params: { conversationId: "thr_1", callId: "call_2", command: ["echo", "hi"] },
  });
  assert.equal(typeof execRes.result.decision?.denied?.rejection, "string");

  const mcpRes = await rpc.simulateServerRequest({
    id: 5,
    method: "mcpServer/elicitation/request",
    params: { threadId: "thr_1", turnId: "turn_1", serverName: "ext", message: "Auth?" },
  });
  assert.deepEqual(mcpRes, { result: { action: "decline" } });

  const permRes = await rpc.simulateServerRequest({
    id: 6,
    method: "item/permissions/requestApproval",
    params: { threadId: "thr_1", turnId: "turn_1", itemId: "item_3", permissions: {}, cwd: "/tmp", startedAtMs: 1 },
  });
  assert.deepEqual(permRes, { result: { permissions: {} } });

  // Unknown request must return -32601, never silently accepted.
  const unknownRes = await rpc.simulateServerRequest({
    id: 7,
    method: "unknown/escalation",
    params: { threadId: "thr_1" },
  });
  assert.equal(unknownRes.error.code, -32601);

  assert.equal(approvals.length, 6);
  assert.equal(approvals[0].method, "item/commandExecution/requestApproval");
  assert.equal(approvals[0].threadId, "thr_1");
  assert.equal(approvals[2].threadId, "thr_1");

  server.close();
  assert.equal(rpc.closed, true);
});
