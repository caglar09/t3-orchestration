import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_PLUGIN_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);

const DEFAULT_CONFIG_PATH = path.join(
  os.homedir(),
  '.t3-orchestration',
  'codex',
  'config.json'
);

/**
 * Execute an external binary using an explicit argument array without a shell.
 */
async function defaultExec(cmd, args = [], options = {}) {
  try {
    const result = await execFileAsync(cmd, args, {
      ...options,
      shell: false,
      encoding: 'utf8',
      timeout: options.timeout ?? 5000,
    });
    return {
      exitCode: 0,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  } catch (err) {
    if (err && typeof err.code === 'number') {
      return {
        exitCode: err.code,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? err.message ?? '',
      };
    }
    throw err;
  }
}

function parseMajorMinor(raw, pattern) {
  if (typeof raw !== 'string') return null;
  const match = raw.trim().match(pattern);
  if (!match) return null;
  return {
    major: Number.parseInt(match[1], 10),
    minor: match[2] !== undefined ? Number.parseInt(match[2], 10) : 0,
    raw: raw.trim(),
  };
}

function detectMemoryEnabled(configPath) {
  if (!configPath || !fs.existsSync(configPath)) {
    return false;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return (
      Array.isArray(parsed?.projects) &&
      parsed.projects.some((project) => project?.memoryEnabled === true)
    );
  } catch {
    return false;
  }
}

function readJsonFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(content);
}

function checkManifest(pluginDir) {
  const rootPortablePlugin = path.join(pluginDir, 'plugin.json');
  if (fs.existsSync(rootPortablePlugin)) {
    return {
      name: 'manifest',
      ok: false,
      message: 'Root plugin.json must not exist alongside native .codex-plugin/plugin.json.',
    };
  }

  const pluginJsonPath = path.join(pluginDir, '.codex-plugin', 'plugin.json');
  const mcpJsonPath = path.join(pluginDir, '.mcp.json');
  const hooksJsonPath = path.join(pluginDir, 'hooks', 'hooks.json');

  for (const requiredPath of [pluginJsonPath, mcpJsonPath, hooksJsonPath]) {
    if (!fs.existsSync(requiredPath)) {
      return {
        name: 'manifest',
        ok: false,
        message: `Missing required manifest file: ${requiredPath}`,
      };
    }
  }

  let pluginJson;
  let mcpJson;
  let hooksJson;
  try {
    pluginJson = readJsonFile(pluginJsonPath);
    mcpJson = readJsonFile(mcpJsonPath);
    hooksJson = readJsonFile(hooksJsonPath);
  } catch (err) {
    return {
      name: 'manifest',
      ok: false,
      message: `Invalid manifest JSON: ${err.message}`,
    };
  }

  if (pluginJson.name !== 't3-orchestration-codex') {
    return {
      name: 'manifest',
      ok: false,
      message: 'plugin.json name must be t3-orchestration-codex.',
    };
  }
  if (pluginJson.mcpServers !== './.mcp.json') {
    return {
      name: 'manifest',
      ok: false,
      message: 'plugin.json mcpServers must point to ./.mcp.json.',
    };
  }
  if (pluginJson.hooks !== './hooks/hooks.json') {
    return {
      name: 'manifest',
      ok: false,
      message: 'plugin.json hooks must point to ./hooks/hooks.json.',
    };
  }

  const server = mcpJson?.mcpServers?.t3o_codex;
  if (!server || typeof server.command !== 'string' || !server.command) {
    return {
      name: 'manifest',
      ok: false,
      message: '.mcp.json must define mcpServers.t3o_codex with a relative command.',
    };
  }
  if (path.isAbsolute(server.command)) {
    return {
      name: 'manifest',
      ok: false,
      message: '.mcp.json command must be relative (absolute paths are rejected by Codex).',
    };
  }
  if (!Array.isArray(server.args) || server.args[0] !== 'src/mcp.mjs') {
    return {
      name: 'manifest',
      ok: false,
      message: '.mcp.json args must invoke relative src/mcp.mjs.',
    };
  }

  const hooks = hooksJson?.hooks;
  if (!hooks || !Array.isArray(hooks.UserPromptSubmit) || hooks.UserPromptSubmit.length === 0) {
    return {
      name: 'manifest',
      ok: false,
      message: 'hooks/hooks.json must define UserPromptSubmit.',
    };
  }
  if (hooks.Stop !== undefined) {
    return {
      name: 'manifest',
      ok: false,
      message: 'hooks/hooks.json must not define a Stop hook.',
    };
  }

  const serializedHooks = JSON.stringify(hooks);
  if (serializedHooks.includes('register.mjs') || serializedHooks.includes('../hooks')) {
    return {
      name: 'manifest',
      ok: false,
      message: 'hooks/hooks.json must not reference Claude/T3 hooks.',
    };
  }

  const promptHandlers = hooks.UserPromptSubmit.flatMap((entry) => entry?.hooks ?? []);
  const validContextHook = promptHandlers.some(
    (h) =>
      h?.type === 'command' &&
      h?.command === 'node hooks/context.mjs' &&
      typeof h?.timeout === 'number' &&
      h.timeout > 0 &&
      h.timeout <= 5
  );
  if (!validContextHook) {
    return {
      name: 'manifest',
      ok: false,
      message: 'UserPromptSubmit must run "node hooks/context.mjs" with bounded timeout (<=5s).',
    };
  }

  return {
    name: 'manifest',
    ok: true,
    message: 'Native Codex plugin manifest, MCP config, and hooks validated.',
  };
}

/**
 * Run non-destructive local environment and manifest diagnostics for the Codex plugin.
 * Never prompts for input, reads credentials, or mutates global Codex configuration.
 */
export async function doctor({
  exec = defaultExec,
  platform = process.platform,
  configPath = DEFAULT_CONFIG_PATH,
  pluginDir = DEFAULT_PLUGIN_DIR,
  checkMemory,
  nodeVersion = process.version,
  hookTrusted,
} = {}) {
  const checks = [];

  checks.push({
    name: 'platform',
    ok: platform === 'darwin',
    message:
      platform === 'darwin'
        ? 'Platform darwin (macOS) supported.'
        : `Unsupported platform "${platform}" for V1 (macOS darwin required).`,
  });

  const parsedNode = parseMajorMinor(nodeVersion, /^v?(\d+)(?:\.(\d+))?/);
  const nodeOk = parsedNode !== null && parsedNode.major >= 22;
  checks.push({
    name: 'node',
    ok: nodeOk,
    version: parsedNode?.raw ?? String(nodeVersion),
    message: nodeOk
      ? `Node.js ${parsedNode.raw} satisfies >=22.`
      : `Node.js >=22 is required (found "${nodeVersion}").`,
  });

  try {
    const codexRes = await exec('codex', ['--version'], { shell: false });
    const codexOut = (codexRes?.stdout ?? '').trim();
    const codexOk = codexRes?.exitCode === 0 && codexOut.length > 0;
    checks.push({
      name: 'codex',
      ok: codexOk,
      version: codexOut || null,
      message: codexOk
        ? `Codex CLI detected: ${codexOut}`
        : `Codex CLI check failed (exit ${codexRes?.exitCode ?? 'unknown'}).`,
    });
  } catch (err) {
    checks.push({
      name: 'codex',
      ok: false,
      version: null,
      message: `Codex CLI unavailable: ${err?.message ?? 'execution failed'}`,
    });
  }

  const memoryEnabled =
    typeof checkMemory === 'boolean' ? checkMemory : detectMemoryEnabled(configPath);

  if (!memoryEnabled) {
    checks.push({
      name: 'python',
      ok: true,
      status: 'skipped',
      message: 'Memory disabled; Python check skipped.',
    });
  } else {
    try {
      const pyRes = await exec('python3', ['--version'], { shell: false });
      const pyOut = `${pyRes?.stdout ?? ''} ${pyRes?.stderr ?? ''}`.trim();
      const parsedPy = parseMajorMinor(pyOut, /Python\s+(\d+)\.(\d+)/i);
      const pyOk =
        pyRes?.exitCode === 0 &&
        parsedPy !== null &&
        (parsedPy.major > 3 || (parsedPy.major === 3 && parsedPy.minor >= 9));
      checks.push({
        name: 'python',
        ok: pyOk,
        version: pyOut || null,
        message: pyOk
          ? `Python ${pyOut} satisfies >=3.9 for memory.`
          : `Python >=3.9 is required when memory is enabled (found "${pyOut || 'none'}").`,
      });
    } catch (err) {
      checks.push({
        name: 'python',
        ok: false,
        version: null,
        message: `Python unavailable while memory is enabled: ${err?.message ?? 'execution failed'}`,
      });
    }
  }

  checks.push(checkManifest(pluginDir));

  const trusted = hookTrusted === true;
  checks.push({
    name: 'hook_trust',
    ok: true,
    status: trusted ? 'trusted' : 'untrusted',
    message: trusted
      ? 'Plugin hooks confirmed trusted.'
      : 'Plugin hooks are untrusted or unverified; review and trust hooks manually in Codex Settings > Hooks or CLI /hooks.',
    checklist: trusted
      ? []
      : [
          'Open Codex Settings > Hooks or run /hooks in Codex CLI',
          'Review and explicitly trust UserPromptSubmit ("node hooks/context.mjs") for this plugin',
          'Verify global ~/.codex configuration was not modified automatically',
        ],
  });

  return {
    ok: checks.every((check) => check.ok === true),
    checks,
  };
}

const isCli =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isCli) {
  const result = await doctor();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
