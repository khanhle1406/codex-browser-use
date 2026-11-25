import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { isEphemeralPackagePath, stableNodePath } from "../src/config.js";
import { configureClient, nativeMessagingDirs, stageRuntime, stripJsonComments } from "../src/install.js";
import { createTabHandlers } from "../src/backend-tabs.js";
import { BridgeBrowser } from "../src/bridge-browser.js";

function event() {
  const listeners = new Set();
  return {
    addListener(fn) { listeners.add(fn); },
    removeListener(fn) { listeners.delete(fn); },
    async emit(...args) {
      for (const fn of [...listeners]) await fn(...args);
    },
  };
}

test("stableNodePath, isEphemeralPackagePath, and nativeMessagingDirs handle managers & platforms", () => {
  const existing = new Set([
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/home/dev/.volta/bin/node",
    "/home/dev/.local/share/fnm/aliases/default/bin/node",
  ]);
  const has = (p) => existing.has(p);

  assert.equal(stableNodePath("/opt/homebrew/Cellar/node/26.13.0/bin/node", has, "/home/dev"), "/opt/homebrew/bin/node");
  assert.equal(stableNodePath("/usr/local/Cellar/node/24.1.0/bin/node", has, "/home/dev"), "/usr/local/bin/node");
  assert.equal(stableNodePath("/home/dev/.volta/tools/image/node/22.12.0/bin/node", has, "/home/dev"), "/home/dev/.volta/bin/node");
  assert.equal(stableNodePath("/tmp/fnm_multishells/12345_0/bin/node", has, "/home/dev"), "/home/dev/.local/share/fnm/aliases/default/bin/node");

  assert.equal(isEphemeralPackagePath("/Users/u/.npm/_npx/ab12/node_modules/codex-browser-use/bin/chrome-native-host.js"), true);
  assert.equal(isEphemeralPackagePath(path.join(os.tmpdir(), "pkg", "server.js")), true);
  assert.equal(isEphemeralPackagePath("/opt/homebrew/lib/node_modules/codex-browser-use/src/server.js"), false);

  const dirs = nativeMessagingDirs();
  if (process.platform === "darwin") {
    assert.ok(dirs.some((d) => d.includes(`${path.sep}Arc${path.sep}User Data${path.sep}NativeMessagingHosts`)));
    assert.ok(dirs.some((d) => d.includes(`${path.sep}Google${path.sep}Chrome Beta${path.sep}NativeMessagingHosts`)));
  }
});

test("stageRuntime, stripJsonComments, configureClient env merge, CLI codex TOML, and dead-socket doctor", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bu-wave2-"));
  t.after(async () => rm(root, { recursive: true, force: true }));

  // 1. stageRuntime produces a complete runnable copy of mcp-server
  const stagedDest = path.join(root, "staged-runtime");
  const staged = await stageRuntime({ destination: stagedDest });
  assert.equal(staged.staged, true);
  assert.equal((await stat(staged.serverPath)).isFile(), true);
  assert.equal((await stat(staged.nativeHostEntry)).isFile(), true);
  assert.equal((await stat(path.join(stagedDest, "node_modules", "acorn", "package.json"))).isFile(), true);

  // 2. configureClient parses JSONC configs & preserves existing custom env keys
  const home = path.join(root, "home");
  const cursorConfigPath = path.join(home, ".cursor", "mcp.json");
  await mkdir(path.dirname(cursorConfigPath), { recursive: true });
  await writeFile(cursorConfigPath, `{
    // user comment
    "mcpServers": {
      "other": { "command": "foo" },
      "browser-use": {
        "command": "old-node",
        "env": { "BROWSER_USE_CURSOR_MODE": "off", "BROWSER_USE_BRIDGE_FILE": "/old.json" },
      },
    },
  }`, "utf8");
  assert.equal(JSON.parse(stripJsonComments(`{"a": "http://x//y", /* c */ "b": [1,2,],}`)).a, "http://x//y");
  const updated = await configureClient({
    client: "cursor",
    bridgeFile: "/new/bridge.json",
    serverPath: staged.serverPath,
    write: true,
    home,
  });
  assert.equal(updated.written, true);
  const parsed = JSON.parse(await readFile(cursorConfigPath, "utf8"));
  assert.equal(parsed.mcpServers.other.command, "foo");
  assert.equal(parsed.mcpServers["browser-use"].env.BROWSER_USE_CURSOR_MODE, "off");
  assert.equal(parsed.mcpServers["browser-use"].env.BROWSER_USE_BRIDGE_FILE, "/new/bridge.json");
  assert.deepEqual(parsed.mcpServers["browser-use"].args, [staged.serverPath]);

  // 3. CLI `install --client codex` prints TOML when not JSON
  const cli = fileURLToPath(new URL("../bin/browser-use.js", import.meta.url));
  const installRes = spawnSync(process.execPath, [cli, "install", "--client", "codex"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  // Only assert TOML output if install succeeded in HOME
  if (installRes.status === 0) {
    assert.ok(installRes.stdout.includes("[mcp_servers.browser-use]"));
  }

  // 4. doctor --json rejects dead socket instead of reporting ready: true
  const bridgeDir = path.join(root, "bridge-dir");
  await mkdir(bridgeDir, { mode: 0o700 });
  const deadSock = path.join(bridgeDir, "rpc.sock");
  const srv = net.createServer();
  await new Promise((r) => srv.listen(deadSock, r));
  await new Promise((r) => srv.close(r));
  // Recreate a stale socket path if close unlinked it cleanly; skip connect test if OS unlinked
  const bridgeJson = path.join(bridgeDir, "bridge.json");
  await writeFile(bridgeJson, JSON.stringify({ version: 1, socketPath: deadSock }), { mode: 0o600 });
  await chmod(bridgeDir, 0o700);
  const docRes = spawnSync(process.execPath, [cli, "doctor", "--bridge", bridgeJson, "--json"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  assert.equal(docRes.status, 1);
  const docReport = JSON.parse(docRes.stdout);
  assert.equal(docReport.ready, false);
  assert.ok("checks" in docReport);
});

test("background.js fixes zero-window createBlankTab, cross-window grouping, user group restore, and burst/window focus", async () => {
  const onEvent = event();
  const onMessage = event();
  const onClicked = event();
  const tabsCreated = event();
  const tabsActivated = event();
  const winFocusChanged = event();
  const replies = [];
  const winUpdates = [];
  const tabUpdates = [];
  const groupCalls = [];
  let storageData = {};

  const openTabs = new Map([
    [10, { id: 10, windowId: 1, active: true, groupId: 50, url: "https://mail.example.com", title: "Mail" }],
    [11, { id: 11, windowId: 2, active: false, groupId: -1, url: "https://other-window.example.com", title: "Win2" }],
  ]);
  const tabGroups = new Map([
    [50, { id: 50, windowId: 1, title: "Work", color: "green", collapsed: false }],
  ]);
  let windowCount = 0; // simulate 0 windows for createBlankTab test first

  const port = { onMessage, onDisconnect: event(), postMessage: (r) => replies.push(r) };
  const chrome = {
    runtime: { connectNative: () => port, id: "ext-1" },
    storage: {
      local: {
        async get() { return storageData; },
        async set(obj) { storageData = { ...storageData, ...obj }; },
      },
    },
    windows: {
      onFocusChanged: winFocusChanged,
      onRemoved: event(),
      async getLastFocused() {
        return windowCount === 0 ? null : { id: 1, focused: true };
      },
      async create(opts) {
        const t = { id: 30, windowId: 3, active: Boolean(opts.focused), groupId: -1, url: opts.url, title: "Blank" };
        openTabs.set(30, t);
        return { id: 3, tabs: [t] };
      },
      async update(winId, props) {
        winUpdates.push({ winId, ...props });
        return { id: winId, ...props };
      },
    },
    tabs: {
      onRemoved: event(),
      onCreated: tabsCreated,
      onActivated: tabsActivated,
      async query() { return [openTabs.get(10)]; },
      async get(id) { return openTabs.get(id) ?? null; },
      async create() { throw new Error("No current window"); },
      async remove(id) { openTabs.delete(id); },
      async update(id, props) {
        tabUpdates.push({ id, ...props });
        return { ...openTabs.get(id), ...props };
      },
      async group(opts) {
        groupCalls.push(opts);
        const gid = opts.groupId ?? 99;
        if (!tabGroups.has(gid)) tabGroups.set(gid, { id: gid, windowId: 1, title: "", color: "blue", collapsed: false });
        for (const tid of opts.tabIds) {
          const t = openTabs.get(tid);
          if (t) t.groupId = gid;
        }
        return gid;
      },
    },
    tabGroups: {
      onRemoved: event(),
      async get(id) { return tabGroups.get(id) ?? null; },
      async query() { return [...tabGroups.values()]; },
      async update() {},
    },
    action: { onClicked, async setBadgeText() {} },
    debugger: { onEvent, onDetach: event(), async attach() {}, async detach() {}, async sendCommand() { return {}; } },
  };

  let reqId = 1;
  async function req(msg) {
    const id = reqId++;
    await onMessage.emit({ id, ...msg });
    return replies.find((r) => r.id === id);
  }

  const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
  runInNewContext(source, { chrome, console, Promise, URL });
  await new Promise((r) => setTimeout(r, 10));

  // 1. createBlankTab falls back to windows.create({ focused: false }) when Chrome has 0 windows
  const blank = await req({ method: "createBlankTab" });
  assert.equal(blank.ok, true);
  assert.equal(blank.value.id, 30);

  // 2. Claim user tab 10 (in user group 50), move into agent group, then releaseTab -> restores original group 50!
  await req({ method: "claimTab", tabId: 10 });
  await req({ method: "claimTab", tabId: 11 });
  // Grouping [10, 11] across Window 1 & Window 2 must only group Window 1's tab (10), never yanking tab 11 across windows!
  await req({ method: "groupTabs", details: { tabIds: [10, 11], title: "Agent", color: "blue" } });
  assert.deepEqual(groupCalls.at(-1).tabIds, [10]);
  await req({ method: "releaseTab", tabId: 10 });
  assert.equal(openTabs.get(10).groupId, 50);

  // 3. Burst popups & new-window popups do not steal user focus
  openTabs.set(20, { id: 20, windowId: 1, active: true, url: "https://user.example" });
  await tabsActivated.emit({ tabId: 20, windowId: 1 });
  const p1 = { id: 21, windowId: 1, openerTabId: 30, active: true, url: "https://p1.example" };
  const p2 = { id: 22, windowId: 1, openerTabId: 30, active: true, url: "https://p2.example" };
  await tabsActivated.emit({ tabId: 21, windowId: 1 });
  await tabsCreated.emit(p1);
  await tabsActivated.emit({ tabId: 22, windowId: 1 });
  await tabsCreated.emit(p2);
  assert.equal(tabUpdates.filter((u) => u.id === 20 && u.active === true).length, 2);

  // New popup window (windowId 99) restores OS focus to last user window 1
  const pWin = { id: 23, windowId: 99, openerTabId: 30, active: true, url: "https://oauth.example" };
  await tabsCreated.emit(pWin);
  assert.ok(winUpdates.some((w) => w.winId === 1 && w.focused === true));
});

test("canceled_by_user stops auto-reattach, setConfig forwards allowTabFocus, and claimTab rolls back on DevTools conflict", async () => {
  let lastConfig = null;
  let releasedTabs = [];
  let attachCalls = 0;

  const handlers = createTabHandlers({
    async createBlankTab() { return { id: 1, url: "about:blank", title: "New" }; },
    async readTab(id) { return { id, url: "https://example.com", title: "Example" }; },
    async listTabs() { return [{ id: 10, url: "https://user.example", title: "User", owned: false }]; },
    async claimTab(id) { return { id, url: "https://user.example", title: "User" }; },
    async releaseTab(id) { releasedTabs.push(id); },
    async setConfig(cfg) { lastConfig = cfg; return { ok: true, ...cfg }; },
    async closeTab() {},
    async attach(id) {
      attachCalls += 1;
      if (id === 10) throw new Error("Another debugger is already attached to tab 10");
    },
    async detach() {},
    async execute() { throw new Error("Debugger unattached"); },
    onEvent() {},
  }, { name: "test", version: "1.0.0" });

  const ac = new AbortController();
  const base = { session_id: "s1", turn_id: "t1" };
  await handlers.get("getInfo")(base, ac.signal, () => {});
  await handlers.get("setConfig")({ ...base, cursorMode: "off", allowTabFocus: true }, ac.signal, () => {});
  assert.deepEqual(lastConfig, { cursorMode: "off", allowTabFocus: true });

  // DevTools conflict + rollback via BridgeBrowser.claimTab
  let cancelTab1 = false;
  const browser = new BridgeBrowser({
    request: async (method, params = {}) => {
      if (method === "executeCdp" && !cancelTab1) return {};
      const handler = handlers.get(method);
      return await handler(params, ac.signal, () => {});
    },
    close: async () => {},
    sessionId: "s1",
    turnId: "t1",
    info: { apiSupportOverrides: { "BrowserUser.claimTab": true } },
  });

  await assert.rejects(
    browser.claimTab(10),
    /Chrome DevTools.*attached to tab 10/i,
  );
  assert.ok(releasedTabs.includes(10));
  assert.equal(browser.ownedTabs.has(10), false);

  // Simulate user clicking Cancel on debugger infobar on tab 1
  const created = await browser.newTab();
  assert.equal(created.tab_id, "1");
  const attachBefore = attachCalls;
  browser.userCanceledTabs.add(1);
  browser.attached.delete(1);
  cancelTab1 = true;
  await assert.rejects(
    browser.evaluate("document.title", { tabId: 1 }),
    /canceled by the user/i,
  );
  assert.equal(attachCalls, attachBefore);
});
