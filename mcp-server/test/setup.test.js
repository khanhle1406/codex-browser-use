import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertRuntime, discoverEngine, validateEngine } from "../src/engine-discovery.js";
import { defaultBridgeFile } from "../src/backend-discovery.js";
import { buildConfig } from "../bin/browser-use.js";

/** @param {string} root @param {string} version @returns {Promise<string>} */
async function fixture(root, version) {
  const dir = path.join(root, version);
  for (const part of ["scripts", "docs", ".codex-plugin"]) await mkdir(path.join(dir, part), { recursive: true });
  await writeFile(path.join(dir, ".codex-plugin/plugin.json"), JSON.stringify({ name: "chrome", version }));
  await writeFile(path.join(dir, "docs/api.json"), JSON.stringify({ interfaces: { Agent: {}, Browser: {}, Tab: {} } }));
  await writeFile(path.join(dir, "scripts/browser-client.mjs"), "throw new Error('must not execute during discovery');");
  await writeFile(path.join(dir, "scripts/browser-service.mjs"), "throw new Error('must not execute during discovery');");
  return dir;
}

test("runtime version gate enforces the REPL handler's minimum Node release", () => {
  for (const version of ["26.12.1", "26.12.2", "26.13.0", "27.0.0", "30.0.0"]) {
    assert.doesNotThrow(() => assertRuntime(version));
  }
  for (const version of ["25.99.99", "26.11.99", "26.12.0"]) {
    assert.throws(() => assertRuntime(version), /requires Node.js 26\.12\.1 or newer/);
  }
  for (const version of ["v26.12.1", "26.12", "26.12.1-rc.1", "garbage"]) {
    assert.throws(() => assertRuntime(version), /Unsupported Node.js version/);
  }
});

test("discovery sorts numeric releases and excludes staging directories", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "browser-setup-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, ".codex/plugins/cache/openai-bundled/chrome");
  await fixture(root, "26.9.1");
  const expected = await fixture(root, "26.10.1");
  await fixture(root, "plugin-install-999");
  await mkdir(path.join(root, "99.99.99"));
  const engine = await discoverEngine({ homeDir: home, env: {} });
  assert.equal(engine.path, await realpath(expected));
  assert.equal(engine.version, "26.10.1");
});

test("explicit engine selection fails closed and honors CODEX_HOME", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "browser-profile-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const profile = path.join(home, "profile");
  const expected = await fixture(path.join(profile, "plugins/cache/openai-bundled/chrome"), "26.11.1");
  assert.equal((await discoverEngine({ homeDir: home, env: { CODEX_HOME: profile } })).path, await realpath(expected));
  await assert.rejects(discoverEngine({ homeDir: home, env: { CODEX_HOME: profile, BROWSER_USE_ENGINE_PATH: path.join(home, "missing") } }), /ENOENT/);
  await assert.rejects(validateEngine("relative"), /absolute/);
  await assert.rejects(discoverEngine({ env: { BROWSER_USE_ENGINE_PATH: "" } }), /empty/);
});

test("validation rejects incomplete manifests", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "browser-invalid-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = await fixture(home, "26.1.1");
  await writeFile(path.join(dir, "docs/api.json"), JSON.stringify({ interfaces: { Agent: {} } }));
  await assert.rejects(validateEngine(dir), /missing Agent, Browser, or Tab/);
});

test("provider configuration uses absolute paths and the OpenCode V2 schema", () => {
  const opts = { nodePath: "/node path/node", serverPath: "/project path/server.js", bridgeFile: "/bridge.json" };
  const generic = buildConfig("generic", opts).mcpServers["browser-use"];
  assert.deepEqual(generic, {
    command: opts.nodePath,
    args: [opts.serverPath],
    env: { BROWSER_USE_BRIDGE_FILE: "/bridge.json" },
  });
  assert.deepEqual(buildConfig("copilot", opts).mcpServers, {
    "browser-use-portable": { ...generic, type: "local", tools: ["*"] },
  });
  assert.deepEqual(buildConfig("antigravity", opts).mcpServers["browser-use"], {
    ...generic,
    tools: { browser_get_state: { eager: true }, browser_end_turn: { eager: true } },
  });
  const opencode = buildConfig("opencode", opts).mcp.servers["browser-use"];
  assert.deepEqual(opencode.command, [opts.nodePath, opts.serverPath]);
  assert.equal(opencode.disabled, false);
  assert.equal("enabled" in opencode, false);
  assert.deepEqual(opencode.environment, generic.env);
  assert.deepEqual(buildConfig("commandcode", opts).mcpServers["browser-use"], {
    transport: "stdio",
    enabled: true,
    command: opts.nodePath,
    args: [opts.serverPath],
    env: { BROWSER_USE_BRIDGE_FILE: "/bridge.json" },
  });
  assert.equal(buildConfig("codex", opts).mcp_servers["browser-use"].command, opts.nodePath);
  assert.throws(() => buildConfig("invented", opts), /Unknown client/);
});

test("CLI config/setup print JSON only and doctor reports missing engine without execution", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "browser-cli-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL("../bin/browser-use.js", import.meta.url));
  for (const command of ["config", "setup"]) {
    const result = spawnSync(process.execPath, [cli, command, "--client", "opencode"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).mcp.servers["browser-use"].environment, {
      BROWSER_USE_BRIDGE_FILE: defaultBridgeFile(),
    });
  }
  const result = spawnSync(process.execPath, [cli, "doctor", "--json", "--engine", path.join(home, "missing")], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).ready, false);
});

test("one workspace setup pins all three providers to the same bridge without overwriting settings", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-setup-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const enginePath = await fixture(root, "26.11.1");
  const cli = fileURLToPath(new URL("../bin/browser-use.js", import.meta.url));
  const workspace = path.join(root, "project");
  const descriptor = path.join(root, "bridge.json");
  const setup = ["setup", "--workspace", workspace, "--bridge", descriptor, "--json"];
  const created = spawnSync(process.execPath, [cli, ...setup], {encoding: "utf8"});
  assert.equal(created.status, 0, created.stderr);
  const files = JSON.parse(created.stdout);
  assert.equal(files.length, 3);
  const contents = await Promise.all(files.map((file) => readFile(file, "utf8")));
  const [copilot, agy, opencode] = contents.map((content) => JSON.parse(content));
  assert.equal(copilot.mcpServers["browser-use-portable"].type, "local");
  const environments = [copilot.mcpServers["browser-use-portable"].env, agy.mcpServers["browser-use"].env,
    opencode.mcp.servers["browser-use"].environment];
  for (const env of environments) {
    assert.equal(env.BROWSER_USE_BRIDGE_FILE, descriptor);
    assert.equal("BROWSER_USE_ENGINE_PATH" in env, false);
  }
  const repeat = spawnSync(process.execPath, [cli, ...setup], {encoding: "utf8"});
  assert.equal(repeat.status, 1);
  assert.match(repeat.stderr, /already has a provider config/);
  assert.deepEqual(await Promise.all(files.map((file) => readFile(file, "utf8"))), contents);
  const doctor = spawnSync(process.execPath, [cli, "doctor", "--engine", enginePath, "--bridge", descriptor, "--json"], {encoding: "utf8"});
  assert.equal(doctor.status, 1);
  assert.equal(JSON.parse(doctor.stdout).ready, false);
});
