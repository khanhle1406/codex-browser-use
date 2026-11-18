import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, symlink, stat, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createNativePipe, createRuntimeConfig, createRuntimeHost } from "../src/official-runtime.js";

/** @returns {Promise<string>} */
async function temporaryDirectory() {
  return mkdtemp(path.join(tmpdir(), "browser-runtime-test-"));
}

test("native pipe preserves binary bytes and closes connected peers on shutdown", { timeout: 3000 }, async (t) => {
  const root = await temporaryDirectory();
  const socketPath = path.join(root, "pipe.sock");
  const server = createServer();
  const pipe = createNativePipe();
  t.after(async () => {
    pipe.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  server.listen(socketPath);
  await once(server, "listening");
  const connected = once(server, "connection");
  const socket = await pipe.createConnection(socketPath);
  const [peer] = await connected;
  peer.on("data", (bytes) => peer.write(bytes));
  const bytes = Buffer.from([0, 0xff, 0x80, 4, 0, 10, 13, 0xc3, 0xa9]);
  /** @type {Buffer[]} */
  const received = [];
  const echoed = new Promise((resolve, reject) => {
    socket.on("data", (chunk) => {
      received.push(chunk);
      if (Buffer.concat(received).length >= bytes.length) resolve(Buffer.concat(received));
    });
    socket.once("error", reject);
  });
  socket.write(bytes.subarray(0, 3));
  socket.write(bytes.subarray(3));
  assert.deepEqual(await echoed, bytes);
  const peerClosed = once(peer, "close");
  const socketClosed = once(socket, "close");
  pipe.close();
  await Promise.all([peerClosed, socketClosed]);
  assert.equal(socket.destroyed, true);
  await assert.rejects(pipe.createConnection(socketPath), /bridge is closed/);
  pipe.close();
});

test("native pipe rejects missing sockets and nonlocal paths without hanging", { timeout: 3000 }, async (t) => {
  const root = await temporaryDirectory();
  const pipe = createNativePipe({ connectTimeoutMs: 500 });
  t.after(async () => {
    pipe.close();
    await rm(root, { recursive: true, force: true });
  });
  await assert.rejects(pipe.createConnection("relative.sock"), /absolute local socket path/);
  await assert.rejects(pipe.createConnection("https://example.org/socket"), /absolute local socket path/);
  await assert.rejects(pipe.createConnection(path.join(root, "missing.sock")), { code: "ENOENT" });
  assert.throws(() => createNativePipe({ connectTimeoutMs: 0 }), /Invalid native pipe connection timeout/);
  assert.throws(() => createNativePipe({ connectTimeoutMs: 1.5 }), /Invalid native pipe connection timeout/);
});

test("browser config round-trips TOML, preserves access policy, and limits paths", async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = createRuntimeConfig(root);
  assert.deepEqual(await config.read(), { config: {} });
  await writeFile(path.join(root, "config.toml"), '[browser_use]\nallow_history_access = false\n');
  await writeFile(path.join(root, "requirements.toml"), '[browserUse]\ndisableAutoReview = true\n');
  assert.equal((await config.read()).config.browser_use.allow_history_access, false);
  assert.equal((await config.readRequirements()).requirements.browserUse.disableAutoReview, true);
  await config.writeToml("browser/config.toml", { origins: { "https://example.org": "deny" } });
  assert.equal((await config.readToml("browser/config.toml")).origins["https://example.org"], "deny");
  assert.equal((await stat(path.join(root, "browser/config.toml"))).mode & 0o777, 0o600);
  await assert.rejects(config.writeToml("config.toml", {}), /only write browser state/);
  await assert.rejects(config.readToml("../secrets.toml"), /Unsupported browser configuration path/);
  await assert.rejects(config.readToml("browser/sessions/../../outside.toml"), /Unsupported browser configuration path/);
  await writeFile(path.join(root, "browser/config.toml"), "broken = [");
  await assert.rejects(config.readToml("browser/config.toml"));
});

test("browser state rejects symlink files and directories", async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(root, "browser"));
  const config = createRuntimeConfig(root);
  await assert.rejects(config.writeToml("browser/config.toml", {}), /must not be symlinks/);
  await assert.rejects(config.readToml("browser/config.toml"), /must not be symlinks/);
  await rm(path.join(root, "browser"));
  await mkdir(path.join(root, "browser"));
  await writeFile(path.join(outside, "secret.toml"), "sensitive = true");
  await symlink(path.join(outside, "secret.toml"), path.join(root, "browser/config.toml"));
  await assert.rejects(config.writeToml("browser/config.toml", {}), /must not be symlinks/);
  await assert.rejects(config.readToml("browser/config.toml"));
  assert.equal(await readFile(path.join(outside, "secret.toml"), "utf8"), "sensitive = true");
});

test("concurrent state publication never leaves partially written TOML", async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = createRuntimeConfig(root);
  await Promise.all(Array.from({ length: 12 }, (_, index) => config.writeToml("browser/config.toml", { revision: index, state: "valid" })));
  const published = await config.readToml("browser/config.toml");
  assert.equal(published.revision, 11);
  assert.equal(published.state, "valid");
  await Promise.all([config.writeToml("browser/sessions/one.toml", { owner: "one" }), config.writeToml("browser/sessions/two.toml", { owner: "two" })]);
  assert.equal((await config.readToml("browser/sessions/one.toml")).owner, "one");
});

test("independent providers isolate mutable decisions and share read-only policy", async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "config.toml"), '[browser_use]\nallow_history_access = false\n');
  await writeFile(path.join(root, "requirements.toml"), '[browserUse]\ndisableAutoReview = true\n');
  const first = createRuntimeConfig(root, { stateNamespace: "provider-one" });
  const second = createRuntimeConfig(root, { stateNamespace: "provider-two" });
  const [snapshotOne, snapshotTwo] = await Promise.all([first.readToml("browser/config.toml"), second.readToml("browser/config.toml")]);
  await Promise.all([
    first.writeToml("browser/config.toml", { ...snapshotOne, origins: { "https://one.example": "allow" } }),
    second.writeToml("browser/config.toml", { ...snapshotTwo, origins: { "https://two.example": "deny" } }),
  ]);
  assert.deepEqual(Object.entries((await first.readToml("browser/config.toml")).origins), [["https://one.example", "allow"]]);
  assert.deepEqual(Object.entries((await second.readToml("browser/config.toml")).origins), [["https://two.example", "deny"]]);
  assert.deepEqual(await first.read(), await second.read());
  assert.deepEqual(await first.readRequirements(), await second.readRequirements());
  assert.equal((await first.read()).config.browser_use.allow_history_access, false);
  assert.equal((await second.readRequirements()).requirements.browserUse.disableAutoReview, true);
  assert.throws(() => createRuntimeConfig(root, { stateNamespace: "../outside" }), /Invalid browser state namespace/);
  await assert.rejects(first.writeToml("requirements.toml", {}), /only write browser state/);
  await symlink(path.join(root, "state/provider-two"), path.join(root, "state/redirected"));
  const redirected = createRuntimeConfig(root, { stateNamespace: "redirected" });
  await assert.rejects(redirected.readToml("browser/config.toml"), /must not be symlinks/);
});

test("host fails closed without elicitation support and preserves denial responses", async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = createRuntimeHost({ enginePath: root, configRoot: path.join(root, "state") });
  await assert.rejects(host.nodeRepl.createElicitation({ message: "May I access this site?" }), /access was not granted/);
  await assert.rejects(host.nodeRepl.rpc("shell", {}), /Unsupported runtime RPC channel/);
  const denial = { action: "decline", content: { decision: "deny" } };
  const guarded = createRuntimeHost({ enginePath: root, configRoot: path.join(root, "guarded"), onElicitation: async () => denial });
  assert.deepEqual(await guarded.nodeRepl.createElicitation({}), denial);
  const invalid = createRuntimeHost({ enginePath: root, configRoot: path.join(root, "invalid"), onElicitation: async () => ({ action: "approved" }) });
  await assert.rejects(invalid.nodeRepl.createElicitation({}), /Invalid browser approval response/);
  await Promise.all([host.close(), guarded.close(), invalid.close()]);
});

test("host passes live turn metadata and runs registered lifecycle hooks", async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  let current = { session_id: "session-one", turn_id: "turn-one" };
  const events = [];
  const host = createRuntimeHost({ enginePath: root, configRoot: path.join(root, "state"), requestMeta: () => ({ "x-codex-turn-metadata": current }) });
  host.nodeRepl.addAfterSubmittedCodeHook({ timeoutMs: 100, async run() { events.push("after"); } });
  host.nodeRepl.addTurnEndedHandler({ timeoutMs: 100, async run(value) { events.push(value); } });
  await host.runAfterSubmittedCodeHooks();
  await host.endTurn();
  current = { session_id: "session-one", turn_id: "turn-two" };
  assert.deepEqual(host.nodeRepl.requestMeta["x-codex-turn-metadata"], current);
  await host.close();
  await host.close();
  assert.deepEqual(events, ["after", { session_id: "session-one", turn_id: "turn-one" }, current]);
  await assert.rejects(host.nodeRepl.rpc("browser", {}), /closed/);
});

test("hook timeout is reported so the caller can terminate its worker", async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = createRuntimeHost({ enginePath: root, configRoot: path.join(root, "state") });
  const remove = host.nodeRepl.addTurnEndedHandler({ timeoutMs: 5, run: () => new Promise(() => {}) });
  await assert.rejects(host.endTurn(), /timed out; terminate its worker/);
  remove();
  await host.close();
});

test("installed official engine boots unchanged without browser discovery", { skip: !process.env.BROWSER_USE_TEST_ENGINE }, () => {
  // A child prevents global singleton state from leaking into other hosts/tests.
  const moduleUrl = new URL("../src/official-runtime.js", import.meta.url).href;
  const program = `
    import { createRuntimeHost } from ${JSON.stringify(moduleUrl)};
    import { mkdtemp, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import path from 'node:path';
    const root = await mkdtemp(path.join(tmpdir(), 'official-engine-setup-'));
    const host = createRuntimeHost({enginePath: process.env.BROWSER_USE_TEST_ENGINE, configRoot: root});
    globalThis.nodeRepl = host.nodeRepl;
    host.nodeRepl.fetch = async () => { throw new Error('This setup probe forbids network'); };
    const setup = await host.nodeRepl.rpc('browser', {method:'setup',params:{environment:'codex-app'}});
    if (!setup.apiManifest.interfaces.PlaywrightAPI || !setup.apiManifest.interfaces.BrowserUser) throw new Error('Official API manifest missing');
    const {setupBrowserRuntime} = await import(new URL('scripts/browser-client.mjs', 'file://' + process.env.BROWSER_USE_TEST_ENGINE + '/').href);
    const agent = await setupBrowserRuntime();
    const safety = await agent.documentation.get('browser-safety');
    if (typeof agent.browsers.get !== 'function' || !safety.includes('untrusted')) throw new Error('Original client or browser safety guidance missing');
    console.log('PASS: unmodified official engine setup, API manifest, lifecycle cleanup');
    await host.close();
    await rm(root, {recursive:true,force:true});
    process.exit(0);
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", program], { cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: "utf8", timeout: 20000 });
  assert.equal(child.status, 0, child.stderr || child.error?.message || child.stdout);
  assert.match(child.stdout, /PASS: unmodified official engine setup/);
});
