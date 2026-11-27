import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROLE_MARKER = "[T3O_T3_COORDINATOR_REMINDER_V1]";
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/g;
const DEFAULT_CLI_TIMEOUT_MS = 800;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizeInline(value, maxLen = 128) {
  if (typeof value !== "string") return "";
  return value.replace(CONTROL_CHARS_RE, " ").replace(/\s+/g, " ").trim().slice(0, maxLen);
}

function deriveSlug(cwd) {
  if (typeof cwd !== "string" || !cwd.trim()) return "";
  return path.basename(cwd).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

function readJsonOptional(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function resolveT3Project(config, routing, { projectName, cwd } = {}) {
  const projects = Array.isArray(config?.projects) ? config.projects : [];
  if (projects.length === 0) return null;

  if (projectName) {
    return projects.find((p) => p && p.name === projectName && p.coordinatorThreadId && p.projectId) ?? null;
  }

  if (cwd && routing?.projects && typeof routing.projects === "object") {
    const resolvedCwd = path.resolve(cwd);
    for (const [name, entry] of Object.entries(routing.projects)) {
      if (entry?.root && path.resolve(entry.root) === resolvedCwd) {
        const hit = projects.find((p) => p && p.name === name && p.coordinatorThreadId && p.projectId);
        if (hit) return hit;
      }
    }
  }

  const slug = deriveSlug(cwd);
  if (slug) {
    return projects.find((p) => p && p.name === slug && p.coordinatorThreadId && p.projectId) ?? null;
  }
  return null;
}

/**
 * Renders a fail-closed UserPromptSubmit reminder for T3 Code Codex Coordinators.
 * Returns null for subagents, non-UserPromptSubmit events, or unregistered projects.
 */
export function renderT3Context(hookInput, config, routing = null, options = {}) {
  if (!isPlainObject(hookInput) || hookInput.hook_event_name !== "UserPromptSubmit") {
    return null;
  }
  if (hookInput.agent_id || hookInput.is_subagent || hookInput.subagent || hookInput.internal) {
    return null;
  }

  const project = resolveT3Project(config, routing, {
    projectName: options.projectName ?? null,
    cwd: typeof hookInput.cwd === "string" ? hookInput.cwd : null,
  });
  if (!project) {
    return null;
  }

  const name = sanitizeInline(project.name, 64);
  const projectId = sanitizeInline(project.projectId, 128);
  const coordId = sanitizeInline(project.coordinatorThreadId, 160);
  if (!name || !projectId || !coordId) return null;

  const lines = [
    `${ROLE_MARKER} Project "${name}" has T3 Code coordinator thread ${coordId} (projectId=${projectId}).`,
    `- First verify your threadId via t3_thread_configure matches ${coordId}. If it does NOT match (manual chat or worker thread), IGNORE this reminder completely.`,
    `- If it MATCHES: you are the T3 Code Coordinator. Do NOT explore code, run tests, edit files, or spawn Codex native subagents (spawn_agent / invoke_subagent).`,
    `- Delegate EVERY technical task via: t3o-codex t3-brief --project "${name}" --coordinator "${coordId}" --title "<title>" --brief "<brief>" --tier <simple|standard|complex> --json, then call t3-code.t3_thread_launch (projectId="${projectId}") with the returned modelSelection and brief.`,
    `- NEVER fall back to standalone t3o_codex.* tools. Read worker evidence via t3_thread_read when [T3O_SIGNAL_V1] arrives.`,
  ];

  const tiers = routing?.projects?.[name]?.tiers;
  if (tiers && typeof tiers === "object") {
    const summary = ["simple", "standard", "complex"]
      .filter((t) => tiers[t]?.instanceId && tiers[t]?.model)
      .map((t) => `${t}=${tiers[t].instanceId}:${tiers[t].model} (${tiers[t].effort ?? "default"})`)
      .join(", ");
    if (summary) {
      lines.push(`- Configured T3 tiers: ${summary}.`);
    }
  }

  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: lines.join("\n"),
    },
  };
}

function readStreamBounded(stream, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let data = "";
    const effectiveTimeout = Math.min(Math.max(20, timeoutMs), 950);

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      resolve(value);
    };

    const onData = (chunk) => {
      data += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (Buffer.byteLength(data, "utf8") > 256 * 1024) finish("");
    };
    const onEnd = () => finish(data);
    const onError = () => finish("");

    const timer = setTimeout(() => finish(""), effectiveTimeout);
    stream.setEncoding("utf8");
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
  });
}

function parseCliArgs(argv) {
  let projectName = null;
  let configPath = path.join(os.homedir(), ".t3-orchestration", "config.json");
  let routingPath = path.join(os.homedir(), ".t3-orchestration", "t3-routing.json");
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--project" && argv[i + 1]) projectName = argv[++i];
    else if (argv[i] === "--config" && argv[i + 1]) configPath = path.resolve(argv[++i]);
    else if (argv[i] === "--routing" && argv[i + 1]) routingPath = path.resolve(argv[++i]);
  }
  return { projectName, configPath, routingPath };
}

async function runCli() {
  try {
    const opts = parseCliArgs(process.argv.slice(2));
    const raw = await readStreamBounded(process.stdin, DEFAULT_CLI_TIMEOUT_MS);
    if (!raw || !raw.trim()) return;
    let hookInput;
    try {
      hookInput = JSON.parse(raw);
    } catch {
      return;
    }
    const config = readJsonOptional(opts.configPath);
    if (!config) return;
    const routing = readJsonOptional(opts.routingPath);
    const output = renderT3Context(hookInput, config, routing, { projectName: opts.projectName });
    if (output) {
      process.stdout.write(`${JSON.stringify(output)}\n`);
    }
  } catch {
    // Fail open: never block user prompts.
  }
}

const isEntrypoint =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntrypoint) {
  runCli();
}
