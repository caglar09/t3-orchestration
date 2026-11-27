import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { saveConfigAtomic } from "../src/config.mjs";
import { openState, projectStateDir } from "../src/state.mjs";
import { createMcpBridge } from "../src/mcp.mjs";

const tempDirs = [];

function makeTempDir(prefix = "t3o-mcp-") {
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

function createMockWorkerService() {
  const calls = [];
  const workers = new Map();
  const events = new Map();

  return {
    calls,
    seedWorker(worker) {
      workers.set(worker.id, worker);
    },
    seedEvent(event) {
      events.set(event.id, event);
    },
    async launch(params) {
      calls.push({ method: "launch", params });
      const worker = {
        id: `w-${workers.size + 1}`,
        projectId: params.projectId,
        threadId: `thr-w-${workers.size + 1}`,
        mode: params.mode,
        status: "running",
        requestId: params.requestId,
      };
      workers.set(worker.id, worker);
      return worker;
    },
    async list(projectId) {
      calls.push({ method: "list", projectId });
      return [...workers.values()].filter((w) => w.projectId === projectId);
    },
    async read({ projectId, workerId, cursor, limit }) {
      calls.push({ method: "read", projectId, workerId, cursor, limit });
      const worker = workers.get(workerId);
      if (!worker || worker.projectId !== projectId) {
        throw new Error(`Worker ${workerId} not found in project ${projectId}`);
      }
      return {
        worker,
        turns: [
          {
            id: "turn-1",
            status: "completed",
            summary: "Verified sk-ant-secret1234567890 token redacted; test@example.com",
          },
        ],
        nextCursor: null,
      };
    },
    async continue(params) {
      calls.push({ method: "continue", params });
      const worker = workers.get(params.workerId);
      if (!worker || worker.projectId !== params.projectId) {
        throw new Error(`Worker ${params.workerId} not found in project ${params.projectId}`);
      }
      return { ...worker, status: "running", requestId: params.requestId };
    },
    async cancel({ projectId, workerId }) {
      calls.push({ method: "cancel", projectId, workerId });
      const worker = workers.get(workerId);
      if (!worker || worker.projectId !== params.projectId) {
        throw new Error(`Worker ${workerId} not found in project ${params.projectId}`);
      }
      return { ...worker, status: "interrupting" };
    },
    async inbox({ projectId, limit }) {
      calls.push({ method: "inbox", projectId, limit });
      return [...events.values()]
        .filter((e) => e.projectId === projectId && !e.ackAt)
        .slice(0, limit ?? 20);
    },
    async ack({ projectId, eventIds }) {
      calls.push({ method: "ack", projectId, eventIds });
      const acked = [];
      for (const id of eventIds) {
        const ev = events.get(id);
        if (!ev || ev.projectId !== projectId) {
          throw new Error(`Event ${id} not found in project ${projectId}`);
        }
        ev.ackAt = "2026-11-27T12:00:00.000Z";
        acked.push(id);
      }
      return { acked };
    },
  };
}

function createMockAppServer({
  account = {
    account: {
      type: "chatgpt",
      email: "owner@example.invalid",
      planType: "plus",
      workspaceName: "Private Workspace",
    },
    requiresOpenaiAuth: true,
    userId: "user-secret-001",
  },
  limits = {
    status: "known",
    planType: "plus",
    windows: [{ name: "primary", usedPercent: 12, resetsAt: 1764260000, windowDurationMins: 300 }],
  },
} = {}) {
  return {
    async readAccount() {
      if (account instanceof Error) throw account;
      return account;
    },
    async readLimits() {
      if (limits instanceof Error) throw limits;
      return limits;
    },
  };
}

async function connectTestClient(bridge) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.1.0" });
  await Promise.all([bridge.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    async close() {
      await client.close();
      await bridge.close();
    },
  };
}

function parseResultJson(res) {
  assert.equal(res.isError ?? false, false);
  assert.ok(res.structuredContent);
  const textBlock = res.content.find((c) => c.type === "text");
  assert.ok(textBlock);
  assert.deepEqual(JSON.parse(textBlock.text), res.structuredContent);
  return res.structuredContent;
}

test("registers all 10 strict MCP tools rejecting unknown args", async () => {
  const base = makeTempDir();
  const bridge = createMcpBridge({
    configPath: path.join(base, "config.json"),
    stateRoot: base,
    hostIdentity: { sessionId: "sess-coord-a", threadId: "thr-coord-a" },
    pairingCode: "pair-secret-1",
    workerService: createMockWorkerService(),
    appServer: createMockAppServer(),
  });

  const { client, close } = await connectTestClient(bridge);
  try {
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "account_status",
      "inbox_ack",
      "inbox_list",
      "project_setup",
      "worker_cancel",
      "worker_continue",
      "worker_launch",
      "worker_list",
      "worker_read",
      "worker_resolve",
    ]);
    for (const tool of listed.tools) {
      assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} must forbid extra args`);
    }
  } finally {
    await close();
  }
});

test("project_setup requires verified out-of-band pairingCode, rejects forged/worker callers, and binds hostIdentity", async () => {
  const base = makeTempDir();
  const repoA = path.join(base, "repo-a");
  fs.mkdirSync(repoA);
  const cfgPath = path.join(base, "config.json");

  // 1. Bad pairingCode rejected
  {
    const bridge = createMcpBridge({
      configPath: cfgPath,
      stateRoot: base,
      hostIdentity: { sessionId: "sess-coord-a", threadId: "thr-coord-a" },
      pairingCode: "correct-code",
      workerService: createMockWorkerService(),
      appServer: createMockAppServer(),
    });
    const { client, close } = await connectTestClient(bridge);
    try {
      const badPair = await client.callTool({
        name: "project_setup",
        arguments: { name: "alpha", root: repoA, pairingCode: "wrong-code" },
      });
      assert.equal(badPair.isError, true);

      // Extra forged args rejected
      const forgedArg = await client.callTool({
        name: "project_setup",
        arguments: {
          name: "alpha",
          root: repoA,
          pairingCode: "correct-code",
          coordinatorSessionId: "forged-session",
        },
      });
      assert.equal(forgedArg.isError, true);

      // Valid pairing succeeds and binds hostIdentity.sessionId
      const ok = await client.callTool({
        name: "project_setup",
        arguments: { name: "alpha", root: repoA, pairingCode: "correct-code" },
      });
      const data = parseResultJson(ok);
      assert.equal(data.project.name, "alpha");
      assert.equal(data.project.allowWrite, false);
      assert.equal(data.project.memoryEnabled, false);
      assert.equal(data.project.maxWorkers, 2);
      assert.equal("coordinatorSessionId" in data.project, false);

      const saved = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      assert.equal(saved.projects[0].coordinatorSessionId, "sess-coord-a");
      assert.equal(saved.projects[0].coordinatorThreadId, "thr-coord-a");
    } finally {
      await close();
    }
  }

  // 2. Worker caller cannot run project_setup
  {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    const projId = cfg.projects[0].id;
    const store = openState(projectStateDir(base, projId));
    store.transact((s) => {
      s.workers["w-1"] = {
        id: "w-1",
        projectId: projId,
        threadId: "thr-w-1",
        sessionId: "sess-w-1",
        status: "running",
      };
    });
    store.close();

    const repoB = path.join(base, "repo-b");
    fs.mkdirSync(repoB);
    const workerBridge = createMcpBridge({
      configPath: cfgPath,
      stateRoot: base,
      hostIdentity: { sessionId: "sess-w-1", threadId: "thr-w-1" },
      pairingCode: "correct-code",
      workerService: createMockWorkerService(),
      appServer: createMockAppServer(),
    });
    const { client, close } = await connectTestClient(workerBridge);
    try {
      const res = await client.callTool({
        name: "project_setup",
        arguments: { name: "beta", root: repoB, pairingCode: "correct-code" },
      });
      assert.equal(res.isError, true);
    } finally {
      await close();
    }
  }
});

test("unregistered, missing, subagent, and worker callers are denied on all operational tools", async () => {
  const base = makeTempDir();
  const repoA = path.join(base, "repo-a");
  fs.mkdirSync(repoA);
  const cfgPath = path.join(base, "config.json");
  saveConfigAtomic(cfgPath, {
    version: 1,
    projects: [
      {
        id: PROJECT_A_ID,
        name: "alpha",
        root: repoA,
        coordinatorSessionId: "sess-coord-a",
        coordinatorThreadId: "thr-coord-a",
        maxWorkers: 2,
        memoryEnabled: false,
        libraryPath: null,
        allowWrite: false,
      },
    ],
  });
  const store = openState(projectStateDir(base, PROJECT_A_ID));
  store.transact((s) => {
    s.workers["w-1"] = {
      id: "w-1",
      projectId: PROJECT_A_ID,
      threadId: "thr-w-1",
      sessionId: "sess-w-1",
      status: "running",
    };
  });
  store.close();

  const forbiddenIdentities = [
    null,
    { sessionId: "" },
    { sessionId: "sess-manual-unknown" },
    { sessionId: "sess-coord-a", isSubagent: true },
    { sessionId: "sess-coord-a", internal: true },
    { sessionId: "sess-w-1", threadId: "thr-w-1" },
  ];

  for (const hostIdentity of forbiddenIdentities) {
    const workerService = createMockWorkerService();
    const bridge = createMcpBridge({
      configPath: cfgPath,
      stateRoot: base,
      hostIdentity,
      workerService,
      appServer: createMockAppServer(),
    });
    const { client, close } = await connectTestClient(bridge);
    try {
      for (const [name, args] of [
        ["worker_launch", { requestId: "req-1", brief: "hello" }],
        ["worker_list", {}],
        ["worker_read", { workerId: "w-1" }],
        ["worker_continue", { workerId: "w-1", requestId: "req-2", brief: "more" }],
        ["worker_cancel", { workerId: "w-1" }],
        ["inbox_list", {}],
        ["inbox_ack", { eventIds: [`${PROJECT_A_ID}:w-1:turn-1`] }],
        ["account_status", {}],
      ]) {
        const res = await client.callTool({ name, arguments: args });
        assert.equal(res.isError, true, `${name} should fail for identity ${JSON.stringify(hostIdentity)}`);
      }
      assert.equal(workerService.calls.length, 0);
    } finally {
      await close();
    }
  }
});

test("enforces brief size (16 KiB UTF-8), read/inbox limits, strict extra-arg rejection, and write authorization", async () => {
  const base = makeTempDir();
  const repoA = path.join(base, "repo-a");
  fs.mkdirSync(repoA);
  const cfgPath = path.join(base, "config.json");
  saveConfigAtomic(cfgPath, {
    version: 1,
    projects: [
      {
        id: PROJECT_A_ID,
        name: "alpha",
        root: repoA,
        coordinatorSessionId: "sess-coord-a",
        coordinatorThreadId: "thr-coord-a",
        maxWorkers: 2,
        memoryEnabled: false,
        libraryPath: null,
        allowWrite: false,
      },
    ],
  });

  const workerService = createMockWorkerService();
  workerService.seedWorker({ id: "w-1", projectId: PROJECT_A_ID, threadId: "thr-w-1", status: "completed" });
  const bridge = createMcpBridge({
    configPath: cfgPath,
    stateRoot: base,
    hostIdentity: { sessionId: "sess-coord-a", threadId: "thr-coord-a" },
    workerService,
    appServer: createMockAppServer(),
  });
  const { client, close } = await connectTestClient(bridge);
  try {
    // Reject extra forged project arg
    const extraProject = await client.callTool({
      name: "worker_launch",
      arguments: { requestId: "req-1", brief: "inspect", projectId: PROJECT_B_ID },
    });
    assert.equal(extraProject.isError, true);

    // Reject oversized brief (multi-byte UTF-8 > 16384 bytes even if < 16384 chars)
    const multiByteTooBig = "\u00e9".repeat(9000); // 18000 bytes
    const bigLaunch = await client.callTool({
      name: "worker_launch",
      arguments: { requestId: "req-2", brief: multiByteTooBig },
    });
    assert.equal(bigLaunch.isError, true);

    const bigContinue = await client.callTool({
      name: "worker_continue",
      arguments: { workerId: "w-1", requestId: "req-2c", brief: "a".repeat(16385) },
    });
    assert.equal(bigContinue.isError, true);

    // Reject unauthorized write mode
    const writeDenied = await client.callTool({
      name: "worker_launch",
      arguments: { requestId: "req-3", brief: "edit file", mode: "write" },
    });
    assert.equal(writeDenied.isError, true);

    // Reject out-of-range limits
    const badReadLimit = await client.callTool({
      name: "worker_read",
      arguments: { workerId: "w-1", limit: 101 },
    });
    assert.equal(badReadLimit.isError, true);

    const badInboxLimit = await client.callTool({
      name: "inbox_list",
      arguments: { limit: 21 },
    });
    assert.equal(badInboxLimit.isError, true);

    // Default read launch succeeds and scopes to PROJECT_A_ID
    const okLaunch = await client.callTool({
      name: "worker_launch",
      arguments: { requestId: "req-4", brief: "inspect repo" },
    });
    const launched = parseResultJson(okLaunch);
    assert.equal(launched.worker.mode, "read");
    assert.equal(launched.worker.projectId, PROJECT_A_ID);

    // worker_read defaults limit=20 and redacts secrets/PII in output
    const readRes = await client.callTool({
      name: "worker_read",
      arguments: { workerId: "w-1" },
    });
    const readData = parseResultJson(readRes);
    assert.equal(workerService.calls.at(-1).limit, 20);
    assert.equal(JSON.stringify(readData).includes("sk-ant-secret1234567890"), false);
    assert.equal(JSON.stringify(readData).includes("test@example.com"), false);
  } finally {
    await close();
  }
});

test("enforces cross-project isolation and preserves failed/interrupted vs completed events", async () => {
  const base = makeTempDir();
  const repoA = path.join(base, "repo-a");
  const repoB = path.join(base, "repo-b");
  fs.mkdirSync(repoA);
  fs.mkdirSync(repoB);
  const cfgPath = path.join(base, "config.json");
  saveConfigAtomic(cfgPath, {
    version: 1,
    projects: [
      {
        id: PROJECT_A_ID,
        name: "alpha",
        root: repoA,
        coordinatorSessionId: "sess-coord-a",
        coordinatorThreadId: "thr-coord-a",
        maxWorkers: 2,
        memoryEnabled: false,
        libraryPath: null,
        allowWrite: true,
      },
      {
        id: PROJECT_B_ID,
        name: "beta",
        root: repoB,
        coordinatorSessionId: "sess-coord-b",
        coordinatorThreadId: "thr-coord-b",
        maxWorkers: 2,
        memoryEnabled: false,
        libraryPath: null,
        allowWrite: false,
      },
    ],
  });

  const workerService = createMockWorkerService();
  workerService.seedWorker({ id: "wa-1", projectId: PROJECT_A_ID, threadId: "thr-a1", status: "completed" });
  workerService.seedWorker({ id: "wb-1", projectId: PROJECT_B_ID, threadId: "thr-b1", status: "completed" });
  workerService.seedEvent({
    id: `${PROJECT_A_ID}:wa-1:turn-1`,
    projectId: PROJECT_A_ID,
    workerId: "wa-1",
    threadId: "thr-a1",
    turnId: "turn-1",
    status: "failed",
    errorCode: "SandboxError",
    createdAt: "2026-11-27T10:00:00.000Z",
    ackAt: null,
  });
  workerService.seedEvent({
    id: `${PROJECT_A_ID}:wa-1:turn-2`,
    projectId: PROJECT_A_ID,
    workerId: "wa-1",
    threadId: "thr-a1",
    turnId: "turn-2",
    status: "interrupted",
    createdAt: "2026-11-27T10:01:00.000Z",
    ackAt: null,
  });
  workerService.seedEvent({
    id: `${PROJECT_B_ID}:wb-1:turn-1`,
    projectId: PROJECT_B_ID,
    workerId: "wb-1",
    threadId: "thr-b1",
    turnId: "turn-1",
    status: "completed",
    createdAt: "2026-11-27T10:02:00.000Z",
    ackAt: null,
  });

  const bridge = createMcpBridge({
    configPath: cfgPath,
    stateRoot: base,
    hostIdentity: { sessionId: "sess-coord-a", threadId: "thr-coord-a" },
    allowWrite: true,
    workerService,
    appServer: createMockAppServer(),
  });
  const { client, close } = await connectTestClient(bridge);
  try {
    // Authorized write passes authorized=true
    const writeRes = await client.callTool({
      name: "worker_launch",
      arguments: { requestId: "req-w", brief: "apply fix", mode: "write" },
    });
    const writeData = parseResultJson(writeRes);
    assert.equal(writeData.worker.mode, "write");

    // Cannot read/continue/cancel Project B worker
    assert.equal((await client.callTool({ name: "worker_read", arguments: { workerId: "wb-1" } })).isError, true);
    assert.equal((await client.callTool({ name: "worker_continue", arguments: { workerId: "wb-1", requestId: "r1", brief: "hi" } })).isError, true);
    assert.equal((await client.callTool({ name: "worker_cancel", arguments: { workerId: "wb-1" } })).isError, true);

    // Inbox returns only Project A events with failed/interrupted distinct from completed
    const inboxData = parseResultJson(await client.callTool({ name: "inbox_list", arguments: {} }));
    assert.equal(inboxData.events.length, 2);
    assert.equal(inboxData.events[0].status, "failed");
    assert.equal(inboxData.events[1].status, "interrupted");

    // Cross-project ack denied
    assert.equal(
      (await client.callTool({ name: "inbox_ack", arguments: { eventIds: [`${PROJECT_B_ID}:wb-1:turn-1`] } })).isError,
      true,
    );

    // Own project ack succeeds
    const ackData = parseResultJson(
      await client.callTool({
        name: "inbox_ack",
        arguments: { eventIds: [`${PROJECT_A_ID}:wa-1:turn-1`] },
      }),
    );
    assert.deepEqual(ackData.acked, [`${PROJECT_A_ID}:wa-1:turn-1`]);
  } finally {
    await close();
  }
});

test("account_status strips sensitive account fields and falls back to unknown safely", async () => {
  const base = makeTempDir();
  const repoA = path.join(base, "repo-a");
  fs.mkdirSync(repoA);
  const cfgPath = path.join(base, "config.json");
  saveConfigAtomic(cfgPath, {
    version: 1,
    projects: [
      {
        id: PROJECT_A_ID,
        name: "alpha",
        root: repoA,
        coordinatorSessionId: "sess-coord-a",
        coordinatorThreadId: "thr-coord-a",
        maxWorkers: 2,
        memoryEnabled: false,
        libraryPath: null,
        allowWrite: false,
      },
    ],
  });

  // Known account & limits without leaking email/userId/workspaceName
  {
    const bridge = createMcpBridge({
      configPath: cfgPath,
      stateRoot: base,
      hostIdentity: { sessionId: "sess-coord-a", threadId: "thr-coord-a" },
      workerService: createMockWorkerService(),
      appServer: createMockAppServer(),
    });
    const { client, close } = await connectTestClient(bridge);
    try {
      const data = parseResultJson(await client.callTool({ name: "account_status", arguments: {} }));
      assert.equal(data.authenticated, true);
      assert.equal(data.accountType, "chatgpt");
      assert.equal(data.planType, "plus");
      assert.equal(data.limits.status, "known");
      const raw = JSON.stringify(data);
      assert.equal(raw.includes("owner@example.invalid"), false);
      assert.equal(raw.includes("user-secret-001"), false);
      assert.equal(raw.includes("Private Workspace"), false);
    } finally {
      await close();
    }
  }

  // Unavailable account & limits => unknown without crashing
  {
    const bridge = createMcpBridge({
      configPath: cfgPath,
      stateRoot: base,
      hostIdentity: { sessionId: "sess-coord-a", threadId: "thr-coord-a" },
      workerService: createMockWorkerService(),
      appServer: createMockAppServer({
        account: new Error("rpc unavailable"),
        limits: new Error("rpc unavailable"),
      }),
    });
    const { client, close } = await connectTestClient(bridge);
    try {
      const data = parseResultJson(await client.callTool({ name: "account_status", arguments: {} }));
      assert.equal(data.authenticated, "unknown");
      assert.equal(data.accountType, "unknown");
      assert.equal(data.planType, "unknown");
      assert.deepEqual(data.limits, { status: "unknown", windows: [] });
    } finally {
      await close();
    }
  }
});

test("allowWrite defaults closed for programmatic callers and getWorkerService deduplicates concurrent init / releases lease on error", async () => {
  const base = makeTempDir();
  const repoA = path.join(base, "repo-a");
  fs.mkdirSync(repoA);
  const cfgPath = path.join(base, "config.json");
  saveConfigAtomic(cfgPath, {
    version: 1,
    projects: [
      {
        id: PROJECT_A_ID,
        name: "alpha",
        root: repoA,
        coordinatorSessionId: "sess-coord-a",
        coordinatorThreadId: "thr-coord-a",
        maxWorkers: 2,
        memoryEnabled: false,
        libraryPath: null,
        allowWrite: true,
      },
    ],
  });

  // 1. Omitting allowWrite in createMcpBridge defaults to false even if project.allowWrite === true
  {
    const workerService = createMockWorkerService();
    const bridge = createMcpBridge({
      configPath: cfgPath,
      stateRoot: base,
      hostIdentity: { sessionId: "sess-coord-a", threadId: "thr-coord-a" },
      workerService,
      appServer: createMockAppServer(),
    });
    const { client, close } = await connectTestClient(bridge);
    try {
      const denied = await client.callTool({
        name: "worker_launch",
        arguments: { requestId: "req-deny-default", brief: "edit", mode: "write" },
      });
      assert.equal(denied.isError, true);
      assert.equal(workerService.calls.length, 0);
    } finally {
      await close();
    }
  }

  // 2. Init failure releases lease so retry succeeds, and concurrent calls share one init
  {
    let attempts = 0;
    const mockSvc = createMockWorkerService();
    const bridge = createMcpBridge({
      configPath: cfgPath,
      stateRoot: base,
      hostIdentity: { sessionId: "sess-coord-a", threadId: "thr-coord-a" },
      appServer: createMockAppServer(),
      workerServiceFactory: async () => {
        attempts += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (attempts === 1) {
          throw new Error("transient init failure");
        }
        return mockSvc;
      },
    });
    const { client, close } = await connectTestClient(bridge);
    try {
      const failedFirst = await client.callTool({ name: "worker_list", arguments: {} });
      assert.equal(failedFirst.isError, true);

      const [r1, r2] = await Promise.all([
        client.callTool({ name: "worker_list", arguments: {} }),
        client.callTool({ name: "worker_list", arguments: {} }),
      ]);
      assert.equal(r1.isError ?? false, false);
      assert.equal(r2.isError ?? false, false);
      assert.equal(attempts, 2);
    } finally {
      await close();
    }
  }
});

test("out-of-band pairing ticket is single-use, tool errors redact quoted secrets, worker_resolve works, and crashed appServer resets", async () => {
  const base = makeTempDir();
  const repo = path.join(base, "repo");
  fs.mkdirSync(repo);
  const cfgPath = path.join(base, "config.json");

  const { createPairingTicket } = await import("../scripts/pair.mjs");
  const ticket = createPairingTicket({ stateRoot: base, ttlMs: 60_000 });
  assert.equal(fs.statSync(ticket.pairingPath).mode & 0o777, 0o600);

  let appServerCalls = 0;
  let exitHandler = null;
  const mockSvc = createMockWorkerService();
  mockSvc.resolve = async (params) => ({
    id: params.workerId,
    projectId: params.projectId,
    status: params.resolution,
    threadId: "thr-stuck",
  });
  mockSvc.list = async () => {
    throw new Error('git failed with password="my secret phrase"');
  };

  const bridge = createMcpBridge({
    configPath: cfgPath,
    stateRoot: base,
    hostIdentity: { sessionId: "sess-pair-1", threadId: "thr-pair-1" },
    appServerFactory: async () => {
      appServerCalls += 1;
      return {
        ...createMockAppServer(),
        onClose(fn) {
          exitHandler = fn;
          return () => {};
        },
      };
    },
    workerService: mockSvc,
  });

  const { client, close } = await connectTestClient(bridge);
  try {
    // First project_setup consumes ticket
    const setupRes = await client.callTool({
      name: "project_setup",
      arguments: { name: "paired-proj", root: repo, pairingCode: ticket.pairingCode },
    });
    assert.equal(setupRes.isError ?? false, false);

    // Replay of consumed ticket fails
    const replayRes = await client.callTool({
      name: "project_setup",
      arguments: { name: "paired-proj-2", root: repo, pairingCode: ticket.pairingCode },
    });
    assert.equal(replayRes.isError, true);

    // Thrown error with quoted secret is redacted
    const errRes = await client.callTool({ name: "worker_list", arguments: {} });
    assert.equal(errRes.isError, true);
    const errText = errRes.content?.[0]?.text ?? "";
    assert.equal(errText.includes("my secret phrase"), false);
    assert.match(errText, /\[REDACTED\]/);

    // worker_resolve tool works
    const resolveRes = await client.callTool({
      name: "worker_resolve",
      arguments: { workerId: "w-stuck", resolution: "failed", reason: "inspected" },
    });
    assert.equal(resolveRes.isError ?? false, false);
    assert.equal(resolveRes.structuredContent.worker.status, "failed");

    // Trigger account_status -> init appServer #1 -> simulate crash -> next call re-inits appServer #2
    await client.callTool({ name: "account_status", arguments: {} });
    assert.equal(appServerCalls, 1);
    exitHandler?.();
    await client.callTool({ name: "account_status", arguments: {} });
    assert.equal(appServerCalls, 2);
  } finally {
    await close();
  }
});
