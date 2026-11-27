import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const WORKER_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const WORKER_BRANCH_PREFIX = "codex-worker/";

function assertValidWorkerId(workerId) {
  if (typeof workerId !== "string" || !WORKER_ID_PATTERN.test(workerId)) {
    throw new Error("Invalid workerId: must match /^[a-zA-Z0-9_-]{1,64}$/");
  }
}

function isSubpath(parentDir, childPath) {
  const relative = path.relative(parentDir, childPath);
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

async function tryRealpath(targetPath) {
  try {
    return await realpath(targetPath);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function assertNotSymlink(targetPath, label) {
  const stats = await lstatIfExists(targetPath);
  if (stats && stats.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink`);
  }
  return stats;
}

async function resolveCanonicalDirectory(dirPath, label) {
  if (typeof dirPath !== "string" || dirPath.length === 0 || !path.isAbsolute(dirPath)) {
    throw new Error(`${label} must be a non-empty absolute path`);
  }
  const stats = await assertNotSymlink(dirPath, label);
  if (!stats) {
    throw new Error(`${label} does not exist`);
  }
  const canonical = await realpath(dirPath);
  const canonicalStats = await stat(canonical);
  if (!canonicalStats.isDirectory()) {
    throw new Error(`${label} must be a directory`);
  }
  return canonical;
}

async function defaultGit(args, { cwd }) {
  return execFile("git", args, { cwd, shell: false, encoding: "utf8" });
}

function normalizeGitResult(result) {
  if (typeof result === "string") {
    return { stdout: result, stderr: "" };
  }
  if (result && typeof result.exitCode === "number" && result.exitCode !== 0) {
    throw new Error(result.stderr || `git failed with exit code ${result.exitCode}`);
  }
  return {
    stdout: typeof result?.stdout === "string" ? result.stdout : "",
    stderr: typeof result?.stderr === "string" ? result.stderr : "",
  };
}

function parseWorktreeList(porcelain) {
  const entries = [];
  let current = null;

  for (const rawLine of porcelain.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      if (current) {
        entries.push(current);
        current = null;
      }
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { worktree: line.slice("worktree ".length), head: null, branch: null };
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (current && line.startsWith("branch ")) {
      const ref = line.slice("branch ".length);
      current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    }
  }
  if (current) entries.push(current);
  return entries;
}

/**
 * Creates a scoped Git worktree manager for Codex worker isolation.
 * Read mode validates the canonical root without creating worktrees; write mode
 * requires both host `allowWrite` and verified `authorized` approval.
 */
export function createWorktreeManager({ git, root, baseDir, allowWrite = false } = {}) {
  const gitRunner = git ?? defaultGit;

  async function runGit(args, cwd) {
    if (!Array.isArray(args) || args.some((part) => typeof part !== "string")) {
      throw new Error("git arguments must be an array of strings");
    }
    return normalizeGitResult(await gitRunner(args, { cwd }));
  }

  async function resolveGitRoot() {
    const canonicalRoot = await resolveCanonicalDirectory(root, "root");
    const topLevelResult = await runGit(["rev-parse", "--show-toplevel"], canonicalRoot);
    const topLevel = topLevelResult.stdout.trim();
    if (!topLevel) {
      throw new Error("root is not a valid Git repository");
    }
    await assertNotSymlink(topLevel, "git top-level");
    const canonicalTopLevel = await tryRealpath(topLevel);
    if (canonicalTopLevel !== canonicalRoot) {
      throw new Error("root must match canonical Git repository top-level directory");
    }
    return canonicalRoot;
  }

  async function resolveBaseDirectory(createIfMissing) {
    if (typeof baseDir !== "string" || baseDir.length === 0 || !path.isAbsolute(baseDir)) {
      throw new Error("baseDir must be a non-empty absolute path");
    }
    const existing = await assertNotSymlink(baseDir, "baseDir");
    if (!existing) {
      if (!createIfMissing) return null;
      await mkdir(baseDir, { recursive: true, mode: 0o700 });
      await assertNotSymlink(baseDir, "baseDir");
    }
    const canonicalBase = await realpath(baseDir);
    const baseStats = await stat(canonicalBase);
    if (!baseStats.isDirectory()) {
      throw new Error("baseDir must be a directory");
    }
    return canonicalBase;
  }

  async function findExistingWorktree(canonicalRoot, canonicalBase, workerId, expectedBranch) {
    const candidatePath = path.join(canonicalBase, workerId);
    const existingStats = await assertNotSymlink(candidatePath, "worktree path");
    const listed = parseWorktreeList((await runGit(["worktree", "list", "--porcelain"], canonicalRoot)).stdout);

    for (const entry of listed) {
      if (entry.branch !== expectedBranch) continue;
      const entryCanonical = await tryRealpath(entry.worktree);
      if (entryCanonical && (!existingStats || entryCanonical !== (await realpath(candidatePath)))) {
        throw new Error(`Branch ${expectedBranch} is already attached to another worktree`);
      }
    }

    if (!existingStats) {
      return { exists: false, candidatePath };
    }
    if (!existingStats.isDirectory()) {
      throw new Error("Existing worktree path is not a directory");
    }

    const canonicalWorktree = await realpath(candidatePath);
    if (!isSubpath(canonicalBase, canonicalWorktree)) {
      throw new Error("Worktree path escapes baseDir");
    }

    for (const entry of listed) {
      const entryCanonical = await tryRealpath(entry.worktree);
      if (entryCanonical === canonicalWorktree) {
        if (entry.branch !== expectedBranch) {
          throw new Error("Existing worktree belongs to a different branch/worker");
        }
        return { exists: true, canonicalWorktree };
      }
    }

    throw new Error("Existing directory at worktree path is not registered to this worker");
  }

  async function branchExists(canonicalRoot, branchName) {
    try {
      await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], canonicalRoot);
      return true;
    } catch {
      return false;
    }
  }

  async function prepare({ workerId, mode = "read", authorized = false } = {}) {
    if (mode !== "read" && mode !== "write") {
      throw new Error('Invalid mode: expected "read" or "write"');
    }
    if (workerId !== undefined) {
      assertValidWorkerId(workerId);
    }

    if (mode === "read") {
      const canonicalRoot = await resolveCanonicalDirectory(root, "root");
      return {
        mode: "read",
        cwd: canonicalRoot,
        worktree: null,
        writableRoots: [],
      };
    }

    assertValidWorkerId(workerId);
    if (allowWrite !== true || authorized !== true) {
      throw new Error("Unauthorized write mode: requires allowWrite=true and authorized=true");
    }

    const canonicalRoot = await resolveGitRoot();
    const canonicalBase = await resolveBaseDirectory(true);
    const expectedBranch = `${WORKER_BRANCH_PREFIX}${workerId}`;
    const existing = await findExistingWorktree(canonicalRoot, canonicalBase, workerId, expectedBranch);

    if (existing.exists) {
      return {
        mode: "write",
        cwd: existing.canonicalWorktree,
        worktree: existing.canonicalWorktree,
        branch: expectedBranch,
        writableRoots: [existing.canonicalWorktree],
        reused: true,
      };
    }

    if (existing.candidatePath === canonicalRoot) {
      throw new Error("Worktree path cannot equal repository root");
    }

    // Never pass shell strings; preserve dirty root tree and attach existing branch if present.
    const hasBranch = await branchExists(canonicalRoot, expectedBranch);
    const addArgs = hasBranch
      ? ["worktree", "add", existing.candidatePath, expectedBranch]
      : ["worktree", "add", "-b", expectedBranch, existing.candidatePath];
    await runGit(addArgs, canonicalRoot);

    await assertNotSymlink(existing.candidatePath, "worktree path");
    const canonicalWorktree = await realpath(existing.candidatePath);
    if (!isSubpath(canonicalBase, canonicalWorktree)) {
      throw new Error("Created worktree path escaped baseDir");
    }

    return {
      mode: "write",
      cwd: canonicalWorktree,
      worktree: canonicalWorktree,
      branch: expectedBranch,
      writableRoots: [canonicalWorktree],
      reused: false,
    };
  }

  async function inspect(workerId) {
    assertValidWorkerId(workerId);
    const expectedBranch = `${WORKER_BRANCH_PREFIX}${workerId}`;
    const canonicalBase = await resolveBaseDirectory(false);
    if (!canonicalBase) {
      return {
        exists: false,
        workerId,
        branch: expectedBranch,
        path: path.resolve(baseDir, workerId),
        dirty: false,
        changes: [],
      };
    }

    const candidatePath = path.join(canonicalBase, workerId);
    const stats = await assertNotSymlink(candidatePath, "worktree path");
    if (!stats) {
      return {
        exists: false,
        workerId,
        branch: expectedBranch,
        path: candidatePath,
        dirty: false,
        changes: [],
      };
    }
    if (!stats.isDirectory()) {
      throw new Error("Worktree path is not a directory");
    }

    const canonicalWorktree = await realpath(candidatePath);
    if (!isSubpath(canonicalBase, canonicalWorktree)) {
      throw new Error("Worktree path escaped baseDir");
    }

    const branchResult = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], canonicalWorktree);
    const actualBranch = branchResult.stdout.trim();
    const statusResult = await runGit(["status", "--porcelain"], canonicalWorktree);
    const changes = statusResult.stdout.split(/\r?\n/).filter((line) => line.length > 0);

    return {
      exists: true,
      workerId,
      branch: actualBranch,
      expectedBranch,
      matchesWorker: actualBranch === expectedBranch,
      path: canonicalWorktree,
      dirty: changes.length > 0,
      changes,
    };
  }

  return { prepare, inspect };
}
