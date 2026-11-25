import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { endianness } from "node:os";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { encodeFrame } from "../src/frame-reader.js";
import { listenBackend } from "../src/backend-transport.js";
import { createTabHandlers } from "../src/backend-tabs.js";
import { createNativeTabDriver } from "../src/backend-native-driver.js";
import { BridgeBrowser } from "../src/bridge-browser.js";
import { assertReadOnly } from "../src/read-only.js";
import { BrowserScriptSession } from "../src/script-runner.js";
import { buildAxDiff } from "../src/ax-tree.js";
import { defaultBridgeFile } from "../src/backend-discovery.js";

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

test("executeBatch collapses multi-CDP steps with $prev substitution and fireAndForget in background.js", async () => {
  const onEvent = event();
  const onMessage = event();
  const onDisconnect = event();
  const onClicked = event();
  const replies = [];
  const cdpCalls = [];
  let releaseDone = false;

  const openTabs = new Map([[10, { id: 10, url: "https://example.com", title: "Home", active: false }]]);
  const port = { onMessage, onDisconnect, postMessage: (msg) => replies.push(msg), disconnect() {} };
  const chrome = {
    runtime: { connectNative: () => port, onMessage: event() },
    tabs: {
      onRemoved: event(),
      async create() { return openTabs.get(10); },
      async query() { return [...openTabs.values()]; },
      async get(id) { return openTabs.get(id) ?? null; },
      async remove() {},
    },
    action: { onClicked, async setBadgeText() {} },
    downloads: { onCreated: event(), onChanged: event() },
    debugger: {
      onEvent,
      onDetach: event(),
      async attach() {},
      async detach() {},
      async sendCommand(_target, method, params) {
        cdpCalls.push({ method, params });
        if (method === "DOM.resolveNode") return { object: { objectId: "obj-42" } };
        if (method === "Runtime.callFunctionOn") {
          return { result: { value: { hitsTarget: true, point: { x: 120, y: 240 } } } };
        }
        if (method === "Runtime.releaseObject") {
          releaseDone = true;
          return {};
        }
        return {};
      },
    },
  };

  const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
  runInNewContext(source, { chrome, console });
  await onClicked.emit();

  let nextId = 1;
  async function req(msg) {
    const id = nextId++;
    await onMessage.emit({ id, ...msg });
    return replies.find((r) => r.id === id);
  }

  assert.equal((await req({ method: "claimTab", tabId: 10 })).ok, true);
  assert.equal((await req({ method: "attach", tabId: 10 })).ok, true);

  cdpCalls.length = 0;
  const batchRes = await req({
    method: "executeBatch",
    tabId: 10,
    details: {
      commands: [
        { method: "DOM.resolveNode", params: { backendNodeId: 77 } },
        { method: "Runtime.callFunctionOn", params: { objectId: "$prev.object.objectId", functionDeclaration: "function(){}" } },
        { method: "Runtime.releaseObject", params: { objectId: "$prev.object.objectId" }, fireAndForget: true },
      ],
    },
  });
  assert.equal(batchRes.ok, true, batchRes.error);
  assert.equal(batchRes.value.results.length, 3);
  assert.equal(batchRes.value.results[0].object.objectId, "obj-42");
  assert.equal(batchRes.value.results[1].result.value.hitsTarget, true);
  assert.equal(batchRes.value.results[2], null);
  assert.equal(cdpCalls[1].params.objectId, "obj-42");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(cdpCalls[2].params.objectId, "obj-42");
  assert.equal(releaseDone, true);

  // detach and unwatchDownloads on unowned tab return null instead of throwing
  const detachUnowned = await req({ method: "detach", tabId: 999 });
  const unwatchUnowned = await req({ method: "unwatchDownloads", tabId: 999 });
  assert.equal(detachUnowned.ok, true);
  assert.equal(detachUnowned.value, null);
  assert.equal(unwatchUnowned.ok, true);
  assert.equal(unwatchUnowned.value, null);
});

test("Page.handleJavaScriptDialog bypasses expiredCountsByTab lockout to avoid alert() deadlock", async () => {
  const fromChrome = new PassThrough();
  const toChrome = new PassThrough();
  const requests = [];
  toChrome.on("data", (buf) => {
    const raw = buf.subarray(4).toString("utf8");
    requests.push(JSON.parse(raw));
  });

  const driver = createNativeTabDriver(fromChrome, toChrome, { timeoutMs: 40 });
  const hangReq = driver.execute(7, "Runtime.evaluate", { expression: "alert('hi')" });
  await assert.rejects(hangReq, /timed out/i);

  // Normal execute on tab 7 is locked out while the timed-out command is still in-flight
  await assert.rejects(
    driver.execute(7, "Runtime.evaluate", { expression: "1+1" }),
    /still in flight/,
  );

  const frameOpts = { littleEndian: endianness() === "LE", maxFrameBytes: 1024 * 1024 };
  // Page.handleJavaScriptDialog MUST bypass the lockout so the alert can be dismissed!
  const dialogPromise = driver.execute(7, "Page.handleJavaScriptDialog", { accept: true });
  await new Promise((r) => setTimeout(r, 5));
  const dialogReq = requests.find((r) => r.details?.method === "Page.handleJavaScriptDialog");
  assert.ok(dialogReq);
  fromChrome.write(encodeFrame({ id: dialogReq.id, ok: true, value: {} }, frameOpts));
  await dialogPromise;

  // Resolving the earlier timed-out execute clears the lockout
  const stuckReq = requests.find((r) => r.details?.params?.expression === "alert('hi')");
  fromChrome.write(encodeFrame({ id: stuckReq.id, ok: true, value: {} }, frameOpts));
  const after = driver.execute(7, "Runtime.evaluate", { expression: "1+1" });
  await new Promise((r) => setTimeout(r, 5));
  const afterReq = requests.find((r) => r.details?.params?.expression === "1+1");
  fromChrome.write(encodeFrame({ id: afterReq.id, ok: true, value: { result: { value: 2 } } }, frameOpts));
  const res = await after;
  assert.equal(res.result.value, 2);
  driver.close();
});

test("assertReadOnly LRU cache, endTurn finally cleanup, and concurrent browser_run serialization", async () => {
  // 1. assertReadOnly cache validates valid & rejects invalid consistently
  const expr = "document.querySelectorAll('a').length";
  assert.equal(assertReadOnly(expr), expr);
  assert.equal(assertReadOnly(expr), expr);
  assert.throws(() => assertReadOnly("fetch('/x')"), /not allowed/);
  assert.throws(() => assertReadOnly("fetch('/x')"), /not allowed/);

  // 2. backend-tabs endTurn clears session.turn even if detach rejects
  let detached = false;
  const handlers = createTabHandlers({
    async createBlankTab() { return { id: 1, url: "about:blank", title: "New" }; },
    async readTab(id) { return { id, url: "about:blank", title: "New" }; },
    async closeTab() {},
    async attach() {},
    async detach() {
      detached = true;
      throw new Error("tab vanished");
    },
    async execute() { return {}; },
    onEvent() {},
  }, { name: "test", version: "1.0.0" });

  const ac = new AbortController();
  const base = { session_id: "s1", turn_id: "t1" };
  await handlers.get("getInfo")(base, ac.signal, () => {});
  await handlers.get("createTab")(base, ac.signal, () => {});
  await handlers.get("attach")({ ...base, tabId: 1 }, ac.signal, () => {});
  await assert.rejects(handlers.get("turnEnded")(base, ac.signal, () => {}), /cleanup failed/);
  assert.equal(detached, true);
  // New turn must succeed (session.turn was cleared in finally!)
  const nextTurn = await handlers.get("createTab")({ session_id: "s1", turn_id: "t2" }, ac.signal, () => {});
  assert.equal(nextTurn.id, 1);

  // 3. BrowserScriptSession serializes overlapping run() calls instead of clobbering activeRun
  const session = new BrowserScriptSession();
  const order = [];
  const fakeBrowser = {
    ownedTabs: new Set([1]),
    activeTabId: 1,
    drainNotifications: () => [],
  };
  const p1 = session.run(fakeBrowser, "await sleep(25); order.push(1);", { timeoutMs: 2000 })
    .catch(() => null);
  session.scope.order = order;
  const p2 = session.run(fakeBrowser, "order.push(2); return order.length;", { timeoutMs: 2000 });
  await Promise.all([p1, p2]);
  assert.deepEqual(order, [1, 2]);
});

test("warm loopback latency benchmark across core tools stays under 50ms per tool call (6ms simulated bridge RTT)", async (t) => {
  const BRIDGE_RTT_MS = 6;
  const delay = () => new Promise((r) => setTimeout(r, BRIDGE_RTT_MS));
  const tabs = new Map([[1, { id: 1, url: "https://app.example.com/form", title: "App Form", active: false }]]);
  let notifyFn = () => {};

  const axNodes = [
    { nodeId: "root", role: { value: "RootWebArea" }, name: { value: "App Form" }, childIds: ["btn", "inp"] },
    { nodeId: "btn", role: { value: "button" }, name: { value: "Submit" }, backendDOMNodeId: 11, childIds: [] },
    { nodeId: "inp", role: { value: "textbox" }, name: { value: "Email" }, backendDOMNodeId: 12, childIds: [] },
  ];

  const execOne = (method, params) => {
    if (method === "Accessibility.getFullAXTree") return { nodes: axNodes };
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main", url: "https://app.example.com/form" }, childFrames: [] } };
    if (method === "DOM.resolveNode") return { object: { objectId: `obj-${params.backendNodeId}` } };
    if (method === "Runtime.callFunctionOn") {
      return { result: { value: { hitsTarget: true, point: { x: 100, y: 200 }, status: "done" } } };
    }
    if (method === "Runtime.evaluate") return { result: { value: "App Form" } };
    return {};
  };

  const handlers = createTabHandlers({
    async createBlankTab() { return tabs.get(1); },
    async readTab(id) { return tabs.get(id) ?? null; },
    async closeTab() {},
    async releaseTab() {},
    async markTab() {},
    async attach() { await delay(); },
    async detach() {},
    async navigate(id, url) {
      await delay();
      tabs.set(id, { ...tabs.get(id), url });
      notifyFn("onCDPEvent", {
        source: { tabId: id },
        method: "Page.frameNavigated",
        params: { frame: { id: "main", loaderId: "l2", url: `${url}/dashboard` } },
      });
      notifyFn("onCDPEvent", { source: { tabId: id }, method: "Page.loadEventFired", params: {} });
    },
    async execute(_id, method, params) {
      await delay();
      return execOne(method, params);
    },
    async executeBatch(_id, commands) {
      await delay();
      const results = [];
      let prev = null;
      for (const cmd of commands) {
        if (cmd.fireAndForget) {
          results.push(null);
          continue;
        }
        const resolved = { ...cmd.params };
        if (resolved.objectId === "$prev.object.objectId") {
          resolved.objectId = prev?.object?.objectId;
        }
        const out = execOne(cmd.method, resolved);
        prev = out;
        results.push(out);
      }
      return { results };
    },
    onEvent() {},
  }, { name: "bench", version: "4.8.3" });

  // Capture notify callback cleanly through getInfo
  const origGetInfo = handlers.get("getInfo");
  const wrappedHandlers = new Map(handlers);
  wrappedHandlers.set("getInfo", (params, signal, notify) => {
    notifyFn = notify;
    return origGetInfo(params, signal, notify);
  });

  const backend = await listenBackend(wrappedHandlers);
  const { writeFile, mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(os.tmpdir(), "bu-bench-"));
  await import("node:fs/promises").then((fs) => fs.chmod(dir, 0o700));
  const bridgeFile = path.join(dir, "bridge.json");
  await writeFile(bridgeFile, JSON.stringify({ version: 1, socketPath: backend.socketPath }), { mode: 0o600 });

  const browser = await BridgeBrowser.connect({ bridgeFile });
  t.after(async () => {
    await browser.close().catch(() => {});
    await backend.close().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  // Warm up tab and prime AX index + event stream
  await browser.newTab();
  browser.handleCdpEvent({
    source: { tabId: 1 },
    method: "Accessibility.nodesUpdated",
    params: {},
  });
  await browser.getState({ tabId: 1, screenshot: false });

  // Verify redirect commit completes immediately without 5000ms stall
  const tNav = performance.now();
  await browser.goto("https://app.example.com/login", 1);
  const navMs = performance.now() - tNav;
  assert.ok(navMs < 200, `redirect goto took ${navMs.toFixed(1)}ms`);

  browser.handleCdpEvent({
    source: { tabId: 1 },
    method: "Accessibility.nodesUpdated",
    params: {},
  });
  await browser.getState({ tabId: 1, screenshot: false });

  async function measure(label, fn) {
    const start = performance.now();
    await fn();
    const elapsed = performance.now() - start;
    return { label, elapsed };
  }

  const results = [];
  results.push(await measure("browser_click", () => browser.click("1", { tabId: 1 })));
  results.push(await measure("browser_set_value", () => browser.setValue("2", "ada@example.com", { tabId: 1 })));
  results.push(await measure("browser_type_text", () => browser.typeText("hello", { tabId: 1 })));
  results.push(await measure("browser_press_key", () => browser.pressKey("Enter", { tabId: 1 })));
  results.push(await measure("browser_evaluate", () => browser.evaluate("document.title", { tabId: 1 })));
  results.push(await measure("browser_get_state(unchanged)", () => browser.getState({ tabId: 1, screenshot: false })));
  browser.handleCdpEvent({ source: { tabId: 1 }, method: "Accessibility.nodesUpdated", params: {} });
  results.push(await measure("browser_get_state(changed)", () => browser.getState({ tabId: 1, screenshot: false })));
  results.push(await measure("browser_batch(3+diff)", () => browser.batch([
    { action: "set_value", element_index: "2", value: "ada@example.com" },
    { action: "type_text", text: "!" },
    { action: "press_key", key: "Enter" },
  ], { tabId: 1, returnState: "diff" })));

  const scriptSession = new BrowserScriptSession();
  results.push(await measure("browser_run(click+ret)", () => scriptSession.run(browser, 'await page.click("1"); return 42;', { tabId: 1 })));

  for (const r of results) {
    console.log(`  [bench] ${r.label.padEnd(28)} ${r.elapsed.toFixed(2)}ms`);
    assert.ok(r.elapsed < 50, `${r.label} exceeded 50ms budget: ${r.elapsed.toFixed(2)}ms`);
  }

  // Silence unused import lint warnings while keeping defaultBridgeFile smoke-tested
  assert.equal(typeof defaultBridgeFile(), "string");
  assert.equal(buildAxDiff(null, { documentKey: "k", lines: [], entries: [] }).mode, "full");
});
