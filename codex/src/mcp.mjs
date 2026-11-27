import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createAppServer } from "./app-server.mjs";
import {
  bindCoordinator,
  defaultConfigPath,
  loadConfig,
  saveConfigAtomic,
  resolveRole,
} from "./config.mjs";
import { createRpc } from "./rpc.mjs";
import { openState, projectStateDir, readSnapshot } from "./state.mjs";
import { createWorktreeManager } from "./worktrees.mjs";

const MAX_BRIEF_BYTES = 16 * 1024;
const DEFAULT_READ_LIMIT = 20;
const MAX_READ_LIMIT = 100;
const MAX_INBOX_LIMIT = 20;
const MAX_TEXT_LENGTH = 4000;
const CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const SECRET_REPLACEMENTS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_KEY]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, "[REDACTED_JWT]"],
  [/\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g, "[REDACTED]"],
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g, "[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED]"],
  [/\b(password|passwd|secret|api_key|apikey|access_token|refresh_token|auth_token|private_key|client_secret)\s*([:=])\s*(['"])(?:\\.|(?!\3)[^\\]){4,}\3/gi, "$1$2[REDACTED]"],
  [/\b(password|passwd|secret|api_key|apikey|access_token|refresh_token|auth_token|private_key|client_secret)\s*([:=])\s*[^\s'",;]{4,}/gi, "$1$2[REDACTED]"],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED_EMAIL]"],
];

function sanitizeString(value, maxLen = MAX_TEXT_LENGTH) {
  let cleaned = value;
  for (const [pattern, replacement] of SECRET_REPLACEMENTS) {
    cleaned = cleaned.replace(pattern, replacement);
  }
  if (cleaned.length > maxLen) {
    return `${cleaned.slice(0, maxLen - 1)}…`;
  }
  return cleaned;
}

function sanitizeValue(value, depth = 0) {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return sanitizeString(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_READ_LIMIT).map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (val === undefined || FORBIDDEN_KEYS.has(key)) continue;
      out[key] = sanitizeValue(val, depth + 1);
    }
    return out;
  }
  return undefined;
}

function formatToolResult(payload) {
  const sanitized = sanitizeValue(payload);
  return {
    content: [{ type: "text", text: JSON.stringify(sanitized) }],
    structuredContent: sanitized,
  };
}

function safeDigestCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length === 0 || b.length === 0) {
    return false;
  }
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}

function checkAndConsumePairingFromDisk(stateRoot, candidateCode) {
  const pairingPath = path.join(stateRoot, "pairing.json");
  let raw;
  try {
    raw = fs.readFileSync(pairingPath, "utf8");
  } catch {
    return false;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  if (parsed.consumed === true) return false;
  if (typeof parsed.expiresAt === "number" && Date.now() > parsed.expiresAt) {
    return false;
  }
  let matched = false;
  if (typeof parsed.codeHash === "string") {
    const candidateHash = createHash("sha256").update(candidateCode, "utf8").digest("hex");
    matched = safeDigestCompare(candidateHash, parsed.codeHash);
  } else if (typeof parsed.code === "string") {
    matched = safeDigestCompare(candidateCode, parsed.code);
  }
  if (!matched) return false;

  try {
    const updated = { ...parsed, consumed: true, consumedAt: Date.now() };
    const tmpPath = `${pairingPath}.tmp.${process.pid}`;
    const fd = fs.openSync(tmpPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, pairingPath);
  } catch {
    return false;
  }
  return true;
}

function sessionIsWorkerAnywhere(states, sessionId) {
  for (const projState of Object.values(states)) {
    if (!projState || typeof projState !== "object" || typeof projState.workers !== "object") continue;
    for (const worker of Object.values(projState.workers)) {
      if (!worker || typeof worker !== "object") continue;
      if (worker.sessionId === sessionId || worker.threadId === sessionId) {
        return true;
      }
    }
  }
  return false;
}

function sanitizeProjectSummary(project) {
  return {
    id: project.id,
    name: project.name,
    root: project.root,
    maxWorkers: project.maxWorkers,
    memoryEnabled: project.memoryEnabled,
    libraryPath: project.libraryPath,
    allowWrite: project.allowWrite,
  };
}

function sanitizeWorkerSummary(worker) {
  if (!worker || typeof worker !== "object") return null;
  return sanitizeValue({
    id: worker.id,
    projectId: worker.projectId,
    threadId: worker.threadId ?? null,
    worktree: worker.worktree ?? null,
    cwd: worker.cwd ?? null,
    mode: worker.mode ?? "read",
    status: worker.status,
    activeTurnId: worker.activeTurnId ?? null,
    lastTurnId: worker.lastTurnId ?? null,
    approvalRequired: Boolean(worker.approvalRequired),
    pendingApproval: worker.pendingApproval ?? null,
    requestId: worker.requestId ?? null,
    errorCode: worker.errorCode ?? null,
    lastError: worker.lastError ?? null,
    createdAt: worker.createdAt ?? null,
    updatedAt: worker.updatedAt ?? null,
  });
}

function normalizeAccountStatus(accountRes, limitsRes) {
  let authenticated = "unknown";
  let accountType = "unknown";
  let planType = "unknown";

  if (accountRes && typeof accountRes === "object") {
    if (accountRes.account === null) {
      authenticated = false;
    } else if (accountRes.account && typeof accountRes.account === "object") {
      authenticated = true;
      if (typeof accountRes.account.type === "string" && accountRes.account.type.length > 0) {
        accountType = accountRes.account.type;
      }
      if (typeof accountRes.account.planType === "string" && accountRes.account.planType.length > 0) {
        planType = accountRes.account.planType;
      }
    }
  }

  let limits = { status: "unknown", windows: [] };
  if (limitsRes && typeof limitsRes === "object") {
    const windows = Array.isArray(limitsRes.windows)
      ? limitsRes.windows.slice(0, 4).map((w) => ({
          name: String(w.name ?? "unknown"),
          usedPercent: typeof w.usedPercent === "number" ? w.usedPercent : null,
          resetsAt: typeof w.resetsAt === "number" ? w.resetsAt : null,
          windowDurationMins: typeof w.windowDurationMins === "number" ? w.windowDurationMins : null,
        }))
      : [];
    const status = limitsRes.status === "known" && windows.length > 0 ? "known" : "unknown";
    limits = { status, windows };
    if (planType === "unknown" && typeof limitsRes.planType === "string" && limitsRes.planType.length > 0) {
      planType = limitsRes.planType;
    }
    if (accountType === "unknown" && typeof limitsRes.accountType === "string" && limitsRes.accountType.length > 0) {
      accountType = limitsRes.accountType;
    }
  }

  return { authenticated, accountType, planType, limits };
}

const briefSchema = z
  .string()
  .min(1)
  .refine((s) => Buffer.byteLength(s, "utf8") <= MAX_BRIEF_BYTES, {
    message: `brief must be at most ${MAX_BRIEF_BYTES} bytes (16 KiB)`,
  });

const projectSetupSchema = z.strictObject({
  name: z.string().min(1).max(64),
  root: z.string().min(1),
  pairingCode: z.string().min(1),
  maxWorkers: z.number().int().min(1).max(4).optional(),
  memoryEnabled: z.boolean().optional(),
  libraryPath: z.string().min(1).nullable().optional(),
  allowWrite: z.boolean().optional(),
});

const workerLaunchSchema = z.strictObject({
  requestId: z.string().min(1).max(128),
  brief: briefSchema,
  mode: z.enum(["read", "write"]).optional(),
});

const workerListSchema = z.strictObject({});

const workerReadSchema = z.strictObject({
  workerId: z.string().min(1).max(64),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(MAX_READ_LIMIT).optional(),
});

const workerContinueSchema = z.strictObject({
  workerId: z.string().min(1).max(64),
  requestId: z.string().min(1).max(128),
  brief: briefSchema,
});

const workerCancelSchema = z.strictObject({
  workerId: z.string().min(1).max(64),
});

const workerResolveSchema = z.strictObject({
  workerId: z.string().min(1).max(64),
  resolution: z.enum(["failed", "interrupted"]),
  reason: z.string().min(1).max(500).optional(),
});

const inboxListSchema = z.strictObject({
  limit: z.number().int().min(1).max(MAX_INBOX_LIMIT).optional(),
});

const inboxAckSchema = z.strictObject({
  eventIds: z.array(z.string().min(1)).min(1).max(100),
});

const accountStatusSchema = z.strictObject({});

/**
 * Creates the local Codex MCP orchestration bridge backed by official @modelcontextprotocol/sdk.
 * Enforces verified host coordinator identity, strict schemas, project isolation, and safe defaults.
 */
export function createMcpBridge({
  configPath = defaultConfigPath(),
  stateRoot,
  hostIdentity,
  pairingCode,
  verifyPairingCode,
  allowWrite = false,
  appServer,
  appServerFactory,
  worktreeFactory,
  workerService,
  workerServiceFactory,
  readSnapshot: customReadSnapshot = readSnapshot,
} = {}) {
  const effectiveStateRoot = stateRoot ?? path.dirname(configPath);
  const projectServices = new Map();
  const projectServicePromises = new Map();
  const openedStates = new Map();
  let bridgeClosed = false;
  let sharedAppServerPromise = null;
  let sharedAppServerInstance = appServer ?? null;

  const server = new McpServer({
    name: "t3o_codex",
    version: "0.1.0",
  });

  function registerSafeTool(name, config, handler) {
    server.registerTool(name, config, async (args, extra) => {
      try {
        return await handler(args, extra);
      } catch (err) {
        const message = sanitizeString(err instanceof Error ? err.message : String(err));
        throw new Error(message);
      }
    });
  }

  async function resolveCallerIdentity(extra) {
    const raw = typeof hostIdentity === "function" ? await hostIdentity(extra) : hostIdentity;
    if (!raw || typeof raw !== "object") {
      throw new Error(
        "Unauthorized: missing verified host identity. Run `node codex/scripts/pair.mjs` and launch the coordinator MCP session with T3O_CODEX_HOST_SESSION_ID.",
      );
    }
    if (
      raw.isWorker === true ||
      raw.isSubagent === true ||
      raw.internal === true ||
      raw.role === "worker" ||
      raw.agentId
    ) {
      throw new Error("Unauthorized: worker, subagent, and internal callers cannot invoke orchestration tools.");
    }
    if (
      typeof raw.sessionId !== "string" ||
      raw.sessionId.trim().length === 0 ||
      CONTROL_CHARS_RE.test(raw.sessionId)
    ) {
      throw new Error("Unauthorized: missing or invalid host sessionId.");
    }
    return raw;
  }

  function loadAllProjectStates(config) {
    const states = {};
    for (const project of config.projects) {
      try {
        const snap = customReadSnapshot(projectStateDir(effectiveStateRoot, project.id));
        if (snap) {
          states[project.id] = snap;
        }
      } catch {
        // Ignore unreadable snapshots during role check; mutations still use openState.
      }
    }
    return states;
  }

  async function requireCoordinator(extra) {
    const identity = await resolveCallerIdentity(extra);
    const config = loadConfig(configPath);
    const states = loadAllProjectStates(config);

    if (sessionIsWorkerAnywhere(states, identity.sessionId)) {
      throw new Error("Unauthorized: worker sessions cannot invoke orchestration tools.");
    }

    const resolved = resolveRole(config, states, identity.sessionId, {
      threadId: identity.threadId,
      agentId: identity.agentId,
      isSubagent: identity.isSubagent,
      internal: identity.internal,
    });
    if (!resolved || resolved.role !== "coordinator") {
      throw new Error("Unauthorized: caller is not a bound coordinator for any configured project.");
    }
    return { identity, config, ...resolved };
  }

  async function verifyOutOfBandPairing(candidateCode, identity) {
    if (typeof verifyPairingCode === "function") {
      return Boolean(await verifyPairingCode(candidateCode, identity));
    }
    if (typeof pairingCode === "string" && pairingCode.length > 0) {
      return safeDigestCompare(candidateCode, pairingCode);
    }
    return checkAndConsumePairingFromDisk(effectiveStateRoot, candidateCode);
  }

  async function getAppServer() {
    if (sharedAppServerInstance) return sharedAppServerInstance;
    if (!sharedAppServerPromise) {
      sharedAppServerPromise = (async () => {
        let srv;
        if (typeof appServerFactory === "function") {
          srv = await appServerFactory();
        } else {
          const rpc = createRpc();
          srv = createAppServer(rpc);
          await srv.initialize();
        }
        if (typeof srv?.onClose === "function") {
          srv.onClose(() => {
            if (sharedAppServerInstance === srv) {
              sharedAppServerInstance = null;
              sharedAppServerPromise = null;
            }
          });
        }
        sharedAppServerInstance = srv;
        return sharedAppServerInstance;
      })().catch((err) => {
        sharedAppServerPromise = null;
        throw err;
      });
    }
    return sharedAppServerPromise;
  }

  async function getWorkerService(project) {
    if (workerService) return workerService;
    if (bridgeClosed) {
      throw new Error("MCP bridge is closed.");
    }
    const existing = projectServices.get(project.id);
    if (existing) return existing;

    const pending = projectServicePromises.get(project.id);
    if (pending) return pending;

    const initPromise = (async () => {
      const srv = await getAppServer();
      const stateDir = projectStateDir(effectiveStateRoot, project.id);
      const state = openState(stateDir);
      let service;

      try {
        const worktreeBase = path.join(stateDir, "worktrees");
        const worktrees = typeof worktreeFactory === "function"
          ? worktreeFactory({ project, root: project.root, baseDir: worktreeBase, allowWrite: project.allowWrite })
          : createWorktreeManager({ root: project.root, baseDir: worktreeBase, allowWrite: project.allowWrite });

        if (typeof workerServiceFactory === "function") {
          service = await workerServiceFactory({ project, state, appServer: srv, worktrees });
        } else {
          const { createWorkerService } = await import("./workers.mjs");
          service = createWorkerService({
            state,
            appServer: srv,
            worktrees,
            maxWorkers: project.maxWorkers,
          });
          if (typeof service.reconcile === "function") {
            await service.reconcile(project.id);
          }
        }

        if (bridgeClosed) {
          service?.dispose?.();
          state.close();
          throw new Error("MCP bridge is closed.");
        }

        openedStates.set(project.id, state);
        projectServices.set(project.id, service);
        return service;
      } catch (err) {
        service?.dispose?.();
        state.close();
        openedStates.delete(project.id);
        throw err;
      }
    })().finally(() => {
      projectServicePromises.delete(project.id);
    });

    projectServicePromises.set(project.id, initPromise);
    return initPromise;
  }

  registerSafeTool(
    "project_setup",
    {
      description: "Bind the verified coordinator session to a project using an out-of-band pairing code.",
      inputSchema: projectSetupSchema,
    },
    async (args, extra) => {
      const identity = await resolveCallerIdentity(extra);
      const config = loadConfig(configPath);
      const states = loadAllProjectStates(config);

      if (sessionIsWorkerAnywhere(states, identity.sessionId)) {
        throw new Error("Unauthorized: worker sessions cannot run project_setup.");
      }

      const verified = await verifyOutOfBandPairing(args.pairingCode, identity);
      if (!verified) {
        throw new Error("Unauthorized: invalid or missing out-of-band pairing code.");
      }

      if (args.allowWrite === true && (allowWrite !== true || identity.allowWrite === false)) {
        throw new Error("Unauthorized: write mode is disabled by host policy.");
      }

      const nextConfig = bindCoordinator(
        config,
        {
          name: args.name,
          root: args.root,
          ...(identity.threadId ? { coordinatorThreadId: identity.threadId } : {}),
          ...(args.maxWorkers !== undefined ? { maxWorkers: args.maxWorkers } : {}),
          ...(args.memoryEnabled !== undefined ? { memoryEnabled: args.memoryEnabled } : {}),
          ...(args.libraryPath !== undefined ? { libraryPath: args.libraryPath } : {}),
          ...(args.allowWrite !== undefined ? { allowWrite: args.allowWrite } : {}),
        },
        identity.sessionId,
        { state: states },
      );

      saveConfigAtomic(configPath, nextConfig);
      const created = nextConfig.projects.at(-1);
      return formatToolResult({ project: sanitizeProjectSummary(created) });
    },
  );

  registerSafeTool(
    "worker_launch",
    {
      description: "Launch a scoped Codex worker thread in read mode (default) or authorized write mode.",
      inputSchema: workerLaunchSchema,
    },
    async (args, extra) => {
      const { identity, projectId, project } = await requireCoordinator(extra);
      const mode = args.mode ?? "read";
      const hostAllowsWrite = allowWrite === true && identity.allowWrite !== false;
      const authorized = mode === "write" && project.allowWrite === true && hostAllowsWrite;

      if (mode === "write" && !authorized) {
        throw new Error("Unauthorized write mode: project.allowWrite and host write authorization are required.");
      }

      const service = await getWorkerService(project);
      const worker = await service.launch({
        projectId,
        requestId: args.requestId,
        brief: args.brief,
        mode,
        authorized,
      });
      return formatToolResult({ worker: sanitizeWorkerSummary(worker) });
    },
  );

  registerSafeTool(
    "worker_list",
    {
      description: "List registered workers belonging to the bound coordinator project.",
      inputSchema: workerListSchema,
    },
    async (_args, extra) => {
      const { projectId, project } = await requireCoordinator(extra);
      const service = await getWorkerService(project);
      const workers = await service.list(projectId);
      return formatToolResult({
        workers: Array.isArray(workers) ? workers.map(sanitizeWorkerSummary).filter(Boolean) : [],
      });
    },
  );

  registerSafeTool(
    "worker_read",
    {
      description: "Read bounded turns and evidence from a worker belonging to the bound project.",
      inputSchema: workerReadSchema,
    },
    async (args, extra) => {
      const { projectId, project } = await requireCoordinator(extra);
      const service = await getWorkerService(project);
      const limit = args.limit ?? DEFAULT_READ_LIMIT;
      const res = await service.read({
        projectId,
        workerId: args.workerId,
        ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
        limit,
      });
      return formatToolResult({
        worker: sanitizeWorkerSummary(res?.worker),
        turns: Array.isArray(res?.turns) ? res.turns.slice(0, limit) : [],
        nextCursor: res?.nextCursor ?? null,
        ...(res?.backwardsCursor !== undefined ? { backwardsCursor: res.backwardsCursor } : {}),
      });
    },
  );

  registerSafeTool(
    "worker_continue",
    {
      description: "Start a new bounded turn on an existing worker in the bound project.",
      inputSchema: workerContinueSchema,
    },
    async (args, extra) => {
      const { projectId, project } = await requireCoordinator(extra);
      const service = await getWorkerService(project);
      const worker = await service.continue({
        projectId,
        workerId: args.workerId,
        requestId: args.requestId,
        brief: args.brief,
      });
      return formatToolResult({ worker: sanitizeWorkerSummary(worker) });
    },
  );

  registerSafeTool(
    "worker_cancel",
    {
      description: "Interrupt an active turn on a worker in the bound project and wait for terminal status.",
      inputSchema: workerCancelSchema,
    },
    async (args, extra) => {
      const { projectId, project } = await requireCoordinator(extra);
      const service = await getWorkerService(project);
      const worker = await service.cancel({
        projectId,
        workerId: args.workerId,
      });
      return formatToolResult({ worker: sanitizeWorkerSummary(worker) });
    },
  );

  registerSafeTool(
    "worker_resolve",
    {
      description: "Explicitly resolve a recovery_required or approval_required worker to failed or interrupted to free its slot.",
      inputSchema: workerResolveSchema,
    },
    async (args, extra) => {
      const { projectId, project } = await requireCoordinator(extra);
      const service = await getWorkerService(project);
      if (typeof service.resolve !== "function") {
        throw new Error("Worker service does not support explicit resolution.");
      }
      const worker = await service.resolve({
        projectId,
        workerId: args.workerId,
        resolution: args.resolution,
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
      });
      return formatToolResult({ worker: sanitizeWorkerSummary(worker) });
    },
  );

  registerSafeTool(
    "inbox_list",
    {
      description: "List unread terminal events from the bound project's durable inbox.",
      inputSchema: inboxListSchema,
    },
    async (args, extra) => {
      const { projectId, project } = await requireCoordinator(extra);
      const service = await getWorkerService(project);
      const limit = args.limit ?? MAX_INBOX_LIMIT;
      const events = await service.inbox({ projectId, limit });
      return formatToolResult({
        events: Array.isArray(events)
          ? events.slice(0, limit).map((ev) => ({
              id: ev.id,
              projectId: ev.projectId,
              workerId: ev.workerId,
              threadId: ev.threadId,
              turnId: ev.turnId,
              status: ev.status,
              ...(ev.errorCode ? { errorCode: ev.errorCode } : {}),
              createdAt: ev.createdAt ?? null,
              ackAt: ev.ackAt ?? null,
            }))
          : [],
      });
    },
  );

  registerSafeTool(
    "inbox_ack",
    {
      description: "Acknowledge processed terminal events in the bound project's durable inbox.",
      inputSchema: inboxAckSchema,
    },
    async (args, extra) => {
      const { projectId, project } = await requireCoordinator(extra);
      const service = await getWorkerService(project);
      const res = await service.ack({ projectId, eventIds: args.eventIds });
      const acked = Array.isArray(res?.ackedIds)
        ? res.ackedIds
        : Array.isArray(res?.acked)
          ? res.acked
          : [];
      return formatToolResult({
        acked,
        newlyAckedCount: typeof res?.newlyAckedCount === "number" ? res.newlyAckedCount : acked.length,
      });
    },
  );

  registerSafeTool(
    "account_status",
    {
      description: "Return safe normalized Codex account and rate-limit status without secrets.",
      inputSchema: accountStatusSchema,
    },
    async (_args, extra) => {
      await requireCoordinator(extra);
      let accountRes = null;
      let limitsRes = null;
      try {
        const srv = await getAppServer();
        const [acc, lim] = await Promise.allSettled([
          typeof srv.readAccount === "function" ? srv.readAccount() : Promise.resolve(null),
          typeof srv.readLimits === "function" ? srv.readLimits() : Promise.resolve(null),
        ]);
        accountRes = acc.status === "fulfilled" ? acc.value : null;
        limitsRes = lim.status === "fulfilled" ? lim.value : null;
      } catch {
        accountRes = null;
        limitsRes = null;
      }
      return formatToolResult(normalizeAccountStatus(accountRes, limitsRes));
    },
  );

  async function connect(transport) {
    await server.connect(transport);
  }

  async function close() {
    bridgeClosed = true;
    await Promise.allSettled([...projectServicePromises.values()]);
    for (const service of projectServices.values()) {
      service?.dispose?.();
    }
    projectServices.clear();
    workerService?.dispose?.();
    for (const st of openedStates.values()) {
      st?.close?.();
    }
    openedStates.clear();
    if (sharedAppServerInstance && !appServer) {
      sharedAppServerInstance.close?.();
      sharedAppServerInstance = null;
    }
    await server.close();
  }

  return {
    server,
    connect,
    close,
  };
}

function hostIdentityFromEnv() {
  const sessionId = process.env.T3O_CODEX_HOST_SESSION_ID;
  const threadId = process.env.T3O_CODEX_HOST_THREAD_ID;
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    return null;
  }
  return {
    sessionId,
    ...(typeof threadId === "string" && threadId.trim().length > 0 ? { threadId } : {}),
    allowWrite: process.env.T3O_CODEX_ALLOW_WRITE === "true",
  };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const bridge = createMcpBridge({
    hostIdentity: hostIdentityFromEnv(),
    pairingCode: process.env.T3O_CODEX_PAIRING_CODE || undefined,
    allowWrite: process.env.T3O_CODEX_ALLOW_WRITE === "true",
  });
  const transport = new StdioServerTransport();
  let shuttingDown = false;
  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await bridge.close();
    } catch {
      // Ignore shutdown cleanup errors.
    }
    process.exit(exitCode);
  };
  transport.onclose = () => {
    void shutdown(0);
  };
  process.once("SIGINT", () => {
    void shutdown(0);
  });
  process.once("SIGTERM", () => {
    void shutdown(0);
  });
  bridge.connect(transport).catch(() => {
    void shutdown(1);
  });
}
