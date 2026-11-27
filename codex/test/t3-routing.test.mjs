import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  getProjectRouting,
  loadT3Routing,
  parseTierAssignment,
  setProjectTierRoute,
} from "../src/t3-routing.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "t3o-routing-"));
}

describe("t3-routing", () => {
  it("returns empty version 1 structure when routing file does not exist", () => {
    const dir = makeTempDir();
    const data = loadT3Routing(path.join(dir, "t3-routing.json"));
    assert.deepEqual(data, { version: 1, projects: {} });
  });

  it("parses tier assignments and defaults effort when omitted", () => {
    assert.deepEqual(parseTierAssignment("simple=antigravity:gemini-3.8-flash-low:low"), {
      tier: "simple",
      instanceId: "antigravity",
      model: "gemini-3.8-flash-low",
      effort: "low",
    });

    assert.deepEqual(parseTierAssignment("complex=codex:gpt-6.1-sol"), {
      tier: "complex",
      instanceId: "codex",
      model: "gpt-6.1-sol",
      effort: "high",
    });

    assert.throws(() => parseTierAssignment("complex=codex:gpt-6.1-sol:max"), /effort/i);
    assert.throws(() => parseTierAssignment("ultra=codex:gpt-6.1-sol:low"), /tier/i);
    assert.throws(() => parseTierAssignment("bad-format"), /Invalid --set/i);
  });

  it("persists project tier routes atomically with 0600 permissions and preserves other projects", () => {
    const dir = makeTempDir();
    const routingPath = path.join(dir, "t3-routing.json");

    setProjectTierRoute({
      routingPath,
      projectName: "app-one",
      tier: "simple",
      instanceId: "antigravity",
      model: "gemini-3.8-flash-low",
      effort: "low",
      root: "/tmp/app-one",
    });

    setProjectTierRoute({
      routingPath,
      projectName: "app-two",
      tier: "complex",
      instanceId: "codex",
      model: "gpt-6.1-sol",
      effort: "high",
    });

    const stat = fs.statSync(routingPath);
    assert.equal(stat.mode & 0o777, 0o600);

    const one = getProjectRouting(routingPath, "app-one");
    const two = getProjectRouting(routingPath, "app-two");
    assert.equal(one.tiers.simple.instanceId, "antigravity");
    assert.equal(one.tiers.simple.model, "gemini-3.8-flash-low");
    assert.equal(two.tiers.complex.instanceId, "codex");
    assert.equal(two.tiers.complex.effort, "high");
  });

  it("rejects unsafe project slugs and disallowed efforts", () => {
    const dir = makeTempDir();
    const routingPath = path.join(dir, "t3-routing.json");
    assert.throws(
      () =>
        setProjectTierRoute({
          routingPath,
          projectName: "../escape",
          tier: "simple",
          instanceId: "codex",
          model: "gpt-6-luna",
          effort: "low",
        }),
      /project/i,
    );
    assert.throws(
      () =>
        setProjectTierRoute({
          routingPath,
          projectName: "demo",
          tier: "complex",
          instanceId: "codex",
          model: "gpt-6.1-sol",
          effort: "max",
        }),
      /effort/i,
    );
  });
});
