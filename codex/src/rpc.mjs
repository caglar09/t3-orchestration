import { spawn as nodeSpawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_PENDING = 128;
const MAX_LINE_LENGTH = 16 * 1024 * 1024;
const METHOD_NOT_FOUND = -32601;

function createTimeoutError(method, timeoutMs) {
  const err = new Error(`RPC request timed out after ${timeoutMs}ms (${method})`);
  err.name = "TimeoutError";
  err.code = "ETIMEDOUT";
  return err;
}

function createRpcError(errorPayload) {
  const message =
    typeof errorPayload?.message === "string" && errorPayload.message.length > 0
      ? errorPayload.message
      : "RPC error";
  const err = new Error(message);
  if (errorPayload && Object.hasOwn(errorPayload, "code")) {
    err.code = errorPayload.code;
  }
  if (errorPayload && Object.hasOwn(errorPayload, "data")) {
    err.data = errorPayload.data;
  }
  return err;
}

/**
 * Creates a bounded JSONL-over-stdio JSON-RPC client for a Codex App Server process.
 * Spawns without a shell and strips `OPENAI_API_KEY` by default to preserve ChatGPT login.
 */
export function createRpc({
  spawn = nodeSpawn,
  command = "codex",
  args = ["app-server"],
  cwd,
  env = process.env,
  stripOpenAiApiKey = true,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxPendingRequests = DEFAULT_MAX_PENDING,
  onRequest,
  onStderr,
} = {}) {
  if (typeof spawn !== "function") throw new TypeError("spawn must be a function");
  if (typeof command !== "string" || command.length === 0) {
    throw new TypeError("command must be a non-empty string");
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new TypeError("args must be an array of strings");
  }
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive number");
  }
  if (!Number.isInteger(maxPendingRequests) || maxPendingRequests < 1) {
    throw new RangeError("maxPendingRequests must be a positive integer");
  }

  const childEnv = { ...(env ?? process.env) };
  if (stripOpenAiApiKey !== false) {
    delete childEnv.OPENAI_API_KEY;
  }
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith("T3O_CODEX_")) {
      delete childEnv[key];
    }
  }

  const spawnOptions = {
    env: childEnv,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  };
  if (cwd !== undefined) {
    spawnOptions.cwd = cwd;
  }

  const child = spawn(command, [...args], spawnOptions);
  if (!child?.stdin || !child?.stdout) {
    throw new Error("spawned process must expose stdin and stdout streams");
  }

  let closed = false;
  let nextId = 1;
  let stdoutBuffer = "";
  const pending = new Map();
  const notificationListeners = new Set();
  const closeListeners = new Set();
  let requestHandler = typeof onRequest === "function" ? onRequest : null;

  function rejectAllPending(reason) {
    for (const [id, entry] of pending.entries()) {
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
  }

  function writeLine(payload) {
    if (closed || child.stdin.writable === false) {
      throw new Error("RPC transport is closed");
    }
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  function safeWriteLine(payload) {
    if (closed || child.stdin.writable === false) return;
    try {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch {
      // Ignore write failures when transport closes mid-response.
    }
  }

  async function dispatchServerRequest(msg) {
    if (!requestHandler) {
      safeWriteLine({ id: msg.id, error: { code: METHOD_NOT_FOUND, message: "Method not found" } });
      return;
    }

    try {
      const result = await requestHandler({ id: msg.id, method: msg.method, params: msg.params });
      if (result === undefined) {
        safeWriteLine({ id: msg.id, error: { code: METHOD_NOT_FOUND, message: "Method not found" } });
        return;
      }
      safeWriteLine({ id: msg.id, result });
    } catch (err) {
      const code =
        typeof err?.code === "number" && Number.isInteger(err.code) ? err.code : METHOD_NOT_FOUND;
      const message =
        typeof err?.message === "string" && err.message.length > 0
          ? err.message
          : "Method not found";
      safeWriteLine({ id: msg.id, error: { code, message } });
    }
  }

  function handleParsedMessage(msg) {
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;

    const hasId = Object.hasOwn(msg, "id") && msg.id !== null && msg.id !== undefined;
    const hasMethod = typeof msg.method === "string" && msg.method.length > 0;

    if (hasMethod && hasId) {
      void dispatchServerRequest(msg);
      return;
    }

    if (hasMethod) {
      for (const listener of [...notificationListeners]) {
        try {
          listener({ method: msg.method, params: msg.params });
        } catch {
          // Isolate listener errors from the transport read loop.
        }
      }
      return;
    }

    if (!hasId) return;

    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);

    if (Object.hasOwn(msg, "error") && msg.error != null) {
      entry.reject(createRpcError(msg.error));
    } else {
      entry.resolve(msg.result);
    }
  }

  function handleStdoutChunk(chunk) {
    stdoutBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (stdoutBuffer.length > MAX_LINE_LENGTH && !stdoutBuffer.includes("\n")) {
      stdoutBuffer = "";
      return;
    }

    while (true) {
      const newlineIndex = stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) break;

      let line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      if (!line.trim()) continue;

      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      handleParsedMessage(parsed);
    }
  }

  function notifyCloseListeners(reason) {
    for (const fn of [...closeListeners]) {
      try {
        fn(reason);
      } catch {
        // Ignore close listener failures.
      }
    }
    closeListeners.clear();
  }

  function terminate(reason) {
    if (closed) return;
    closed = true;
    stdoutBuffer = "";
    rejectAllPending(reason);
    notifyCloseListeners(reason);
  }

  child.stdout.on("data", handleStdoutChunk);
  child.stderr?.on("data", (chunk) => {
    if (typeof onStderr !== "function") return;
    try {
      onStderr(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    } catch {
      // Ignore stderr callback failures.
    }
  });
  child.stdin.on?.("error", () => {});
  child.on?.("exit", (code, signal) => {
    terminate(`RPC process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
  });
  child.on?.("close", (code, signal) => {
    terminate(`RPC process closed (code=${code ?? "null"}, signal=${signal ?? "null"})`);
  });
  child.on?.("error", (err) => {
    terminate(`RPC process error: ${err?.message ?? "unknown"}`);
  });

  function request(method, params = {}, options = {}) {
    if (typeof method !== "string" || method.length === 0) {
      return Promise.reject(new TypeError("method must be a non-empty string"));
    }
    if (closed) {
      return Promise.reject(new Error("RPC transport is closed"));
    }
    if (pending.size >= maxPendingRequests) {
      return Promise.reject(new Error("Too many pending RPC requests"));
    }

    const effectiveTimeoutMs =
      typeof options?.timeoutMs === "number" &&
      Number.isFinite(options.timeoutMs) &&
      options.timeoutMs > 0
        ? options.timeoutMs
        : timeoutMs;

    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        entry.reject(createTimeoutError(method, effectiveTimeoutMs));
      }, effectiveTimeoutMs);

      pending.set(id, { resolve, reject, timer, method });

      try {
        writeLine({ id, method, params });
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  function notify(method, params = {}) {
    if (typeof method !== "string" || method.length === 0) {
      throw new TypeError("method must be a non-empty string");
    }
    writeLine({ method, params });
  }

  function onNotification(fn) {
    if (typeof fn !== "function") {
      throw new TypeError("notification listener must be a function");
    }
    notificationListeners.add(fn);
    return () => {
      notificationListeners.delete(fn);
    };
  }

  function registerRequestHandler(fn) {
    if (typeof fn !== "function") {
      throw new TypeError("request handler must be a function");
    }
    requestHandler = fn;
    return () => {
      if (requestHandler === fn) {
        requestHandler = null;
      }
    };
  }

  function onClose(fn) {
    if (typeof fn !== "function") {
      throw new TypeError("close listener must be a function");
    }
    if (closed) {
      try {
        fn("RPC transport already closed");
      } catch {
        // Ignore close listener failures.
      }
      return () => {};
    }
    closeListeners.add(fn);
    return () => {
      closeListeners.delete(fn);
    };
  }

  function close() {
    if (closed) return;
    closed = true;
    stdoutBuffer = "";
    rejectAllPending("RPC transport closed");
    notificationListeners.clear();
    requestHandler = null;
    notifyCloseListeners("RPC transport closed");
    try {
      child.stdin.end?.();
    } catch {
      // Ignore close errors.
    }
    try {
      child.kill?.("SIGTERM");
    } catch {
      // Ignore kill errors.
    }
  }

  return {
    request,
    notify,
    onNotification,
    onRequest: registerRequestHandler,
    onClose,
    close,
  };
}
