import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONFIG_VERSION = 1;
export const DEFAULT_MAX_WORKERS = 2;
export const MIN_MAX_WORKERS = 1;
export const MAX_MAX_WORKERS = 4;
export const MAX_PROJECT_NAME_LENGTH = 64;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertNoForbiddenKeys(obj, label) {
  for (const key of Object.getOwnPropertyNames(obj)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new Error(`${label} contains forbidden property "${key}".`);
    }
  }
}

function assertSafeNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0 || CONTROL_CHARS_RE.test(value)) {
    throw new Error(`${label} must be a non-empty string without control characters.`);
  }
  return value;
}

function assertValidUuid(value, label) {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new Error(`${label} must be a valid UUID.`);
  }
  return value;
}

function assertValidSlug(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_PROJECT_NAME_LENGTH ||
    !SLUG_RE.test(value)
  ) {
    throw new Error(
      `${label} must match /^[a-z0-9][a-z0-9-]*$/ and be at most ${MAX_PROJECT_NAME_LENGTH} characters.`,
    );
  }
  return value;
}

function isWithinBase(targetPath, basePath) {
  if (targetPath === basePath) return true;
  const prefix = basePath === "/" ? "/" : `${basePath}${path.sep}`;
  return targetPath.startsWith(prefix);
}

/**
 * Validates that `inputPath` is a canonical absolute path with no traversal or symlink escape.
 */
function validateCanonicalPath(inputPath, label, options = {}) {
  if (typeof inputPath !== "string" || inputPath.length === 0 || CONTROL_CHARS_RE.test(inputPath)) {
    throw new Error(`${label} must be a non-empty path string.`);
  }
  if (!path.isAbsolute(inputPath)) {
    throw new Error(`${label} must be an absolute path.`);
  }

  const segments = inputPath.split("/");
  if (segments.includes("..") || segments.includes(".")) {
    throw new Error(`${label} must not contain relative traversal segments.`);
  }

  const normalized = path.resolve(inputPath);
  if (normalized !== inputPath) {
    throw new Error(`${label} must be normalized without trailing slashes or redundant separators.`);
  }

  const hasCustomResolver = typeof options.resolvePath === "function";
  const resolvePath = hasCustomResolver ? options.resolvePath : fs.realpathSync;
  const lstat = typeof options.lstat === "function"
    ? options.lstat
    : (!hasCustomResolver ? fs.lstatSync : null);

  if (lstat) {
    let stat;
    try {
      stat = lstat(normalized);
    } catch (err) {
      if (err && err.code === "ENOENT" && options.allowNonExistent === true) {
        return validateMissingPathAncestor(normalized, label, options, resolvePath, lstat);
      }
      throw new Error(`${label} does not exist or cannot be inspected: ${err.message}`);
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} must not be a symbolic link.`);
    }
  }

  let canonical;
  try {
    canonical = resolvePath(normalized);
  } catch (err) {
    throw new Error(`${label} cannot be resolved: ${err.message}`);
  }

  if (typeof canonical !== "string" || !path.isAbsolute(canonical)) {
    throw new Error(`${label} resolved to an invalid path.`);
  }

  if (canonical !== normalized) {
    // macOS maps /var -> /private/var and /tmp -> /private/tmp at the OS root; allow that only when normalizing inputs.
    const isDarwinSystemRoot =
      !hasCustomResolver &&
      !options.strictExactCanonical &&
      process.platform === "darwin" &&
      (normalized.startsWith("/var/") || normalized.startsWith("/tmp/")) &&
      canonical === `/private${normalized}`;
    if (!isDarwinSystemRoot) {
      throw new Error(`${label} resolves through a symlink or non-canonical segment.`);
    }
  }

  if (typeof options.allowedRoot === "string" && options.allowedRoot.length > 0) {
    const canonicalBase = resolvePath(path.resolve(options.allowedRoot));
    if (!isWithinBase(canonical, canonicalBase)) {
      throw new Error(`${label} escapes allowedRoot.`);
    }
  }

  return canonical;
}

function validateMissingPathAncestor(normalized, label, options, resolvePath, lstat) {
  const missingSegments = [];
  let probe = normalized;
  while (true) {
    try {
      const st = lstat(probe);
      if (st.isSymbolicLink()) {
        throw new Error(`${label} resolves through a symlink or non-canonical segment.`);
      }
      const canonicalAncestor = resolvePath(probe);
      if (canonicalAncestor !== probe) {
        const isDarwinSystemRoot =
          !options.strictExactCanonical &&
          process.platform === "darwin" &&
          (probe.startsWith("/var/") || probe.startsWith("/tmp/")) &&
          canonicalAncestor === `/private${probe}`;
        if (!isDarwinSystemRoot) {
          throw new Error(`${label} resolves through a symlink or non-canonical segment.`);
        }
      }
      const reconstructed = missingSegments.length === 0
        ? canonicalAncestor
        : path.join(canonicalAncestor, ...missingSegments.reverse());
      if (typeof options.allowedRoot === "string" && options.allowedRoot.length > 0) {
        const canonicalBase = resolvePath(path.resolve(options.allowedRoot));
        if (!isWithinBase(reconstructed, canonicalBase)) {
          throw new Error(`${label} escapes allowedRoot.`);
        }
      }
      return reconstructed;
    } catch (err) {
      if (err && err.code !== "ENOENT") {
        throw err;
      }
      const parent = path.dirname(probe);
      if (parent === probe) {
        throw new Error(`${label} has no existing ancestor directory.`);
      }
      missingSegments.push(path.basename(probe));
      probe = parent;
    }
  }
}

function validateProject(rawProject, options = {}) {
  if (!isPlainObject(rawProject)) {
    throw new Error("Project entry must be a plain object.");
  }
  assertNoForbiddenKeys(rawProject, "project");

  const id = assertValidUuid(rawProject.id, "project.id");
  const name = assertValidSlug(rawProject.name, "project.name");
  const root = validateCanonicalPath(rawProject.root, "project.root", {
    ...options,
    allowNonExistent: options.allowMissingRoot === true,
  });
  const coordinatorSessionId = assertSafeNonEmptyString(
    rawProject.coordinatorSessionId,
    "project.coordinatorSessionId",
  );

  let coordinatorThreadId;
  if (rawProject.coordinatorThreadId !== undefined && rawProject.coordinatorThreadId !== null) {
    coordinatorThreadId = assertSafeNonEmptyString(
      rawProject.coordinatorThreadId,
      "project.coordinatorThreadId",
    );
  }

  const maxWorkers = rawProject.maxWorkers === undefined ? DEFAULT_MAX_WORKERS : rawProject.maxWorkers;
  if (!Number.isInteger(maxWorkers) || maxWorkers < MIN_MAX_WORKERS || maxWorkers > MAX_MAX_WORKERS) {
    throw new Error(`project.maxWorkers must be an integer between ${MIN_MAX_WORKERS} and ${MAX_MAX_WORKERS}.`);
  }

  const memoryEnabled = rawProject.memoryEnabled === undefined ? false : rawProject.memoryEnabled;
  if (typeof memoryEnabled !== "boolean") {
    throw new Error("project.memoryEnabled must be a boolean.");
  }

  let libraryPath = null;
  if (rawProject.libraryPath !== undefined && rawProject.libraryPath !== null) {
    libraryPath = validateCanonicalPath(rawProject.libraryPath, "project.libraryPath", {
      ...options,
      allowNonExistent: true,
    });
  }

  const allowWrite = rawProject.allowWrite === undefined ? false : rawProject.allowWrite;
  if (typeof allowWrite !== "boolean") {
    throw new Error("project.allowWrite must be a boolean.");
  }

  return {
    id,
    name,
    root,
    coordinatorSessionId,
    ...(coordinatorThreadId !== undefined ? { coordinatorThreadId } : {}),
    maxWorkers,
    memoryEnabled,
    libraryPath,
    allowWrite,
  };
}

function validateConfig(rawConfig, options = {}) {
  if (!isPlainObject(rawConfig)) {
    throw new Error("Config must be a plain object.");
  }
  assertNoForbiddenKeys(rawConfig, "config");

  if (rawConfig.version !== CONFIG_VERSION) {
    throw new Error(`Unsupported config version: ${String(rawConfig.version)}.`);
  }
  if (!Array.isArray(rawConfig.projects)) {
    throw new Error("Config projects must be an array.");
  }

  const projects = [];
  const seenIds = new Set();
  const seenNames = new Set();
  const seenRoots = new Set();
  const seenCoordinatorSessions = new Set();

  for (const entry of rawConfig.projects) {
    const project = validateProject(entry, options);
    const idKey = project.id.toLowerCase();
    if (seenIds.has(idKey)) {
      throw new Error(`Duplicate project id: ${project.id}.`);
    }
    if (seenNames.has(project.name)) {
      throw new Error(`Duplicate project name: ${project.name}.`);
    }
    if (seenRoots.has(project.root)) {
      throw new Error(`Duplicate project root: ${project.root}.`);
    }
    if (seenCoordinatorSessions.has(project.coordinatorSessionId)) {
      throw new Error(`Duplicate coordinatorSessionId: ${project.coordinatorSessionId}.`);
    }
    seenIds.add(idKey);
    seenNames.add(project.name);
    seenRoots.add(project.root);
    seenCoordinatorSessions.add(project.coordinatorSessionId);
    projects.push(project);
  }

  return { version: CONFIG_VERSION, projects };
}

function writeAllSync(fd, content) {
  const buf = Buffer.from(content, "utf8");
  let offset = 0;
  while (offset < buf.length) {
    offset += fs.writeSync(fd, buf, offset, buf.length - offset);
  }
}

function fsyncDirBestEffort(dir) {
  let dirFd;
  try {
    dirFd = fs.openSync(dir, fs.constants.O_RDONLY);
    fs.fsyncSync(dirFd);
  } catch {
    // Some filesystems do not support fsync on directories.
  } finally {
    if (dirFd !== undefined) {
      try {
        fs.closeSync(dirFd);
      } catch {
        // Ignore close errors during cleanup.
      }
    }
  }
}

/**
 * Returns the default Codex orchestration config path (`~/.t3-orchestration/codex/config.json`).
 */
export function defaultConfigPath(homeDir = os.homedir()) {
  assertSafeNonEmptyString(homeDir, "homeDir");
  return path.join(homeDir, ".t3-orchestration", "codex", "config.json");
}

/**
 * Loads and validates the Codex config. Returns an empty v1 config if missing; throws on corruption.
 */
export function loadConfig(configPath = defaultConfigPath(), options = {}) {
  assertSafeNonEmptyString(configPath, "configPath");
  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { version: CONFIG_VERSION, projects: [] };
    }
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Malformed config JSON at ${configPath}: ${err.message}`);
  }

  return validateConfig(parsed, { ...options, strictExactCanonical: true, allowMissingRoot: true });
}

/**
 * Atomically persists a validated Codex config with 0700 directory and 0600 file permissions.
 */
export function saveConfigAtomic(configPath, config, options = {}) {
  assertSafeNonEmptyString(configPath, "configPath");
  const validated = validateConfig(config, options);
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);

  const tmpPath = path.join(
    dir,
    `.${path.basename(configPath)}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`,
  );
  const payload = `${JSON.stringify(validated, null, 2)}\n`;
  let fd;
  try {
    fd = fs.openSync(
      tmpPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    writeAllSync(fd, payload);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, configPath);
    fsyncDirBestEffort(dir);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors during cleanup.
      }
    }
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Ignore missing temp file during cleanup.
    }
    throw err;
  }
  return validated;
}

function stateHasSessionAsWorker(state, sessionId) {
  if (!state || typeof state !== "object") return false;
  const states = state instanceof Map
    ? Array.from(state.values())
    : isPlainObject(state.workers)
      ? [state]
      : Object.values(state);

  for (const projState of states) {
    if (!projState || !isPlainObject(projState.workers)) continue;
    for (const worker of Object.values(projState.workers)) {
      if (!worker || typeof worker !== "object") continue;
      if (worker.sessionId === sessionId || worker.threadId === sessionId) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Registers a project bound to a host-verified coordinator session ID, returning a new Config.
 */
export function bindCoordinator(config, projectInput, verifiedSessionId, options = {}) {
  const baseConfig = validateConfig(config, options);
  if (!isPlainObject(projectInput)) {
    throw new Error("projectInput must be a plain object.");
  }
  assertNoForbiddenKeys(projectInput, "projectInput");

  const sessionId = assertSafeNonEmptyString(verifiedSessionId, "verifiedSessionId");
  if (
    projectInput.coordinatorSessionId !== undefined &&
    projectInput.coordinatorSessionId !== sessionId
  ) {
    throw new Error("Caller-supplied coordinatorSessionId does not match verified session identity.");
  }
  if (stateHasSessionAsWorker(options.state, sessionId)) {
    throw new Error("A worker session cannot bind itself as coordinator.");
  }

  const candidateId = projectInput.id === undefined ? randomUUID() : projectInput.id;
  const project = validateProject(
    {
      ...projectInput,
      id: candidateId,
      coordinatorSessionId: sessionId,
    },
    options,
  );

  for (const existing of baseConfig.projects) {
    if (existing.id.toLowerCase() === project.id.toLowerCase()) {
      throw new Error(`Project id already registered: ${project.id}.`);
    }
    if (existing.name === project.name) {
      throw new Error(`Project name already registered: ${project.name}.`);
    }
    if (existing.root === project.root) {
      throw new Error(`Project root already registered: ${project.root}.`);
    }
    if (existing.coordinatorSessionId === project.coordinatorSessionId) {
      throw new Error(`Coordinator session already bound: ${project.coordinatorSessionId}.`);
    }
  }

  return {
    version: CONFIG_VERSION,
    projects: [...baseConfig.projects, project],
  };
}

function projectStateFor(state, projectId) {
  if (!state || typeof state !== "object") return null;
  if (state instanceof Map) {
    return state.get(projectId) ?? null;
  }
  if (isPlainObject(state.workers)) {
    if (typeof state.projectId === "string" && state.projectId !== projectId) {
      return null;
    }
    return state;
  }
  return state[projectId] ?? null;
}

/**
 * Resolves a verified session ID to `{ role: 'coordinator' | 'worker', projectId, project }` or `null`.
 * Never infers role from cwd, title, or prompt; excludes subagents, internal jobs, and unregistered threads.
 */
export function resolveRole(config, state, sessionId, options = {}) {
  if (!config || !Array.isArray(config.projects)) return null;
  if (typeof sessionId !== "string" || sessionId.trim().length === 0 || CONTROL_CHARS_RE.test(sessionId)) {
    return null;
  }
  if (options?.agentId || options?.isSubagent || options?.internal) {
    return null;
  }

  for (const project of config.projects) {
    if (!isPlainObject(project) || typeof project.id !== "string" || typeof project.coordinatorSessionId !== "string") {
      continue;
    }
    if (project.coordinatorSessionId === sessionId) {
      if (options?.threadId && project.coordinatorThreadId && options.threadId !== project.coordinatorThreadId) {
        return null;
      }
      return { role: "coordinator", projectId: project.id, project };
    }
  }

  for (const project of config.projects) {
    if (!isPlainObject(project) || typeof project.id !== "string") {
      continue;
    }
    const projState = projectStateFor(state, project.id);
    if (!projState || !isPlainObject(projState.workers)) continue;

    for (const worker of Object.values(projState.workers)) {
      if (!worker || typeof worker !== "object") continue;
      if (worker.projectId !== project.id) continue;
      if (worker.archived === true || worker.status === "archived") continue;

      const matches =
        (typeof worker.sessionId === "string" && worker.sessionId === sessionId) ||
        (typeof worker.threadId === "string" && worker.threadId === sessionId);
      if (!matches) continue;

      if (options?.threadId && worker.threadId && options.threadId !== worker.threadId) {
        return null;
      }
      return { role: "worker", projectId: project.id, project };
    }
  }

  return null;
}
