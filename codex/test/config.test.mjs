import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  bindCoordinator,
  defaultConfigPath,
  loadConfig,
  resolveRole,
  saveConfigAtomic,
} from "../src/config.mjs";

const tempDirs = [];

function makeTempDir(prefix = "t3o-cfg-") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const UUID_1 = "11111111-1111-4111-8111-111111111111";
const UUID_2 = "22222222-2222-4222-8222-222222222222";
const UUID_3 = "33333333-3333-4333-8333-333333333333";

test("defaultConfigPath targets ~/.t3-orchestration/codex/config.json", () => {
  const home = "/tmp/fake-home";
  assert.equal(
    defaultConfigPath(home),
    path.join(home, ".t3-orchestration", "codex", "config.json"),
  );
});

test("loadConfig returns empty v1 config when file is missing", () => {
  const base = makeTempDir();
  const cfgPath = path.join(base, ".t3-orchestration", "codex", "config.json");
  const cfg = loadConfig(cfgPath);
  assert.deepEqual(cfg, { version: 1, projects: [] });
  assert.equal(fs.existsSync(cfgPath), false);
});

test("loadConfig throws on malformed JSON, wrong version, or invalid entries", () => {
  const base = makeTempDir();
  const cfgPath = path.join(base, "config.json");

  for (const raw of [
    "{not valid json",
    "[]",
    JSON.stringify({ version: 2, projects: [] }),
    JSON.stringify({ version: 1, projects: "nope" }),
    JSON.stringify({ version: 1, projects: [null] }),
    JSON.stringify({
      version: 1,
      projects: [{ id: "bad-uuid", name: "demo", root: base, coordinatorSessionId: "s1" }],
    }),
  ]) {
    fs.writeFileSync(cfgPath, raw, "utf8");
    assert.throws(() => loadConfig(cfgPath));
  }
});

test("saveConfigAtomic enforces 0700 dir and 0600 file permissions and leaves legacy config untouched", () => {
  const base = makeTempDir();
  const legacyDir = path.join(base, ".t3-orchestration");
  const legacyPath = path.join(legacyDir, "config.json");
  fs.mkdirSync(legacyDir, { recursive: true });
  const legacyBytes = '{"projects":[{"name":"legacy"}]}\n';
  fs.writeFileSync(legacyPath, legacyBytes, "utf8");

  const repo = path.join(base, "repo");
  fs.mkdirSync(repo);

  const cfgPath = path.join(legacyDir, "codex", "config.json");
  const initial = loadConfig(cfgPath);
  const updated = bindCoordinator(
    initial,
    { id: UUID_1, name: "demo-app", root: repo },
    "sess-coord-1",
  );
  saveConfigAtomic(cfgPath, updated);

  const dirMode = fs.statSync(path.dirname(cfgPath)).mode & 0o777;
  const fileMode = fs.statSync(cfgPath).mode & 0o777;
  assert.equal(dirMode, 0o700);
  assert.equal(fileMode, 0o600);
  assert.equal(fs.readFileSync(legacyPath, "utf8"), legacyBytes);

  const reloaded = loadConfig(cfgPath);
  assert.equal(reloaded.version, 1);
  assert.equal(reloaded.projects.length, 1);
  assert.equal(reloaded.projects[0].id, UUID_1);
  assert.equal(reloaded.projects[0].name, "demo-app");
  assert.equal(reloaded.projects[0].root, repo);
  assert.equal(reloaded.projects[0].coordinatorSessionId, "sess-coord-1");
  assert.equal(reloaded.projects[0].maxWorkers, 2);
  assert.equal(reloaded.projects[0].memoryEnabled, false);
  assert.equal(reloaded.projects[0].libraryPath, null);
});

test("bindCoordinator validates fields, preserves immutability, and rejects duplicates", () => {
  const base = makeTempDir();
  const repoA = path.join(base, "repo-a");
  const repoB = path.join(base, "repo-b");
  const libA = path.join(base, "lib-a");
  fs.mkdirSync(repoA);
  fs.mkdirSync(repoB);
  fs.mkdirSync(libA);

  const cfg0 = { version: 1, projects: [] };
  const cfg1 = bindCoordinator(
    cfg0,
    {
      id: UUID_1,
      name: "alpha-1",
      root: repoA,
      coordinatorThreadId: "thr-coord-1",
      maxWorkers: 4,
      memoryEnabled: true,
      libraryPath: libA,
      allowWrite: false,
    },
    "sess-1",
  );
  assert.equal(cfg0.projects.length, 0);
  assert.equal(cfg1.projects.length, 1);
  assert.equal(cfg1.projects[0].maxWorkers, 4);
  assert.equal(cfg1.projects[0].memoryEnabled, true);
  assert.equal(cfg1.projects[0].libraryPath, libA);
  assert.equal(cfg1.projects[0].coordinatorThreadId, "thr-coord-1");

  // Duplicate id
  assert.throws(() =>
    bindCoordinator(cfg1, { id: UUID_1, name: "beta", root: repoB }, "sess-2"),
  );
  // Duplicate name
  assert.throws(() =>
    bindCoordinator(cfg1, { id: UUID_2, name: "alpha-1", root: repoB }, "sess-2"),
  );
  // Duplicate canonical root
  assert.throws(() =>
    bindCoordinator(cfg1, { id: UUID_2, name: "beta", root: repoA }, "sess-2"),
  );
  // Duplicate coordinatorSessionId
  assert.throws(() =>
    bindCoordinator(cfg1, { id: UUID_2, name: "beta", root: repoB }, "sess-1"),
  );

  // Invalid maxWorkers
  for (const maxWorkers of [0, 5, 1.5, "2", NaN]) {
    assert.throws(() =>
      bindCoordinator(cfg1, { id: UUID_2, name: "beta", root: repoB, maxWorkers }, "sess-2"),
    );
  }

  // Invalid memoryEnabled / allowWrite / libraryPath
  assert.throws(() =>
    bindCoordinator(cfg1, { id: UUID_2, name: "beta", root: repoB, memoryEnabled: "yes" }, "sess-2"),
  );
  assert.throws(() =>
    bindCoordinator(cfg1, { id: UUID_2, name: "beta", root: repoB, libraryPath: "relative/lib" }, "sess-2"),
  );
});

test("bindCoordinator rejects invalid slug, non-absolute root, non-existent root, and symlink escape", () => {
  const base = makeTempDir();
  const realRepo = path.join(base, "real-repo");
  const outside = path.join(base, "outside");
  const nestedOutside = path.join(outside, "sub");
  fs.mkdirSync(realRepo);
  fs.mkdirSync(nestedOutside, { recursive: true });

  const symlinkRoot = path.join(base, "escape-link");
  fs.symlinkSync(outside, symlinkRoot);

  const cfg = { version: 1, projects: [] };

  // Invalid slugs
  for (const name of ["", "-lead", "Upper", "has space", "../escape", "a/b", "a".repeat(65)]) {
    assert.throws(() =>
      bindCoordinator(cfg, { id: UUID_1, name, root: realRepo }, "sess-1"),
    );
  }

  // Non-absolute / traversal / missing roots
  for (const badRoot of ["relative/path", "./here", `${realRepo}/../real-repo`, path.join(base, "missing")]) {
    assert.throws(() =>
      bindCoordinator(cfg, { id: UUID_1, name: "valid", root: badRoot }, "sess-1"),
    );
  }

  // Symlink escape (direct symlink and nested via symlink)
  assert.throws(() =>
    bindCoordinator(cfg, { id: UUID_1, name: "valid", root: symlinkRoot }, "sess-1"),
  );
  assert.throws(() =>
    bindCoordinator(cfg, { id: UUID_1, name: "valid", root: path.join(symlinkRoot, "sub") }, "sess-1"),
  );

  // Injected resolver detecting symlink escape
  assert.throws(() =>
    bindCoordinator(
      cfg,
      { id: UUID_1, name: "valid", root: "/workspace/link" },
      "sess-1",
      { resolvePath: () => "/etc/outside" },
    ),
  );

  // Injected resolver accepting canonical synthetic root
  const synthetic = bindCoordinator(
    cfg,
    { id: UUID_1, name: "valid", root: "/workspace/repo" },
    "sess-1",
    { resolvePath: (p) => p },
  );
  assert.equal(synthetic.projects[0].root, "/workspace/repo");
});

test("bindCoordinator and loadConfig reject forged or unverified session IDs", () => {
  const base = makeTempDir();
  const repo = path.join(base, "repo");
  fs.mkdirSync(repo);
  const cfg = { version: 1, projects: [] };

  for (const badSession of ["", "   ", null, undefined, 123, "bad\nsess"]) {
    assert.throws(() =>
      bindCoordinator(cfg, { id: UUID_1, name: "demo", root: repo }, badSession),
    );
  }

  // Reject mismatched caller-supplied coordinatorSessionId in projectInput
  assert.throws(() =>
    bindCoordinator(
      cfg,
      { id: UUID_1, name: "demo", root: repo, coordinatorSessionId: "forged-sess" },
      "verified-sess",
    ),
  );
});

test("resolveRole identifies coordinator and registered workers without cwd/title inference", () => {
  const base = makeTempDir();
  const repoA = path.join(base, "repo-a");
  const repoB = path.join(base, "repo-b");
  fs.mkdirSync(repoA);
  fs.mkdirSync(repoB);

  let cfg = loadConfig(path.join(base, "missing.json"));
  cfg = bindCoordinator(
    cfg,
    { id: UUID_1, name: "proj-a", root: repoA, coordinatorThreadId: "thr-coord-a" },
    "sess-coord-a",
  );
  cfg = bindCoordinator(
    cfg,
    { id: UUID_2, name: "proj-b", root: repoB, coordinatorThreadId: "thr-coord-b" },
    "sess-coord-b",
  );

  const stateA = {
    version: 1,
    revision: 2,
    workers: {
      "w-1": {
        id: "w-1",
        projectId: UUID_1,
        threadId: "thr-w1",
        sessionId: "sess-w1",
        cwd: repoA,
        status: "running",
      },
    },
    events: [],
    requests: {},
  };

  const stateB = {
    version: 1,
    revision: 1,
    workers: {
      "w-2": {
        id: "w-2",
        projectId: UUID_2,
        threadId: "thr-w2",
        sessionId: "sess-w2",
        cwd: repoB,
        status: "ready",
      },
    },
    events: [],
    requests: {},
  };

  const stateMap = { [UUID_1]: stateA, [UUID_2]: stateB };

  // Bound coordinators
  const roleA = resolveRole(cfg, stateMap, "sess-coord-a");
  assert.equal(roleA?.role, "coordinator");
  assert.equal(roleA?.projectId, UUID_1);

  const roleB = resolveRole(cfg, stateMap, "sess-coord-b");
  assert.equal(roleB?.role, "coordinator");
  assert.equal(roleB?.projectId, UUID_2);

  // Registered workers
  const workerRoleA = resolveRole(cfg, stateMap, "sess-w1");
  assert.equal(workerRoleA?.role, "worker");
  assert.equal(workerRoleA?.projectId, UUID_1);

  // Unknown / missing / forged session IDs => null
  for (const unknown of [null, undefined, "", "   ", "sess-manual-same-cwd", "forged-id", "thr-unknown"]) {
    assert.equal(resolveRole(cfg, stateMap, unknown), null);
  }

  // Manual thread in same cwd or forged metadata => never inferred as coordinator/worker
  assert.equal(
    resolveRole(cfg, stateMap, "sess-manual", { cwd: repoA, title: "Coordinator" }),
    null,
  );

  // Subagent / internal job sharing parent session ID => null
  assert.equal(
    resolveRole(cfg, stateMap, "sess-coord-a", { agentId: "subagent-1" }),
    null,
  );
  assert.equal(
    resolveRole(cfg, stateMap, "sess-coord-a", { isSubagent: true }),
    null,
  );
  assert.equal(
    resolveRole(cfg, stateMap, "sess-coord-a", { internal: true }),
    null,
  );
  // Forked thread sharing coordinator sessionId but different threadId => null
  assert.equal(
    resolveRole(cfg, stateMap, "sess-coord-a", { threadId: "thr-fork-999" }),
    null,
  );

  // Worker registry isolation across distinct projects:
  // Config only containing proj-b must NEVER resolve a worker from stateA (proj-a)
  const onlyB = { version: 1, projects: [cfg.projects[1]] };
  assert.equal(resolveRole(onlyB, stateA, "sess-w1"), null);
  // Even if stateB erroneously contains a worker claiming UUID_1 (proj-a), proj-b ignores it
  const pollutedB = {
    ...stateB,
    workers: {
      ...stateB.workers,
      "alien-w": { id: "alien-w", projectId: UUID_1, sessionId: "sess-alien", threadId: "thr-alien", status: "running" },
    },
  };
  assert.equal(resolveRole(onlyB, { [UUID_2]: pollutedB }, "sess-alien"), null);

  // Unregistered worker thread without match in state => null
  assert.equal(resolveRole(cfg, { [UUID_1]: { version: 1, revision: 0, workers: {}, events: [], requests: {} } }, "sess-w1"), null);
});

test("loadConfig rejects persisted symlink escape root on reload", () => {
  const base = makeTempDir();
  const outside = path.join(base, "outside");
  fs.mkdirSync(outside);
  const link = path.join(base, "link");
  fs.symlinkSync(outside, link);

  const cfgPath = path.join(base, "config.json");
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({
      version: 1,
      projects: [{
        id: UUID_3,
        name: "tampered",
        root: link,
        coordinatorSessionId: "sess-1",
        maxWorkers: 2,
        memoryEnabled: false,
        libraryPath: null,
      }],
    }),
    "utf8",
  );
  assert.throws(() => loadConfig(cfgPath));
});

test("bindCoordinator allows non-existent libraryPath with canonical ancestor and rejects symlink escape", () => {
  const base = makeTempDir();
  const repo = path.join(base, "repo");
  fs.mkdirSync(repo);
  const futureLib = path.join(base, "new-dir", "library");

  const next = bindCoordinator(
    { version: 1, projects: [] },
    { id: UUID_1, name: "future-lib", root: repo, memoryEnabled: true, libraryPath: futureLib },
    "sess-coord-future",
  );
  assert.equal(next.projects[0].libraryPath, futureLib);

  const outside = path.join(base, "outside");
  fs.mkdirSync(outside);
  const symParent = path.join(base, "sym-parent");
  fs.symlinkSync(outside, symParent);
  assert.throws(() =>
    bindCoordinator(
      { version: 1, projects: [] },
      { id: UUID_2, name: "sym-lib", root: repo, memoryEnabled: true, libraryPath: path.join(symParent, "library") },
      "sess-coord-sym",
    ),
  );
});

test("loadConfig tolerates a missing/unmounted project root without breaking other projects", () => {
  const base = makeTempDir();
  const existingRepo = path.join(base, "existing");
  const removedRepo = path.join(base, "removed");
  fs.mkdirSync(existingRepo);
  fs.mkdirSync(removedRepo);

  const cfgPath = path.join(base, "config.json");
  let cfg = bindCoordinator(
    { version: 1, projects: [] },
    { id: UUID_1, name: "proj-existing", root: existingRepo },
    "sess-existing",
  );
  cfg = bindCoordinator(
    cfg,
    { id: UUID_2, name: "proj-removed", root: removedRepo },
    "sess-removed",
  );
  saveConfigAtomic(cfgPath, cfg);

  fs.rmSync(removedRepo, { recursive: true, force: true });

  const reloaded = loadConfig(cfgPath);
  assert.equal(reloaded.projects.length, 2);
  assert.equal(resolveRole(reloaded, {}, "sess-existing")?.projectId, UUID_1);
});

test("resolveRole matches worker by either sessionId or threadId when both exist", () => {
  const base = makeTempDir();
  const repo = path.join(base, "repo");
  fs.mkdirSync(repo);
  const cfg = bindCoordinator(
    { version: 1, projects: [] },
    { id: UUID_1, name: "proj-a", root: repo },
    "sess-coord-a",
  );
  const state = {
    [UUID_1]: {
      version: 1,
      revision: 1,
      workers: {
        "w-1": { id: "w-1", projectId: UUID_1, sessionId: "sess-w1", threadId: "thr-w1", status: "running" },
      },
      events: [],
      requests: {},
    },
  };
  assert.equal(resolveRole(cfg, state, "sess-w1")?.role, "worker");
  assert.equal(resolveRole(cfg, state, "thr-w1")?.role, "worker");
});
