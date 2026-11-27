import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createRpc } from "../src/rpc.mjs";

function createFakeProcess() {
  const proc = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const writes = [];
  let ended = false;
  let killed = null;

  proc.stdin = {
    writable: true,
    write(chunk) {
      writes.push(String(chunk));
      return true;
    },
    end() {
      ended = true;
      this.writable = false;
    },
  };
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.kill = (signal = "SIGTERM") => {
    killed = signal;
    return true;
  };

  return {
    proc,
    writes,
    get ended() {
      return ended;
    },
    get killed() {
      return killed;
    },
    emitStdout(text) {
      stdout.emit("data", Buffer.from(text, "utf8"));
    },
    emitStderr(text) {
      stderr.emit("data", Buffer.from(text, "utf8"));
    },
    emitExit(code = 0, signal = null) {
      proc.emit("exit", code, signal);
    },
  };
}

test("spawns without shell and strips OPENAI_API_KEY by default", () => {
  const fake = createFakeProcess();
  let captured = null;

  const rpc = createRpc({
    command: "codex",
    args: ["app-server"],
    cwd: "/tmp/project",
    env: { PATH: "/usr/bin", OPENAI_API_KEY: "sk-should-be-stripped", KEEP_ME: "1" },
    spawn(command, args, opts) {
      captured = { command, args, opts };
      return fake.proc;
    },
  });

  assert.equal(captured.command, "codex");
  assert.deepEqual(captured.args, ["app-server"]);
  assert.equal(captured.opts.shell, false);
  assert.equal(captured.opts.cwd, "/tmp/project");
  assert.equal(captured.opts.env.OPENAI_API_KEY, undefined);
  assert.equal(captured.opts.env.KEEP_ME, "1");

  rpc.close();
});

test("sends JSONL without Content-Length framing and resolves split/coalesced lines", async () => {
  const fake = createFakeProcess();
  const rpc = createRpc({ spawn: () => fake.proc, timeoutMs: 2_000 });

  const p1 = rpc.request("initialize", { clientInfo: { name: "test", version: "0.1.0" } });
  const p2 = rpc.request("account/read", {});

  assert.equal(fake.writes.length, 2);
  assert.ok(!fake.writes[0].includes("Content-Length:"));
  assert.ok(fake.writes[0].endsWith("\n"));
  const sent1 = JSON.parse(fake.writes[0]);
  const sent2 = JSON.parse(fake.writes[1]);
  assert.equal(sent1.method, "initialize");
  assert.equal(sent2.method, "account/read");

  // Out-of-order response (id 2 before id 1), split across chunks and coalesced.
  const line2 = JSON.stringify({ id: sent2.id, result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true } });
  const line1 = JSON.stringify({ id: sent1.id, result: { userAgent: "codex/0.172.0" } });
  const half = Math.floor(line2.length / 2);

  fake.emitStdout(line2.slice(0, half));
  fake.emitStdout(`${line2.slice(half)}\n${line1}\n`);

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.userAgent, "codex/0.172.0");
  assert.equal(r2.account.type, "chatgpt");

  rpc.close();
});

test("delivers notifications while request is pending and ignores invalid JSON and isolated stderr", async () => {
  const fake = createFakeProcess();
  const stderrChunks = [];
  const notifications = [];
  const rpc = createRpc({
    spawn: () => fake.proc,
    timeoutMs: 2_000,
    onStderr: (text) => stderrChunks.push(text),
  });
  rpc.onNotification((note) => notifications.push(note));

  const pending = rpc.request("turn/start", { threadId: "t1", input: [] });
  const req = JSON.parse(fake.writes[0]);

  fake.emitStderr('{"not":"rpc"}\nwarning on stderr\n');
  fake.emitStdout("not-valid-json\n");
  fake.emitStdout(`${JSON.stringify({ method: "turn/completed", params: { threadId: "t1", turn: { id: "u1", status: "completed" } } })}\n`);
  fake.emitStdout(`${JSON.stringify({ id: req.id, result: { turn: { id: "u1", status: "inProgress" } } })}\n`);

  const result = await pending;
  assert.equal(result.turn.id, "u1");
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].method, "turn/completed");
  assert.deepEqual(stderrChunks, ['{"not":"rpc"}\nwarning on stderr\n']);

  rpc.close();
});

test("enforces bounded pending request map", async () => {
  const fake = createFakeProcess();
  const rpc = createRpc({ spawn: () => fake.proc, maxPendingRequests: 2, timeoutMs: 2_000 });

  const p1 = rpc.request("a", {});
  const p2 = rpc.request("b", {});
  await assert.rejects(() => rpc.request("c", {}), /pending/i);
  assert.equal(fake.writes.length, 2);

  rpc.close();
  await assert.rejects(p1);
  await assert.rejects(p2);
});

test("times out without retrying writes and ignores late or duplicate responses", async () => {
  const fake = createFakeProcess();
  const rpc = createRpc({ spawn: () => fake.proc, timeoutMs: 20 });

  const pTimeout = rpc.request("thread/start", { cwd: "/tmp" });
  const reqTimeout = JSON.parse(fake.writes[0]);
  await assert.rejects(pTimeout, (err) => err.code === "ETIMEDOUT" || /timeout/i.test(err.message));
  // Must never retry writes after timeout.
  assert.equal(fake.writes.length, 1);

  // Late response for timed-out id must be ignored.
  fake.emitStdout(`${JSON.stringify({ id: reqTimeout.id, result: { thread: { id: "late" } } })}\n`);

  // Duplicate responses for a valid request must be ignored after first settlement.
  const pOk = rpc.request("account/read", {}, { timeoutMs: 2_000 });
  const reqOk = JSON.parse(fake.writes[1]);
  fake.emitStdout(`${JSON.stringify({ id: reqOk.id, result: { first: true } })}\n`);
  fake.emitStdout(`${JSON.stringify({ id: reqOk.id, result: { second: true } })}\n`);
  assert.deepEqual(await pOk, { first: true });

  rpc.close();
});

test("rejects pending requests on unexpected process exit and cleans up on close", async () => {
  const fake = createFakeProcess();
  const rpc = createRpc({ spawn: () => fake.proc, timeoutMs: 2_000 });

  const pending = rpc.request("thread/read", { threadId: "t1" });
  fake.emitExit(1, null);

  await assert.rejects(pending, /exit/i);
  await assert.rejects(() => rpc.request("account/read", {}), /closed/i);
  assert.throws(() => rpc.notify("initialized", {}), /closed/i);

  rpc.close();
  rpc.close();
});

test("handles server-initiated requests and returns -32601 for unknown or unhandled requests", async () => {
  const fake = createFakeProcess();
  const seen = [];
  const rpc = createRpc({
    spawn: () => fake.proc,
    timeoutMs: 2_000,
    onRequest: async (req) => {
      seen.push(req);
      if (req.method === "item/commandExecution/requestApproval") {
        return { decision: "decline" };
      }
      return undefined;
    },
  });

  fake.emitStdout(`${JSON.stringify({ id: 99, method: "item/commandExecution/requestApproval", params: { threadId: "t1", turnId: "u1", itemId: "i1" } })}\n`);
  fake.emitStdout(`${JSON.stringify({ id: 100, method: "unknown/serverMethod", params: {} })}\n`);

  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(seen.length, 2);
  assert.equal(fake.writes.length, 2);

  const r1 = JSON.parse(fake.writes[0]);
  assert.deepEqual(r1, { id: 99, result: { decision: "decline" } });

  const r2 = JSON.parse(fake.writes[1]);
  assert.equal(r2.id, 100);
  assert.equal(r2.error.code, -32601);

  // Also works when registered later via rpc.onRequest
  const fake2 = createFakeProcess();
  const rpc2 = createRpc({ spawn: () => fake2.proc, timeoutMs: 2_000 });
  rpc2.onRequest(async (req) => {
    if (req.method === "ping") return { ok: true };
    return undefined;
  });
  fake2.emitStdout(`${JSON.stringify({ id: "srv-1", method: "ping", params: {} })}\n`);
  fake2.emitStdout(`${JSON.stringify({ id: "srv-2", method: "evil/accept", params: {} })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(JSON.parse(fake2.writes[0]), { id: "srv-1", result: { ok: true } });
  assert.equal(JSON.parse(fake2.writes[1]).error.code, -32601);

  rpc.close();
  rpc2.close();
  assert.equal(fake.ended, true);
  assert.equal(fake.killed, "SIGTERM");
});

test("strips all T3O_CODEX_* bridge identity and pairing env vars from spawned app-server", () => {
  const fake = createFakeProcess();
  let capturedEnv = null;

  const rpc = createRpc({
    command: "codex",
    args: ["app-server"],
    env: {
      PATH: "/usr/bin",
      OPENAI_API_KEY: "sk-secret",
      T3O_CODEX_HOST_SESSION_ID: "sess-coord-secret",
      T3O_CODEX_HOST_THREAD_ID: "thr-coord-secret",
      T3O_CODEX_PAIRING_CODE: "pair-secret-123",
      T3O_CODEX_ALLOW_WRITE: "true",
      T3O_CODEX_CUSTOM: "leak",
      SAFE_VAR: "keep-me",
    },
    spawn(_command, _args, opts) {
      capturedEnv = opts.env;
      return fake.proc;
    },
  });

  assert.equal(capturedEnv.OPENAI_API_KEY, undefined);
  assert.equal(capturedEnv.T3O_CODEX_HOST_SESSION_ID, undefined);
  assert.equal(capturedEnv.T3O_CODEX_HOST_THREAD_ID, undefined);
  assert.equal(capturedEnv.T3O_CODEX_PAIRING_CODE, undefined);
  assert.equal(capturedEnv.T3O_CODEX_ALLOW_WRITE, undefined);
  assert.equal(capturedEnv.T3O_CODEX_CUSTOM, undefined);
  assert.equal(capturedEnv.SAFE_VAR, "keep-me");
  rpc.close();
});
