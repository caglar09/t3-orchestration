import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { doctor } from '../scripts/doctor.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const CODEX_DIR = path.resolve(TEST_DIR, '..');
const REPO_ROOT = path.resolve(CODEX_DIR, '..');

function makeHealthyExec({ codexVersion = 'codex-cli 0.172.0', pythonVersion = 'Python 3.12.0' } = {}) {
  const calls = [];
  const exec = async (cmd, args, options) => {
    calls.push({ cmd, args, options });
    if (cmd === 'codex' && args?.[0] === '--version') {
      return { exitCode: 0, stdout: `${codexVersion}\n`, stderr: '' };
    }
    if (cmd === 'python3' && args?.[0] === '--version') {
      return { exitCode: 0, stdout: `${pythonVersion}\n`, stderr: '' };
    }
    return { exitCode: 1, stdout: '', stderr: `unexpected command: ${cmd}` };
  };
  return { exec, calls };
}

test('missing codex is reported', async () => {
  const exec = async (cmd) => {
    if (cmd === 'codex') {
      const err = new Error('spawn codex ENOENT');
      err.code = 'ENOENT';
      throw err;
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };

  const result = await doctor({
    exec,
    platform: 'darwin',
    nodeVersion: 'v22.14.0',
    pluginDir: CODEX_DIR,
    checkMemory: false,
  });

  assert.equal(result.ok, false);
  const codexCheck = result.checks.find((c) => c.name === 'codex');
  assert.ok(codexCheck, 'codex check should be present');
  assert.equal(codexCheck.ok, false);
  assert.match(codexCheck.message, /codex/i);
});

test('unsupported runtime is reported', async () => {
  const { exec } = makeHealthyExec();

  const oldNodeResult = await doctor({
    exec,
    platform: 'darwin',
    nodeVersion: 'v20.11.0',
    pluginDir: CODEX_DIR,
    checkMemory: false,
  });

  assert.equal(oldNodeResult.ok, false);
  const nodeCheck = oldNodeResult.checks.find((c) => c.name === 'node');
  assert.ok(nodeCheck, 'node check should be present');
  assert.equal(nodeCheck.ok, false);
  assert.match(nodeCheck.message, /22/);

  const missingPythonResult = await doctor({
    exec: async (cmd, args) => {
      if (cmd === 'codex') {
        return { exitCode: 0, stdout: 'codex-cli 0.172.0\n', stderr: '' };
      }
      if (cmd === 'python3') {
        const err = new Error('spawn python3 ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return { exitCode: 1, stdout: '', stderr: '' };
    },
    platform: 'darwin',
    nodeVersion: 'v22.14.0',
    pluginDir: CODEX_DIR,
    checkMemory: true,
  });

  assert.equal(missingPythonResult.ok, false);
  const pythonCheck = missingPythonResult.checks.find((c) => c.name === 'python');
  assert.ok(pythonCheck, 'python check should be present when memory is enabled');
  assert.equal(pythonCheck.ok, false);
});

test('manifest selects only codex hooks', async () => {
  const rootHooksJson = fs.readFileSync(path.join(REPO_ROOT, 'hooks', 'hooks.json'), 'utf8');
  assert.equal(
    JSON.stringify(JSON.parse(rootHooksJson)),
    JSON.stringify({ modules: ['./register.mjs'] }),
    'original Claude hooks/hooks.json must remain untouched'
  );
  assert.ok(
    fs.existsSync(path.join(REPO_ROOT, 'hooks', 'register.mjs')),
    'original hooks/register.mjs must remain present'
  );

  const { exec } = makeHealthyExec();
  const result = await doctor({
    exec,
    platform: 'darwin',
    nodeVersion: 'v22.14.0',
    pluginDir: CODEX_DIR,
    checkMemory: false,
  });

  const manifestCheck = result.checks.find((c) => c.name === 'manifest');
  assert.ok(manifestCheck, 'manifest check should be present');
  assert.equal(manifestCheck.ok, true, manifestCheck.message);

  assert.equal(
    fs.existsSync(path.join(CODEX_DIR, 'plugin.json')),
    false,
    'codex/plugin.json must not be mixed with native codex/.codex-plugin/plugin.json'
  );

  const pluginJson = JSON.parse(
    fs.readFileSync(path.join(CODEX_DIR, '.codex-plugin', 'plugin.json'), 'utf8')
  );
  assert.equal(pluginJson.hooks, './hooks/hooks.json');
  assert.equal(pluginJson.mcpServers, './.mcp.json');

  const mcpJson = JSON.parse(fs.readFileSync(path.join(CODEX_DIR, '.mcp.json'), 'utf8'));
  assert.equal(mcpJson.mcpServers.t3o_codex.command, 'node');
  assert.deepEqual(mcpJson.mcpServers.t3o_codex.args, ['src/mcp.mjs']);

  const codexHooks = JSON.parse(fs.readFileSync(path.join(CODEX_DIR, 'hooks', 'hooks.json'), 'utf8'));
  assert.ok(codexHooks.hooks.UserPromptSubmit, 'UserPromptSubmit hook must exist');
  assert.equal(codexHooks.hooks.Stop, undefined, 'Stop hook must not be configured');
});

test('paths with spaces work', async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 't3o codex space '));
  try {
    const spacedPluginDir = path.join(tmpBase, 'codex plugin');
    const spacedConfigPath = path.join(tmpBase, 'user config', 'config.json');

    fs.mkdirSync(path.join(spacedPluginDir, '.codex-plugin'), { recursive: true });
    fs.mkdirSync(path.join(spacedPluginDir, 'hooks'), { recursive: true });
    fs.mkdirSync(path.dirname(spacedConfigPath), { recursive: true });

    fs.copyFileSync(
      path.join(CODEX_DIR, '.codex-plugin', 'plugin.json'),
      path.join(spacedPluginDir, '.codex-plugin', 'plugin.json')
    );
    fs.copyFileSync(
      path.join(CODEX_DIR, '.mcp.json'),
      path.join(spacedPluginDir, '.mcp.json')
    );
    fs.copyFileSync(
      path.join(CODEX_DIR, 'hooks', 'hooks.json'),
      path.join(spacedPluginDir, 'hooks', 'hooks.json')
    );
    fs.writeFileSync(
      spacedConfigPath,
      JSON.stringify({ version: 1, projects: [{ id: '00000000-0000-4000-8000-000000000001', memoryEnabled: true }] })
    );

    const { exec, calls } = makeHealthyExec();
    const result = await doctor({
      exec,
      platform: 'darwin',
      nodeVersion: 'v22.14.0',
      pluginDir: spacedPluginDir,
      configPath: spacedConfigPath,
    });

    assert.equal(result.ok, true);
    assert.ok(calls.length >= 2);
    for (const call of calls) {
      assert.ok(Array.isArray(call.args), 'exec must receive argv array, never shell string');
      assert.equal(call.options?.shell, false, 'shell must be explicitly disabled');
      assert.equal(typeof call.cmd, 'string');
      assert.equal(call.cmd.includes(' '), false, 'command binary must not contain unsplit args');
    }
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('untrusted hook reported', async () => {
  const { exec } = makeHealthyExec();
  const result = await doctor({
    exec,
    platform: 'darwin',
    nodeVersion: 'v22.14.0',
    pluginDir: CODEX_DIR,
    checkMemory: false,
    hookTrusted: false,
  });

  const trustCheck = result.checks.find((c) => c.name === 'hook_trust');
  assert.ok(trustCheck, 'hook_trust check should be present');
  assert.equal(trustCheck.status, 'untrusted');
  assert.match(trustCheck.message, /trust|hooks/i);
  assert.ok(Array.isArray(trustCheck.checklist) && trustCheck.checklist.length > 0);
});
