import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  buildWorkerBrief,
  classifyModelTier,
  readT3Providers,
  selectModelForTask,
} from "../src/t3-providers.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "t3o-providers-"));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

describe("t3-providers", () => {
  it("reads all enabled provider instances, excludes disabled ones, and strips secrets", () => {
    const dir = makeTempDir();
    const settingsPath = path.join(dir, "settings.json");
    const manifestPath = path.join(dir, "model-manifest.json");

    writeJson(settingsPath, {
      providerInstances: {
        codex: {
          driver: "codex",
          enabled: true,
          config: { binaryPath: "/usr/local/bin/codex", apiKey: "sk-secret-123" },
        },
        antigravity: {
          driver: "antigravity",
          displayName: "Antigravity First",
          enabled: true,
          config: { token: "tok-secret-456" },
        },
        opencode: {
          driver: "opencode",
          displayName: "OpenCode",
          enabled: true,
          config: { binaryPath: "/opt/homebrew/bin/opencode" },
        },
        claudeAgent: {
          driver: "claudeAgent",
          enabled: false,
          config: { apiKey: "sk-ant-secret" },
        },
      },
    });

    writeJson(manifestPath, {
      fetchedAtMs: Date.now(),
      manifest: {
        currentModels: {
          codex: ["gpt-6-luna", "gpt-6.1-sol"],
          antigravity: ["gemini-3.8-flash-low", "gemini-4-carbon"],
        },
        providers: {
          codex: {
            models: [
              { slug: "gpt-6.1-sol", name: "GPT-6.1 Sol", status: "current" },
              { slug: "gpt-6-luna", name: "GPT-6 Luna", status: "current" },
            ],
          },
          antigravity: {
            models: [
              { slug: "gemini-4-carbon", name: "Gemini 4 Carbon", status: "current" },
              { slug: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash Low", status: "current" },
            ],
          },
        },
      },
    });

    const { providers } = readT3Providers({ settingsPath, manifestPath });
    assert.deepEqual(
      providers.map((p) => p.instanceId),
      ["codex", "antigravity", "opencode"],
    );

    const serialized = JSON.stringify(providers);
    assert.ok(!serialized.includes("sk-secret-123"));
    assert.ok(!serialized.includes("tok-secret-456"));
    assert.ok(!serialized.includes("sk-ant-secret"));

    const codex = providers.find((p) => p.instanceId === "codex");
    assert.deepEqual(
      codex.models.map((m) => m.slug),
      ["gpt-6-luna", "gpt-6.1-sol"],
    );

    const opencode = providers.find((p) => p.instanceId === "opencode");
    assert.deepEqual(opencode.models, []);
  });

  it("tolerates missing or malformed model-manifest.json without throwing", () => {
    const dir = makeTempDir();
    const settingsPath = path.join(dir, "settings.json");
    const badManifestPath = path.join(dir, "bad-manifest.json");
    writeJson(settingsPath, {
      providerInstances: {
        codex: { driver: "codex", enabled: true, config: {} },
      },
    });
    fs.writeFileSync(badManifestPath, "{not-json", "utf8");

    const fromMissing = readT3Providers({
      settingsPath,
      manifestPath: path.join(dir, "missing.json"),
    });
    assert.equal(fromMissing.providers.length, 1);
    assert.deepEqual(fromMissing.providers[0].models, []);

    const fromMalformed = readT3Providers({
      settingsPath,
      manifestPath: badManifestPath,
    });
    assert.equal(fromMalformed.providers.length, 1);
    assert.deepEqual(fromMalformed.providers[0].models, []);
  });

  it("classifies simple, standard, and complex model slugs deterministically", () => {
    assert.equal(classifyModelTier("gemini-3.8-flash-low"), "simple");
    assert.equal(classifyModelTier("claude-haiku-5-5"), "simple");
    assert.equal(classifyModelTier("gpt-5-mini"), "simple");
    assert.equal(classifyModelTier("claude-sonnet-5-5"), "standard");
    assert.equal(classifyModelTier("gpt-6-luna"), "standard");
    assert.equal(classifyModelTier("gemini-4-argon"), "standard");
    assert.equal(classifyModelTier("claude-opus-5-5"), "complex");
    assert.equal(classifyModelTier("gemini-4-carbon"), "complex");
    assert.equal(classifyModelTier("gpt-6.1-sol"), "complex");
  });

  it("honors explicit routingPolicy when provider is enabled and ignores disabled policy targets", () => {
    const providers = [
      {
        instanceId: "codex",
        driver: "codex",
        label: "codex",
        enabled: true,
        models: [
          { slug: "gpt-6-luna", name: "GPT-6 Luna", tier: "standard" },
          { slug: "gpt-6.1-sol", name: "GPT-6.1 Sol", tier: "complex" },
        ],
      },
      {
        instanceId: "antigravity",
        driver: "antigravity",
        label: "Antigravity First",
        enabled: true,
        models: [
          { slug: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash Low", tier: "simple" },
          { slug: "gemini-4-carbon", name: "Gemini 4 Carbon", tier: "complex" },
        ],
      },
    ];

    const policyPick = selectModelForTask({
      providers,
      tier: "simple",
      routingPolicy: {
        tiers: {
          simple: { instanceId: "antigravity", model: "gemini-3.8-flash-low", effort: "low" },
        },
      },
    });
    assert.equal(policyPick.source, "policy");
    assert.deepEqual(policyPick.modelSelection, {
      instanceId: "antigravity",
      model: "gemini-3.8-flash-low",
      options: [{ id: "effort", value: "low" }],
    });

    // Policy pointing to a disabled/removed instance falls back cleanly to heuristic
    const fallbackPick = selectModelForTask({
      providers,
      tier: "simple",
      routingPolicy: {
        tiers: {
          simple: { instanceId: "disabled-claude", model: "claude-haiku-5-5", effort: "low" },
        },
      },
    });
    assert.equal(fallbackPick.source, "heuristic");
    assert.equal(fallbackPick.modelSelection.instanceId, "antigravity");
    assert.equal(fallbackPick.modelSelection.model, "gemini-3.8-flash-low");
    assert.equal(fallbackPick.modelSelection.options[0].value, "low");
  });

  it("rejects unknown tiers and empty enabled provider list", () => {
    assert.throws(() => selectModelForTask({ providers: [], tier: "simple" }), /No enabled T3/);
    assert.throws(
      () =>
        selectModelForTask({
          providers: [{ instanceId: "codex", driver: "codex", label: "codex", enabled: true, models: [] }],
          tier: "ultra",
        }),
      /Invalid tier/,
    );
  });

  it("builds wake-up t3_thread_send protocol for non-Claude workers and suppresses duplicates for Claude workers", () => {
    const nonClaudeBrief = buildWorkerBrief({
      projectName: "demo",
      coordinatorThreadId: "th_coord_1",
      taskTitle: "Inspect auth logs",
      brief: "Read auth middleware and list failure modes.",
      isClaudeWorker: false,
      routing: {
        tier: "simple",
        modelSelection: {
          instanceId: "antigravity",
          model: "gemini-3.8-flash-low",
          options: [{ id: "effort", value: "low" }],
        },
      },
      projectRules: "- Never push to main.",
    });

    assert.match(nonClaudeBrief, /\[T3O_WORKER_V1\]/);
    assert.match(nonClaudeBrief, /th_coord_1/);
    assert.match(nonClaudeBrief, /t3_thread_send/);
    assert.match(nonClaudeBrief, /\[T3O_SIGNAL_V1\]/);
    assert.match(nonClaudeBrief, /clientRequestId/);
    assert.match(nonClaudeBrief, /Never push to main/);

    const claudeBrief = buildWorkerBrief({
      projectName: "demo",
      coordinatorThreadId: "th_coord_1",
      taskTitle: "Inspect auth logs",
      brief: "Read auth middleware.",
      isClaudeWorker: true,
    });
    assert.match(claudeBrief, /Do NOT send a duplicate/i);
  });
});
