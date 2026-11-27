import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, realpath, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_SCRIPT_PATH = fileURLToPath(new URL("../../scripts/memory.py", import.meta.url));
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_STDIN_BYTES = 65536;
const TOPIC_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

const SECRET_ENV_KEY_RE = /(?:API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|CREDENTIALS)/i;

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
  [/\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g, "[REDACTED_PHONE]"],
];

function sanitizeText(value, maxLength = 2000) {
  if (typeof value !== "string") return "";
  let cleaned = value;
  for (const [pattern, replacement] of SECRET_REPLACEMENTS) {
    cleaned = cleaned.replace(pattern, replacement);
  }
  cleaned = cleaned.trim();
  if (cleaned.length > maxLength) {
    return `${cleaned.slice(0, maxLength - 1)}…`;
  }
  return cleaned;
}

function isInsideOrEqual(parentDir, targetPath) {
  const relative = path.relative(parentDir, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isStrictlyInside(parentDir, targetPath) {
  const relative = path.relative(parentDir, targetPath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function lstatIfExists(targetPath) {
  try {
    return await lstat(targetPath);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function ensureCanonicalLibrary(libraryPath) {
  if (typeof libraryPath !== "string" || libraryPath.trim().length === 0 || !path.isAbsolute(libraryPath)) {
    throw new Error("libraryPath must be a non-empty absolute path");
  }
  const existing = await lstatIfExists(libraryPath);
  if (existing && existing.isSymbolicLink()) {
    throw new Error("libraryPath must not be a symlink");
  }
  if (!existing) {
    await mkdir(libraryPath, { recursive: true, mode: 0o700 });
    const postCreate = await lstatIfExists(libraryPath);
    if (postCreate && postCreate.isSymbolicLink()) {
      throw new Error("libraryPath must not be a symlink");
    }
  }
  const canonical = await realpath(libraryPath);
  const stats = await stat(canonical);
  if (!stats.isDirectory()) {
    throw new Error("libraryPath must be a directory");
  }
  return canonical;
}

async function resolveTargetWithExistingAncestor(targetPath) {
  const normalized = path.resolve(targetPath);
  const missingSegments = [];
  let probe = normalized;

  while (true) {
    const stats = await lstatIfExists(probe);
    if (stats) {
      if (stats.isSymbolicLink()) {
        throw new Error("evidenceDir must not be or traverse a symlink");
      }
      const canonicalExisting = await realpath(probe);
      return missingSegments.length === 0
        ? canonicalExisting
        : path.join(canonicalExisting, ...missingSegments.reverse());
    }
    const parent = path.dirname(probe);
    if (parent === probe) {
      throw new Error("Cannot resolve evidenceDir ancestor");
    }
    missingSegments.push(path.basename(probe));
    probe = parent;
  }
}

async function resolveEvidenceDirectory(canonicalLibrary, evidenceDir) {
  const rawTarget = evidenceDir === undefined ? path.join(canonicalLibrary, "evidence") : evidenceDir;
  if (typeof rawTarget !== "string" || rawTarget.trim().length === 0) {
    throw new Error("evidenceDir must be a non-empty path");
  }
  const resolved = path.isAbsolute(rawTarget)
    ? path.resolve(rawTarget)
    : path.resolve(canonicalLibrary, rawTarget);

  const canonicalCandidate = await resolveTargetWithExistingAncestor(resolved);
  if (!isInsideOrEqual(canonicalLibrary, canonicalCandidate)) {
    throw new Error("evidenceDir must be inside libraryPath");
  }

  await mkdir(canonicalCandidate, { recursive: true, mode: 0o700 });

  const canonicalEvidence = await realpath(canonicalCandidate);
  if (!isInsideOrEqual(canonicalLibrary, canonicalEvidence)) {
    throw new Error("evidenceDir escaped libraryPath");
  }
  return canonicalEvidence;
}

async function validateSourceUri(source, canonicalLibrary) {
  if (typeof source !== "string" || source.length === 0 || source.length > 2000) {
    throw new Error("Invalid source URI");
  }
  let parsed;
  try {
    parsed = new URL(source);
  } catch {
    throw new Error("Untrusted or malformed source URI");
  }

  if (parsed.protocol === "https:") {
    if (!parsed.hostname) {
      throw new Error("Invalid https source URI");
    }
    return source;
  }

  if (parsed.protocol === "file:") {
    if (parsed.search || parsed.hash) {
      throw new Error("file:// source URI must not contain query or fragment");
    }
    const targetPath = fileURLToPath(parsed);
    const targetStats = await lstatIfExists(targetPath);
    if (!targetStats || targetStats.isSymbolicLink()) {
      throw new Error("file:// source URI target must exist and not be a symlink");
    }
    const canonicalTarget = await realpath(targetPath);
    if (!isStrictlyInside(canonicalLibrary, canonicalTarget)) {
      throw new Error("file:// source URI escapes libraryPath");
    }
    return pathToFileURL(canonicalTarget).href;
  }

  throw new Error(`Unsupported or untrusted source URI scheme: ${parsed.protocol}`);
}

function filteredSubprocessEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !SECRET_ENV_KEY_RE.test(key)) {
      env[key] = value;
    }
  }
  return env;
}

function runMemoryScript({ pythonExec = "python3", scriptPath = DEFAULT_SCRIPT_PATH, libraryPath, args, stdinPayload }) {
  if (typeof pythonExec !== "string" || pythonExec.length === 0) {
    throw new Error("pythonExec must be a non-empty executable name or path");
  }
  const serialized = stdinPayload !== undefined ? JSON.stringify(stdinPayload) : "";
  if (Buffer.byteLength(serialized, "utf8") > MAX_STDIN_BYTES) {
    throw new Error("Payload exceeds 64 KiB limit");
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(pythonExec, [scriptPath, "--library", libraryPath, ...args], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: filteredSubprocessEnv(),
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code !== 0) {
        rejectPromise(new Error(stderr.trim() || `memory.py exited with code ${code}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout));
      } catch (error) {
        rejectPromise(new Error(`Invalid JSON from memory.py: ${error.message}`));
      }
    });

    if (serialized.length > 0) {
      child.stdin.write(serialized, "utf8");
    }
    child.stdin.end();
  });
}

async function writeFileAtomic(targetPath, content, mode = 0o600) {
  const dir = path.dirname(targetPath);
  const tempPath = path.join(dir, `.evidence-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(tempPath, "wx", mode);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(tempPath, mode);
    await rename(tempPath, targetPath);
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

function deriveTopicSlug(projectName) {
  const candidate = typeof projectName === "string"
    ? projectName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "")
    : "";
  if (candidate && TOPIC_SLUG_RE.test(candidate)) {
    return candidate.slice(0, 80);
  }
  return "codex-memory";
}

function registeredSourcesFor(project, stateSnapshot) {
  const excluded = new Set(Array.isArray(project.excludedThreadIds) ? project.excludedThreadIds : []);
  const seen = new Set();
  const sources = [];

  if (typeof project.coordinatorThreadId === "string" && project.coordinatorThreadId.length > 0 && !excluded.has(project.coordinatorThreadId)) {
    seen.add(project.coordinatorThreadId);
    sources.push({ threadId: project.coordinatorThreadId, role: "coordinator" });
  }

  const workers = stateSnapshot?.workers && typeof stateSnapshot.workers === "object"
    ? Object.values(stateSnapshot.workers)
    : [];

  const sortedWorkers = [...workers].sort((a, b) => String(a?.id ?? "").localeCompare(String(b?.id ?? "")));
  for (const worker of sortedWorkers) {
    if (!worker || typeof worker.threadId !== "string" || worker.threadId.length === 0) continue;
    if (project.id && worker.projectId !== project.id) continue;
    if (excluded.has(worker.threadId) || seen.has(worker.threadId)) continue;
    seen.add(worker.threadId);
    sources.push({
      threadId: worker.threadId,
      role: "worker",
      workerId: typeof worker.id === "string" ? worker.id : undefined,
    });
  }

  return sources;
}

function extractBoundedItemSummary(turn) {
  if (!Array.isArray(turn?.items)) return null;
  for (let i = turn.items.length - 1; i >= 0; i -= 1) {
    const item = turn.items[i];
    if (!item || typeof item !== "object") continue;
    if (
      (item.type === "agentMessage" || item.type === "message") &&
      typeof item.text === "string" &&
      item.text.trim().length > 0
    ) {
      return item.text;
    }
    if (item.type === "message" && Array.isArray(item.content)) {
      const textPart = item.content.find((c) => c && typeof c.text === "string" && c.text.trim().length > 0);
      if (textPart) return textPart.text;
    }
  }
  return null;
}

function summarizeTurn(turn, source) {
  const turnId = turn?.id ?? turn?.turnId;
  if (typeof turnId !== "string" || turnId.trim().length === 0) {
    return null;
  }
  const status = sanitizeText(typeof turn.status === "string" ? turn.status : "unknown", 40) || "unknown";
  // Extract only bounded summary fields; never copy raw transcripts or full item arrays.
  const rawCandidate = [
    turn.summary,
    turn.outcome,
    turn.conclusion,
    turn.title,
    extractBoundedItemSummary(turn),
    turn.error?.message,
  ].find((entry) => typeof entry === "string" && entry.trim().length > 0);

  const sanitizedSummary = rawCandidate
    ? sanitizeText(rawCandidate, 1500)
    : `Turn ${sanitizeText(turnId, 80)} finished with status ${status}.`;

  const provenanceLine = `Provenance: threadId=${sanitizeText(source.threadId, 120)}, turnId=${sanitizeText(turnId, 120)}, role=${source.role}${source.workerId ? `, workerId=${sanitizeText(source.workerId, 64)}` : ""}, status=${status}`;
  const titleBase = rawCandidate
    ? sanitizedSummary.replace(/\s+/g, " ").slice(0, 140)
    : `${source.role} turn ${sanitizeText(turnId, 80)} (${status})`;
  const title = titleBase.replace(/\r?\n/g, " ").trim().slice(0, 200) || `Turn ${sanitizeText(turnId, 80)}`;

  return {
    turnId: turnId.trim(),
    status,
    title,
    summary: sanitizedSummary,
    body: `${sanitizedSummary}\n\n${provenanceLine}`.slice(0, 20000),
  };
}

function normalizeStartPosition(activeCursor, sources) {
  if (!activeCursor) {
    return { sourceIndex: 0, turnCursor: null, offset: 0 };
  }
  if (typeof activeCursor === "string") {
    return { sourceIndex: 0, turnCursor: activeCursor, offset: 0 };
  }
  if (typeof activeCursor === "object") {
    let sourceIndex = Number.isInteger(activeCursor.sourceIndex) && activeCursor.sourceIndex >= 0
      ? activeCursor.sourceIndex
      : 0;
    let turnCursor = activeCursor.turnCursor ?? null;
    let offset = Number.isInteger(activeCursor.offset) && activeCursor.offset >= 0 ? activeCursor.offset : 0;
    if (typeof activeCursor.threadId === "string") {
      const matched = sources.findIndex((s) => s.threadId === activeCursor.threadId);
      if (matched >= 0) {
        sourceIndex = matched;
      } else {
        turnCursor = null;
        offset = 0;
      }
    }
    return {
      sourceIndex,
      turnCursor,
      offset,
    };
  }
  throw new Error("Invalid cursor format");
}

async function fetchTurnPage(appServer, threadId, turnCursor, remaining) {
  if (typeof appServer?.listTurns === "function") {
    const page = await appServer.listTurns({ threadId, cursor: turnCursor, limit: remaining });
    const turns = Array.isArray(page?.data)
      ? page.data
      : Array.isArray(page?.turns)
        ? page.turns
        : [];
    return { turns, nextTurnCursor: page?.nextCursor ?? null };
  }
  if (typeof appServer?.readThread === "function") {
    const res = await appServer.readThread(threadId, { includeTurns: true });
    const turns = Array.isArray(res?.thread?.turns) ? res.thread.turns : [];
    return { turns, nextTurnCursor: null };
  }
  throw new Error("appServer must provide listTurns or readThread");
}

/**
 * Records a validated note via `scripts/memory.py` (`shell: false`, JSON on stdin).
 * Validates source URIs (`https://` or canonical `file://` inside `libraryPath`).
 */
export async function recordNote({
  libraryPath,
  note,
  publish = false,
  pythonExec = "python3",
  scriptPath = DEFAULT_SCRIPT_PATH,
} = {}) {
  if (!note || typeof note !== "object") {
    throw new Error("note object is required");
  }
  const canonicalLibrary = await ensureCanonicalLibrary(libraryPath);
  const validatedSource = await validateSourceUri(note.source, canonicalLibrary);
  const payload = { ...note, source: validatedSource };

  const recorded = await runMemoryScript({
    pythonExec,
    scriptPath,
    libraryPath: canonicalLibrary,
    args: ["record"],
    stdinPayload: payload,
  });

  if (publish) {
    return runMemoryScript({
      pythonExec,
      scriptPath,
      libraryPath: canonicalLibrary,
      args: ["publish", recorded.id],
    });
  }
  return recorded;
}

/**
 * Incrementally collects sanitized memory artifacts from registered project workers and
 * the explicitly enrolled coordinator thread, persisting pagination cursors with CAS revision.
 */
export async function collectMemory({
  project,
  state,
  appServer,
  libraryPath,
  cursor,
  limit = DEFAULT_LIMIT,
  evidenceDir,
  pythonExec = "python3",
  scriptPath = DEFAULT_SCRIPT_PATH,
} = {}) {
  if (project?.memoryEnabled !== true || typeof libraryPath !== "string" || libraryPath.trim().length === 0) {
    return {
      items: [],
      nextCursor: cursor ?? null,
      complete: true,
      disabled: true,
    };
  }

  const effectiveLimit = Math.min(Math.max(Number.isInteger(limit) ? limit : DEFAULT_LIMIT, 1), MAX_LIMIT);
  const canonicalLibrary = await ensureCanonicalLibrary(libraryPath);
  const canonicalEvidenceDir = await resolveEvidenceDirectory(canonicalLibrary, evidenceDir);
  const stateSnapshot = typeof state?.read === "function" ? await state.read() : state;
  const sources = registeredSourcesFor(project, stateSnapshot);

  const stateKey = `codex-memory:${project.id ?? "default"}`;
  const persisted = await runMemoryScript({
    pythonExec,
    scriptPath,
    libraryPath: canonicalLibrary,
    args: ["state-get", stateKey],
  });

  const initialCursor = cursor !== undefined ? cursor : (persisted?.value?.cursor ?? null);
  let { sourceIndex, turnCursor, offset } = normalizeStartPosition(initialCursor, sources);

  const items = [];
  const recorded = [];
  const topic = deriveTopicSlug(project.name);
  let nextCursor = null;

  while (sourceIndex < sources.length && items.length < effectiveLimit) {
    const source = sources[sourceIndex];
    const remaining = effectiveLimit - items.length;
    const fetchLimit = Math.min(offset + remaining, MAX_LIMIT);
    const { turns, nextTurnCursor } = await fetchTurnPage(appServer, source.threadId, turnCursor, fetchLimit);

    const slice = turns.slice(offset, offset + remaining);
    for (const turn of slice) {
      if (turn?.threadId && turn.threadId !== source.threadId) {
        throw new Error("Turn threadId mismatch");
      }
      const summarized = summarizeTurn(turn, source);
      if (!summarized) continue;

      const digest = createHash("sha256").update(`${source.threadId}:${summarized.turnId}`).digest("hex").slice(0, 24);
      const artifactPath = path.join(canonicalEvidenceDir, `turn-${digest}.json`);
      const artifact = {
        schema: "codex-memory-evidence/v1",
        projectId: project.id ?? null,
        threadId: source.threadId,
        turnId: summarized.turnId,
        role: source.role,
        ...(source.workerId ? { workerId: source.workerId } : {}),
        status: summarized.status,
        summary: summarized.summary,
      };
      await writeFileAtomic(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 0o600);
      const canonicalArtifactPath = await realpath(artifactPath);
      if (!isStrictlyInside(canonicalLibrary, canonicalArtifactPath)) {
        throw new Error("Evidence artifact escaped libraryPath");
      }
      const sourceUri = pathToFileURL(canonicalArtifactPath).href;

      const rec = await recordNote({
        libraryPath: canonicalLibrary,
        note: {
          topic,
          kind: "observation",
          title: summarized.title,
          source: sourceUri,
          body: summarized.body,
        },
        publish: false,
        pythonExec,
        scriptPath,
      });

      items.push({
        threadId: source.threadId,
        turnId: summarized.turnId,
        role: source.role,
        ...(source.workerId ? { workerId: source.workerId } : {}),
        status: summarized.status,
        summary: summarized.summary,
        evidencePath: canonicalArtifactPath,
        source: sourceUri,
      });
      recorded.push({ ...rec, threadId: source.threadId, turnId: summarized.turnId, source: sourceUri });
    }

    const nextOffset = offset + slice.length;
    if (nextOffset < turns.length) {
      nextCursor = { sourceIndex, threadId: source.threadId, turnCursor, offset: nextOffset };
      break;
    }
    if (nextTurnCursor) {
      nextCursor = { sourceIndex, threadId: source.threadId, turnCursor: nextTurnCursor };
      break;
    }

    sourceIndex += 1;
    turnCursor = null;
    offset = 0;
    if (items.length >= effectiveLimit && sourceIndex < sources.length) {
      nextCursor = { sourceIndex, threadId: sources[sourceIndex].threadId, turnCursor: null };
      break;
    }
  }

  const complete = nextCursor === null;
  if (recorded.length > 0 || persisted?.value?.cursor != null || !complete) {
    await runMemoryScript({
      pythonExec,
      scriptPath,
      libraryPath: canonicalLibrary,
      args: ["state-put"],
      stdinPayload: {
        key: stateKey,
        value: {
          cursor: nextCursor,
          complete,
          updatedAt: new Date().toISOString(),
          lastReceiptCount: recorded.length,
        },
        expected_revision: persisted.revision,
      },
    });
  }

  return { items, nextCursor, complete, recorded };
}

async function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return (await realpath(process.argv[1])) === (await realpath(fileURLToPath(import.meta.url)));
  } catch {
    return false;
  }
}

if (await isMainModule()) {
  const { defaultConfigPath, loadConfig } = await import("./config.mjs");
  const { projectStateDir, readSnapshot } = await import("./state.mjs");
  const { createRpc } = await import("./rpc.mjs");
  const { createAppServer } = await import("./app-server.mjs");

  const args = process.argv.slice(2);
  let projectSelector = null;
  let configPath = defaultConfigPath();
  let limit = DEFAULT_LIMIT;

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--project" && args[i + 1]) {
      projectSelector = args[i + 1];
      i += 1;
    } else if (args[i] === "--config" && args[i + 1]) {
      configPath = path.resolve(args[i + 1]);
      i += 1;
    } else if (args[i] === "--limit" && args[i + 1]) {
      limit = Number(args[i + 1]);
      i += 1;
    }
  }

  if (!projectSelector) {
    process.stderr.write("Usage: node codex/src/memory.mjs --project <name-or-id> [--config PATH] [--limit N]\n");
    process.exit(1);
  }

  const config = loadConfig(configPath);
  const project = config.projects.find((p) => p.name === projectSelector || p.id === projectSelector);
  if (!project) {
    process.stderr.write(`Unknown project: ${projectSelector}\n`);
    process.exit(1);
  }

  const stateSnapshot = readSnapshot(projectStateDir(path.dirname(configPath), project.id)) ?? { workers: {} };
  if (project.memoryEnabled !== true || !project.libraryPath) {
    process.stdout.write(`${JSON.stringify({ items: [], nextCursor: null, complete: true, disabled: true })}\n`);
    process.exit(0);
  }

  const rpc = createRpc();
  const appServer = createAppServer(rpc);
  try {
    await appServer.initialize();
    const result = await collectMemory({
      project,
      state: stateSnapshot,
      appServer,
      libraryPath: project.libraryPath,
      limit,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    appServer.close();
  }
}
