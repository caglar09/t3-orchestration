import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ALLOWED_EFFORTS,
  ALLOWED_TIERS,
  DEFAULT_EFFORT_BY_TIER,
} from "./t3-providers.mjs";

export { ALLOWED_EFFORTS, ALLOWED_TIERS };

const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

export function defaultT3RoutingPath() {
  return path.join(os.homedir(), ".t3-orchestration", "t3-routing.json");
}

function assertSafeProjectName(projectName) {
  if (typeof projectName !== "string" || !PROJECT_NAME_RE.test(projectName)) {
    throw new Error(
      `Invalid project name "${projectName}". Expected lowercase slug matching ^[a-z0-9][a-z0-9-]*$ (<= 64 chars).`,
    );
  }
}

function assertSafeToken(value, fieldName) {
  if (typeof value !== "string" || !value.trim() || CONTROL_CHAR_RE.test(value)) {
    throw new Error(`Invalid ${fieldName}: must be a non-empty string without control characters.`);
  }
}

function assertValidTier(tier) {
  if (!ALLOWED_TIERS.includes(tier)) {
    throw new Error(`Invalid tier "${tier}". Expected one of: ${ALLOWED_TIERS.join(", ")}.`);
  }
}

function assertValidEffort(effort) {
  if (!ALLOWED_EFFORTS.includes(effort)) {
    throw new Error(
      `Invalid effort "${effort}". Allowed efforts: ${ALLOWED_EFFORTS.join(", ")} ("max" is disallowed).`,
    );
  }
}

export function parseTierAssignment(spec) {
  if (typeof spec !== "string" || !spec.includes("=")) {
    throw new Error(
      `Invalid --set value "${spec}". Expected format: <simple|standard|complex>=<instanceId>:<model>[:<effort>].`,
    );
  }
  const eqIdx = spec.indexOf("=");
  const tier = spec.slice(0, eqIdx).trim();
  const rhs = spec.slice(eqIdx + 1).trim();
  assertValidTier(tier);

  const parts = rhs.split(":");
  if (parts.length < 2 || parts.length > 3) {
    throw new Error(
      `Invalid --set target "${rhs}". Expected <instanceId>:<model> or <instanceId>:<model>:<effort>.`,
    );
  }
  const instanceId = parts[0].trim();
  const model = parts[1].trim();
  const effort = parts[2] !== undefined ? parts[2].trim() : DEFAULT_EFFORT_BY_TIER[tier];

  assertSafeToken(instanceId, "instanceId");
  assertSafeToken(model, "model");
  assertValidEffort(effort);

  return { tier, instanceId, model, effort };
}

export function loadT3Routing(routingPath = defaultT3RoutingPath()) {
  if (!fs.existsSync(routingPath)) {
    return { version: 1, projects: {} };
  }
  const raw = JSON.parse(fs.readFileSync(routingPath, "utf8"));
  if (!raw || typeof raw !== "object" || raw.version !== 1 || !raw.projects || typeof raw.projects !== "object") {
    throw new Error(`Malformed T3 routing file: ${routingPath}`);
  }
  return raw;
}

export function saveT3RoutingAtomic(routingPath, data) {
  const dir = path.dirname(routingPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = path.join(dir, `.t3-routing.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(tmpPath, 0o600);
  fs.renameSync(tmpPath, routingPath);
  fs.chmodSync(routingPath, 0o600);
}

export function setProjectTierRoute({
  routingPath = defaultT3RoutingPath(),
  projectName,
  tier,
  instanceId,
  model,
  effort,
  root = null,
}) {
  assertSafeProjectName(projectName);
  assertValidTier(tier);
  assertSafeToken(instanceId, "instanceId");
  assertSafeToken(model, "model");
  const resolvedEffort = effort ?? DEFAULT_EFFORT_BY_TIER[tier];
  assertValidEffort(resolvedEffort);

  const data = loadT3Routing(routingPath);
  const existing = data.projects[projectName] ?? { tiers: {} };
  const nextProject = {
    ...(existing.root ? { root: existing.root } : {}),
    ...(root ? { root } : {}),
    tiers: {
      ...(existing.tiers ?? {}),
      [tier]: {
        instanceId: instanceId.trim(),
        model: model.trim(),
        effort: resolvedEffort,
      },
    },
    updatedAt: new Date().toISOString(),
  };

  data.projects[projectName] = nextProject;
  saveT3RoutingAtomic(routingPath, data);
  return nextProject;
}

export function getProjectRouting(routingPath, projectName) {
  if (!projectName) return null;
  const data = loadT3Routing(routingPath);
  return data.projects[projectName] ?? null;
}
