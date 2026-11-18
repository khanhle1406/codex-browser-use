import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listenBackend } from "../src/backend-transport.js";
import { publishBackend } from "../src/backend-discovery.js";
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
