import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createWorktreeManager } from "../src/worktrees.mjs";

const execFile = promisify(execFileCallback);

async function initTempGitRepo(parentDir, name = "repo") {
  const repoDir = join(parentDir, name);
  await mkdir(repoDir, { recursive: true });
  await execFile("git", ["init", "-b", "main"], { cwd: repoDir });
  await execFile("git", ["config", "user.email", "test@example.invalid"], { cwd: repoDir });
  await execFile("git", ["config", "user.name", "Test User"], { cwd: repoDir });
  await writeFile(join(repoDir, "README.md"), "# Test repo\n", "utf8");
  await execFile("git", ["add", "README.md"], { cwd: repoDir });
  await execFile("git", ["commit", "-m", "initial"], { cwd: repoDir });
  return repoDir;
}

test("read mode validates canonical root and returns empty writableRoots", async () => {
  const temp = await mkdtemp(join(tmpdir(), "t3o-wt-read-"));
  try {
    const root = join(temp, "project");
    await mkdir(root, { recursive: true });
    const manager = createWorktreeManager({ root, baseDir: join(temp, "worktrees"), allowWrite: false });
    const result = await manager.prepare({ workerId: "worker-1", mode: "read", authorized: false });

    assert.equal(result.mode, "read");
    assert.equal(result.cwd, await realpath(root));
    assert.equal(result.worktree, null);
    assert.deepEqual(result.writableRoots, []);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("read mode rejects symlink root, non-existent root, and non-absolute root", async () => {
  const temp = await mkdtemp(join(tmpdir(), "t3o-wt-sym-"));
  try {
    const realDir = join(temp, "real");
    const linkDir = join(temp, "link");
    await mkdir(realDir, { recursive: true });
    await symlink(realDir, linkDir);

    await assert.rejects(
      () => createWorktreeManager({ root: linkDir, baseDir: join(temp, "wt") }).prepare({ workerId: "w1", mode: "read" }),
      /symlink/i,
    );
    await assert.rejects(
      () => createWorktreeManager({ root: join(temp, "missing"), baseDir: join(temp, "wt") }).prepare({ workerId: "w1", mode: "read" }),
    );
    await assert.rejects(
      () => createWorktreeManager({ root: "relative/path", baseDir: join(temp, "wt") }).prepare({ workerId: "w1", mode: "read" }),
      /absolute/i,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("write mode rejects unless allowWrite === true && authorized === true", async () => {
  const temp = await mkdtemp(join(tmpdir(), "t3o-wt-auth-"));
  try {
    const repo = await initTempGitRepo(temp);
    const baseDir = join(temp, "worktrees");

    const deniedByProject = createWorktreeManager({ root: repo, baseDir, allowWrite: false });
    await assert.rejects(
      () => deniedByProject.prepare({ workerId: "worker-1", mode: "write", authorized: true }),
      /unauthori[sz]ed|not allowed/i,
    );

    const allowedProject = createWorktreeManager({ root: repo, baseDir, allowWrite: true });
    for (const badAuth of [false, undefined, null, "true", 1, { selfAsserted: true }]) {
      await assert.rejects(
        () => allowedProject.prepare({ workerId: "worker-1", mode: "write", authorized: badAuth }),
        /unauthori[sz]ed|not allowed/i,
      );
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("strict workerId validation blocks path traversal and malformed IDs", async () => {
  const temp = await mkdtemp(join(tmpdir(), "t3o-wt-id-"));
  try {
    const repo = await initTempGitRepo(temp);
    const manager = createWorktreeManager({ root: repo, baseDir: join(temp, "worktrees"), allowWrite: true });

    for (const badId of ["", "../escape", "a/b", "a\\b", "worker 1", "worker.1", "x".repeat(65), null, undefined]) {
      await assert.rejects(
        () => manager.prepare({ workerId: badId, mode: "write", authorized: true }),
        /workerId/i,
      );
      await assert.rejects(
        () => manager.inspect(badId),
        /workerId/i,
      );
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("write mode rejects non-git root and symlinked baseDir", async () => {
  const temp = await mkdtemp(join(tmpdir(), "t3o-wt-nongit-"));
  try {
    const plainDir = join(temp, "not-a-repo");
    await mkdir(plainDir, { recursive: true });
    const manager = createWorktreeManager({ root: plainDir, baseDir: join(temp, "wt"), allowWrite: true });

    await assert.rejects(
      () => manager.prepare({ workerId: "worker-1", mode: "write", authorized: true }),
    );

    const repo = await initTempGitRepo(temp, "git-repo");
    const realBase = join(temp, "real-base");
    const linkBase = join(temp, "link-base");
    await mkdir(realBase, { recursive: true });
    await symlink(realBase, linkBase);

    const symlinkManager = createWorktreeManager({ root: repo, baseDir: linkBase, allowWrite: true });
    await assert.rejects(
      () => symlinkManager.prepare({ workerId: "worker-1", mode: "write", authorized: true }),
      /symlink/i,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("two write workers get distinct branches and directories, and replay is idempotent", async () => {
  const temp = await mkdtemp(join(tmpdir(), "t3o-wt-multi-"));
  try {
    const repo = await initTempGitRepo(temp);
    const baseDir = join(temp, "worktrees");
    const manager = createWorktreeManager({ root: repo, baseDir, allowWrite: true });

    const first = await manager.prepare({ workerId: "worker-1", mode: "write", authorized: true });
    const second = await manager.prepare({ workerId: "worker-2", mode: "write", authorized: true });

    assert.equal(first.mode, "write");
    assert.equal(first.branch, "codex-worker/worker-1");
    assert.equal(first.worktree, first.cwd);
    assert.deepEqual(first.writableRoots, [first.worktree]);
    assert.equal(first.reused, false);

    assert.equal(second.mode, "write");
    assert.equal(second.branch, "codex-worker/worker-2");
    assert.notEqual(first.worktree, second.worktree);
    assert.notEqual(first.branch, second.branch);

    // Replay for same workerId returns identical metadata without creating a duplicate worktree.
    const replay = await manager.prepare({ workerId: "worker-1", mode: "write", authorized: true });
    assert.equal(replay.worktree, first.worktree);
    assert.equal(replay.branch, first.branch);
    assert.deepEqual(replay.writableRoots, first.writableRoots);
    assert.equal(replay.reused, true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("dirty root working tree is preserved and errors never delete uncommitted work", async () => {
  const temp = await mkdtemp(join(tmpdir(), "t3o-wt-dirty-"));
  try {
    const repo = await initTempGitRepo(temp);
    const baseDir = join(temp, "worktrees");
    const dirtyTracked = join(repo, "README.md");
    const dirtyUntracked = join(repo, "manual-notes.txt");
    await writeFile(dirtyTracked, "# Modified locally\n", "utf8");
    await writeFile(dirtyUntracked, "keep me untouched\n", "utf8");

    const manager = createWorktreeManager({ root: repo, baseDir, allowWrite: true });
    const prepared = await manager.prepare({ workerId: "worker-dirty", mode: "write", authorized: true });

    // Dirty root files remain untouched.
    assert.equal(await readFile(dirtyTracked, "utf8"), "# Modified locally\n");
    assert.equal(await readFile(dirtyUntracked, "utf8"), "keep me untouched\n");

    // Uncommitted work inside worker worktree is preserved and reported by inspect().
    const workerFile = join(prepared.worktree, "WIP.txt");
    await writeFile(workerFile, "work in progress\n", "utf8");

    const status = await manager.inspect("worker-dirty");
    assert.equal(status.exists, true);
    assert.equal(status.branch, "codex-worker/worker-dirty");
    assert.equal(status.path, prepared.worktree);
    assert.equal(status.dirty, true);
    assert.ok(status.changes.some((line) => line.includes("WIP.txt")));

    // Simulated interruption / error on a failing git call does not remove workerFile or root dirty files.
    const failingManager = createWorktreeManager({
      root: repo,
      baseDir,
      allowWrite: true,
      git: async (args) => {
        if (args[0] === "rev-parse") return { stdout: `${await realpath(repo)}\n`, stderr: "" };
        if (args[0] === "worktree" && args[1] === "list") return { stdout: "", stderr: "" };
        throw new Error("Simulated SIGINT during git worktree add");
      },
    });
    await assert.rejects(
      () => failingManager.prepare({ workerId: "worker-fail", mode: "write", authorized: true }),
      /SIGINT/,
    );
    assert.equal(await readFile(workerFile, "utf8"), "work in progress\n");
    assert.equal(await readFile(dirtyTracked, "utf8"), "# Modified locally\n");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("git invocations pass argument arrays without shell interpolation, even with spaces in paths", async () => {
  const temp = await mkdtemp(join(tmpdir(), "t3o-wt-spaces-"));
  try {
    const repo = join(temp, "my repo $(echo unsafe)");
    const baseDir = join(temp, "worktrees with spaces");
    await mkdir(repo, { recursive: true });
    const calls = [];
    const canonicalRepo = await realpath(repo);

    const manager = createWorktreeManager({
      root: repo,
      baseDir,
      allowWrite: true,
      git: async (args, opts) => {
        calls.push({ args, cwd: opts.cwd });
        if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
          return { stdout: `${canonicalRepo}\n`, stderr: "" };
        }
        if (args[0] === "worktree" && args[1] === "list") {
          return { stdout: `worktree ${canonicalRepo}\nbranch refs/heads/main\n`, stderr: "" };
        }
        if (args[0] === "show-ref") {
          throw new Error("not found");
        }
        if (args[0] === "worktree" && args[1] === "add") {
          await mkdir(args[4], { recursive: true });
          return { stdout: "", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      },
    });

    const prepared = await manager.prepare({ workerId: "worker-space", mode: "write", authorized: true });
    assert.equal(prepared.branch, "codex-worker/worker-space");

    const addCall = calls.find((c) => c.args[0] === "worktree" && c.args[1] === "add");
    assert.ok(addCall, "expected git worktree add call");
    assert.ok(Array.isArray(addCall.args));
    assert.deepEqual(addCall.args.slice(0, 4), ["worktree", "add", "-b", "codex-worker/worker-space"]);
    assert.ok(addCall.args[4].endsWith("/worker-space"));
    assert.equal(addCall.cwd, canonicalRepo);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("inspect returns safe non-existent status when worker worktree has not been created", async () => {
  const temp = await mkdtemp(join(tmpdir(), "t3o-wt-inspect-"));
  try {
    const repo = await initTempGitRepo(temp);
    const baseDir = join(temp, "worktrees");
    const manager = createWorktreeManager({ root: repo, baseDir, allowWrite: true });

    const missing = await manager.inspect("missing-worker");
    assert.equal(missing.exists, false);
    assert.equal(missing.dirty, false);
    assert.equal(missing.branch, "codex-worker/missing-worker");
    assert.deepEqual(missing.changes, []);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
