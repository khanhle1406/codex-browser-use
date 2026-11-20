import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { endianness, tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { performance } from "node:perf_hooks";
import vm from "node:vm";
import { listenBackend } from "../src/backend-transport.js";
import { publishBackend } from "../src/backend-discovery.js";
import { createTabHandlers } from "../src/backend-tabs.js";
import { createNativeTabDriver } from "../src/backend-native-driver.js";
import { BridgeClient } from "../src/bridge-client.js";
import { BridgeBrowser } from "../src/bridge-browser.js";
import { buildAxState } from "../src/ax-tree.js";
import { extractContentExpression } from "../src/content-extractor.js";
import { locatorExpression, locatorInvokeExpression, locatorRuntimeInstallExpression } from "../src/locators.js";
import { createStandaloneServer } from "../src/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const LITTLE_ENDIAN = endianness() === "LE";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function round(num, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(num * factor) / factor;
}

function makeAxTree(title = "Benchmark Page") {
  return {
    nodes: [
      { nodeId: "1", role: { value: "RootWebArea" }, name: { value: title }, backendDOMNodeId: 1, childIds: ["2", "3"] },
      { nodeId: "2", parentId: "1", role: { value: "textbox" }, name: { value: "Query" }, value: { value: "" }, backendDOMNodeId: 20 },
      { nodeId: "3", parentId: "1", role: { value: "button" }, name: { value: "Submit" }, backendDOMNodeId: 30 },
    ],
  };
}

async function runScenario1MultiTabParallel() {
  const root = await mkdtemp(path.join(tmpdir(), "bench-s1-"));
  const descriptor = path.join(root, "bridge.json");
  const tabs = new Map();
  let nextTab = 1;
  let emitEvent = () => {};
  let rpcCount = 0;

  const driver = {
    async createBlankTab() {
      rpcCount += 1;
      await pause(5);
      const tab = { id: nextTab++, url: "about:blank", title: "Blank", active: false };
      tabs.set(tab.id, tab);
      return tab;
    },
    async readTab(id) {
      rpcCount += 1;
      await pause(3);
      return tabs.get(id) ?? null;
    },
    async closeTab(id) {
      rpcCount += 1;
      tabs.delete(id);
    },
    async releaseTab() {},
    async attach() {
      rpcCount += 1;
      await pause(5);
    },
    async detach() {},
    async navigate(id, url) {
      rpcCount += 1;
      await pause(15);
      const tab = tabs.get(id);
      if (tab) {
        tab.url = url;
        tab.title = `Tab ${id}`;
      }
      emitEvent("onCDPEvent", id, {
        source: { tabId: id },
        method: "Page.frameNavigated",
        params: { frame: { id: `frame-${id}`, url, loaderId: `loader-${id}` } },
      });
      emitEvent("onCDPEvent", id, {
        source: { tabId: id },
        method: "Page.loadEventFired",
        params: { timestamp: 1 },
      });
    },
    async execute(id, method, params = {}) {
      rpcCount += 1;
      if (method === "Accessibility.getFullAXTree") {
        await pause(20);
        return makeAxTree(`Tab ${id}`);
      }
      await pause(10);
      if (method === "Page.getFrameTree") {
        const url = tabs.get(id)?.url ?? "about:blank";
        return { frameTree: { frame: { id: `frame-${id}`, url }, childFrames: [] } };
      }
      if (method === "Runtime.evaluate") {
        if (params.expression === "document.readyState") return { result: { value: "complete" } };
        if (params.expression === "location.href") return { result: { value: tabs.get(id)?.url ?? "about:blank" } };
        return { result: { value: { title: tabs.get(id)?.title ?? "", url: tabs.get(id)?.url ?? "" } } };
      }
      return {};
    },
    onEvent(listener) { emitEvent = listener; },
  };

  const backend = await listenBackend(createTabHandlers(driver, { name: "Bench S1", version: "1", childFrames: true }));
  const unpublish = await publishBackend(descriptor, backend.socketPath);
  const browser = await BridgeBrowser.connect({ bridgeFile: descriptor, sessionId: "bench-s1", turnId: "t1" });

  try {
    const start = performance.now();
    const created = await Promise.all([
      browser.newTab(),
      browser.newTab(),
      browser.newTab(),
      browser.newTab(),
    ]);
    await Promise.all(
      created.map((t, idx) =>
        browser.goto(`https://bench.example/tab-${idx}`, t.tab_id)
          .then(() => browser.getState({ tabId: t.tab_id, screenshot: false })),
      ),
    );
    const ms = performance.now() - start;
    return { ms: round(ms), rpcCount };
  } finally {
    await browser.close().catch(() => {});
    await unpublish().catch(() => {});
    await backend.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

async function runScenario2GetStateIframesScreenshot() {
  const root = await mkdtemp(path.join(tmpdir(), "bench-s2-"));
  const descriptor = path.join(root, "bridge.json");
  const tabs = new Map();
  let nextTab = 1;
  let emitEvent = () => {};
  let cdpCount = 0;
  let attachedChildren = false;

  const driver = {
    async createBlankTab() {
      const tab = { id: nextTab++, url: "https://bench.example/frames", title: "Frames", active: true };
      tabs.set(tab.id, tab);
      return tab;
    },
    async readTab(id) { return tabs.get(id) ?? null; },
    async closeTab(id) { tabs.delete(id); },
    async releaseTab() {},
    async attach() {},
    async detach() {},
    async execute(id, method, params = {}) {
      cdpCount += 1;
      if (method === "Accessibility.getFullAXTree") {
        await pause(20);
        return makeAxTree(params.frameId ? `Frame ${params.frameId}` : "Main Frames Page");
      }
      if (method === "Page.captureScreenshot") {
        await pause(35);
        return { data: "LzlqLzRBQVFTa1pKUmdBQkFRQUFBUUFC" };
      }
      await pause(10);
      if (method === "Page.enable" && !attachedChildren) {
        attachedChildren = true;
        emitEvent("onCDPEvent", id, {
          source: { tabId: id },
          method: "Target.attachedToTarget",
          params: { sessionId: "co-sess-1", targetInfo: { type: "iframe", targetId: "frame-co-1" } },
        });
        emitEvent("onCDPEvent", id, {
          source: { tabId: id },
          method: "Target.attachedToTarget",
          params: { sessionId: "co-sess-2", targetInfo: { type: "iframe", targetId: "frame-co-2" } },
        });
      }
      if (method === "Page.getFrameTree") {
        return {
          frameTree: {
            frame: { id: "main", url: "https://bench.example/frames" },
            childFrames: [
              { frame: { id: "frame-so-1", url: "https://bench.example/embed-1" }, childFrames: [] },
              { frame: { id: "frame-so-2", url: "https://bench.example/embed-2" }, childFrames: [] },
              { frame: { id: "frame-co-1", url: "https://pay.partner.example/card" }, childFrames: [] },
              { frame: { id: "frame-co-2", url: "https://auth.partner.example/sso" }, childFrames: [] },
            ],
          },
        };
      }
      if (method === "Page.getLayoutMetrics") {
        const vp = { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 800 };
        return { cssVisualViewport: vp, cssLayoutViewport: vp };
      }
      if (method === "Runtime.evaluate") {
        if (params.expression === "window.devicePixelRatio") return { result: { value: 2 } };
        return { result: { value: { title: "Frames", url: "https://bench.example/frames" } } };
      }
      return {};
    },
    onEvent(listener) { emitEvent = listener; },
  };

  const backend = await listenBackend(createTabHandlers(driver, { name: "Bench S2", version: "1", childFrames: true }));
  const unpublish = await publishBackend(descriptor, backend.socketPath);
  const browser = await BridgeBrowser.connect({ bridgeFile: descriptor, sessionId: "bench-s2", turnId: "t1" });

  try {
    await browser.newTab();
    cdpCount = 0;

    const coldStart = performance.now();
    const coldState = await browser.getState({ screenshot: true });
    const coldMs = performance.now() - coldStart;
    if (!coldState.axText.includes("Frame frame-co-2")) {
      throw new Error("Expected child iframe trees in cold getState");
    }

    const warmStart = performance.now();
    await browser.getState({ screenshot: true });
    const warmMs = performance.now() - warmStart;

    return {
      coldMs: round(coldMs),
      warmMs: round(warmMs),
      cdpCount,
    };
  } finally {
    await browser.close().catch(() => {});
    await unpublish().catch(() => {});
    await backend.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

async function runScenario3NavAndLazyNetwork() {
  const root = await mkdtemp(path.join(tmpdir(), "bench-s3-"));
  const descriptor = path.join(root, "bridge.json");
  const tabs = new Map();
  let nextTab = 1;
  let emitEvent = () => {};
  let evalCount = 0;
  let networkEnabled = false;
  const timers = new Set();
  const scheduleTimer = (fn, delay) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, delay);
    timers.add(t);
  };

  let navStartedAt = 0;
  let navUrl = "about:blank";
  let navPhase = "complete";

  const driver = {
    async createBlankTab() {
      const tab = { id: nextTab++, url: "about:blank", title: "Blank", active: true };
      tabs.set(tab.id, tab);
      return tab;
    },
    async readTab(id) { return tabs.get(id) ?? null; },
    async closeTab(id) { tabs.delete(id); },
    async releaseTab() {},
    async attach() {},
    async detach() {},
    async navigate(id, url) {
      await pause(5);
      navStartedAt = performance.now();
      navUrl = url;
      navPhase = "loading";
      const tab = tabs.get(id);
      if (tab) tab.url = "about:blank";

      emitEvent("onCDPEvent", id, {
        source: { tabId: id },
        method: "Page.frameStartedLoading",
        params: { frameId: "main-frame" },
      });

      scheduleTimer(() => {
        navPhase = "committed";
        if (tab) tab.url = url;
        emitEvent("onCDPEvent", id, {
          source: { tabId: id },
          method: "Page.frameNavigated",
          params: { frame: { id: "main-frame", url, loaderId: `loader-${Math.round(navStartedAt)}` } },
        });
      }, 20);

      scheduleTimer(() => {
        navPhase = "interactive";
        emitEvent("onCDPEvent", id, {
          source: { tabId: id },
          method: "Page.domContentEventFired",
          params: { timestamp: 1 },
        });
      }, 50);

      // Emit realistic subresource traffic when Network domain is enabled
      for (let i = 0; i < 8; i++) {
        const reqId = `req-${i}`;
        scheduleTimer(() => {
          if (!networkEnabled) return;
          emitEvent("onCDPEvent", id, {
            source: { tabId: id },
            method: "Network.requestWillBeSent",
            params: { requestId: reqId, request: { url: `${url}/asset-${i}.js`, method: "GET" } },
          });
        }, 30 + i * 7);
        scheduleTimer(() => {
          if (!networkEnabled) return;
          emitEvent("onCDPEvent", id, {
            source: { tabId: id },
            method: "Network.loadingFinished",
            params: { requestId: reqId },
          });
        }, 42 + i * 9);
      }

      scheduleTimer(() => {
        navPhase = "complete";
        emitEvent("onCDPEvent", id, {
          source: { tabId: id },
          method: "Page.loadEventFired",
          params: { timestamp: 2 },
        });
        emitEvent("onCDPEvent", id, {
          source: { tabId: id },
          method: "Page.frameStoppedLoading",
          params: { frameId: "main-frame" },
        });
      }, 100);
    },
    async execute(_id, method, params = {}) {
      await pause(5);
      if (method === "Network.enable") {
        networkEnabled = true;
        return {};
      }
      if (method === "Runtime.evaluate") {
        evalCount += 1;
        if (params.expression === "location.href") {
          const href = navPhase === "loading" ? "about:blank" : navUrl;
          return { result: { value: href } };
        }
        if (params.expression === "document.readyState") {
          const ready = navPhase === "complete"
            ? "complete"
            : (navPhase === "interactive" ? "interactive" : "loading");
          return { result: { value: ready } };
        }
      }
      return {};
    },
    onEvent(listener) { emitEvent = listener; },
  };

  const backend = await listenBackend(createTabHandlers(driver, { name: "Bench S3", version: "1", childFrames: true }));
  const unpublish = await publishBackend(descriptor, backend.socketPath);
  const browser = await BridgeBrowser.connect({ bridgeFile: descriptor, sessionId: "bench-s3", turnId: "t1" });

  try {
    await browser.newTab();

    evalCount = 0;
    networkEnabled = false;
    const loadStart = performance.now();
    await browser.goto("https://bench.example/load", undefined, { waitUntil: "load", timeoutMs: 5_000 });
    const loadMs = performance.now() - loadStart;
    const loadEvalCount = evalCount;
    const loadNetworkEnabled = networkEnabled;

    evalCount = 0;
    const idleStart = performance.now();
    await browser.goto("https://bench.example/idle", undefined, { waitUntil: "networkidle", timeoutMs: 5_000 });
    const idleMs = performance.now() - idleStart;
    const idleEvalCount = evalCount;

    return {
      loadMs: round(loadMs),
      loadEvalCount,
      loadNetworkEnabled,
      idleMs: round(idleMs),
      idleEvalCount,
      idleNetworkEnabled: networkEnabled,
    };
  } finally {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    await browser.close().catch(() => {});
    await unpublish().catch(() => {});
    await backend.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

function createDomVmContext() {
  const observers = new Set();

  function scheduleMutation(records) {
    queueMicrotask(() => {
      for (const obs of [...observers]) {
        if (obs.active) obs.callback(records, obs);
      }
    });
  }

  class MutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.active = false;
    }
    observe() {
      this.active = true;
      observers.add(this);
    }
    disconnect() {
      this.active = false;
      observers.delete(this);
    }
    takeRecords() { return []; }
  }

  function makeEl(tag, opts = {}) {
    let inner = opts.text ?? "";
    const el = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      id: opts.id || "",
      attrs: { ...(opts.attrs ?? {}), ...(opts.id ? { id: opts.id } : {}) },
      children: [],
      childNodes: [],
      labels: [],
      shadowRoot: null,
      ownerDocument: null,
      parentNode: null,
      get innerText() { return inner; },
      set innerText(v) {
        inner = String(v);
        scheduleMutation([{ type: "characterData", target: el }]);
      },
      get textContent() { return inner; },
      set textContent(v) {
        inner = String(v);
        scheduleMutation([{ type: "characterData", target: el }]);
      },
      appendChild(child) {
        child.parentNode = el;
        child.ownerDocument = el.ownerDocument;
        el.children.push(child);
        el.childNodes.push(child);
        scheduleMutation([{ type: "childList", target: el, addedNodes: [child] }]);
        return child;
      },
      removeChild(child) {
        el.children = el.children.filter((c) => c !== child);
        el.childNodes = el.childNodes.filter((c) => c !== child);
        child.parentNode = null;
        scheduleMutation([{ type: "childList", target: el, removedNodes: [child] }]);
        return child;
      },
      getAttribute(k) { return el.attrs?.[k] ?? null; },
      hasAttribute(k) { return Boolean(el.attrs && k in el.attrs); },
      matches() { return false; },
      closest() { return null; },
      contains(other) {
        if (other === el) return true;
        return el.children.some((c) => c.contains(other));
      },
      scrollIntoView() {},
      focus() {},
      click() {},
      dispatchEvent() {},
      getBoundingClientRect() {
        return { left: 20, top: 20, right: 120, bottom: 60, x: 20, y: 20, width: 100, height: 40 };
      },
      querySelectorAll(css) {
        const out = [];
        const walk = (n) => {
          for (const c of n.children) {
            if ((css === "#delayed-btn" && c.id === "delayed-btn") ||
                (css === "button" && c.tagName === "BUTTON")) {
              out.push(c);
            }
            walk(c);
          }
        };
        walk(el);
        return out;
      },
      getRootNode() { return el.ownerDocument; },
    };
    return el;
  }

  const body = makeEl("body", { text: "Loading..." });
  const doc = {
    body,
    documentElement: body,
    children: [body],
    querySelectorAll: (css) => body.querySelectorAll(css),
    elementFromPoint(_x, _y) {
      return body.children.find((c) => c.id === "delayed-btn") ?? body;
    },
    getElementById(id) {
      return body.children.find((c) => c.id === id) ?? null;
    },
  };
  body.ownerDocument = doc;

  const ctx = {
    window: {
      innerWidth: 1280,
      innerHeight: 800,
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    },
    document: doc,
    CSS: { escape: (s) => String(s) },
    HTMLInputElement: class {},
    HTMLButtonElement: class {},
    HTMLTextAreaElement: class {},
    HTMLSelectElement: class {},
    HTMLElement: class {},
    ShadowRoot: class {},
    InputEvent: class { constructor(t, init) { this.type = t; Object.assign(this, init); } },
    Event: class { constructor(t, init) { this.type = t; Object.assign(this, init); } },
    MutationObserver,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    Promise,
  };
  return { ctx, doc, body, makeEl };
}

async function runScenario4MutationObserverWait() {
  const vmEnv = createDomVmContext();
  let evalCount = 0;

  const browser = new BridgeBrowser({
    request: async (method, params = {}) => {
      if (method === "getTabs") return [{ id: 1, url: "https://bench.example/wait", title: "Wait" }];
      if (method === "attach") return null;
      if (method === "executeCdp") {
        if (params.method === "Runtime.evaluate") {
          evalCount += 1;
          await pause(8);
          let val = vm.runInNewContext(params.commandParams.expression, vmEnv.ctx);
          if (params.commandParams.awaitPromise && val && typeof val.then === "function") {
            val = await val;
          }
          return { result: { value: val } };
        }
        await pause(4);
        return {};
      }
      return {};
    },
    close: async () => {},
    sessionId: "bench-s4",
    turnId: "t1",
  });

  await browser.listTabs();
  const timers = new Set();

  // 1. waitFor selector
  evalCount = 0;
  let btn = vmEnv.makeEl("button", { id: "delayed-btn", text: "Go" });
  timers.add(setTimeout(() => vmEnv.body.appendChild(btn), 90));
  const selStart = performance.now();
  await browser.waitFor({ selector: "css=#delayed-btn", timeoutMs: 2_000 });
  const selectorMs = performance.now() - selStart;
  const selectorEvalCount = evalCount;
  vmEnv.body.removeChild(btn);

  // 2. waitFor text
  evalCount = 0;
  vmEnv.body.innerText = "Still loading...";
  timers.add(setTimeout(() => { vmEnv.body.innerText = "Ready!"; }, 90));
  const textStart = performance.now();
  await browser.waitFor({ text: "Ready!", timeoutMs: 2_000 });
  const textMs = performance.now() - textStart;
  const textEvalCount = evalCount;

  // 3. locatorClick auto-wait
  evalCount = 0;
  btn = vmEnv.makeEl("button", { id: "delayed-btn", text: "Confirm" });
  timers.add(setTimeout(() => vmEnv.body.appendChild(btn), 90));
  const clickStart = performance.now();
  await browser.locatorClick("css=#delayed-btn", { timeoutMs: 2_000 });
  const clickMs = performance.now() - clickStart;
  const clickEvalCount = evalCount;

  for (const t of timers) clearTimeout(t);
  return {
    selectorMs: round(selectorMs),
    selectorEvalCount,
    textMs: round(textMs),
    textEvalCount,
    clickMs: round(clickMs),
    clickEvalCount,
    totalMs: round(selectorMs + textMs + clickMs),
    totalEvalCount: selectorEvalCount + textEvalCount + clickEvalCount,
  };
}

async function runScenario5SetValueAndIframeCache() {
  const root = await mkdtemp(path.join(tmpdir(), "bench-s5-"));
  const descriptor = path.join(root, "bridge.json");
  const tabs = new Map([[1, { id: 1, url: "https://bench.example/form", title: "Form", active: true }]]);
  let cdpCount = 0;

  const driver = {
    async createBlankTab() { return tabs.get(1); },
    async readTab(id) { return tabs.get(id) ?? null; },
    async closeTab() {},
    async releaseTab() {},
    async attach() {},
    async detach() {},
    async execute(_id, method, params = {}) {
      cdpCount += 1;
      await pause(8);
      if (method === "Accessibility.getFullAXTree") return makeAxTree("Form");
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main", url: "https://bench.example/form" }, childFrames: [] } };
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") return { nodeId: 99 };
      if (method === "DOM.describeNode") return { node: { frameId: "frame-checkout" } };
      if (method === "DOM.resolveNode") return { object: { objectId: "obj-20" } };
      if (method === "Runtime.callFunctionOn") return { result: { value: "done" } };
      if (method === "Runtime.evaluate") {
        if (String(params.expression).includes("Locator did not match")) {
          return { result: { value: { count: 1, clicked: true } } };
        }
        return { result: { value: { title: "Form", url: "https://bench.example/form" } } };
      }
      return {};
    },
    onEvent() {},
  };

  const backend = await listenBackend(createTabHandlers(driver, { name: "Bench S5", version: "1", childFrames: true }));
  const unpublish = await publishBackend(descriptor, backend.socketPath);
  const browser = await BridgeBrowser.connect({ bridgeFile: descriptor, sessionId: "bench-s5", turnId: "t1" });

  try {
    await browser.newTab();
    browser.frameSessions.set(1, new Map([["frame-checkout", "co-session-1"]]));
    await browser.getState({ screenshot: false });

    cdpCount = 0;
    const svStart = performance.now();
    for (let i = 0; i < 10; i++) {
      await browser.setValue("1", `value-${i}`);
    }
    const setValueMs = performance.now() - svStart;
    const setValueCdpCount = cdpCount;

    cdpCount = 0;
    const iframeStart = performance.now();
    for (let i = 0; i < 10; i++) {
      await browser.locatorClick("css=#go", { frame: "iframe#checkout" });
    }
    const iframeMs = performance.now() - iframeStart;
    const iframeCdpCount = cdpCount;

    return {
      setValueMs: round(setValueMs),
      setValueCdpCount,
      iframeMs: round(iframeMs),
      iframeCdpCount,
      totalMs: round(setValueMs + iframeMs),
      totalCdpCount: setValueCdpCount + iframeCdpCount,
    };
  } finally {
    await browser.close().catch(() => {});
    await unpublish().catch(() => {});
    await backend.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

async function runScenario6ExtensionEventsAndLargePayloads() {
  const event = () => {
    const listeners = new Set();
    return {
      addListener(fn) { listeners.add(fn); },
      removeListener(fn) { listeners.delete(fn); },
      emit(...args) {
        const out = [];
        for (const fn of listeners) out.push(fn(...args));
        return Promise.all(out);
      },
    };
  };

  const onDebugEvent = event();
  const onMessage = event();
  const onClicked = event();
  const extToHost = new PassThrough();
  const hostToExt = new PassThrough();
  let wireMessages = 0;

  let nextTab = 1;
  const chrome = {
    runtime: {
      connectNative() {
        return {
          onMessage,
          onDisconnect: event(),
          postMessage(msg) {
            wireMessages += 1;
            const body = Buffer.from(JSON.stringify(msg));
            const header = Buffer.alloc(4);
            if (LITTLE_ENDIAN) header.writeUInt32LE(body.length);
            else header.writeUInt32BE(body.length);
            extToHost.write(Buffer.concat([header, body]));
          },
          disconnect() {},
        };
      },
    },
    tabs: {
      onRemoved: event(),
      async create() { return { id: nextTab++, url: "about:blank", title: "Blank", active: false }; },
    },
    action: { onClicked, async setBadgeText() {} },
    downloads: { onCreated: event(), onChanged: event() },
    debugger: {
      onEvent: onDebugEvent,
      onDetach: event(),
      async attach() {},
      async sendCommand(_target, method) {
        if (method === "Page.captureScreenshot") {
          return { data: "A".repeat(350_000) };
        }
        return {};
      },
    },
  };

  let hostBuf = Buffer.alloc(0);
  hostToExt.on("data", (chunk) => {
    hostBuf = Buffer.concat([hostBuf, chunk]);
    while (hostBuf.length >= 4) {
      const len = LITTLE_ENDIAN ? hostBuf.readUInt32LE() : hostBuf.readUInt32BE();
      if (hostBuf.length < 4 + len) break;
      const req = JSON.parse(hostBuf.subarray(4, 4 + len).toString("utf8"));
      hostBuf = hostBuf.subarray(4 + len);
      void onMessage.emit(req);
    }
  });

  const extSource = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
  vm.runInNewContext(extSource, { chrome, console });
  await onClicked.emit();

  const driver = createNativeTabDriver(extToHost, hostToExt, { timeoutMs: 30_000 });
  try {
    let seenEvents = 0;
    let resolveAllEvents;
    const allEventsDone = new Promise((resolve) => { resolveAllEvents = resolve; });
    driver.onEvent(() => {
      seenEvents += 1;
      if (seenEvents === 2_000) resolveAllEvents();
    });

    const tab = await driver.createBlankTab();
    await driver.attach(tab.id);

    const evStart = performance.now();
    for (let i = 0; i < 1_000; i++) {
      onDebugEvent.emit({ tabId: tab.id }, "Network.requestWillBeSent", {
        requestId: `r-${i}`,
        request: { url: `https://cdn.example/${i}.js`, method: "GET", headers: { Authorization: "Bearer x" } },
      });
      onDebugEvent.emit({ tabId: tab.id }, "Page.lifecycleEvent", {
        frameId: "main",
        name: "networkIdle",
        timestamp: i,
      });
    }
    await allEventsDone;
    const eventsMs = performance.now() - evStart;

    wireMessages = 0;
    const bigStart = performance.now();
    for (let i = 0; i < 40; i++) {
      const res = await driver.execute(tab.id, "Page.captureScreenshot", {});
      if (res?.data?.length !== 350_000) throw new Error("Unexpected screenshot payload length");
    }
    const largePayloadsMs = performance.now() - bigStart;

    return {
      eventsMs: round(eventsMs),
      largePayloadsMs: round(largePayloadsMs),
      wireMessages,
      totalMs: round(eventsMs + largePayloadsMs),
    };
  } finally {
    driver.close();
    extToHost.destroy();
    hostToExt.destroy();
  }
}

async function runScenario7FragmentedIpc1Mb() {
  const payload = "X".repeat(1_000_000);
  const backend = await listenBackend(new Map([
    ["echo1mb", async () => ({ data: payload })],
  ]));

  const root = await mkdtemp(path.join(tmpdir(), "bench-s7-"));
  const descriptor = path.join(root, "bridge.json");
  const unpublish = await publishBackend(descriptor, backend.socketPath);
  const client = new BridgeClient({ bridgeFile: descriptor, requestTimeoutMs: 30_000 });

  // Also write fragmented 8KB client->server requests over a raw Unix socket to exercise backend reader.
  const rawSocket = createConnection(backend.socketPath);
  await new Promise((resolve) => rawSocket.once("connect", resolve));

  const bigReqBody = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "echo1mb", params: { data: payload } }));
  const bigHeader = Buffer.alloc(4);
  if (LITTLE_ENDIAN) bigHeader.writeUInt32LE(bigReqBody.length);
  else bigHeader.writeUInt32BE(bigReqBody.length);
  const fullReqFrame = Buffer.concat([bigHeader, bigReqBody]);

  try {
    await client.connect();
    const start = performance.now();

    // 1. 30 * 1MB server -> client responses via BridgeClient
    for (let i = 0; i < 30; i++) {
      const res = await client.request("echo1mb", {});
      if (res?.data?.length !== 1_000_000) throw new Error("Corrupted 1MB IPC response");
    }

    // 2. Fragmented 8KB chunks client -> server over raw socket (10 * 1MB)
    let receivedCount = 0;
    let rx = Buffer.alloc(0);
    const doneRaw = new Promise((resolve, reject) => {
      rawSocket.on("error", reject);
      rawSocket.on("data", (chunk) => {
        rx = Buffer.concat([rx, chunk]);
        while (rx.length >= 4) {
          const len = LITTLE_ENDIAN ? rx.readUInt32LE() : rx.readUInt32BE();
          if (rx.length < 4 + len) break;
          rx = rx.subarray(4 + len);
          receivedCount += 1;
          if (receivedCount === 10) resolve();
        }
      });
    });

    for (let n = 0; n < 10; n++) {
      for (let off = 0; off < fullReqFrame.length; off += 8192) {
        const slice = fullReqFrame.subarray(off, off + 8192);
        const ok = rawSocket.write(slice);
        if (!ok) await new Promise((r) => rawSocket.once("drain", r));
        await new Promise((r) => setImmediate(r));
      }
    }
    await doneRaw;

    const ms = performance.now() - start;
    const totalMb = 40;
    const mbPerSec = totalMb / (ms / 1_000);
    return {
      ms: round(ms),
      mbPerSec: round(mbPerSec, 1),
    };
  } finally {
    rawSocket.destroy();
    await client.close().catch(() => {});
    await unpublish().catch(() => {});
    await backend.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

async function runScenario8LocatorRuntimeCache10x() {
  const vmEnv = createDomVmContext();
  const btn = vmEnv.makeEl("button", { id: "delayed-btn", attrs: { role: "button", "aria-label": "Save" }, text: "Save" });
  vmEnv.body.appendChild(btn);

  let standaloneBytes = 0;
  const standaloneStart = performance.now();
  for (let i = 0; i < 10; i++) {
    const expr = locatorExpression('role=button[name="Save"]', { mutation: "count" });
    standaloneBytes += expr.length;
    vm.runInNewContext(expr, vmEnv.ctx);
  }
  const standaloneMs = performance.now() - standaloneStart;

  const statefulCtx = vm.createContext({ ...vmEnv.ctx });
  const installExpr = locatorRuntimeInstallExpression();
  vm.runInNewContext(installExpr, statefulCtx);

  let cachedCallBytes = 0;
  const cachedStart = performance.now();
  for (let i = 0; i < 10; i++) {
    const expr = locatorInvokeExpression('role=button[name="Save"]', { mutation: "count" });
    cachedCallBytes += expr.length;
    vm.runInNewContext(expr, statefulCtx);
  }
  const cachedMs = performance.now() - cachedStart;

  return {
    standaloneBytes,
    cachedWarmBytes10x: cachedCallBytes,
    perCallReductionPct: round((1 - (cachedCallBytes / standaloneBytes)) * 100, 1),
    standaloneMs: round(standaloneMs),
    cachedMs: round(cachedMs),
  };
}

async function runScenario9McpSchemaProfiles() {
  const measureProfile = async (profile) => {
    const server = createStandaloneServer({ profile, resetBrowser: async () => {} });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: `bench-${profile}`, version: "1.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const list = await client.listTools();
      const bytes = JSON.stringify(list.tools).length;
      return { count: list.tools.length, bytes, estTokens: Math.ceil(bytes / 4) };
    } finally {
      await client.close();
      await server.close();
    }
  };

  const full = await measureProfile("full");
  const standard = await measureProfile("standard");
  const compact = await measureProfile("compact");
  return {
    fullTools: full.count,
    fullBytes: full.bytes,
    fullTokens: full.estTokens,
    standardTools: standard.count,
    standardTokens: standard.estTokens,
    compactTools: compact.count,
    compactBytes: compact.bytes,
    compactTokens: compact.estTokens,
    compactSavingsPct: round((1 - compact.bytes / full.bytes) * 100, 1),
  };
}

function runScenario10AxAndContentCompression() {
  const nodes = [
    { nodeId: "root", role: { value: "RootWebArea" }, name: { value: "Catalog" }, backendDOMNodeId: 1, childIds: ["nav", "main"] },
    { nodeId: "nav", parentId: "root", role: { value: "navigation" }, name: { value: "Header" }, childIds: ["n1", "n2"] },
    { nodeId: "n1", parentId: "nav", role: { value: "StaticText" }, name: { value: "Welcome back to the store catalog portal" } },
    { nodeId: "n2", parentId: "nav", role: { value: "StaticText" }, name: { value: "Copyright 2026 All rights reserved worldwide" } },
    { nodeId: "main", parentId: "root", role: { value: "list" }, childIds: [] },
  ];
  for (let i = 0; i < 30; i++) {
    const rowId = `r-${i}`;
    const btnId = `b-${i}`;
    const txtId = `t-${i}`;
    nodes[4].childIds.push(rowId);
    nodes.push(
      { nodeId: rowId, parentId: "main", role: { value: "listitem" }, name: { value: `Item ${i}` }, backendDOMNodeId: 100 + i, childIds: [txtId, btnId] },
      { nodeId: txtId, parentId: rowId, role: { value: "StaticText" }, name: { value: `Industrial pump model P-${100 + i} stock description` } },
      { nodeId: btnId, parentId: rowId, role: { value: "button" }, name: { value: i === 0 ? "Order" : `Order #${i}` }, backendDOMNodeId: 200 + i },
    );
  }
  const fullAx = buildAxState(nodes, { mode: "full" }).lines.join("\n");
  const compactAx = buildAxState(nodes, { mode: "compact" }).lines.join("\n");
  const interactiveAx = buildAxState(nodes, { mode: "interactive" }).lines.join("\n");

  const makeEl = (tag, text, children = [], attrs = {}) => {
    const el = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      attrs,
      children,
      childNodes: text ? [{ nodeType: 3, textContent: text }, ...children] : children,
      innerText: text,
      textContent: text,
      hidden: false,
      getAttribute: (k) => attrs[k] ?? null,
    };
    return el;
  };
  const nav = makeEl("nav", "Home Products About Contact Login Cart Support ".repeat(25));
  const h1 = makeEl("h1", "Pump Selection Guide");
  const p = makeEl("p", "Choose efficiency class IE4 motors for continuous industrial duty.");
  const article = makeEl("article", "", [h1, p]);
  article.innerText = "Pump Selection Guide Choose efficiency class IE4 motors for continuous industrial duty.".repeat(4);
  const body = makeEl("body", "", [nav, article]);
  const rawBodyText = "Home Products About Contact Login Cart Support ".repeat(25) + "\n" + article.innerText;
  body.innerText = rawBodyText;
  body.querySelectorAll = (sel) => (sel.includes("article") ? [article] : []);

  const vmCtx = vm.createContext({
    document: { title: "Guide", body, querySelector: (sel) => (sel === "article" ? article : null), querySelectorAll: body.querySelectorAll },
    location: { href: "https://shop.example/guide" },
    window: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
  });
  const mdRes = vm.runInNewContext(extractContentExpression({ format: "markdown" }), vmCtx);

  return {
    axFullChars: fullAx.length,
    axCompactChars: compactAx.length,
    axCompactSavingsPct: round((1 - compactAx.length / fullAx.length) * 100, 1),
    axInteractiveChars: interactiveAx.length,
    rawTextChars: rawBodyText.length,
    markdownChars: mdRes.text.length,
    contentSavingsPct: round((1 - mdRes.text.length / rawBodyText.length) * 100, 1),
  };
}

async function main() {
  const results = {
    node: process.version,
    timestamp: new Date().toISOString(),
    scenarios: {
      multi_tab_parallel: await runScenario1MultiTabParallel(),
      get_state_iframes_screenshot: await runScenario2GetStateIframesScreenshot(),
      nav_event_driven_and_lazy_network: await runScenario3NavAndLazyNetwork(),
      wait_mutation_observer: await runScenario4MutationObserverWait(),
      setvalue_and_iframe_cache: await runScenario5SetValueAndIframeCache(),
      extension_events_and_large_payloads: await runScenario6ExtensionEventsAndLargePayloads(),
      ipc_fragmented_1mb_frames: await runScenario7FragmentedIpc1Mb(),
      locator_runtime_cache_10x: await runScenario8LocatorRuntimeCache10x(),
      mcp_schema_profiles: await runScenario9McpSchemaProfiles(),
      ax_and_content_compression: runScenario10AxAndContentCompression(),
    },
  };
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.table(results.scenarios);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
