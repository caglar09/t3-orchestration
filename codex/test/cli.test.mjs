import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { loadConfig } from "../src/config.mjs";
import {
  getProjectStatus,
  initProject,
  runCli,
  uninstallProject,
  updateProject,
} from "../src/cli.mjs";

const tempDirs = [];

function makeTempDir(prefix = "t3o-cli-") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function makeFakeGitRepo(parent, name = "my-app") {
  const dir = path.join(parent, name);
  fs.mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("initProject initializes .codex config/hooks, .git/info/exclude, and registers project atomically", () => {
  const base = makeTempDir();
  const repo = makeFakeGitRepo(base, "Demo App");
  const configPath = path.join(base, "codex-home", "config.json");
  const pluginRoot = path.join(base, "plugin root");
  fs.mkdirSync(pluginRoot, { recursive: true });

  const result = initProject({
    targetDir: repo,
    configPath,
    pluginRoot,
    nodeExec: "/usr/local/bin/node",
  });

  assert.equal(result.project.name, "demo-app");
  assert.equal(result.project.root, repo);
  assert.equal(result.project.maxWorkers, 2);
  assert.equal(result.project.allowWrite, false);
  assert.equal(result.project.memoryEnabled, false);
  assert.match(result.project.coordinatorSessionId, /^coord-demo-app-/);
  assert.equal(result.gitExcludeUpdated, true);

  const cfg = loadConfig(configPath);
  assert.equal(cfg.projects.length, 1);
  assert.equal(cfg.projects[0].id, result.project.id);

  const toml = fs.readFileSync(path.join(repo, ".codex", "config.toml"), "utf8");
  assert.match(toml, /# BEGIN t3-orchestration-codex/);
  assert.match(toml, /\[mcp_servers\.t3o_codex\]/);
  assert.match(toml, /T3O_CODEX_HOST_SESSION_ID = "coord-demo-app-/);
  assert.equal(toml.includes("T3O_CODEX_ALLOW_WRITE"), false);
  assert.ok(toml.includes(JSON.stringify(path.join(pluginRoot, "src", "mcp.mjs"))));

  const hooks = JSON.parse(fs.readFileSync(path.join(repo, ".codex", "hooks.json"), "utf8"));
  assert.equal(hooks.hooks.UserPromptSubmit.length, 1);
  const hookCmd = hooks.hooks.UserPromptSubmit[0].hooks[0].command;
  assert.ok(hookCmd.includes("'/usr/local/bin/node'") || hookCmd.includes("/usr/local/bin/node"));
  assert.ok(hookCmd.includes(`'${path.join(pluginRoot, "hooks", "context.mjs")}'`));

  const exclude = fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8");
  assert.match(exclude, /^\.codex\/$/m);
  // .gitignore must not be created or modified
  assert.equal(fs.existsSync(path.join(repo, ".gitignore")), false);

  // Duplicate init rejects cleanly and suggests update
  assert.throws(
    () => initProject({ targetDir: repo, configPath, pluginRoot, nodeExec: "/usr/local/bin/node" }),
    /already registered.*update/i,
  );
});

test("initProject and updateProject preserve unrelated .codex/config.toml and .codex/hooks.json entries", () => {
  const base = makeTempDir();
  const repo = makeFakeGitRepo(base, "preserve-app");
  const configPath = path.join(base, "codex-home", "config.json");
  const pluginRootV1 = path.join(base, "plugin-v1");
  const pluginRootV2 = path.join(base, "plugin-v2");
  fs.mkdirSync(pluginRootV1, { recursive: true });
  fs.mkdirSync(pluginRootV2, { recursive: true });

  fs.mkdirSync(path.join(repo, ".codex"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, ".codex", "config.toml"),
    '[mcp_servers.other_tool]\ncommand = "python3"\nargs = ["other.py"]\n',
    "utf8",
  );
  fs.writeFileSync(
    path.join(repo, ".codex", "hooks.json"),
    `${JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo custom-prompt", timeout: 2 }] }],
        Stop: [{ hooks: [{ type: "command", command: "echo custom-stop", timeout: 2 }] }],
      },
    }, null, 2)}\n`,
    "utf8",
  );

  const initRes = initProject({
    targetDir: repo,
    name: "preserve-app",
    configPath,
    pluginRoot: pluginRootV1,
    nodeExec: "/opt/node-v1",
  });

  const updRes = updateProject({
    targetDir: repo,
    configPath,
    pluginRoot: pluginRootV2,
    nodeExec: "/opt/node-v2",
    allowWrite: true,
    maxWorkers: 3,
    memoryEnabled: true,
  });

  // Identity preserved across update
  assert.equal(updRes.project.id, initRes.project.id);
  assert.equal(updRes.project.coordinatorSessionId, initRes.project.coordinatorSessionId);
  assert.equal(updRes.project.allowWrite, true);
  assert.equal(updRes.project.maxWorkers, 3);
  assert.equal(updRes.project.memoryEnabled, true);
  assert.ok(updRes.project.libraryPath);

  const toml = fs.readFileSync(path.join(repo, ".codex", "config.toml"), "utf8");
  assert.match(toml, /\[mcp_servers\.other_tool\]/);
  assert.ok(toml.includes("/opt/node-v2"));
  assert.ok(toml.includes(path.join(pluginRootV2, "src", "mcp.mjs")));
  assert.equal(toml.includes(pluginRootV1), false);
  assert.match(toml, /T3O_CODEX_ALLOW_WRITE = "true"/);

  const hooks = JSON.parse(fs.readFileSync(path.join(repo, ".codex", "hooks.json"), "utf8"));
  assert.equal(hooks.hooks.Stop.length, 1);
  assert.equal(hooks.hooks.UserPromptSubmit.length, 2);
  const allCommands = hooks.hooks.UserPromptSubmit.flatMap((entry) => entry.hooks.map((h) => h.command));
  assert.ok(allCommands.includes("echo custom-prompt"));
  assert.equal(allCommands.filter((c) => c.includes("hooks/context.mjs")).length, 1);
  assert.ok(allCommands.some((c) => c.includes(path.join(pluginRootV2, "hooks", "context.mjs"))));
});

test("fails closed on symlink root, malformed hooks.json, and update on unregistered project", () => {
  const base = makeTempDir();
  const realRepo = makeFakeGitRepo(base, "real-repo");
  const symRepo = path.join(base, "sym-repo");
  fs.symlinkSync(realRepo, symRepo);
  const configPath = path.join(base, "codex-home", "config.json");

  assert.throws(() => initProject({ targetDir: symRepo, configPath }), /symlink/i);
  assert.throws(() => updateProject({ targetDir: realRepo, configPath }), /not registered.*init/i);

  fs.mkdirSync(path.join(realRepo, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(realRepo, ".codex", "hooks.json"), "{broken json", "utf8");
  assert.throws(() => initProject({ targetDir: realRepo, configPath }), /malformed|invalid/i);
  // Config must remain clean (fail closed before persisting)
  assert.equal(loadConfig(configPath).projects.length, 0);
});

test("status reports integration health and uninstall strips only t3o_codex entries while preserving project state", () => {
  const base = makeTempDir();
  const repo = makeFakeGitRepo(base, "clean-app");
  const configPath = path.join(base, "codex-home", "config.json");
  const pluginRoot = path.join(base, "plugin");
  fs.mkdirSync(pluginRoot, { recursive: true });

  fs.mkdirSync(path.join(repo, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".codex", "config.toml"), '[mcp_servers.keep_me]\ncommand = "echo"\n', "utf8");

  const initRes = initProject({
    targetDir: repo,
    configPath,
    pluginRoot,
    nodeExec: "/usr/local/bin/node",
  });

  // Create fake user state under ~/.t3-orchestration/codex/projects/<id>/
  const projectState = path.join(path.dirname(configPath), "projects", initRes.project.id);
  fs.mkdirSync(projectState, { recursive: true });
  fs.writeFileSync(path.join(projectState, "state.json"), '{"keep":true}', "utf8");

  const statusBefore = getProjectStatus({ targetDir: repo, configPath });
  assert.equal(statusBefore.registered, true);
  assert.equal(statusBefore.mcpConfigured, true);
  assert.equal(statusBefore.hookConfigured, true);
  assert.equal(statusBefore.gitExcluded, true);

  const removed = uninstallProject({ targetDir: repo, configPath });
  assert.equal(removed.removedFromConfig, true);
  assert.equal(removed.statePreserved, true);
  assert.equal(loadConfig(configPath).projects.length, 0);

  // User state directory preserved!
  assert.equal(fs.existsSync(path.join(projectState, "state.json")), true);

  // Other MCP server preserved, t3o_codex removed
  const tomlAfter = fs.readFileSync(path.join(repo, ".codex", "config.toml"), "utf8");
  assert.match(tomlAfter, /\[mcp_servers\.keep_me\]/);
  assert.equal(tomlAfter.includes("t3o_codex"), false);

  // hooks.json had only t3o_codex hook -> cleaned up
  assert.equal(fs.existsSync(path.join(repo, ".codex", "hooks.json")), false);
});

test("runCli dispatches init, status, update, uninstall, and --help cleanly", async () => {
  const base = makeTempDir();
  const repo = makeFakeGitRepo(base, "cli-dispatch");
  const configPath = path.join(base, "codex-home", "config.json");

  const capture = () => {
    let out = "";
    let err = "";
    return {
      stdout: (s) => { out += s; },
      stderr: (s) => { err += s; },
      get out() { return out; },
      get err() { return err; },
    };
  };

  const helpIo = capture();
  assert.equal(await runCli(["--help"], helpIo), 0);
  assert.match(helpIo.out, /t3o-codex/);

  const initIo = capture();
  assert.equal(await runCli(["init", repo, "--config", configPath, "--json"], initIo), 0);
  const initJson = JSON.parse(initIo.out);
  assert.equal(initJson.project.name, "cli-dispatch");

  const updIo = capture();
  assert.equal(await runCli(["update", repo, "--config", configPath, "--allow-write", "--json"], updIo), 0);
  assert.equal(JSON.parse(updIo.out).project.allowWrite, true);

  const statusIo = capture();
  assert.equal(await runCli(["status", repo, "--config", configPath, "--json"], statusIo), 0);
  assert.equal(JSON.parse(statusIo.out).registered, true);

  const uninstIo = capture();
  assert.equal(await runCli(["uninstall", repo, "--config", configPath, "--json"], uninstIo), 0);
  assert.equal(JSON.parse(uninstIo.out).removedFromConfig, true);
});
