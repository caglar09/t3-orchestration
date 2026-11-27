import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  openState,
  projectStateDir,
  readSnapshot,
} from "../src/state.mjs";

const tempDirs = [];

function makeTempDir(prefix = "t3o-state-") {
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

test("projectStateDir builds isolated project directory under <stateRoot>/projects/<projectId>", () => {
  const root = "/tmp/codex-state";
  assert.equal(
    projectStateDir(root, UUID_1),
    path.join(root, "projects", UUID_1),
  );
  assert.throws(() => projectStateDir(root, "../escape"));
  assert.throws(() => projectStateDir(root, "not-a-uuid"));
});

test("openState creates 0700 dir and 0600 lease/state files and increments revision on transact", () => {
  const base = makeTempDir();
  const stateDir = projectStateDir(base, UUID_1);

  const store = openState(stateDir);
  try {
    assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(stateDir, "lease.json")).mode & 0o777, 0o600);

    const initial = store.read();
    assert.deepEqual(initial, {
      version: 1,
      revision: 0,
      workers: {},
      events: [],
      requests: {},
    });

    const after1 = store.transact((draft) => {
      draft.workers["w-1"] = {
        id: "w-1",
        projectId: UUID_1,
        threadId: "thr-1",
        status: "running",
      };
    });
    assert.equal(after1.revision, 1);
    assert.equal(after1.workers["w-1"].status, "running");
    assert.equal(fs.statSync(path.join(stateDir, "state.json")).mode & 0o777, 0o600);

    const after2 = store.transact((cur) => ({
      ...cur,
      events: [
        ...cur.events,
        { id: `${UUID_1}:w-1:turn-1`, workerId: "w-1", status: "completed" },
      ],
    }));
    assert.equal(after2.revision, 2);
    assert.equal(after2.events.length, 1);
  } finally {
    store.close();
  }

  // Reopen cleanly and observe persisted revision
  const reopened = openState(stateDir);
  try {
    const snap = reopened.read();
    assert.equal(snap.revision, 2);
    assert.equal(snap.workers["w-1"].threadId, "thr-1");
    assert.equal(snap.events.length, 1);
  } finally {
    reopened.close();
  }
});

test("second writer cannot acquire lease while owner PID is alive", () => {
  const stateDir = path.join(makeTempDir(), "proj");
  const writer1 = openState(stateDir);
  try {
    assert.throws(
      () => openState(stateDir),
      /lease|lock|active/i,
    );
    // Even with stale recovery flag, live owner PID blocks takeover
    assert.throws(
      () => openState(stateDir, { isPidAlive: () => true }),
      /lease|lock|active|alive/i,
    );
  } finally {
    writer1.close();
  }

  // After close, a new writer can acquire
  const writer2 = openState(stateDir);
  writer2.close();
});

test("stale lease with dead PID is recovered safely while live PID prevents takeover", () => {
  const stateDir = path.join(makeTempDir(), "proj");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const leasePath = path.join(stateDir, "lease.json");

  // Live owner (PID alive) -> takeover must fail
  fs.writeFileSync(
    leasePath,
    JSON.stringify({ pid: 424242, token: "live-token", acquiredAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
  assert.throws(() => openState(stateDir, { isPidAlive: (pid) => pid === 424242 }));

  // Dead owner (PID not alive) -> stale lease recovered safely
  const recovered = openState(stateDir, { isPidAlive: () => false });
  try {
    const leaseOnDisk = JSON.parse(fs.readFileSync(leasePath, "utf8"));
    assert.equal(leaseOnDisk.pid, process.pid);
    assert.notEqual(leaseOnDisk.token, "live-token");
    const committed = recovered.transact((s) => {
      s.requests["req-1"] = { status: "ok" };
    });
    assert.equal(committed.revision, 1);
  } finally {
    recovered.close();
  }
  assert.equal(fs.existsSync(leasePath), false);
});

test("interrupted write leaves previous valid snapshot intact", () => {
  const stateDir = path.join(makeTempDir(), "proj");
  const writer = openState(stateDir);
  try {
    writer.transact((s) => {
      s.workers["w-1"] = { id: "w-1", status: "ready" };
    });
  } finally {
    writer.close();
  }

  // Simulate crash right before rename during second transaction
  const writer2 = openState(stateDir, {
    onBeforeRename: () => {
      throw new Error("Simulated crash before rename");
    },
  });
  try {
    assert.throws(() => {
      writer2.transact((s) => {
        s.workers["w-1"].status = "corrupted-half-write";
      });
    }, /Simulated crash/);

    const current = writer2.read();
    assert.equal(current.revision, 1);
    assert.equal(current.workers["w-1"].status, "ready");
  } finally {
    writer2.close();
  }

  // Orphaned partial temp file in dir does not affect snapshot
  fs.writeFileSync(path.join(stateDir, ".state.json.tmp.99999"), "{partial", { mode: 0o600 });
  const snap = readSnapshot(stateDir);
  assert.equal(snap?.revision, 1);
  assert.equal(snap?.workers["w-1"].status, "ready");
});

test("corrupted state JSON or invalid shape refuses read and mutation (fails closed)", () => {
  const stateDir = path.join(makeTempDir(), "proj");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const statePath = path.join(stateDir, "state.json");

  for (const badContent of [
    "{corrupted-json",
    "",
    JSON.stringify({ version: 2, revision: 0, workers: {}, events: [], requests: {} }),
    JSON.stringify({ version: 1, revision: -1, workers: {}, events: [], requests: {} }),
    JSON.stringify({ version: 1, revision: 0, workers: [], events: [], requests: {} }),
    JSON.stringify({ version: 1, revision: 0, workers: {}, events: {}, requests: {} }),
  ]) {
    fs.writeFileSync(statePath, badContent, { mode: 0o600 });
    const store = openState(stateDir);
    try {
      assert.throws(() => store.read());
      let callbackCalled = false;
      assert.throws(() => {
        store.transact(() => {
          callbackCalled = true;
        });
      });
      assert.equal(callbackCalled, false);
      // Corrupted file preserved intact, never silently overwritten
      assert.equal(fs.readFileSync(statePath, "utf8"), badContent);
    } finally {
      store.close();
    }
  }
});

test("readSnapshot reads without lease, returns null when missing/corrupt, and never mutates", () => {
  const base = makeTempDir();
  const missingDir = path.join(base, "does-not-exist");
  assert.equal(readSnapshot(missingDir), null);
  assert.equal(fs.existsSync(missingDir), false);

  const stateDir = path.join(base, "proj");
  const writer = openState(stateDir);
  try {
    writer.transact((s) => {
      s.workers["w-1"] = { id: "w-1", status: "running" };
    });

    // Hook snapshot succeeds even while writer holds lease
    const snap = readSnapshot(stateDir);
    assert.equal(snap?.revision, 1);
    assert.equal(snap?.workers["w-1"].status, "running");
  } finally {
    writer.close();
  }

  // Corrupt state => readSnapshot returns null without throwing or modifying file
  const statePath = path.join(stateDir, "state.json");
  fs.writeFileSync(statePath, "{broken", { mode: 0o600 });
  assert.equal(readSnapshot(stateDir), null);
  assert.equal(fs.readFileSync(statePath, "utf8"), "{broken");
});
