import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listenBackend } from "../src/backend-transport.js";
import { publishBackend, readBackend } from "../src/backend-discovery.js";
import { createTabHandlers } from "../src/backend-tabs.js";
import { BridgeBrowser } from "../src/bridge-browser.js";

const AX_NODES = [
  { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Socket" }, backendDOMNodeId: 1, childIds: ["2"] },
  { nodeId: "2", parentId: "1", role: { value: "button" }, name: { value: "Go" }, backendDOMNodeId: 20 },
];

/** @param {string} method @param {Record<string, any>} params */
function respond(method, params) {
  switch (method) {
    case "Accessibility.enable": return {};
    case "Accessibility.getFullAXTree": return { nodes: AX_NODES };
    case "Page.enable": return {};
    case "Page.navigate": return { frameId: "frame-1" };
    case "Page.captureScreenshot": return { data: "iVBORw0KGgo=" };
    case "Runtime.evaluate":
      if (params.expression === "document.readyState") return { result: { value: "complete" } };
      return { result: { value: { title: "Socket", url: "http://127.0.0.1:1/" } } };
    default: return {};
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "browser-use-client-"));
  const tabs = new Map();
  let nextTab = 1;
  const cdpCalls = [];
  const driver = {
    createBlankTab: async () => {
      const tab = { id: nextTab++, url: "about:blank", title: "Blank" };
      tabs.set(tab.id, tab);
      return tab;
    },
    readTab: async (id) => tabs.get(id) ?? null,
    closeTab: async (id) => { tabs.delete(id); },
    releaseTab: async () => {},
    attach: async () => {},
    detach: async () => {},
    execute: async (tabId, method, params) => {
      cdpCalls.push({ tabId, method, params });
      return respond(method, params);
    },
    onEvent: () => {},
  };
  const backend = await listenBackend(createTabHandlers(driver, { name: "Socket fixture", version: "1", childFrames: true }));
  const descriptor = path.join(root, "bridge.json");
  const unpublish = await publishBackend(descriptor, backend.socketPath);
  return {
    descriptor,
    cdpCalls,
    async close() {
      await unpublish();
      await backend.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("BridgeBrowser drives the bridge protocol over a real socket", async () => {
  const server = await fixture();
  const browser = await BridgeBrowser.connect({ bridgeFile: server.descriptor, sessionId: "session-a", turnId: "turn-a" });
  try {
    const tab = await browser.newTab();
    assert.equal(tab.tab_id, "1");
    const state = await browser.getState({ screenshot: true });
    assert.match(state.axText, /1 button "Go"/);
    assert.equal(state.screenshotBase64, "iVBORw0KGgo=");
    assert.ok(server.cdpCalls.some((call) => call.method === "Accessibility.getFullAXTree"));
    assert.ok(server.cdpCalls.some((call) => call.method === "Page.captureScreenshot"));
  } finally {
    await browser.close();
    await server.close();
  }
});

test("a second connection cannot reuse a bound session id", async () => {
  const server = await fixture();
  const first = await BridgeBrowser.connect({ bridgeFile: server.descriptor, sessionId: "session-b", turnId: "turn-b" });
  try {
    await assert.rejects(
      () => BridgeBrowser.connect({ bridgeFile: server.descriptor, sessionId: "session-b", turnId: "turn-c" }),
      /Browser session is open on another connection/,
    );
  } finally {
    await first.close();
    await server.close();
  }
});

test("endTurn closes unmarked tabs and the next turn starts clean", async () => {
  const server = await fixture();
  const browser = await BridgeBrowser.connect({ bridgeFile: server.descriptor, sessionId: "session-c", turnId: "turn-c" });
  try {
    await browser.newTab();
    assert.equal((await browser.listTabs()).length, 1);
    await browser.endTurn();
    assert.equal((await browser.listTabs()).length, 0);
    const next = await browser.newTab();
    assert.equal(next.tab_id, "2");
  } finally {
    await browser.close();
    await server.close();
  }
});

test("BridgeBrowser rejects a descriptor that does not exist", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "browser-use-missing-"));
  try {
    await assert.rejects(
      () => BridgeBrowser.connect({ bridgeFile: path.join(root, "missing.json") }),
      /ENOENT|no such file/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publishBackend recovers from a stale descriptor without clobbering newer inodes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "browser-use-stale-"));
  const descriptor = path.join(root, "bridge.json");
  const handlers = createTabHandlers({
    createBlankTab: async () => ({ id: 1 }),
    readTab: async () => null,
    closeTab: async () => {},
    releaseTab: async () => {},
    attach: async () => {},
    detach: async () => {},
    execute: async () => ({}),
    onEvent: () => {},
  }, { name: "Stale fixture", version: "1", childFrames: false });
  const backend1 = await listenBackend(handlers);
  const backend2 = await listenBackend(handlers);
  try {
    await writeFile(descriptor, JSON.stringify({
      version: 1,
      socketPath: path.join(root, "dead-socket", "rpc.sock"),
    }), { mode: 0o600 });
    const unpublish1 = await publishBackend(descriptor, backend1.socketPath);
    assert.equal(await readBackend(descriptor), backend1.socketPath);

    await backend1.close();
    const unpublish2 = await publishBackend(descriptor, backend2.socketPath);
    assert.equal(await readBackend(descriptor), backend2.socketPath);

    await unpublish1();
    assert.equal(await readBackend(descriptor), backend2.socketPath);
    await unpublish2();
  } finally {
    await backend1.close().catch(() => {});
    await backend2.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("publishBackend refuses symlink descriptors and active listening hosts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "browser-use-live-"));
  const handlers = createTabHandlers({
    createBlankTab: async () => ({ id: 1 }),
    readTab: async () => null,
    closeTab: async () => {},
    releaseTab: async () => {},
    attach: async () => {},
    detach: async () => {},
    execute: async () => ({}),
    onEvent: () => {},
  }, { name: "Live fixture", version: "1", childFrames: false });
  const backend1 = await listenBackend(handlers);
  const backend2 = await listenBackend(handlers);
  try {
    const symlinkTarget = path.join(root, "target.json");
    const symlinkDescriptor = path.join(root, "symlink-bridge.json");
    await writeFile(symlinkTarget, "{}", { mode: 0o600 });
    await symlink(symlinkTarget, symlinkDescriptor);
    await assert.rejects(
      () => publishBackend(symlinkDescriptor, backend1.socketPath),
      /Refusing to replace non-regular or foreign browser bridge descriptor/,
    );

    const liveDescriptor = path.join(root, "live-bridge.json");
    const unpublish1 = await publishBackend(liveDescriptor, backend1.socketPath);
    await assert.rejects(
      () => publishBackend(liveDescriptor, backend2.socketPath),
      /Another live browser bridge host is already active/,
    );
    await unpublish1();
  } finally {
    await backend1.close().catch(() => {});
    await backend2.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
