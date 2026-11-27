const DEFAULT_CLIENT_INFO = { name: "t3_orchestration_codex", version: "0.1.0" };
const ALLOWED_APPROVAL_POLICIES = new Set(["never", "untrusted", "on-request"]);
const ALLOWED_ITEMS_VIEWS = new Set(["notLoaded", "summary", "full"]);
const ALLOWED_SORT_DIRECTIONS = new Set(["asc", "desc"]);
const METHOD_NOT_FOUND = -32601;

const APPROVAL_RESPONSES = {
  "item/commandExecution/requestApproval": () => ({ decision: "decline" }),
  "item/fileChange/requestApproval": () => ({ decision: "decline" }),
  applyPatchApproval: () => ({
    decision: { denied: { rejection: "Approval denied by bridge policy" } },
  }),
  execCommandApproval: () => ({
    decision: { denied: { rejection: "Approval denied by bridge policy" } },
  }),
  "mcpServer/elicitation/request": () => ({ action: "decline" }),
  "item/permissions/requestApproval": () => ({ permissions: {} }),
};

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function validateSandboxMode(mode = "read") {
  if (mode === "read") return "read-only";
  if (mode === "write") return "workspace-write";
  throw new RangeError(`Unsupported sandbox mode: ${String(mode)}`);
}

function validateApprovalPolicy(policy) {
  if (!ALLOWED_APPROVAL_POLICIES.has(policy)) {
    throw new RangeError(`Unsupported approvalPolicy: ${String(policy)}`);
  }
  return policy;
}

function buildSandboxPolicy(mode = "read", writableRoots) {
  if (mode === "read") {
    return { type: "readOnly" };
  }
  if (mode === "write") {
    if (
      !Array.isArray(writableRoots) ||
      writableRoots.length === 0 ||
      writableRoots.some((root) => typeof root !== "string" || root.length === 0)
    ) {
      throw new TypeError("writableRoots must be a non-empty array of paths in write mode");
    }
    return { type: "workspaceWrite", writableRoots: [...writableRoots] };
  }
  throw new RangeError(`Unsupported sandbox mode: ${String(mode)}`);
}

function extractErrorCode(turnError) {
  if (!turnError || typeof turnError !== "object") return undefined;
  const info = turnError.codexErrorInfo;
  if (typeof info === "string" && info.length > 0) return info;
  if (info && typeof info === "object" && !Array.isArray(info)) {
    const keys = Object.keys(info);
    if (keys.length > 0) return keys[0];
  }
  if (typeof turnError.code === "string" && turnError.code.length > 0) {
    return turnError.code;
  }
  return undefined;
}

function normalizeTerminalEvent(note) {
  if (note?.method !== "turn/completed") return null;
  const params = note.params;
  if (!params || typeof params !== "object") return null;
  const { threadId, turn } = params;
  if (
    typeof threadId !== "string" ||
    threadId.length === 0 ||
    !turn ||
    typeof turn !== "object" ||
    typeof turn.id !== "string" ||
    turn.id.length === 0 ||
    typeof turn.status !== "string" ||
    turn.status.length === 0
  ) {
    return null;
  }

  const errorCode = extractErrorCode(turn.error);
  return {
    threadId,
    turnId: turn.id,
    status: turn.status,
    ...(errorCode ? { errorCode } : {}),
  };
}

function normalizeRateLimits(response) {
  const rateLimits = response?.rateLimits;
  if (!rateLimits || typeof rateLimits !== "object") {
    return { status: "unknown", windows: [] };
  }

  const windows = [];
  for (const name of ["primary", "secondary"]) {
    const win = rateLimits[name];
    if (!win || typeof win !== "object") continue;
    if (typeof win.usedPercent !== "number" || !Number.isFinite(win.usedPercent)) continue;

    windows.push({
      name,
      usedPercent: win.usedPercent,
      resetsAt: typeof win.resetsAt === "number" && Number.isFinite(win.resetsAt) ? win.resetsAt : null,
      windowDurationMins:
        typeof win.windowDurationMins === "number" && Number.isFinite(win.windowDurationMins)
          ? win.windowDurationMins
          : null,
    });
  }

  const planType =
    typeof rateLimits.planType === "string" &&
    rateLimits.planType.length > 0 &&
    rateLimits.planType !== "unknown"
      ? rateLimits.planType
      : undefined;
  const accountType =
    typeof response?.accountType === "string" && response.accountType.length > 0
      ? response.accountType
      : undefined;

  return {
    status: windows.length > 0 ? "known" : "unknown",
    windows,
    ...(planType ? { planType } : {}),
    ...(accountType ? { accountType } : {}),
  };
}

function normalizeApprovalEvent(req) {
  const params = req.params && typeof req.params === "object" ? req.params : {};
  const threadId =
    typeof params.threadId === "string"
      ? params.threadId
      : typeof params.conversationId === "string"
        ? params.conversationId
        : undefined;
  const turnId = typeof params.turnId === "string" ? params.turnId : undefined;
  const itemId =
    typeof params.itemId === "string"
      ? params.itemId
      : typeof params.callId === "string"
        ? params.callId
        : undefined;
  const reason = typeof params.reason === "string" ? params.reason : undefined;

  return {
    id: req.id,
    method: req.method,
    ...(threadId ? { threadId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(itemId ? { itemId } : {}),
    ...(reason ? { reason } : {}),
    params,
  };
}

/**
 * Adapter over the Codex 0.172.0 App Server JSON-RPC protocol.
 * Normalizes terminal events and rate limits, and safely declines server approval requests.
 */
export function createAppServer(rpc, options = {}) {
  if (
    !rpc ||
    typeof rpc.request !== "function" ||
    typeof rpc.notify !== "function" ||
    typeof rpc.onNotification !== "function"
  ) {
    throw new TypeError("rpc transport must provide request, notify, and onNotification");
  }

  const clientInfo = options.clientInfo ?? DEFAULT_CLIENT_INFO;
  const defaultApprovalPolicy = validateApprovalPolicy(options.approvalPolicy ?? "on-request");
  const terminalListeners = new Set();
  const approvalListeners = new Set();

  const unsubscribeNotification = rpc.onNotification((note) => {
    const normalized = normalizeTerminalEvent(note);
    if (!normalized) return;
    for (const listener of [...terminalListeners]) {
      try {
        listener(normalized);
      } catch {
        // Isolate listener failures.
      }
    }
  });

  function handleServerRequest(req) {
    const respond = req && typeof req.method === "string" ? APPROVAL_RESPONSES[req.method] : null;
    if (!respond) {
      const err = new Error(`Unsupported server request: ${req?.method ?? "unknown"}`);
      err.code = METHOD_NOT_FOUND;
      throw err;
    }

    const event = normalizeApprovalEvent(req);
    for (const listener of [...approvalListeners]) {
      try {
        listener(event);
      } catch {
        // Never allow listener errors to change the safe decline response.
      }
    }
    return respond();
  }

  const unsubscribeRequest =
    typeof rpc.onRequest === "function" ? rpc.onRequest(handleServerRequest) : null;

  async function initialize() {
    const params = { clientInfo };
    if (options.capabilities && typeof options.capabilities === "object") {
      params.capabilities = options.capabilities;
    }
    const result = await rpc.request("initialize", params);
    await rpc.notify("initialized", {});
    return result;
  }

  async function startThread({
    cwd,
    mode = "read",
    instructions,
    developerInstructions,
    baseInstructions,
    approvalPolicy,
    ephemeral = false,
    config,
  } = {}) {
    requireNonEmptyString(cwd, "cwd");
    const sandbox = validateSandboxMode(mode);
    const effectiveApprovalPolicy = validateApprovalPolicy(approvalPolicy ?? defaultApprovalPolicy);
    const devInstructions = developerInstructions ?? instructions;

    const params = {
      cwd,
      sandbox,
      approvalPolicy: effectiveApprovalPolicy,
      ephemeral: Boolean(ephemeral),
    };
    if (typeof devInstructions === "string" && devInstructions.length > 0) {
      params.developerInstructions = devInstructions;
    }
    if (typeof baseInstructions === "string" && baseInstructions.length > 0) {
      params.baseInstructions = baseInstructions;
    }
    if (config && typeof config === "object" && !Array.isArray(config)) {
      params.config = config;
    }

    return rpc.request("thread/start", params);
  }

  async function startTurn({
    threadId,
    brief,
    input,
    toolOutput,
    mode = "read",
    writableRoots,
    approvalPolicy,
  } = {}) {
    requireNonEmptyString(threadId, "threadId");
    const effectiveApprovalPolicy = validateApprovalPolicy(approvalPolicy ?? defaultApprovalPolicy);
    const sandboxPolicy = buildSandboxPolicy(mode, writableRoots);

    let normalizedInput;
    if (Array.isArray(input)) {
      normalizedInput = [...input];
    } else if (typeof brief === "string" && brief.length > 0) {
      normalizedInput = [{ type: "text", text: brief }];
    } else if (toolOutput !== undefined) {
      normalizedInput = [];
    } else {
      throw new TypeError("startTurn requires brief, input, or toolOutput");
    }

    const params = {
      threadId,
      input: normalizedInput,
      approvalPolicy: effectiveApprovalPolicy,
      sandboxPolicy,
    };

    if (toolOutput !== undefined) {
      if (
        !toolOutput ||
        typeof toolOutput !== "object" ||
        typeof toolOutput.name !== "string" ||
        toolOutput.name.length === 0 ||
        toolOutput.output === undefined
      ) {
        throw new TypeError("toolOutput must include name and output");
      }
      params.toolOutput = toolOutput;
    }

    return rpc.request("turn/start", params);
  }

  async function readThread(threadId, opts = {}) {
    requireNonEmptyString(threadId, "threadId");
    const params = { threadId };
    if (typeof opts?.includeTurns === "boolean") {
      params.includeTurns = opts.includeTurns;
    }
    return rpc.request("thread/read", params);
  }

  async function listTurns({ threadId, cursor, limit, itemsView, sortDirection } = {}) {
    requireNonEmptyString(threadId, "threadId");
    const params = { threadId };
    if (typeof cursor === "string" && cursor.length > 0) {
      params.cursor = cursor;
    }
    if (typeof limit === "number" && Number.isInteger(limit) && limit >= 0) {
      params.limit = limit;
    }
    if (itemsView !== undefined) {
      if (!ALLOWED_ITEMS_VIEWS.has(itemsView)) {
        throw new RangeError(`Unsupported itemsView: ${String(itemsView)}`);
      }
      params.itemsView = itemsView;
    }
    if (sortDirection !== undefined) {
      if (!ALLOWED_SORT_DIRECTIONS.has(sortDirection)) {
        throw new RangeError(`Unsupported sortDirection: ${String(sortDirection)}`);
      }
      params.sortDirection = sortDirection;
    }
    return rpc.request("thread/turns/list", params);
  }

  async function resumeThread(threadId, opts = {}) {
    requireNonEmptyString(threadId, "threadId");
    const params = { threadId };
    if (typeof opts?.excludeTurns === "boolean") {
      params.excludeTurns = opts.excludeTurns;
    }
    if (typeof opts?.cwd === "string" && opts.cwd.length > 0) {
      params.cwd = opts.cwd;
    }
    if (opts?.mode !== undefined) {
      params.sandbox = validateSandboxMode(opts.mode);
    }
    if (opts?.approvalPolicy !== undefined) {
      params.approvalPolicy = validateApprovalPolicy(opts.approvalPolicy);
    }
    return rpc.request("thread/resume", params);
  }

  async function interrupt({ threadId, turnId } = {}) {
    requireNonEmptyString(threadId, "threadId");
    requireNonEmptyString(turnId, "turnId");
    return rpc.request("turn/interrupt", { threadId, turnId });
  }

  async function readAccount() {
    return rpc.request("account/read", {});
  }

  async function readLimits() {
    const response = await rpc.request("account/rateLimits/read", {});
    return normalizeRateLimits(response);
  }

  function onTerminal(fn) {
    if (typeof fn !== "function") {
      throw new TypeError("terminal listener must be a function");
    }
    terminalListeners.add(fn);
    return () => {
      terminalListeners.delete(fn);
    };
  }

  function onApprovalRequest(fn) {
    if (typeof fn !== "function") {
      throw new TypeError("approval listener must be a function");
    }
    approvalListeners.add(fn);
    return () => {
      approvalListeners.delete(fn);
    };
  }

  function onClose(fn) {
    if (typeof fn !== "function") {
      throw new TypeError("close listener must be a function");
    }
    if (typeof rpc.onClose === "function") {
      return rpc.onClose(fn);
    }
    return () => {};
  }

  function close() {
    unsubscribeNotification?.();
    unsubscribeRequest?.();
    terminalListeners.clear();
    approvalListeners.clear();
    rpc.close?.();
  }

  return {
    initialize,
    startThread,
    startTurn,
    readThread,
    listTurns,
    resumeThread,
    interrupt,
    readAccount,
    readLimits,
    onTerminal,
    onApprovalRequest,
    onClose,
    close,
  };
}
