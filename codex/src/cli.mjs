import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bindCoordinator,
  defaultConfigPath,
  loadConfig,
  saveConfigAtomic,
} from "./config.mjs";
import { doctor } from "../scripts/doctor.mjs";
import { createPairingTicket } from "../scripts/pair.mjs";
import {
  buildWorkerBrief,
  readT3Providers,
  selectModelForTask,
} from "./t3-providers.mjs";
import {
  defaultT3RoutingPath,
  getProjectRouting,
  parseTierAssignment,
  setProjectTierRoute,
} from "./t3-routing.mjs";

const BEGIN_MARKER = "# BEGIN t3-orchestration-codex";
const END_MARKER = "# END t3-orchestration-codex";
const HOOK_CONTEXT_SUBSTR = "hooks/context.mjs";
const DEFAULT_PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function deriveSlug(targetDir) {
  const base = path.basename(targetDir).toLowerCase();
  const slug = base
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    return "project";
  }
  return slug;
}

function resolveCanonicalTargetDir(targetDir) {
  const raw = path.resolve(targetDir ?? process.cwd());
  let st;
  try {
    st = fs.lstatSync(raw);
  } catch (err) {
    throw new Error(`Target directory does not exist: ${raw} (${err.message})`);
  }
  if (st.isSymbolicLink()) {
    throw new Error(`Target directory must not be a symlink: ${raw}`);
  }
  const canonical = fs.realpathSync(raw);
  const isDarwinSystemRoot =
    process.platform === "darwin" &&
    (raw.startsWith("/var/") || raw.startsWith("/tmp/")) &&
    canonical === `/private${raw}`;
  if (canonical !== raw && !isDarwinSystemRoot) {
    throw new Error(`Target directory resolves through a symlink: ${raw}`);
  }
  if (!fs.statSync(canonical).isDirectory()) {
    throw new Error(`Target path is not a directory: ${canonical}`);
  }
  return canonical;
}

function renderTomlBlock({ nodeExec, pluginRoot, coordinatorSessionId, allowWrite }) {
  const mcpEntry = path.join(pluginRoot, "src", "mcp.mjs");
  const lines = [
    BEGIN_MARKER,
    "[mcp_servers.t3o_codex]",
    `command = ${JSON.stringify(nodeExec)}`,
    `args = [${JSON.stringify(mcpEntry)}]`,
    "",
    "[mcp_servers.t3o_codex.env]",
    `T3O_CODEX_HOST_SESSION_ID = ${JSON.stringify(coordinatorSessionId)}`,
  ];
  if (allowWrite === true) {
    lines.push('T3O_CODEX_ALLOW_WRITE = "true"');
  }
  lines.push(END_MARKER);
  return `${lines.join("\n")}\n`;
}

function stripManagedTomlBlock(content) {
  const startIdx = content.indexOf(BEGIN_MARKER);
  const endIdx = content.indexOf(END_MARKER);
  if (startIdx !== -1 && endIdx !== -1 && endIdx >= startIdx) {
    const before = content.slice(0, startIdx).replace(/\s+$/, "");
    const after = content.slice(endIdx + END_MARKER.length).replace(/^\s+/, "");
    if (!before && !after) return "";
    if (!before) return `${after}\n`;
    if (!after) return `${before}\n`;
    return `${before}\n\n${after}\n`;
  }
  return content;
}

function mergeTomlFile(tomlPath, block) {
  const existing = fs.existsSync(tomlPath) ? fs.readFileSync(tomlPath, "utf8") : "";
  const stripped = stripManagedTomlBlock(existing).trimEnd();
  const next = stripped.length > 0 ? `${stripped}\n\n${block}` : block;
  fs.mkdirSync(path.dirname(tomlPath), { recursive: true });
  fs.writeFileSync(tomlPath, next, "utf8");
}

function isManagedHookEntry(entry) {
  if (!entry || typeof entry !== "object" || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some(
    (h) => h && typeof h === "object" && typeof h.command === "string" && h.command.includes(HOOK_CONTEXT_SUBSTR),
  );
}

function readExistingHooks(hooksPath) {
  if (!fs.existsSync(hooksPath)) {
    return { hooks: {} };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  } catch (err) {
    throw new Error(`Malformed existing .codex/hooks.json: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid existing .codex/hooks.json: root must be an object");
  }
  if (parsed.hooks !== undefined && (!parsed.hooks || typeof parsed.hooks !== "object" || Array.isArray(parsed.hooks))) {
    throw new Error("Invalid existing .codex/hooks.json: hooks must be an object");
  }
  return { ...parsed, hooks: { ...(parsed.hooks ?? {}) } };
}

function mergeHooksFile(hooksPath, { nodeExec, pluginRoot }) {
  const parsed = readExistingHooks(hooksPath);
  const contextPath = path.join(pluginRoot, "hooks", "context.mjs");
  const command = `${shellQuote(nodeExec)} ${shellQuote(contextPath)}`;
  const managedEntry = {
    hooks: [
      {
        type: "command",
        command,
        timeout: 3,
      },
    ],
  };

  const existingSubmit = Array.isArray(parsed.hooks.UserPromptSubmit)
    ? parsed.hooks.UserPromptSubmit.filter((entry) => !isManagedHookEntry(entry))
    : [];
  parsed.hooks.UserPromptSubmit = [...existingSubmit, managedEntry];

  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  fs.writeFileSync(hooksPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

function removeManagedHooks(hooksPath) {
  if (!fs.existsSync(hooksPath)) return false;
  const parsed = readExistingHooks(hooksPath);
  const existingSubmit = Array.isArray(parsed.hooks.UserPromptSubmit)
    ? parsed.hooks.UserPromptSubmit
    : [];
  const remainingSubmit = existingSubmit.filter((entry) => !isManagedHookEntry(entry));
  const changed = remainingSubmit.length !== existingSubmit.length;
  if (!changed) return false;

  if (remainingSubmit.length > 0) {
    parsed.hooks.UserPromptSubmit = remainingSubmit;
  } else {
    delete parsed.hooks.UserPromptSubmit;
  }

  if (Object.keys(parsed.hooks).length === 0 && Object.keys(parsed).length === 1) {
    fs.unlinkSync(hooksPath);
  } else {
    fs.writeFileSync(hooksPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  }
  return true;
}

function ensureGitExclude(targetRoot) {
  const infoDir = path.join(targetRoot, ".git", "info");
  if (!fs.existsSync(infoDir) || !fs.statSync(infoDir).isDirectory()) {
    return false;
  }
  const excludePath = path.join(infoDir, "exclude");
  const current = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
  const lines = current.split(/\r?\n/);
  if (lines.includes(".codex/")) {
    return false;
  }
  const prefix = current.length > 0 && !current.endsWith("\n") ? `${current}\n` : current;
  fs.writeFileSync(excludePath, `${prefix}.codex/\n`, "utf8");
  return true;
}

function hasGitExclude(targetRoot) {
  const excludePath = path.join(targetRoot, ".git", "info", "exclude");
  if (!fs.existsSync(excludePath)) return false;
  return fs.readFileSync(excludePath, "utf8").split(/\r?\n/).includes(".codex/");
}

export function initProject({
  targetDir = process.cwd(),
  name,
  maxWorkers = 2,
  allowWrite = false,
  memoryEnabled = false,
  libraryPath,
  configPath = defaultConfigPath(),
  pluginRoot = DEFAULT_PLUGIN_ROOT,
  nodeExec = process.execPath,
  excludeGit = true,
} = {}) {
  const canonicalRoot = resolveCanonicalTargetDir(targetDir);
  const codexDir = path.join(canonicalRoot, ".codex");
  const hooksPath = path.join(codexDir, "hooks.json");
  const tomlPath = path.join(codexDir, "config.toml");

  // Validate existing hooks.json BEFORE mutating config.json (fail closed)
  readExistingHooks(hooksPath);

  const existingConfig = loadConfig(configPath);
  const already = existingConfig.projects.find((p) => p.root === canonicalRoot);
  if (already) {
    throw new Error(
      `Project "${already.name}" is already registered for ${canonicalRoot}. Run "t3o-codex update" to refresh it.`,
    );
  }

  const slug = name ?? deriveSlug(canonicalRoot);
  const projectId = randomUUID();
  const coordinatorSessionId = `coord-${slug}-${projectId.slice(0, 8)}`;
  const effectiveLibraryPath = memoryEnabled
    ? (libraryPath ?? path.join(path.dirname(configPath), "projects", projectId, "library"))
    : null;

  const nextConfig = bindCoordinator(
    existingConfig,
    {
      id: projectId,
      name: slug,
      root: canonicalRoot,
      maxWorkers,
      allowWrite,
      memoryEnabled,
      libraryPath: effectiveLibraryPath,
    },
    coordinatorSessionId,
  );

  saveConfigAtomic(configPath, nextConfig);

  const tomlBlock = renderTomlBlock({
    nodeExec,
    pluginRoot,
    coordinatorSessionId,
    allowWrite,
  });
  mergeTomlFile(tomlPath, tomlBlock);
  mergeHooksFile(hooksPath, { nodeExec, pluginRoot });
  const gitExcludeUpdated = excludeGit ? ensureGitExclude(canonicalRoot) : false;

  const project = nextConfig.projects.find((p) => p.id === projectId);
  return {
    action: "init",
    project,
    configPath,
    tomlPath,
    hooksPath,
    gitExcludeUpdated,
  };
}

export function updateProject({
  targetDir = process.cwd(),
  maxWorkers,
  allowWrite,
  memoryEnabled,
  libraryPath,
  configPath = defaultConfigPath(),
  pluginRoot = DEFAULT_PLUGIN_ROOT,
  nodeExec = process.execPath,
  excludeGit = true,
} = {}) {
  const canonicalRoot = resolveCanonicalTargetDir(targetDir);
  const codexDir = path.join(canonicalRoot, ".codex");
  const hooksPath = path.join(codexDir, "hooks.json");
  const tomlPath = path.join(codexDir, "config.toml");

  readExistingHooks(hooksPath);

  const existingConfig = loadConfig(configPath);
  const index = existingConfig.projects.findIndex((p) => p.root === canonicalRoot);
  if (index === -1) {
    throw new Error(
      `Project at ${canonicalRoot} is not registered. Run "t3o-codex init" first.`,
    );
  }

  const current = existingConfig.projects[index];
  const nextMemoryEnabled = memoryEnabled !== undefined ? memoryEnabled : current.memoryEnabled;
  const nextLibraryPath = nextMemoryEnabled
    ? (libraryPath !== undefined
      ? libraryPath
      : (current.libraryPath ?? path.join(path.dirname(configPath), "projects", current.id, "library")))
    : null;

  const updatedEntry = {
    ...current,
    ...(maxWorkers !== undefined ? { maxWorkers } : {}),
    ...(allowWrite !== undefined ? { allowWrite } : {}),
    memoryEnabled: nextMemoryEnabled,
    libraryPath: nextLibraryPath,
  };

  const nextProjects = [...existingConfig.projects];
  nextProjects[index] = updatedEntry;
  const saved = saveConfigAtomic(configPath, {
    version: existingConfig.version,
    projects: nextProjects,
  });

  const savedProject = saved.projects[index];
  const tomlBlock = renderTomlBlock({
    nodeExec,
    pluginRoot,
    coordinatorSessionId: savedProject.coordinatorSessionId,
    allowWrite: savedProject.allowWrite,
  });
  mergeTomlFile(tomlPath, tomlBlock);
  mergeHooksFile(hooksPath, { nodeExec, pluginRoot });
  const gitExcludeUpdated = excludeGit ? ensureGitExclude(canonicalRoot) : false;

  return {
    action: "update",
    project: savedProject,
    configPath,
    tomlPath,
    hooksPath,
    gitExcludeUpdated,
  };
}

export function getProjectStatus({
  targetDir = process.cwd(),
  configPath = defaultConfigPath(),
} = {}) {
  const canonicalRoot = resolveCanonicalTargetDir(targetDir);
  const config = loadConfig(configPath);
  const project = config.projects.find((p) => p.root === canonicalRoot) ?? null;
  const tomlPath = path.join(canonicalRoot, ".codex", "config.toml");
  const hooksPath = path.join(canonicalRoot, ".codex", "hooks.json");

  const mcpConfigured =
    fs.existsSync(tomlPath) &&
    fs.readFileSync(tomlPath, "utf8").includes("[mcp_servers.t3o_codex]");
  let hookConfigured = false;
  if (fs.existsSync(hooksPath)) {
    try {
      const parsed = readExistingHooks(hooksPath);
      hookConfigured =
        Array.isArray(parsed.hooks.UserPromptSubmit) &&
        parsed.hooks.UserPromptSubmit.some(isManagedHookEntry);
    } catch {
      hookConfigured = false;
    }
  }

  return {
    root: canonicalRoot,
    registered: Boolean(project),
    project,
    mcpConfigured,
    hookConfigured,
    gitExcluded: hasGitExclude(canonicalRoot),
    configPath,
  };
}

export function uninstallProject({
  targetDir = process.cwd(),
  configPath = defaultConfigPath(),
} = {}) {
  const canonicalRoot = resolveCanonicalTargetDir(targetDir);
  const config = loadConfig(configPath);
  const remaining = config.projects.filter((p) => p.root !== canonicalRoot);
  const removedFromConfig = remaining.length !== config.projects.length;

  if (removedFromConfig) {
    saveConfigAtomic(configPath, {
      version: config.version,
      projects: remaining,
    });
  }

  const tomlPath = path.join(canonicalRoot, ".codex", "config.toml");
  let mcpRemoved = false;
  if (fs.existsSync(tomlPath)) {
    const existing = fs.readFileSync(tomlPath, "utf8");
    const stripped = stripManagedTomlBlock(existing);
    if (stripped !== existing) {
      mcpRemoved = true;
      if (stripped.trim().length === 0) {
        fs.unlinkSync(tomlPath);
      } else {
        fs.writeFileSync(tomlPath, stripped, "utf8");
      }
    }
  }

  const hooksPath = path.join(canonicalRoot, ".codex", "hooks.json");
  const hookRemoved = removeManagedHooks(hooksPath);

  return {
    action: "uninstall",
    root: canonicalRoot,
    removedFromConfig,
    mcpRemoved,
    hookRemoved,
    statePreserved: true,
  };
}

function parseFlags(args) {
  const positionals = [];
  const flags = {
    json: false,
    excludeGit: true,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") {
      flags.json = true;
    } else if (arg === "--allow-write") {
      flags.allowWrite = true;
    } else if (arg === "--no-allow-write") {
      flags.allowWrite = false;
    } else if (arg === "--memory") {
      flags.memoryEnabled = true;
    } else if (arg === "--no-memory") {
      flags.memoryEnabled = false;
    } else if (arg === "--no-exclude") {
      flags.excludeGit = false;
    } else if (arg === "--name" && args[i + 1]) {
      flags.name = args[++i];
    } else if (arg === "--max-workers" && args[i + 1]) {
      flags.maxWorkers = Number(args[++i]);
    } else if (arg === "--library-path" && args[i + 1]) {
      flags.libraryPath = path.resolve(args[++i]);
    } else if (arg === "--config" && args[i + 1]) {
      flags.configPath = path.resolve(args[++i]);
    } else if (arg === "--plugin-root" && args[i + 1]) {
      flags.pluginRoot = path.resolve(args[++i]);
    } else if (arg === "--project" && args[i + 1]) {
      flags.project = args[++i];
    } else if (arg === "--tier" && args[i + 1]) {
      flags.tier = args[++i];
    } else if (arg === "--driver" && args[i + 1]) {
      flags.driver = args[++i];
    } else if (arg === "--set" && args[i + 1]) {
      flags.set = args[++i];
    } else if (arg === "--settings" && args[i + 1]) {
      flags.settingsPath = path.resolve(args[++i]);
    } else if (arg === "--manifest" && args[i + 1]) {
      flags.manifestPath = path.resolve(args[++i]);
    } else if (arg === "--routing" && args[i + 1]) {
      flags.routingPath = path.resolve(args[++i]);
    } else if (arg === "--coordinator" && args[i + 1]) {
      flags.coordinator = args[++i];
    } else if (arg === "--title" && args[i + 1]) {
      flags.title = args[++i];
    } else if (arg === "--brief" && args[i + 1]) {
      flags.brief = args[++i];
    } else if (arg === "--rules" && args[i + 1]) {
      flags.rules = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, flags };
}

const HELP_TEXT = `t3o-codex — Local Codex App & T3 Code Multi-LLM orchestration CLI

Usage:
  t3o-codex init [dir] [options]       Initialize standalone Codex orchestration in a project
  t3o-codex update [dir] [options]     Update .codex paths and project settings safely
  t3o-codex status [dir] [options]     Inspect project registration and .codex files
  t3o-codex uninstall [dir] [options]  Remove t3o_codex entries (preserves user state)
  t3o-codex doctor                     Run environment & manifest diagnostics
  t3o-codex pair                       Generate a single-use out-of-band pairing code
  t3o-codex t3-providers [options]     List enabled T3 Code LLM providers & models
  t3o-codex t3-route [options]         Select or configure simple/standard/complex T3 LLM routing
  t3o-codex t3-brief [options]         Generate modelSelection + wake-up brief for t3_thread_launch

Options:
  --name <slug>            Project slug (default: derived from directory name)
  --max-workers <1..4>     Maximum parallel workers (default: 2)
  --allow-write            Enable isolated Git worktree writes (default: read-only)
  --no-allow-write         Disable write mode on update
  --memory                 Enable optional sourced long-term memory
  --no-memory              Disable memory on update
  --library-path <path>    Custom canonical memory library directory
  --config <path>          Override ~/.t3-orchestration/codex/config.json
  --no-exclude             Skip adding .codex/ to .git/info/exclude
  --project <slug>         T3 project slug (for t3-route / t3-brief)
  --tier <tier>            Task complexity tier: simple | standard | complex
  --driver <driver>        Preferred T3 provider driver or instanceId
  --set <spec>             Save policy: <tier>=<instanceId>:<model>[:<effort>]
  --coordinator <id>       T3 coordinator threadId (for t3-brief)
  --title <text>           Worker topic title (for t3-brief)
  --brief <text>           Worker task brief (for t3-brief)
  --rules <text>           Optional project rules block (for t3-brief)
  --settings <path>        Override ~/.t3/userdata/settings.json
  --manifest <path>        Override ~/.t3/userdata/model-manifest.json
  --routing <path>         Override ~/.t3-orchestration/t3-routing.json
  --json                   Print machine-readable JSON output
  -h, --help               Show this help
`;

export async function runCli(
  argv,
  io = {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  },
) {
  try {
    const [subcommand, ...rest] = argv;
    if (!subcommand || subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
      io.stdout(HELP_TEXT);
      return 0;
    }

    const { positionals, flags } = parseFlags(rest);
    if (flags.help) {
      io.stdout(HELP_TEXT);
      return 0;
    }

    const targetDir = positionals[0] ?? process.cwd();
    const common = {
      targetDir,
      ...(flags.configPath ? { configPath: flags.configPath } : {}),
      ...(flags.pluginRoot ? { pluginRoot: flags.pluginRoot } : {}),
      excludeGit: flags.excludeGit,
    };

    let result;
    if (subcommand === "init") {
      result = initProject({
        ...common,
        ...(flags.name ? { name: flags.name } : {}),
        ...(flags.maxWorkers !== undefined ? { maxWorkers: flags.maxWorkers } : {}),
        ...(flags.allowWrite !== undefined ? { allowWrite: flags.allowWrite } : {}),
        ...(flags.memoryEnabled !== undefined ? { memoryEnabled: flags.memoryEnabled } : {}),
        ...(flags.libraryPath ? { libraryPath: flags.libraryPath } : {}),
      });
    } else if (subcommand === "update") {
      result = updateProject({
        ...common,
        ...(flags.maxWorkers !== undefined ? { maxWorkers: flags.maxWorkers } : {}),
        ...(flags.allowWrite !== undefined ? { allowWrite: flags.allowWrite } : {}),
        ...(flags.memoryEnabled !== undefined ? { memoryEnabled: flags.memoryEnabled } : {}),
        ...(flags.libraryPath ? { libraryPath: flags.libraryPath } : {}),
      });
    } else if (subcommand === "status") {
      result = getProjectStatus(common);
    } else if (subcommand === "uninstall" || subcommand === "remove") {
      result = uninstallProject(common);
    } else if (subcommand === "doctor") {
      result = await doctor({
        ...(flags.configPath ? { configPath: flags.configPath } : {}),
      });
    } else if (subcommand === "pair") {
      const stateRoot = flags.configPath ? path.dirname(flags.configPath) : undefined;
      result = createPairingTicket(stateRoot ? { stateRoot } : {});
    } else if (subcommand === "t3-providers") {
      result = readT3Providers({
        ...(flags.settingsPath ? { settingsPath: flags.settingsPath } : {}),
        ...(flags.manifestPath ? { manifestPath: flags.manifestPath } : {}),
      });
    } else if (subcommand === "t3-route") {
      const routingPath = flags.routingPath ?? defaultT3RoutingPath();
      if (flags.set) {
        if (!flags.project) {
          throw new Error("--project <slug> is required when using --set.");
        }
        const parsed = parseTierAssignment(flags.set);
        const saved = setProjectTierRoute({
          routingPath,
          projectName: flags.project,
          ...parsed,
        });
        result = { project: flags.project, routingPath, saved };
      } else {
        const { providers } = readT3Providers({
          ...(flags.settingsPath ? { settingsPath: flags.settingsPath } : {}),
          ...(flags.manifestPath ? { manifestPath: flags.manifestPath } : {}),
        });
        const policy = flags.project ? getProjectRouting(routingPath, flags.project) : null;
        result = selectModelForTask({
          providers,
          tier: flags.tier ?? "standard",
          preferredDriver: flags.driver ?? null,
          routingPolicy: policy,
        });
      }
    } else if (subcommand === "t3-brief") {
      const routingPath = flags.routingPath ?? defaultT3RoutingPath();
      const { providers } = readT3Providers({
        ...(flags.settingsPath ? { settingsPath: flags.settingsPath } : {}),
        ...(flags.manifestPath ? { manifestPath: flags.manifestPath } : {}),
      });
      const policy = flags.project ? getProjectRouting(routingPath, flags.project) : null;
      const route = selectModelForTask({
        providers,
        tier: flags.tier ?? "standard",
        preferredDriver: flags.driver ?? null,
        routingPolicy: policy,
      });
      const isClaudeWorker = route.provider.driver === "claudeAgent";
      const briefText = buildWorkerBrief({
        projectName: flags.project,
        coordinatorThreadId: flags.coordinator,
        taskTitle: flags.title ?? "Worker task",
        brief: flags.brief,
        isClaudeWorker,
        routing: route,
        projectRules: flags.rules ?? "",
      });
      result = {
        tier: route.tier,
        source: route.source,
        provider: route.provider,
        isClaudeWorker,
        modelSelection: route.modelSelection,
        brief: briefText,
      };
    } else {
      throw new Error(`Unknown command: ${subcommand}. Run "t3o-codex --help".`);
    }

    if (flags.json || subcommand === "doctor" || subcommand === "pair") {
      io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    } else if (subcommand === "t3-providers") {
      const lines = ["[t3o-codex] Enabled T3 Code LLM providers:"];
      for (const p of result.providers) {
        const models = p.models.length > 0
          ? p.models.map((m) => `${m.slug} [${m.tier}]`).join(", ")
          : "(provider default / no manifest models)";
        lines.push(`  - ${p.instanceId} (driver=${p.driver}, label="${p.label}"): ${models}`);
      }
      io.stdout(`${lines.join("\n")}\n`);
    } else if (subcommand === "t3-route") {
      if (result.saved) {
        io.stdout(`[t3o-codex] Saved routing policy for "${result.project}" in ${result.routingPath}\n`);
      } else {
        io.stdout(
          `[t3o-codex] tier=${result.tier} (${result.source}): instanceId=${result.modelSelection.instanceId}, model=${result.modelSelection.model ?? "default"}, effort=${result.modelSelection.options[0].value}\n` +
          `  reason: ${result.reason}\n`,
        );
      }
    } else if (subcommand === "t3-brief") {
      io.stdout(`${result.brief}\n`);
    } else if (subcommand === "init" || subcommand === "update") {
      io.stdout(
        `[t3o-codex] ${subcommand} complete for "${result.project.name}" (${result.project.root})\n` +
        `  - MCP config: ${result.tomlPath}\n` +
        `  - Hook config: ${result.hooksPath}\n` +
        `  - Mode: ${result.project.allowWrite ? "write-enabled (worktrees)" : "read-only (default)"}, maxWorkers=${result.project.maxWorkers}, memory=${result.project.memoryEnabled}\n` +
        `  - Next: open this project in Codex, trust UserPromptSubmit in /hooks (or Settings > Hooks), and verify /mcp shows t3o_codex.\n`,
      );
    } else if (subcommand === "status") {
      io.stdout(
        `[t3o-codex] status for ${result.root}\n` +
        `  - registered: ${result.registered}${result.project ? ` (${result.project.name}, allowWrite=${result.project.allowWrite}, maxWorkers=${result.project.maxWorkers})` : ""}\n` +
        `  - .codex/config.toml (t3o_codex): ${result.mcpConfigured}\n` +
        `  - .codex/hooks.json (context.mjs): ${result.hookConfigured}\n` +
        `  - .git/info/exclude (.codex/): ${result.gitExcluded}\n`,
      );
    } else if (subcommand === "uninstall" || subcommand === "remove") {
      io.stdout(
        `[t3o-codex] uninstalled from ${result.root} (removedFromConfig=${result.removedFromConfig}, mcpRemoved=${result.mcpRemoved}, hookRemoved=${result.hookRemoved}; ~/.t3-orchestration/codex/projects/ preserved).\n`,
      );
    }
    return 0;
  } catch (err) {
    io.stderr(`t3o-codex error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
