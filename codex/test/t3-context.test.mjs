import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { renderT3Context } from "../hooks/t3-context.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "t3o-t3ctx-"));
}

describe("t3-context UserPromptSubmit hook", () => {
  const config = {
    version: 1,
    projects: [
      {
        name: "hurdaci-gdd",
        projectId: "85ffb406-2b19-42ed-a5e8-1f0c863b861c",
        coordinatorThreadId: "mcp:launch:coord-123",
        memoryThreadId: null,
        excludedThreadIds: [],
        libraryPath: null,
      },
    ],
  };

  const routing = {
    version: 1,
    projects: {
      "hurdaci-gdd": {
        tiers: {
          simple: { instanceId: "opencode", model: "opencode/deepseek-v4.1-flash-free", effort: "low" },
          standard: { instanceId: "codex", model: "gpt-6-luna", effort: "medium" },
          complex: { instanceId: "codex", model: "gpt-6.1-terra", effort: "high" },
        },
      },
    },
  };

  it("injects fail-closed coordinator reminder with spawn_agent ban and configured tiers", () => {
    const out = renderT3Context(
      { hook_event_name: "UserPromptSubmit", cwd: "/Users/caglar/Desktop/hurdaci-gdd" },
      config,
      routing,
      { projectName: "hurdaci-gdd" },
    );

    assert.ok(out);
    assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /\[T3O_T3_COORDINATOR_REMINDER_V1\]/);
    assert.match(ctx, /mcp:launch:coord-123/);
    assert.match(ctx, /85ffb406-2b19-42ed-a5e8-1f0c863b861c/);
    assert.match(ctx, /t3_thread_configure/);
    assert.match(ctx, /spawn_agent/);
    assert.match(ctx, /t3_thread_launch/);
    assert.match(ctx, /opencode\/deepseek-v4\.1-flash-free/);
  });

  it("returns null for subagents, non-UserPromptSubmit events, and unregistered projects", () => {
    assert.equal(
      renderT3Context(
        { hook_event_name: "UserPromptSubmit", agent_id: "sub-1", cwd: "/Users/caglar/Desktop/hurdaci-gdd" },
        config,
        routing,
        { projectName: "hurdaci-gdd" },
      ),
      null,
    );
    assert.equal(
      renderT3Context(
        { hook_event_name: "Stop", cwd: "/Users/caglar/Desktop/hurdaci-gdd" },
        config,
        routing,
        { projectName: "hurdaci-gdd" },
      ),
      null,
    );
    assert.equal(
      renderT3Context(
        { hook_event_name: "UserPromptSubmit", cwd: "/Users/caglar/Desktop/other-repo" },
        config,
        routing,
      ),
      null,
    );
  });

  it("resolves project by cwd basename when --project is omitted", () => {
    const out = renderT3Context(
      { hook_event_name: "UserPromptSubmit", cwd: "/Users/caglar/Desktop/hurdaci-gdd" },
      config,
      null,
    );
    assert.ok(out);
    assert.match(out.hookSpecificOutput.additionalContext, /hurdaci-gdd/);
  });
});
