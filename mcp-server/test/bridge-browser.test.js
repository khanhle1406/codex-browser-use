import test from "node:test";
import assert from "node:assert/strict";
import { BridgeBrowser, buildAxState, parseKeyCombo, normalizeUrl } from "../src/bridge-browser.js";
import { assertReadOnly } from "../src/read-only.js";

const AX_NODES = [
  { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Fixture" }, backendDOMNodeId: 1, childIds: ["3", "2", "5"] },
  { nodeId: "2", parentId: "1", role: { value: "generic" }, childIds: ["4"] },
  { nodeId: "3", parentId: "1", role: { value: "button" }, name: { value: "Save" }, backendDOMNodeId: 30, properties: [{ name: "focused", value: { value: true } }] },
  { nodeId: "4", parentId: "2", role: { value: "textbox" }, name: { value: "Name" }, value: { value: "Ada" }, backendDOMNodeId: 40, properties: [{ name: "required", value: { value: true } }] },
  { nodeId: "5", parentId: "1", ignored: true, childIds: ["6"] },
  { nodeId: "6", parentId: "5", role: { value: "StaticText" }, name: { value: "Hello" }, backendDOMNodeId: 60 },
];

function fakeBridge() {
  const tabs = new Map([[1, { id: 1, url: "about:blank", title: "Blank" }]]);
  let nextTab = 2;
  const calls = [];

  const cdp = async (tabId, sessionId, method, params = {}) => {
    calls.push({ kind: "cdp", tabId, sessionId, method, params });
    switch (method) {
      case "Target.setAutoAttach": return {};
      case "DOM.enable": return {};
      case "DOM.getDocument": return { root: { nodeId: 1 } };
      case "DOM.querySelector": return { nodeId: 2 };
      case "DOM.describeNode": return { node: { frameId: "frame-1" } };
      case "Accessibility.enable": return {};
      case "Accessibility.getFullAXTree": return { nodes: AX_NODES };
      case "Page.enable": return {};
      case "Page.navigate":
        tabs.get(tabId).url = params.url;
        return { frameId: "frame-1" };
      case "Page.reload": return {};
      case "Page.getNavigationHistory": return { currentIndex: 1, entries: [{ id: 1 }, { id: 2 }] };
      case "Page.navigateToHistoryEntry": return {};
      case "Page.getLayoutMetrics": return { cssLayoutViewport: { clientWidth: 1000, clientHeight: 700 } };
      case "Page.captureScreenshot": return { data: "iVBORw0KGgo=" };
      case "Page.handleJavaScriptDialog": return {};
      case "Page.close": tabs.delete(tabId); return null;
      case "DOM.scrollIntoViewIfNeeded": return {};
      case "DOM.focus": return {};
      case "DOM.getBoxModel": return { model: { border: [10, 20, 30, 20, 30, 40, 10, 40] } };
      case "DOM.resolveNode": return { object: { objectId: "obj-1" } };
      case "Input.dispatchMouseEvent":
      case "Input.dispatchKeyEvent":
      case "Input.insertText":
      case "Runtime.callFunctionOn": return {};
      case "Runtime.evaluate": return evaluate(tabId, params.expression, tabs);
      default: throw new Error(`Unexpected CDP method: ${method}`);
    }
  };

  const request = async (method, params = {}) => {
    calls.push({ kind: "rpc", method, params });
    if (method === "executeCdp") return cdp(params.target.tabId, params.target.sessionId, params.method, params.commandParams);
    switch (method) {
      case "getInfo": return { type: "extension", family: "chrome", name: "Fake", version: "1" };
      case "getTabs": return [...tabs.values()];
      case "createTab": {
        const id = nextTab++;
        tabs.set(id, { id, url: "about:blank", title: "Blank" });
        return tabs.get(id);
      }
      case "attach":
      case "markTab":
      case "turnEnded": return null;
      default: throw new Error(`Unexpected rpc: ${method}`);
    }
  };

  return { request, close: async () => {}, calls, tabs };
}

function evaluate(tabId, expression, tabs) {
  if (expression === "document.readyState") return { result: { value: "complete" } };
  if (expression.startsWith("({title")) {
    return { result: { value: { title: "Fixture Page", url: tabs.get(tabId).url } } };
  }
  if (expression.includes("document.body ? document.body.innerText")) {
    return { result: { value: "Visible text" } };
  }
  if (expression.includes("Locator did not match")) {
    return { result: { value: { count: 1, x: 50, y: 60 } } };
  }
  return { result: { value: 42 } };
}

function browserFixture() {
  const bridge = fakeBridge();
  const browser = new BridgeBrowser({
    request: bridge.request,
    close: bridge.close,
    sessionId: "session-1",
    turnId: "turn-1",
  });
  return { browser, ...bridge };
}

const cdpCalls = (calls, method) => calls.filter((call) => call.kind === "cdp" && call.method === method);

test("buildAxState indexes the tree, skips generic wrappers, and keeps states", () => {
  const snapshot = buildAxState(AX_NODES);
  assert.equal(snapshot.count, 4);
  assert.deepEqual(snapshot.lines, [
    '0 RootWebArea "Fixture"',
    '  1 button "Save" [focused]',
    '  2 textbox "Name" (value: "Ada") [required]',
    '  3 StaticText "Hello"',
  ]);
  assert.equal(snapshot.index.get("1").backendDOMNodeId, 30);
  assert.equal(snapshot.index.get("2").backendDOMNodeId, 40);
});

test("buildAxState truncates at maxLines", () => {
  const snapshot = buildAxState(AX_NODES, { maxLines: 2 });
  assert.equal(snapshot.lines.length, 2);
  assert.equal(snapshot.truncated, true);
});

test("parseKeyCombo maps named keys and chords", () => {
  assert.deepEqual(parseKeyCombo("Return"), { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r", modifiers: 0 });
  assert.equal(parseKeyCombo("super+a").modifiers, 4);
  assert.equal(parseKeyCombo("super+a").text, undefined);
  assert.throws(() => parseKeyCombo("hyper+a"), /Unknown key modifier/);
});

test("normalizeUrl adds https and preserves explicit schemes", () => {
  assert.equal(normalizeUrl("example.com"), "https://example.com");
  assert.equal(normalizeUrl("http://localhost:3000"), "http://localhost:3000");
  assert.equal(normalizeUrl("about:blank"), "about:blank");
});

test("newTab creates, attaches, and activates a tab", async () => {
  const { browser, calls } = browserFixture();
  const tab = await browser.newTab();
  assert.equal(tab.tab_id, "2");
  assert.deepEqual(calls.filter((call) => call.kind === "rpc").map((call) => call.method), ["createTab", "attach"]);
  assert.equal(browser.activeTabId, 2);
});

test("every request carries the session and turn identity", async () => {
  const { browser, calls } = browserFixture();
  await browser.getState({ screenshot: false });
  const rpcCalls = calls.filter((call) => call.kind === "rpc");
  assert.ok(rpcCalls.length >= 3);
  for (const call of rpcCalls) {
    assert.equal(call.params.session_id, "session-1");
    assert.equal(call.params.turn_id, "turn-1");
  }
});

test("getState returns indexed accessibility text and a screenshot", async () => {
  const { browser } = browserFixture();
  const state = await browser.getState();
  assert.match(state.axText, /<ax_state>/);
  assert.match(state.axText, /1 button "Save"/);
  assert.match(state.axText, /Title: Fixture Page/);
  assert.equal(state.screenshotBase64, "iVBORw0KGgo=");
  assert.equal(state.elementCount, 4);
});

test("click uses the accessibility index and dispatches mouse events at the box center", async () => {
  const { browser, calls } = browserFixture();
  await browser.getState({ screenshot: false });
  const result = await browser.click("1");
  assert.equal(result.ok, true);
  const mouse = cdpCalls(calls, "Input.dispatchMouseEvent");
  assert.deepEqual(mouse.map((call) => call.params.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
  assert.equal(mouse[1].params.x, 20);
  assert.equal(mouse[1].params.y, 30);
  assert.equal(mouse[1].params.button, "left");
});

test("click rejects a stale element index", async () => {
  const { browser } = browserFixture();
  await browser.getState({ screenshot: false });
  await assert.rejects(() => browser.click("99"), /Element index 99 not found/);
});

test("setValue focuses the node and dispatches input and change events", async () => {
  const { browser, calls } = browserFixture();
  await browser.getState({ screenshot: false });
  await browser.setValue("2", "Grace");
  const resolve = cdpCalls(calls, "DOM.resolveNode")[0];
  assert.equal(resolve.params.backendNodeId, 40);
  const mutation = cdpCalls(calls, "Runtime.callFunctionOn")[0];
  assert.match(mutation.params.functionDeclaration, /dispatchEvent\(new Event\("input"/);
  assert.deepEqual(mutation.params.arguments, [{ value: "Grace" }]);
});

test("pressKey sends modifiers and key metadata", async () => {
  const { browser, calls } = browserFixture();
  await browser.pressKey("super+a");
  const events = cdpCalls(calls, "Input.dispatchKeyEvent");
  assert.equal(events.length, 2);
  assert.equal(events[0].params.modifiers, 4);
  assert.equal(events[0].params.key, "a");
  assert.equal(events[0].params.windowsVirtualKeyCode, 65);
});

test("scroll dispatches a wheel event at the viewport center", async () => {
  const { browser, calls } = browserFixture();
  await browser.scroll("down", { pages: 2 });
  const wheel = cdpCalls(calls, "Input.dispatchMouseEvent")[0];
  assert.equal(wheel.params.type, "mouseWheel");
  assert.equal(wheel.params.deltaY, 1000);
  assert.equal(wheel.params.x, 500);
  assert.equal(wheel.params.y, 350);
});

test("evaluate rejects mutation and returns read-only values", async () => {
  const { browser } = browserFixture();
  await assert.rejects(() => browser.evaluate("document.title = 'changed'"), /read-only: assignment is not allowed/);
  await assert.rejects(() => browser.evaluate("document.body.append('x')"), /append\(\) is not allowed/);
  await assert.rejects(() => browser.evaluate("fetch('https://example.com')"), /fetch\(\) is not allowed/);
  const result = await browser.evaluate("document.title");
  assert.equal(result.value, 42);
});

test("locatorFill and locatorClick use the locator resolver", async () => {
  const { browser, calls } = browserFixture();
  await browser.locatorClick('role=button[name="Save"]');
  const click = cdpCalls(calls, "Input.dispatchMouseEvent");
  assert.equal(click.length, 3);
  assert.equal(click[1].params.x, 50);
  assert.equal(click[1].params.y, 60);
  await browser.locatorFill("testid=name", "Ada");
  const evaluateCalls = cdpCalls(calls, "Runtime.evaluate");
  assert.ok(evaluateCalls.some((call) => call.params.expression.includes("data-testid")));
});

test("getContent returns visible text", async () => {
  const { browser } = browserFixture();
  const result = await browser.getContent();
  assert.equal(result.text, "Visible text");
});

test("handleDialog forwards the dialog decision", async () => {
  const { browser, calls } = browserFixture();
  await browser.handleDialog({ accept: true, promptText: "hello" });
  const dialog = cdpCalls(calls, "Page.handleJavaScriptDialog")[0];
  assert.deepEqual(dialog.params, { accept: true, promptText: "hello" });
});

test("endTurn marks kept tabs, ends the turn, and rotates the turn id", async () => {
  const { browser, calls } = browserFixture();
  await browser.getState({ screenshot: false });
  const before = browser.turnId;
  const result = await browser.endTurn({ keep: [{ tab_id: "1", mode: "handoff" }] });
  const mark = calls.find((call) => call.kind === "rpc" && call.method === "markTab");
  assert.deepEqual(mark.params, { session_id: "session-1", turn_id: before, tabId: 1, status: "handoff" });
  assert.ok(calls.some((call) => call.kind === "rpc" && call.method === "turnEnded"));
  assert.equal(result.ok, true);
  assert.notEqual(result.nextTurnId, before);
  assert.equal(browser.turnId, result.nextTurnId);
  await browser.listTabs();
  assert.equal(calls.at(-1).params.turn_id, result.nextTurnId);
});

test("assertReadOnly allows inspection and blocks storage or navigation writes", () => {
  assert.equal(assertReadOnly("document.querySelector('.x').innerText"), "document.querySelector('.x').innerText");
  assert.throws(() => assertReadOnly("localStorage.setItem('a','b')"), /setItem\(\) is not allowed/);
  assert.throws(() => assertReadOnly("history.pushState({}, '', '/x')"), /pushState\(\) is not allowed/);
  assert.throws(() => assertReadOnly("delete document.body.dataset.x"), /delete is not allowed/);
  assert.throws(() => assertReadOnly("element.classList.add('x')"), /classList access is not allowed/);
});

test("frame locators execute inside the attached cross-origin frame session", async () => {
  const bridge = fakeBridge();
  const frameSessions = new Map([[1, new Map([["frame-1", "session-9"]])]]);
  const browser = new BridgeBrowser({
    request: bridge.request,
    close: bridge.close,
    sessionId: "session-1",
    turnId: "turn-1",
    frameSessions,
  });
  await browser.listTabs();
  const result = await browser.locatorClick("css=#go", { frame: "iframe#inner" });
  assert.equal(result.frame, "iframe#inner");
  const frameCalls = bridge.calls.filter((call) => call.kind === "cdp" && call.sessionId === "session-9");
  assert.ok(frameCalls.some((call) => call.method === "Runtime.evaluate"));
  assert.equal(bridge.calls.filter((call) => call.kind === "cdp" && call.method === "Input.dispatchMouseEvent").length, 0);
  const autoAttach = bridge.calls.find((call) => call.kind === "cdp" && call.method === "Target.setAutoAttach");
  assert.deepEqual(autoAttach.params.filter, [{ type: "iframe", exclude: false }]);
});

test("a frame locator fails when no cross-origin session exists", async () => {
  const bridge = fakeBridge();
  const browser = new BridgeBrowser({
    request: bridge.request,
    close: bridge.close,
    sessionId: "session-1",
    turnId: "turn-1",
    frameSessions: new Map(),
  });
  await browser.listTabs();
  await assert.rejects(
    () => browser.locatorClick("css=#go", { frame: "iframe#inner" }),
    /cross-origin frame session is unavailable/,
  );
});
