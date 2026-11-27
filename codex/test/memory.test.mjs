import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { collectMemory, recordNote } from "../src/memory.mjs";

const execFile = promisify(execFileCallback);
const MEMORY_SCRIPT = fileURLToPath(new URL("../../scripts/memory.py", import.meta.url));

async function runMemoryCli(libraryPath, ...args) {
  const { stdout } = await execFile("python3", [MEMORY_SCRIPT, "--library", libraryPath, ...args], {
    encoding: "utf8",
  });
  return JSON.parse(stdout);
}

test("disabled memory performs no reads and no writes", async () => {
  const temp = await mkdtemp(join(tmpdir(), "t3o-mem-off-"));
  try {
    const missingLibrary = join(temp, "never-created-library");
    let appServerCalled = false;
    const appServer = {
      listTurns: async () => {
        appServerCalled = true;
        return { data: [], nextCursor: null };
      },
      readThread: async () => {
        appServerCalled = true;
        return { thread: null };
      },
    };

    const offResult = await collectMemory({
      project: { id: "proj-1", name: "demo", memoryEnabled: false, coordinatorThreadId: "coord-1" },
      state: { workers: { "w-1": { id: "w-1", projectId: "proj-1", threadId: "worker-thread-1" } } },
      appServer,
      libraryPath: missingLibrary,
      cursor: "prev-cursor",
      limit: 10,
    });
    assert.deepEqual(offResult, {
      items: [],
      nextCursor: "prev-cursor",
      complete: true,
      disabled: true,
    });
    assert.equal(appServerCalled, false);
    await assert.rejects(() => access(missingLibrary));

    const noLibResult = await collectMemory({
      project: { id: "proj-1", name: "demo", memoryEnabled: true, coordinatorThreadId: "coord-1" },
      state: { workers: {} },
      appServer,
      libraryPath: null,
    });
    assert.deepEqual(noLibResult, {
      items: [],
      nextCursor: null,
      complete: true,
      disabled: true,
    });
    assert.equal(appServerCalled, false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("collects only from registered owned workers and explicitly enrolled coordinator thread", async () => {
  const temp = await mkdtemp(join(tmpdir(), "t3o-mem-scope-"));
  try {
    const libraryPath = join(temp, "library");
    const queriedThreads = [];
    const appServer = {
      listTurns: async ({ threadId }) => {
        queriedThreads.push(threadId);
        if (threadId === "coord-thread-1") {
          return {
            data: [{ id: "turn-c1", status: "completed", summary: "Coordinator approved plan." }],
            nextCursor: null,
          };
        }
        if (threadId === "worker-thread-1") {
          return {
            data: [{ id: "turn-w1", status: "completed", summary: "Worker verified unit checks." }],
            nextCursor: null,
          };
        }
        throw new Error(`Unexpected thread read: ${threadId}`);
      },
      readThread: async () => {
        throw new Error("Should not call readThread blindly on unknown threads");
      },
    };

    const project = {
      id: "proj-1",
      name: "demo",
      memoryEnabled: true,
      coordinatorThreadId: "coord-thread-1",
      excludedThreadIds: ["excluded-thread"],
    };
    const state = {
      workers: {
        w1: { id: "w1", projectId: "proj-1", threadId: "worker-thread-1" },
        otherProject: { id: "w2", projectId: "proj-2", threadId: "other-project-thread" },
        excluded: { id: "w3", projectId: "proj-1", threadId: "excluded-thread" },
      },
    };

    const result = await collectMemory({ project, state, appServer, libraryPath, limit: 10 });
    assert.deepEqual(queriedThreads.sort(), ["coord-thread-1", "worker-thread-1"]);
    assert.equal(result.complete, true);
    assert.equal(result.nextCursor, null);
    assert.equal(result.items.length, 2);
    assert.equal(result.recorded.length, 2);
    assert.ok(result.items.every((item) => item.source.startsWith("file://")));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("partial pagination persists cursor durably via state-put and does not advance on failure", async () => {
  const temp = await mkdtemp(join(tmpdir(), "t3o-mem-page-"));
  try {
    const libraryPath = join(temp, "library");
    const project = {
      id: "proj-page",
      name: "paged",
      memoryEnabled: true,
      coordinatorThreadId: "coord-1",
    };
    const state = { workers: {} };

    let failSecondTurn = false;
    const appServer = {
      listTurns: async ({ threadId, cursor }) => {
        assert.equal(threadId, "coord-1");
        if (!cursor) {
          return {
            data: [{ id: "turn-1", status: "completed", summary: "Page 1 decision." }],
            nextCursor: "page-2",
          };
        }
        if (cursor === "page-2") {
          if (failSecondTurn) throw new Error("Transient read error");
          return {
            data: [{ id: "turn-2", status: "completed", summary: "Page 2 decision." }],
            nextCursor: null,
          };
        }
        throw new Error(`Unexpected cursor: ${cursor}`);
      },
    };

    const pass1 = await collectMemory({ project, state, appServer, libraryPath, limit: 1 });
    assert.equal(pass1.complete, false);
    assert.ok(pass1.nextCursor !== null);
    assert.equal(pass1.items.length, 1);

    const savedAfterPass1 = await runMemoryCli(libraryPath, "state-get", "codex-memory:proj-page");
    assert.equal(savedAfterPass1.revision, 1);
    assert.deepEqual(savedAfterPass1.value.cursor, pass1.nextCursor);

    // Failure during page 2 must NOT overwrite durable cursor from pass 1.
    failSecondTurn = true;
    await assert.rejects(() => collectMemory({ project, state, appServer, libraryPath, limit: 1 }));
    const savedAfterFail = await runMemoryCli(libraryPath, "state-get", "codex-memory:proj-page");
    assert.equal(savedAfterFail.revision, 1);
    assert.deepEqual(savedAfterFail.value.cursor, pass1.nextCursor);

    // Retry resumes from persisted cursor and completes.
    failSecondTurn = false;
    const pass2 = await collectMemory({ project, state, appServer, libraryPath, limit: 1 });
    assert.equal(pass2.complete, true);
    assert.equal(pass2.nextCursor, null);
    assert.equal(pass2.items.length, 1);
    assert.equal(pass2.items[0].turnId, "turn-2");

    const savedAfterPass2 = await runMemoryCli(libraryPath, "state-get", "codex-memory:proj-page");
    assert.equal(savedAfterPass2.revision, 2);
    assert.equal(savedAfterPass2.value.cursor, null);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("excludes secrets, personal data, and raw transcripts; writes sanitized evidence under evidenceDir with file:// URI and provenance", async () => {
  const temp = await mkdtemp(join(tmpdir(), "t3o-mem-redact-"));
  try {
    const libraryPath = join(temp, "library");
    const evidenceDir = join(libraryPath, "evidence");
    const project = {
      id: "proj-sec",
      name: "sec-demo",
      memoryEnabled: true,
      coordinatorThreadId: "coord-sec",
    };

    const rawTranscriptMarker = "RAW_FULL_TRANSCRIPT_DO_NOT_STORE";
    const apiKeySecret = "sk-proj-secret1234567890abcdef";
    const bearerSecret = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature123";
    const emailPii = "alice.private@example.com";

    const appServer = {
      listTurns: async () => ({
        data: [{
          id: "turn-secret-1",
          status: "completed",
          summary: `Configured client using ${apiKeySecret}, auth=${bearerSecret}, owner ${emailPii}, password=hunter2secret.`,
          rawTranscript: rawTranscriptMarker,
          items: [{ type: "user_message", text: rawTranscriptMarker }],
        }],
        nextCursor: null,
      }),
    };

    const result = await collectMemory({
      project,
      state: { workers: {} },
      appServer,
      libraryPath,
      evidenceDir,
      limit: 5,
    });

    assert.equal(result.items.length, 1);
    const item = result.items[0];
    assert.equal(item.threadId, "coord-sec");
    assert.equal(item.turnId, "turn-secret-1");
    assert.ok(item.source.startsWith("file://"));

    const canonicalLib = await realpath(libraryPath);
    const canonicalArtifact = await realpath(item.evidencePath);
    assert.ok(canonicalArtifact.startsWith(`${canonicalLib}/`));

    const artifactStat = await stat(canonicalArtifact);
    assert.equal(artifactStat.mode & 0o777, 0o600);

    const artifactJson = JSON.parse(await readFile(canonicalArtifact, "utf8"));
    assert.equal(artifactJson.threadId, "coord-sec");
    assert.equal(artifactJson.turnId, "turn-secret-1");

    const artifactText = JSON.stringify(artifactJson);
    assert.ok(!artifactText.includes(apiKeySecret));
    assert.ok(!artifactText.includes("eyJhbGciOiJIUzI1NiJ9"));
    assert.ok(!artifactText.includes(emailPii));
    assert.ok(!artifactText.includes("hunter2secret"));
    assert.ok(!artifactText.includes(rawTranscriptMarker));

    const noteRecord = await runMemoryCli(libraryPath, "show", result.recorded[0].id);
    assert.equal(noteRecord.source, item.source);
    assert.ok(!noteRecord.body.includes(apiKeySecret));
    assert.ok(!noteRecord.body.includes(emailPii));
    assert.ok(!noteRecord.body.includes(rawTranscriptMarker));
    assert.ok(noteRecord.body.includes("coord-sec"));
    assert.ok(noteRecord.body.includes("turn-secret-1"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("rejects untrusted source URIs and evidenceDir path escapes outside library", async () => {
  const temp = await mkdtemp(join(tmpdir(), "t3o-mem-escape-"));
  try {
    const libraryPath = join(temp, "library");
    const outsideDir = join(temp, "outside");
    await mkdir(libraryPath, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, "secret.txt"), "secret\n", "utf8");

    // Unknown or escaping source URIs rejected by recordNote.
    for (const badSource of [
      "codex://thread/123",
      "http://example.com/note",
      "javascript:alert(1)",
      pathToFileURL(join(outsideDir, "secret.txt")).href,
      `file://${libraryPath}/../outside/secret.txt`,
    ]) {
      await assert.rejects(() => recordNote({
        libraryPath,
        note: {
          topic: "security",
          kind: "observation",
          title: "Bad source",
          source: badSource,
          body: "Must be rejected",
        },
      }));
    }

    // evidenceDir escaping outside library (both .. and symlink) rejected by collectMemory.
    const symlinkEvidence = join(libraryPath, "bad-evidence-link");
    await symlink(outsideDir, symlinkEvidence);

    const appServer = { listTurns: async () => ({ data: [], nextCursor: null }) };
    for (const badEvidence of [join(libraryPath, "..", "outside"), outsideDir, symlinkEvidence]) {
      await assert.rejects(() => collectMemory({
        project: { id: "p1", name: "demo", memoryEnabled: true, coordinatorThreadId: "c1" },
        state: { workers: {} },
        appServer,
        libraryPath,
        evidenceDir: badEvidence,
      }));
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("recordNote delegates via python script with shell: false, is idempotent, and supports supersedes corrections", async () => {
  const temp = await mkdtemp(join(tmpdir(), "t3o-mem-rec-"));
  try {
    const libraryPath = join(temp, "library");
    const evidenceFile = join(libraryPath, "evidence", "e1.json");
    await mkdir(join(libraryPath, "evidence"), { recursive: true });
    await writeFile(evidenceFile, JSON.stringify({ threadId: "c1", turnId: "t1" }), "utf8");
    const source = pathToFileURL(await realpath(evidenceFile)).href;

    const note = {
      topic: "billing",
      kind: "decision",
      title: "Monthly billing cycle",
      source,
      body: "Use monthly billing for V1.",
    };

    const first = await recordNote({ libraryPath, note, publish: false });
    const second = await recordNote({ libraryPath, note, publish: false });
    assert.deepEqual(second, first);
    assert.equal(first.status, "pending");

    const published = await recordNote({ libraryPath, note, publish: true });
    assert.equal(published.id, first.id);
    assert.equal(published.status, "published");

    const correction = await recordNote({
      libraryPath,
      note: {
        ...note,
        kind: "correction",
        body: "Use quarterly billing instead.",
        supersedes: first.id,
      },
      publish: true,
    });
    assert.equal(correction.status, "published");
    assert.equal((await runMemoryCli(libraryPath, "show", first.id)).status, "superseded");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("redacts quoted secrets with spaces, fixes offset pagination, resets cursor on removed thread, extracts real turn.items, and rejects missing worker.projectId", async () => {
  const temp = await mkdtemp(join(tmpdir(), "t3o-mem-fix-"));
  try {
    const libraryPath = join(temp, "library");
    const turnsByThread = {
      "thr-1": [
        {
          id: "t1",
          status: "completed",
          items: [{ id: "i1", type: "agentMessage", text: 'Config uses password="my super secret phrase" in staging.' }],
        },
        {
          id: "t2",
          status: "completed",
          items: [{ id: "i2", type: "agentMessage", text: "Second turn evidence." }],
        },
        {
          id: "t3",
          status: "completed",
          items: [{ id: "i3", type: "agentMessage", text: "Third turn evidence." }],
        },
      ],
    };

    let callCount = 0;
    const appServer = {
      async listTurns({ threadId, limit }) {
        callCount += 1;
        const all = turnsByThread[threadId] ?? [];
        // Call 1 returns 2 turns (producing offset=1 when limit=1); subsequent calls strictly honor limit
        if (callCount === 1) {
          return { data: all.slice(0, 2), nextCursor: null };
        }
        return { data: all.slice(0, limit), nextCursor: null };
      },
    };

    const project = {
      id: "proj-1",
      name: "fix-test",
      memoryEnabled: true,
      coordinatorThreadId: "thr-1",
    };
    const state = {
      workers: {
        // Missing projectId must be skipped!
        "bad-w": { id: "bad-w", threadId: "thr-alien" },
      },
    };

    // Pass 1: limit=1 -> collects t1 and returns offset=1
    const pass1 = await collectMemory({ project, state, appServer, libraryPath, limit: 1 });
    assert.equal(pass1.items.length, 1);
    assert.equal(pass1.items[0].turnId, "t1");
    assert.equal(pass1.items[0].summary.includes("my super secret phrase"), false);
    assert.match(pass1.items[0].summary, /\[REDACTED\]/);
    assert.equal(pass1.complete, false);

    // Pass 2: offset=1 with limit=1 MUST request enough turns to reach t2 (not slice empty!)
    const pass2 = await collectMemory({ project, state, appServer, libraryPath, limit: 1 });
    assert.equal(pass2.items.length, 1);
    assert.equal(pass2.items[0].turnId, "t2");
    assert.match(pass2.items[0].summary, /Second turn evidence/);

    // Pass 3 with stale cursor pointing to removed thread resets turnCursor/offset cleanly
    const pass3 = await collectMemory({
      project,
      state,
      appServer,
      libraryPath,
      cursor: { sourceIndex: 0, threadId: "thr-deleted", turnCursor: "stale-cur", offset: 99 },
      limit: 3,
    });
    assert.equal(pass3.items.length, 3);
    assert.equal(pass3.items[0].turnId, "t1");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
