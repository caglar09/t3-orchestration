import { randomUUID } from "node:crypto";

const ALLOWED_MODES = new Set(["read", "write"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "interrupted"]);
const RECONCILABLE_STATUSES = new Set(["creating", "starting", "running", "recovery_required"]);
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const DEFAULT_READ_LIMIT = 20;
const MAX_READ_LIMIT = 100;
const DEFAULT_INBOX_LIMIT = 20;
const DEFAULT_CANCEL_TIMEOUT_MS = 30_000;
const MAX_RECONCILE_PAGES = 100;

function requireSafeString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  if (FORBIDDEN_KEYS.has(value)) {
    throw new TypeError(`${label} contains forbidden key "${value}"`);
  }
  return value;
}

function validateLimit(limit, defaultValue, maxValue, label) {
  if (limit === undefined) return defaultValue;
  if (!Number.isInteger(limit) || limit < 1 || limit > maxValue) {
    throw new RangeError(`${label} must be an integer between 1 and ${maxValue}`);
  }
  return limit;
}

function requestKey(projectId, requestId) {
  return `${projectId}:${requestId}`;
}

function eventIdFor(projectId, workerId, turnId) {
  return `${projectId}:${workerId}:${turnId}`;
}

function extractTurnErrorCode(turnError) {
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

function buildTerminalEvent({ projectId, workerId, threadId, turnId, status, errorCode, createdAt }) {
  return {
    id: eventIdFor(projectId, workerId, turnId),
    projectId,
    workerId,
    threadId,
    turnId,
    status,
    ...(errorCode ? { errorCode } : {}),
    createdAt,
    ackAt: null,
  };
}

function hasEvent(events, projectId, workerId, turnId) {
  const id = eventIdFor(projectId, workerId, turnId);
  return events.some((ev) => ev && ev.id === id);
}

function findWorkerByThreadId(workers, threadId) {
  for (const key of Object.keys(workers)) {
    const worker = workers[key];
    if (worker && worker.threadId === threadId) {
      return worker;
    }
  }
  return null;
}

function getOwnedWorker(workers, projectId, workerId) {
  if (!Object.hasOwn(workers, workerId)) {
    throw new Error(`Worker "${workerId}" not found`);
  }
  const worker = workers[workerId];
  if (!worker || worker.projectId !== projectId) {
    throw new Error(`Worker "${workerId}" does not belong to project "${projectId}"`);
  }
  return worker;
}

function shouldApplyTerminal(worker, turnId, events) {
  if (hasEvent(events, worker.projectId, worker.id, turnId)) {
    return false;
  }
  if (worker.status === "creating") {
    return false;
  }
  if (worker.activeTurnId) {
    return turnId === worker.activeTurnId;
  }
  if (TERMINAL_STATUSES.has(worker.status)) {
    return false;
  }
  const turnOrder = Array.isArray(worker.turnOrder) ? worker.turnOrder : [];
  if (turnOrder.includes(turnId)) {
    return worker.lastTurnId === turnId;
  }
  return true;
}

function applyTerminalToDraft(draft, worker, { turnId, status, errorCode }, now) {
  const turnOrder = Array.isArray(worker.turnOrder) ? worker.turnOrder : [];
  if (!turnOrder.includes(turnId)) {
    turnOrder.push(turnId);
  }
  worker.turnOrder = turnOrder;
  worker.status = status;
  worker.activeTurnId = null;
  worker.lastTurnId = turnId;
  worker.errorCode = errorCode ?? null;
  worker.lastError = status === "failed" ? (errorCode ?? "turn_failed") : null;
  worker.updatedAt = now;

  if (!hasEvent(draft.events, worker.projectId, worker.id, turnId)) {
    draft.events.push(
      buildTerminalEvent({
        projectId: worker.projectId,
        workerId: worker.id,
        threadId: worker.threadId,
        turnId,
        status,
        errorCode,
        createdAt: now,
      }),
    );
  }
}

function countActiveWorkers(workers, projectId, excludeWorkerId = null) {
  let count = 0;
  for (const key of Object.keys(workers)) {
    const worker = workers[key];
    if (!worker || worker.projectId !== projectId) continue;
    if (excludeWorkerId && worker.id === excludeWorkerId) continue;
    if (!TERMINAL_STATUSES.has(worker.status)) {
      count += 1;
    }
  }
  return count;
}

/**
 * Creates a project-scoped worker lifecycle service backed by durable state,
 * the Codex App Server adapter, and isolated Git worktree management.
 */
export function createWorkerService({
  state,
  appServer,
  worktrees,
  clock = () => new Date().toISOString(),
  maxWorkers = 2,
  cancelTimeoutMs = DEFAULT_CANCEL_TIMEOUT_MS,
} = {}) {
  if (!state || typeof state.read !== "function" || typeof state.transact !== "function") {
    throw new TypeError("state must provide read() and transact()");
  }
  if (
    !appServer ||
    typeof appServer.startThread !== "function" ||
    typeof appServer.startTurn !== "function" ||
    typeof appServer.readThread !== "function" ||
    typeof appServer.listTurns !== "function" ||
    typeof appServer.interrupt !== "function" ||
    typeof appServer.onTerminal !== "function"
  ) {
    throw new TypeError("appServer must provide startThread, startTurn, readThread, listTurns, interrupt, and onTerminal");
  }
  if (typeof clock !== "function") {
    throw new TypeError("clock must be a function");
  }
  if (!Number.isInteger(maxWorkers) || maxWorkers < 1) {
    throw new RangeError("maxWorkers must be a positive integer");
  }

  let disposed = false;
  let mutationChain = Promise.resolve();
  const inFlightByThread = new Map();
  const earlyTerminals = new Map();
  const terminalWaiters = new Map();

  function assertNotDisposed() {
    if (disposed) {
      throw new Error("Worker service is disposed");
    }
  }

  function withMutationLock(fn) {
    const run = mutationChain.then(() => {
      assertNotDisposed();
      return fn();
    });
    mutationChain = run.catch(() => {});
    return run;
  }

  function resolveTerminalWaiters(threadId, turnId, workerSnapshot) {
    const key = `${threadId}:${turnId}`;
    const waiters = terminalWaiters.get(key);
    if (!waiters || waiters.size === 0) return;
    terminalWaiters.delete(key);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(structuredClone(workerSnapshot));
    }
  }

  function registerTerminalWaiter(threadId, turnId) {
    const key = `${threadId}:${turnId}`;
    let entry;
    let waiters;
    const promise = new Promise((resolve, reject) => {
      waiters = terminalWaiters.get(key);
      if (!waiters) {
        waiters = new Set();
        terminalWaiters.set(key, waiters);
      }
      entry = {
        resolve,
        reject,
        timer: setTimeout(() => {
          waiters.delete(entry);
          if (waiters.size === 0) terminalWaiters.delete(key);
          reject(new Error(`Timed out waiting for terminal event on ${threadId}:${turnId}`));
        }, cancelTimeoutMs),
      };
      waiters.add(entry);
    });
    return {
      promise,
      cancelWaiter() {
        if (!entry || !waiters) return;
        clearTimeout(entry.timer);
        waiters.delete(entry);
        if (waiters.size === 0) terminalWaiters.delete(key);
      },
    };
  }

  function markRecoveryRequired(workerId, err, updates = {}) {
    const now = clock();
    state.transact((draft) => {
      if (!Object.hasOwn(draft.workers, workerId)) return;
      const worker = draft.workers[workerId];
      Object.assign(worker, updates, {
        status: "recovery_required",
        activeTurnId: null,
        lastError: err?.message ?? String(err),
        updatedAt: now,
      });
    });
  }

  function applyTerminalEvent(event) {
    if (disposed || !event || typeof event !== "object") return;
    const { threadId, turnId, status, errorCode } = event;
    if (
      typeof threadId !== "string" ||
      threadId.length === 0 ||
      typeof turnId !== "string" ||
      turnId.length === 0 ||
      typeof status !== "string" ||
      !TERMINAL_STATUSES.has(status)
    ) {
      return;
    }

    if (inFlightByThread.has(threadId)) {
      earlyTerminals.set(`${threadId}:${turnId}`, {
        threadId,
        turnId,
        status,
        ...(errorCode ? { errorCode } : {}),
        receivedAt: clock(),
      });
      return;
    }

    const current = state.read();
    const candidate = findWorkerByThreadId(current.workers, threadId);
    if (!candidate) return;
    if (!shouldApplyTerminal(candidate, turnId, current.events)) return;

    const now = clock();
    const committed = state.transact((draft) => {
      const worker = findWorkerByThreadId(draft.workers, threadId);
      if (!worker) return;
      if (!shouldApplyTerminal(worker, turnId, draft.events)) return;
      applyTerminalToDraft(draft, worker, { turnId, status, errorCode }, now);
    });

    const updatedWorker = committed.workers[candidate.id];
    if (updatedWorker) {
      resolveTerminalWaiters(threadId, turnId, updatedWorker);
    }
  }

  function handleApprovalRequest(event) {
    if (disposed || !event || typeof event !== "object") return;
    const threadId = event.threadId;
    if (typeof threadId !== "string" || threadId.length === 0) return;

    const current = state.read();
    const candidate = findWorkerByThreadId(current.workers, threadId);
    if (!candidate) return;

    const now = clock();
    state.transact((draft) => {
      const worker = findWorkerByThreadId(draft.workers, threadId);
      if (!worker) return;
      worker.approvalRequired = true;
      worker.pendingApproval = {
        status: "approval_required",
        id: event.id ?? null,
        method: typeof event.method === "string" ? event.method : "unknown",
        ...(typeof event.turnId === "string" && event.turnId.length > 0 ? { turnId: event.turnId } : {}),
        ...(typeof event.itemId === "string" && event.itemId.length > 0 ? { itemId: event.itemId } : {}),
        ...(typeof event.reason === "string" && event.reason.length > 0 ? { reason: event.reason } : {}),
        receivedAt: now,
      };
      worker.updatedAt = now;
    });
  }

  const unsubTerminal = appServer.onTerminal(applyTerminalEvent);
  const unsubApproval =
    typeof appServer.onApprovalRequest === "function"
      ? appServer.onApprovalRequest(handleApprovalRequest)
      : null;

  function popEarlyTerminalForThread(threadId, preferredTurnId = null) {
    if (preferredTurnId) {
      const exactKey = `${threadId}:${preferredTurnId}`;
      const exact = earlyTerminals.get(exactKey);
      if (exact) {
        earlyTerminals.delete(exactKey);
        return exact;
      }
      return null;
    }
    const prefix = `${threadId}:`;
    for (const [key, ev] of earlyTerminals.entries()) {
      if (key.startsWith(prefix)) {
        earlyTerminals.delete(key);
        return ev;
      }
    }
    return null;
  }

  async function startAndTrackTurn({ projectId, workerId, threadId, brief, mode, writableRoots }) {
    inFlightByThread.set(threadId, { projectId, workerId });
    try {
      let turnRes;
      try {
        turnRes = await appServer.startTurn({
          threadId,
          brief,
          mode,
          ...(mode === "write" ? { writableRoots } : {}),
        });
      } catch (err) {
        const earlyOnError = popEarlyTerminalForThread(threadId);
        if (earlyOnError) {
          const now = clock();
          const committed = state.transact((draft) => {
            const worker = draft.workers[workerId];
            if (!worker) return;
            applyTerminalToDraft(draft, worker, earlyOnError, earlyOnError.receivedAt ?? now);
          });
          const finalWorker = committed.workers[workerId];
          if (finalWorker) {
            resolveTerminalWaiters(threadId, earlyOnError.turnId, finalWorker);
            return structuredClone(finalWorker);
          }
        }
        markRecoveryRequired(workerId, err);
        throw err;
      }

      const turnId = turnRes?.turn?.id;
      if (typeof turnId !== "string" || turnId.length === 0) {
        const earlyOnBadReply = popEarlyTerminalForThread(threadId);
        if (earlyOnBadReply) {
          const now = clock();
          const committed = state.transact((draft) => {
            const worker = draft.workers[workerId];
            if (!worker) return;
            applyTerminalToDraft(draft, worker, earlyOnBadReply, earlyOnBadReply.receivedAt ?? now);
          });
          const finalWorker = committed.workers[workerId];
          if (finalWorker) {
            resolveTerminalWaiters(threadId, earlyOnBadReply.turnId, finalWorker);
            return structuredClone(finalWorker);
          }
        }
        const err = new Error("appServer.startTurn did not return a valid turn.id");
        markRecoveryRequired(workerId, err);
        throw err;
      }

      const earlyEvent = popEarlyTerminalForThread(threadId, turnId);

      const now = clock();
      const committed = state.transact((draft) => {
        const worker = draft.workers[workerId];
        if (!worker) return;
        const turnOrder = Array.isArray(worker.turnOrder) ? worker.turnOrder : [];
        if (!turnOrder.includes(turnId)) {
          turnOrder.push(turnId);
        }
        worker.turnOrder = turnOrder;
        worker.lastTurnId = turnId;
        worker.updatedAt = now;

        if (earlyEvent) {
          applyTerminalToDraft(draft, worker, earlyEvent, earlyEvent.receivedAt ?? now);
        } else {
          worker.status = "running";
          worker.activeTurnId = turnId;
        }
      });

      const finalWorker = committed.workers[workerId];
      if (earlyEvent && finalWorker) {
        resolveTerminalWaiters(threadId, turnId, finalWorker);
      }
      return structuredClone(finalWorker);
    } finally {
      inFlightByThread.delete(threadId);
    }
  }

  async function launch({ projectId, requestId, brief, mode = "read", authorized = false } = {}) {
    return withMutationLock(async () => {
      requireSafeString(projectId, "projectId");
      requireSafeString(requestId, "requestId");
      requireSafeString(brief, "brief");
      if (!ALLOWED_MODES.has(mode)) {
        throw new RangeError(`Unsupported mode: ${String(mode)}`);
      }

      const snap = state.read();
      const reqKey = requestKey(projectId, requestId);
      if (Object.hasOwn(snap.requests, reqKey)) {
        const existingReq = snap.requests[reqKey];
        if (
          existingReq.action !== "launch" ||
          existingReq.brief !== brief ||
          existingReq.mode !== mode
        ) {
          throw new Error(`requestId "${requestId}" conflict: payload mismatch`);
        }
        return structuredClone(getOwnedWorker(snap.workers, projectId, existingReq.workerId));
      }

      if (mode === "write" && authorized !== true) {
        throw new Error("Unauthorized write mode: explicit authorization is required");
      }
      if (mode === "write" && (!worktrees || typeof worktrees.prepare !== "function")) {
        throw new Error("Write mode requires a worktree manager");
      }

      const activeCount = countActiveWorkers(snap.workers, projectId);
      if (activeCount >= maxWorkers) {
        throw new Error(`Worker limit reached for project "${projectId}" (maxWorkers=${maxWorkers})`);
      }

      const workerId = randomUUID();
      const createdAt = clock();
      state.transact((draft) => {
        draft.workers[workerId] = {
          id: workerId,
          projectId,
          threadId: null,
          worktree: null,
          cwd: null,
          writableRoots: [],
          mode,
          status: "creating",
          activeTurnId: null,
          lastTurnId: null,
          turnOrder: [],
          approvalRequired: false,
          pendingApproval: null,
          requestId,
          brief,
          errorCode: null,
          lastError: null,
          createdAt,
          updatedAt: createdAt,
        };
        draft.requests[reqKey] = {
          projectId,
          requestId,
          action: "launch",
          workerId,
          brief,
          mode,
          createdAt,
        };
      });

      let prepared;
      try {
        prepared = worktrees && typeof worktrees.prepare === "function"
          ? await worktrees.prepare({ workerId, mode, authorized: mode === "write" ? authorized : false })
          : { mode: "read", cwd: process.cwd(), worktree: null, writableRoots: [] };
      } catch (err) {
        const failedAt = clock();
        state.transact((draft) => {
          if (!Object.hasOwn(draft.workers, workerId)) return;
          Object.assign(draft.workers[workerId], {
            status: "failed",
            activeTurnId: null,
            errorCode: "prepare_failed",
            lastError: err?.message ?? String(err),
            updatedAt: failedAt,
          });
        });
        throw err;
      }

      if (
        !prepared ||
        typeof prepared.cwd !== "string" ||
        prepared.cwd.length === 0 ||
        (mode === "write" && (!Array.isArray(prepared.writableRoots) || prepared.writableRoots.length === 0))
      ) {
        const err = new Error("worktrees.prepare returned invalid isolation paths");
        const failedAt = clock();
        state.transact((draft) => {
          if (!Object.hasOwn(draft.workers, workerId)) return;
          Object.assign(draft.workers[workerId], {
            status: "failed",
            activeTurnId: null,
            errorCode: "prepare_failed",
            lastError: err.message,
            updatedAt: failedAt,
          });
        });
        throw err;
      }

      const developerInstructions =
        `[T3O_CODEX_WORKER_V1] You are an isolated Codex worker thread (project ${projectId}, worker ${workerId}, mode ${mode}). ` +
        "Execute strictly within your brief and assigned sandbox. Never widen scope or attempt recursive orchestration (project_setup, worker_launch, etc.). " +
        "End with actual status, concrete observed evidence, and next step/question for the user.";

      let threadRes;
      try {
        threadRes = await appServer.startThread({
          cwd: prepared.cwd,
          mode,
          developerInstructions,
          config: { mcp_servers: { t3o_codex: { enabled: false } } },
        });
      } catch (err) {
        markRecoveryRequired(workerId, err, {
          cwd: prepared.cwd,
          worktree: prepared.worktree ?? null,
          writableRoots: [...(prepared.writableRoots ?? [])],
        });
        throw err;
      }

      const threadId = threadRes?.thread?.id;
      const threadSessionId =
        typeof threadRes?.thread?.sessionId === "string" && threadRes.thread.sessionId.length > 0
          ? threadRes.thread.sessionId
          : null;
      if (typeof threadId !== "string" || threadId.length === 0) {
        const err = new Error("appServer.startThread did not return a valid thread.id");
        markRecoveryRequired(workerId, err, {
          cwd: prepared.cwd,
          worktree: prepared.worktree ?? null,
          writableRoots: [...(prepared.writableRoots ?? [])],
        });
        throw err;
      }

      const startingAt = clock();
      state.transact((draft) => {
        const worker = draft.workers[workerId];
        if (!worker) return;
        worker.threadId = threadId;
        worker.sessionId = threadSessionId;
        worker.cwd = prepared.cwd;
        worker.worktree = prepared.worktree ?? null;
        worker.writableRoots = [...(prepared.writableRoots ?? [])];
        worker.status = "starting";
        worker.updatedAt = startingAt;
      });

      return startAndTrackTurn({
        projectId,
        workerId,
        threadId,
        brief,
        mode,
        writableRoots: prepared.writableRoots ?? [],
      });
    });
  }

  async function continueWorker({ projectId, workerId, requestId, brief } = {}) {
    return withMutationLock(async () => {
      requireSafeString(projectId, "projectId");
      requireSafeString(workerId, "workerId");
      requireSafeString(requestId, "requestId");
      requireSafeString(brief, "brief");

      const snap = state.read();
      const reqKey = requestKey(projectId, requestId);
      if (Object.hasOwn(snap.requests, reqKey)) {
        const existingReq = snap.requests[reqKey];
        if (
          existingReq.action !== "continue" ||
          existingReq.workerId !== workerId ||
          existingReq.brief !== brief
        ) {
          throw new Error(`requestId "${requestId}" conflict: payload mismatch`);
        }
        return structuredClone(getOwnedWorker(snap.workers, projectId, workerId));
      }

      const worker = getOwnedWorker(snap.workers, projectId, workerId);
      if (worker.status !== "ready" && !TERMINAL_STATUSES.has(worker.status)) {
        throw new Error(`Cannot continue worker "${workerId}" in status "${worker.status}"`);
      }
      if (typeof worker.threadId !== "string" || worker.threadId.length === 0) {
        throw new Error(`Cannot continue worker "${workerId}" without a threadId`);
      }

      const activeCount = countActiveWorkers(snap.workers, projectId, workerId);
      if (activeCount >= maxWorkers) {
        throw new Error(`Worker limit reached for project "${projectId}" (maxWorkers=${maxWorkers})`);
      }

      const now = clock();
      state.transact((draft) => {
        const target = getOwnedWorker(draft.workers, projectId, workerId);
        target.status = "starting";
        target.activeTurnId = null;
        target.approvalRequired = false;
        target.pendingApproval = null;
        target.brief = brief;
        target.errorCode = null;
        target.lastError = null;
        target.updatedAt = now;

        draft.requests[reqKey] = {
          projectId,
          requestId,
          action: "continue",
          workerId,
          brief,
          mode: target.mode,
          createdAt: now,
        };
      });

      return startAndTrackTurn({
        projectId,
        workerId,
        threadId: worker.threadId,
        brief,
        mode: worker.mode,
        writableRoots: worker.writableRoots ?? [],
      });
    });
  }

  async function list(projectId) {
    assertNotDisposed();
    requireSafeString(projectId, "projectId");
    const snap = state.read();
    return Object.values(snap.workers)
      .filter((w) => w && w.projectId === projectId)
      .map((w) => structuredClone(w));
  }

  async function read({ projectId, workerId, cursor, limit } = {}) {
    assertNotDisposed();
    requireSafeString(projectId, "projectId");
    requireSafeString(workerId, "workerId");
    const effectiveLimit = validateLimit(limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT, "limit");

    const snap = state.read();
    const worker = getOwnedWorker(snap.workers, projectId, workerId);
    if (!worker.threadId) {
      return {
        worker: structuredClone(worker),
        turns: [],
        nextCursor: null,
      };
    }

    const page = await appServer.listTurns({
      threadId: worker.threadId,
      ...(typeof cursor === "string" && cursor.length > 0 ? { cursor } : {}),
      limit: effectiveLimit,
    });

    return {
      worker: structuredClone(worker),
      turns: Array.isArray(page?.data) ? structuredClone(page.data) : [],
      nextCursor: page?.nextCursor ?? null,
      ...(page?.backwardsCursor !== undefined ? { backwardsCursor: page.backwardsCursor } : {}),
    };
  }

  async function cancel({ projectId, workerId } = {}) {
    const target = await withMutationLock(async () => {
      requireSafeString(projectId, "projectId");
      requireSafeString(workerId, "workerId");

      const snap = state.read();
      const worker = getOwnedWorker(snap.workers, projectId, workerId);
      if (TERMINAL_STATUSES.has(worker.status)) {
        return { alreadyTerminal: true, worker: structuredClone(worker) };
      }
      if (!worker.threadId || !worker.activeTurnId) {
        throw new Error(`Cannot cancel worker "${workerId}" without an active turn`);
      }

      const waiter = registerTerminalWaiter(worker.threadId, worker.activeTurnId);
      return {
        alreadyTerminal: false,
        threadId: worker.threadId,
        turnId: worker.activeTurnId,
        waiter,
      };
    });

    if (target.alreadyTerminal) {
      return target.worker;
    }

    try {
      await appServer.interrupt({ threadId: target.threadId, turnId: target.turnId });
    } catch (err) {
      target.waiter.cancelWaiter();
      const latestSnap = state.read();
      const latestWorker = Object.hasOwn(latestSnap.workers, workerId)
        ? latestSnap.workers[workerId]
        : null;
      if (latestWorker && latestWorker.projectId === projectId && TERMINAL_STATUSES.has(latestWorker.status)) {
        return structuredClone(latestWorker);
      }
      throw err;
    }

    return target.waiter.promise;
  }

  async function resolveWorker({ projectId, workerId, resolution = "failed", reason } = {}) {
    return withMutationLock(async () => {
      requireSafeString(projectId, "projectId");
      requireSafeString(workerId, "workerId");
      if (resolution !== "failed" && resolution !== "interrupted") {
        throw new RangeError(`Unsupported resolution status: ${String(resolution)}`);
      }
      const snap = state.read();
      const worker = getOwnedWorker(snap.workers, projectId, workerId);
      if (worker.status !== "recovery_required" && !worker.approvalRequired) {
        throw new Error(`Worker "${workerId}" is not in recovery_required or approval_required state`);
      }
      const now = clock();
      const committed = state.transact((draft) => {
        const target = getOwnedWorker(draft.workers, projectId, workerId);
        target.status = resolution;
        target.activeTurnId = null;
        target.approvalRequired = false;
        target.pendingApproval = null;
        target.errorCode = target.errorCode ?? (resolution === "failed" ? "operator_resolved" : null);
        target.lastError = typeof reason === "string" && reason.trim().length > 0 ? reason.trim() : "resolved_by_operator";
        target.updatedAt = now;
      });
      return structuredClone(committed.workers[workerId]);
    });
  }

  async function fetchThreadTurns(threadId) {
    let threadResult = null;
    try {
      threadResult = await appServer.readThread(threadId, { includeTurns: true });
    } catch {
      return { ok: false, turns: [] };
    }

    const collected = [];
    let cursor;
    let sawPagedArray = false;
    for (let pageIndex = 0; pageIndex < MAX_RECONCILE_PAGES; pageIndex += 1) {
      let page;
      try {
        page = await appServer.listTurns({
          threadId,
          ...(cursor ? { cursor } : {}),
          limit: MAX_READ_LIMIT,
          sortDirection: "asc",
        });
      } catch {
        if (pageIndex > 0) {
          return { ok: false, turns: [] };
        }
        break;
      }
      if (!Array.isArray(page?.data)) break;
      sawPagedArray = true;
      collected.push(...page.data);
      if (typeof page.nextCursor !== "string" || page.nextCursor.length === 0) {
        break;
      }
      cursor = page.nextCursor;
    }

    if (sawPagedArray && collected.length > 0) {
      return { ok: true, turns: collected };
    }
    if (Array.isArray(threadResult?.thread?.turns) && threadResult.thread.turns.length > 0) {
      return { ok: true, turns: threadResult.thread.turns };
    }
    return { ok: true, turns: sawPagedArray ? collected : [] };
  }

  function findTurnToReconcile(worker, turns, events, projectId) {
    if (worker.activeTurnId) {
      return turns.find((t) => t && t.id === worker.activeTurnId) ?? null;
    }
    const turnOrder = Array.isArray(worker.turnOrder) ? worker.turnOrder : [];
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const turn = turns[i];
      if (!turn || typeof turn.id !== "string" || turn.id.length === 0) continue;
      if (hasEvent(events, projectId, worker.id, turn.id)) continue;
      if (turnOrder.includes(turn.id) && worker.lastTurnId && worker.lastTurnId !== turn.id) continue;
      return turn;
    }
    return null;
  }

  async function reconcile(projectId) {
    return withMutationLock(async () => {
      requireSafeString(projectId, "projectId");
      const snap = state.read();
      const candidates = Object.values(snap.workers).filter(
        (w) => w && w.projectId === projectId && RECONCILABLE_STATUSES.has(w.status),
      );
      if (candidates.length === 0) {
        return {
          workers: Object.values(snap.workers)
            .filter((w) => w && w.projectId === projectId)
            .map((w) => structuredClone(w)),
          reconciledCount: 0,
          eventsAdded: 0,
        };
      }

      const observations = new Map();
      for (const worker of candidates) {
        if (!worker.threadId) {
          observations.set(worker.id, { missingCorrelation: true });
          continue;
        }
        const inspected = await fetchThreadTurns(worker.threadId);
        observations.set(worker.id, inspected);
      }

      let eventsAdded = 0;
      let reconciledCount = 0;
      const now = clock();

      const committed = state.transact((draft) => {
        for (const candidate of candidates) {
          const worker = draft.workers[candidate.id];
          if (!worker || worker.projectId !== projectId || !RECONCILABLE_STATUSES.has(worker.status)) {
            continue;
          }

          const obs = observations.get(worker.id);
          if (!obs || obs.missingCorrelation || !obs.ok) {
            if (worker.status !== "recovery_required") {
              worker.status = "recovery_required";
              worker.activeTurnId = null;
              worker.updatedAt = now;
              reconciledCount += 1;
            }
            continue;
          }

          const turn = findTurnToReconcile(worker, obs.turns, draft.events, projectId);
          if (!turn) {
            if (worker.status !== "recovery_required") {
              worker.status = "recovery_required";
              worker.activeTurnId = null;
              worker.updatedAt = now;
              reconciledCount += 1;
            }
            continue;
          }

          if (TERMINAL_STATUSES.has(turn.status)) {
            const hadEvent = hasEvent(draft.events, projectId, worker.id, turn.id);
            const errorCode = extractTurnErrorCode(turn.error);
            applyTerminalToDraft(draft, worker, { turnId: turn.id, status: turn.status, errorCode }, now);
            if (!hadEvent) eventsAdded += 1;
            reconciledCount += 1;
          } else if (turn.status === "inProgress") {
            const turnOrder = Array.isArray(worker.turnOrder) ? worker.turnOrder : [];
            if (!turnOrder.includes(turn.id)) turnOrder.push(turn.id);
            worker.turnOrder = turnOrder;
            worker.status = "running";
            worker.activeTurnId = turn.id;
            worker.lastTurnId = turn.id;
            worker.updatedAt = now;
            reconciledCount += 1;
          } else if (worker.status !== "recovery_required") {
            worker.status = "recovery_required";
            worker.activeTurnId = null;
            worker.updatedAt = now;
            reconciledCount += 1;
          }
        }
      });

      return {
        workers: Object.values(committed.workers)
          .filter((w) => w && w.projectId === projectId)
          .map((w) => structuredClone(w)),
        reconciledCount,
        eventsAdded,
      };
    });
  }

  async function inbox({ projectId, limit } = {}) {
    assertNotDisposed();
    requireSafeString(projectId, "projectId");
    const effectiveLimit = validateLimit(limit, DEFAULT_INBOX_LIMIT, MAX_READ_LIMIT, "limit");
    const snap = state.read();
    return snap.events
      .filter((ev) => ev && ev.projectId === projectId && ev.ackAt === null)
      .slice(0, effectiveLimit)
      .map((ev) => structuredClone(ev));
  }

  async function ack({ projectId, eventIds } = {}) {
    return withMutationLock(async () => {
      requireSafeString(projectId, "projectId");
      if (!Array.isArray(eventIds)) {
        throw new TypeError("eventIds must be an array");
      }
      const uniqueIds = [];
      const seen = new Set();
      for (const id of eventIds) {
        requireSafeString(id, "eventId");
        if (!seen.has(id)) {
          seen.add(id);
          uniqueIds.push(id);
        }
      }

      if (uniqueIds.length === 0) {
        return { ackedIds: [], newlyAckedCount: 0 };
      }

      const snap = state.read();
      const byId = new Map();
      for (const ev of snap.events) {
        if (ev && typeof ev.id === "string") {
          byId.set(ev.id, ev);
        }
      }

      for (const id of uniqueIds) {
        const ev = byId.get(id);
        if (!ev) {
          throw new Error(`Unknown eventId "${id}"`);
        }
        if (ev.projectId !== projectId) {
          throw new Error(`Event "${id}" does not belong to project "${projectId}"`);
        }
      }

      const now = clock();
      let newlyAckedCount = 0;
      state.transact((draft) => {
        const draftById = new Map();
        for (const ev of draft.events) {
          if (ev && typeof ev.id === "string") {
            draftById.set(ev.id, ev);
          }
        }
        for (const id of uniqueIds) {
          const ev = draftById.get(id);
          if (!ev || ev.projectId !== projectId) {
            throw new Error(`Event "${id}" cannot be acknowledged`);
          }
          if (ev.ackAt === null) {
            ev.ackAt = now;
            newlyAckedCount += 1;
          }
        }
      });

      return { ackedIds: uniqueIds, newlyAckedCount };
    });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    unsubTerminal?.();
    unsubApproval?.();
    inFlightByThread.clear();
    earlyTerminals.clear();
    for (const waiters of terminalWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("Worker service disposed"));
      }
    }
    terminalWaiters.clear();
  }

  return {
    launch,
    continue: continueWorker,
    list,
    read,
    cancel,
    resolve: resolveWorker,
    reconcile,
    inbox,
    ack,
    dispose,
  };
}
