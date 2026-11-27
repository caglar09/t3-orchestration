import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const STATE_VERSION = 1;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;
const ALLOWED_STATE_KEYS = new Set(["version", "revision", "workers", "events", "requests"]);
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

function initialState() {
  return {
    version: STATE_VERSION,
    revision: 0,
    workers: {},
    events: [],
    requests: {},
  };
}

function validateState(raw) {
  if (!isPlainObject(raw)) {
    throw new Error("State must be a plain object.");
  }
  assertNoForbiddenKeys(raw, "state");

  for (const key of Object.keys(raw)) {
    if (!ALLOWED_STATE_KEYS.has(key)) {
      throw new Error(`Unexpected state property "${key}".`);
    }
  }
  if (raw.version !== STATE_VERSION) {
    throw new Error(`Unsupported state version: ${String(raw.version)}.`);
  }
  if (!Number.isInteger(raw.revision) || raw.revision < 0) {
    throw new Error("State revision must be a non-negative integer.");
  }
  if (!isPlainObject(raw.workers)) {
    throw new Error("State workers must be a plain object.");
  }
  if (!Array.isArray(raw.events)) {
    throw new Error("State events must be an array.");
  }
  if (!isPlainObject(raw.requests)) {
    throw new Error("State requests must be a plain object.");
  }

  return {
    version: STATE_VERSION,
    revision: raw.revision,
    workers: structuredClone(raw.workers),
    events: structuredClone(raw.events),
    requests: structuredClone(raw.requests),
  };
}

function defaultIsPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
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

function writeFileAtomicSync(filePath, content, options = {}) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`,
  );
  let fd;
  try {
    fd = fs.openSync(
      tmpPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    writeAllSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.chmodSync(tmpPath, 0o600);
    if (typeof options.onBeforeRename === "function") {
      options.onBeforeRename(tmpPath, filePath);
    }
    fs.renameSync(tmpPath, filePath);
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
}

function readLeaseRecord(leasePath) {
  let raw;
  try {
    raw = fs.readFileSync(leasePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Corrupted state lease file.");
  }
  if (!isPlainObject(parsed) || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
    throw new Error("Invalid state lease metadata.");
  }
  return parsed;
}

function acquireLease(dir, leasePath, ownerPid, token, isPidAlive) {
  const tmpLeasePath = path.join(dir, `.lease.tmp.${process.pid}.${randomUUID().slice(0, 8)}`);
  const payload = `${JSON.stringify({ pid: ownerPid, token, acquiredAt: new Date().toISOString() }, null, 2)}\n`;
  let fd;
  try {
    fd = fs.openSync(
      tmpLeasePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    writeAllSync(fd, payload);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.chmodSync(tmpLeasePath, 0o600);

    try {
      fs.linkSync(tmpLeasePath, leasePath);
      fsyncDirBestEffort(dir);
      return;
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
    }

    const existing = readLeaseRecord(leasePath);
    if (existing && isPidAlive(existing.pid)) {
      throw new Error(`State lease is held by active writer PID ${existing.pid}.`);
    }

    // Serialize stale-lease recovery so two processes cannot unlink each other's newly linked lease.
    const recoverLockPath = path.join(dir, ".lease.recover.lock");
    let recoverFd;
    try {
      recoverFd = fs.openSync(
        recoverLockPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o600,
      );
    } catch (err) {
      if (err && err.code === "EEXIST") {
        throw new Error("Concurrent state lease recovery in progress.");
      }
      throw err;
    }

    try {
      const rechecked = readLeaseRecord(leasePath);
      if (rechecked) {
        if (isPidAlive(rechecked.pid)) {
          throw new Error(`State lease is held by active writer PID ${rechecked.pid}.`);
        }
        fs.unlinkSync(leasePath);
      }
      fs.linkSync(tmpLeasePath, leasePath);
      fsyncDirBestEffort(dir);
    } finally {
      try {
        fs.closeSync(recoverFd);
      } catch {
        // Ignore close error.
      }
      try {
        fs.unlinkSync(recoverLockPath);
      } catch {
        // Ignore unlink error.
      }
    }
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close error.
      }
    }
    try {
      fs.unlinkSync(tmpLeasePath);
    } catch {
      // Ignore cleanup error.
    }
  }
}

/**
 * Returns `<stateRoot>/projects/<projectId>` after validating `projectId` is a UUID.
 */
export function projectStateDir(stateRoot, projectId) {
  if (typeof stateRoot !== "string" || stateRoot.trim().length === 0 || CONTROL_CHARS_RE.test(stateRoot)) {
    throw new Error("stateRoot must be a non-empty path string.");
  }
  if (typeof projectId !== "string" || !UUID_RE.test(projectId)) {
    throw new Error("projectId must be a valid UUID.");
  }
  return path.join(stateRoot, "projects", projectId);
}

/**
 * Opens an exclusive single-writer durable state store in `dir`.
 * Enforces 0700 dir / 0600 files, atomic revision-checked writes, and PID liveness lease checks.
 */
export function openState(dir, options = {}) {
  if (typeof dir !== "string" || dir.trim().length === 0 || CONTROL_CHARS_RE.test(dir)) {
    throw new Error("State directory must be a non-empty path string.");
  }

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);

  const leasePath = path.join(dir, "lease.json");
  const statePath = path.join(dir, "state.json");
  const ownerPid = Number.isInteger(options.pid) && options.pid > 0 ? options.pid : process.pid;
  const isPidAlive = typeof options.isPidAlive === "function" ? options.isPidAlive : defaultIsPidAlive;
  const token = randomUUID();

  acquireLease(dir, leasePath, ownerPid, token, isPidAlive);

  let closed = false;
  let asyncChain = Promise.resolve();
  let pendingAsyncCount = 0;

  function assertLeaseOwned() {
    if (closed) {
      throw new Error("State handle is closed.");
    }
    let leaseRaw;
    try {
      leaseRaw = fs.readFileSync(leasePath, "utf8");
    } catch {
      throw new Error("State writer lease file is missing.");
    }
    let parsed;
    try {
      parsed = JSON.parse(leaseRaw);
    } catch {
      throw new Error("State writer lease file is corrupted.");
    }
    if (parsed?.token !== token) {
      throw new Error("State writer lease ownership was lost.");
    }
  }

  function readStateStrict() {
    let raw;
    try {
      raw = fs.readFileSync(statePath, "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") {
        return initialState();
      }
      throw err;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Corrupted state JSON at ${statePath}: ${err.message}`);
    }
    return validateState(parsed);
  }

  function commitNext(current, candidate) {
    if (!isPlainObject(candidate)) {
      throw new Error("transact callback must return a plain object or undefined.");
    }
    assertNoForbiddenKeys(candidate, "state");
    if (candidate.version !== STATE_VERSION) {
      throw new Error(`Unsupported state version: ${String(candidate.version)}.`);
    }
    const next = validateState({
      ...candidate,
      revision: current.revision + 1,
    });
    writeFileAtomicSync(statePath, `${JSON.stringify(next, null, 2)}\n`, options);
    return structuredClone(next);
  }

  return {
    read() {
      assertLeaseOwned();
      return readStateStrict();
    },

    transact(fn) {
      if (typeof fn !== "function") {
        throw new TypeError("transact requires a callback function.");
      }

      if (pendingAsyncCount > 0) {
        pendingAsyncCount += 1;
        const queued = asyncChain
          .then(async () => {
            assertLeaseOwned();
            const current = readStateStrict();
            const draft = structuredClone(current);
            const result = await fn(draft);
            return commitNext(current, result === undefined ? draft : result);
          })
          .finally(() => {
            pendingAsyncCount -= 1;
          });
        asyncChain = queued.catch(() => {});
        return queued;
      }

      assertLeaseOwned();
      const current = readStateStrict();
      const draft = structuredClone(current);
      const result = fn(draft);

      if (result && typeof result.then === "function") {
        pendingAsyncCount += 1;
        const pending = result
          .then((resolved) => {
            assertLeaseOwned();
            return commitNext(current, resolved === undefined ? draft : resolved);
          })
          .finally(() => {
            pendingAsyncCount -= 1;
          });
        asyncChain = pending.catch(() => {});
        return pending;
      }

      return commitNext(current, result === undefined ? draft : result);
    },

    close() {
      if (closed) return;
      closed = true;
      try {
        const raw = fs.readFileSync(leasePath, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed?.token === token) {
          fs.unlinkSync(leasePath);
        }
      } catch {
        // Lease already absent or replaced; never unlink another owner's lease.
      }
    },
  };
}

/**
 * Read-only, fail-open snapshot reader for hooks.
 * Never acquires a writer lease, never mutates files, and returns null when missing or corrupt.
 */
export function readSnapshot(dir) {
  if (typeof dir !== "string" || dir.trim().length === 0 || CONTROL_CHARS_RE.test(dir)) {
    return null;
  }
  const statePath = path.join(dir, "state.json");
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw);
    return validateState(parsed);
  } catch {
    return null;
  }
}
