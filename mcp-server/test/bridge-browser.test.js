import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { BridgeBrowser, buildAxState, parseKeyCombo, normalizeUrl, sameUrl } from "../src/bridge-browser.js";
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
      case "DOM.setFileInputFiles": return {};
      case "Emulation.setFocusEmulationEnabled": return {};
      case "Emulation.setDeviceMetricsOverride": return {};
      case "Emulation.clearDeviceMetricsOverride": return {};
      case "Page.setInterceptFileChooserDialog": return {};
      case "Page.bringToFront": return {};
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
      case "watchDownloads":
      case "unwatchDownloads":
      case "markTab":
      case "turnEnded": return null;
      case "nameSession": return { title: params.name, color: params.color, groupId: 12, groupedTabs: tabs.size, supported: true };
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
  assert.equal(normalizeUrl("file:///tmp/form.html"), "file:///tmp/form.html");
  assert.equal(normalizeUrl("/tmp/form.html"), "file:///tmp/form.html");
  assert.equal(normalizeUrl("./form.html"), `file://${process.cwd()}/form.html`);
  assert.equal(normalizeUrl("data:text/html,<h1>x</h1>"), "data:text/html,<h1>x</h1>");
});

test("sameUrl ignores the normalizations a browser applies", () => {
  assert.equal(sameUrl("https://example.com/", "https://example.com"), true);
  assert.equal(sameUrl("https://example.com/docs/", "https://example.com/docs"), true);
  assert.equal(sameUrl("https://example.com/?q=1", "https://example.com?q=1"), true);
  assert.equal(sameUrl("https://example.com/a", "https://example.com/b"), false);
  assert.equal(sameUrl("about:blank", "https://example.com"), false);
  assert.equal(sameUrl("file:///tmp/a.html", "file:///tmp/a.html"), true);
});

test("newTab creates, attaches, and activates a tab", async () => {
  const { browser, calls } = browserFixture();
  const tab = await browser.newTab();
  assert.equal(tab.tab_id, "2");
  assert.deepEqual(calls.filter((call) => call.kind === "rpc").map((call) => call.method), ["createTab", "attach", "executeCdp", "getTabs"]);
  assert.equal(cdpCalls(calls, "Emulation.setFocusEmulationEnabled").length, 1);
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
  assert.ok(cdpCalls(calls, "Emulation.setFocusEmulationEnabled").length >= 1);
  const mouse = cdpCalls(calls, "Input.dispatchMouseEvent");
  assert.deepEqual(mouse.map((call) => call.params.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
  assert.equal(mouse[0].params.buttons, 0);
  assert.equal(mouse[1].params.buttons, 1);
  assert.equal(mouse[2].params.buttons, 0);
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
  await browser.pressKey("Enter");
  const events = cdpCalls(calls, "Input.dispatchKeyEvent");
  assert.equal(events.length, 5);
  assert.equal(events[0].params.modifiers, 4);
  assert.equal(events[0].params.key, "a");
  assert.equal(events[0].params.windowsVirtualKeyCode, 65);
  assert.equal(events[2].params.type, "rawKeyDown");
  assert.equal(events[2].params.key, "Enter");
  assert.deepEqual(events[2].params.commands, ["insertNewline"]);
  assert.equal(events[3].params.type, "char");
  assert.equal(events[3].params.text, "\r");
  assert.equal(events[3].params.unmodifiedText, "\r");
  assert.equal(events[4].params.type, "keyUp");
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

test("assertReadOnly allows inspection and local loop/container state while blocking external writes", () => {
  assert.equal(assertReadOnly("document.querySelector('.x').innerText"), "document.querySelector('.x').innerText");
  assert.doesNotThrow(() => assertReadOnly("(() => { let sum = 0; for (let i = 0; i < 3; i++) { sum += i; } return sum; })()"));
  assert.doesNotThrow(() => assertReadOnly("(els) => { let c = 0; c += els.length; return c; }"));
  assert.doesNotThrow(() => assertReadOnly("(el) => ({ active: el.classList.contains('active'), id: el.dataset.id, display: el.style.display })"));
  assert.doesNotThrow(() => assertReadOnly("(el) => Object.keys(el.dataset)"));
  assert.doesNotThrow(() => assertReadOnly("(headings) => { const res = {}; headings.forEach((h, i) => { res.id = h + i; }); return res; }"));
  assert.doesNotThrow(() => assertReadOnly("(el) => { const arr = []; arr[0] = el.textContent; return arr; }"));
  assert.doesNotThrow(() => assertReadOnly("(keys) => { const c = {}; for (const k of keys) { c[k] = (c[k] || 0) + 1; c[k]++; } return c; }"));
  assert.doesNotThrow(() => assertReadOnly("(() => { const m = Object.create(null); m.x = 1; return m; })()"));
  assert.throws(() => assertReadOnly("undeclaredVar = 1"), /assignment is not allowed/);
  assert.throws(() => assertReadOnly("el.value = 'x'"), /assignment is not allowed/);
  assert.throws(() => assertReadOnly("el.style.color = 'red'"), /assignment is not allowed/);
  assert.throws(() => assertReadOnly("el.dataset.id = '1'"), /assignment is not allowed/);
  assert.throws(() => assertReadOnly("(el) => { const x = {}; ((x) => { x.value = '1'; })(el); }"), /assignment is not allowed/);
  assert.throws(() => assertReadOnly("(el) => { const r = {}; r.el = el; r.el.value = '1'; }"), /assignment is not allowed/);
  assert.throws(() => assertReadOnly("(el) => { let a = {}; a = el; a.value = '1'; }"), /assignment is not allowed/);
  assert.throws(() => assertReadOnly("(() => { const r = {}; r.__proto__ = {}; return r; })()"), /assignment is not allowed/);
  assert.throws(() => assertReadOnly("(() => { const r = {}; r['constructor'] = 1; return r; })()"), /assignment is not allowed/);
  assert.throws(() => assertReadOnly("(el) => { const r = {}; r[el.click()] = 1; return r; }"), /click\(\) is not allowed/);
  assert.throws(() => assertReadOnly("localStorage.setItem('a','b')"), /setItem\(\) is not allowed/);
  assert.throws(() => assertReadOnly("history.pushState({}, '', '/x')"), /pushState\(\) is not allowed/);
  assert.throws(() => assertReadOnly("delete document.body.dataset.x"), /delete is not allowed/);
  assert.throws(() => assertReadOnly("element.classList.add('x')"), /classList\.add\(\) is not allowed/);
  assert.throws(() => assertReadOnly("element.classList.remove('x')"), /remove\(\) is not allowed/);
  assert.throws(() => assertReadOnly("element.classList.toggle('x')"), /classList\.toggle\(\) is not allowed/);
  assert.throws(() => assertReadOnly("element.style.setProperty('color', 'red')"), /style\.setProperty\(\) is not allowed/);
  assert.throws(() => assertReadOnly("Object.assign(element, { title: 'x' })"), /Object\.assign\(\) is not allowed/);
  assert.throws(() => assertReadOnly("Reflect.set(element, 'title', 'x')"), /Reflect\.set\(\) is not allowed/);
});

test("post-action settle completes rapidly without stalling 5000ms when Network events precede domContentEventFired", async () => {
  const { browser } = browserFixture();
  await browser.newTab();
  browser.handleCdpEvent({
    source: { tabId: 2 },
    method: "Network.requestWillBeSent",
    params: { requestId: "req-1" },
  });
  const started = Date.now();
  await browser.locatorFill("testid=name", "Grace");
  await browser.locatorClick('role=button[name="Save"]');
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 500, `Expected fast settle < 500ms, got ${elapsed}ms`);
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

test("locatorClick auto-waits on retryable errors, fails fast on strict multiple match, and enforces timeout", async () => {
  let evalAttempts = 0;
  let mode = "retry-then-pass";
  const browser = new BridgeBrowser({
    request: async (method, params) => {
      if (method === "getTabs") return [{ id: 1, url: "https://example.com", title: "Ex" }];
      if (method === "attach") return null;
      if (method === "executeCdp") {
        const cdpMethod = params.method;
        if (cdpMethod === "Emulation.setFocusEmulationEnabled" || cdpMethod === "Input.dispatchMouseEvent") return {};
        if (cdpMethod === "Runtime.evaluate") {
          evalAttempts++;
          if (mode === "retry-then-pass") {
            return {
              result: {
                value: evalAttempts < 3
                  ? { error: "Locator did not match any element: css=.lazy", code: "not_found", retryable: true }
                  : { count: 1, x: 40, y: 80 },
              },
            };
          }
          if (mode === "multiple") {
            return {
              result: {
                value: { error: "Locator matched 2 elements", code: "multiple", retryable: false },
              },
            };
          }
          return {
            result: {
              value: { error: "Locator did not match any element: css=.never", code: "not_found", retryable: true },
            },
          };
        }
      }
      return {};
    },
    close: async () => {},
    sessionId: "s-auto",
    turnId: "t-auto",
  });

  await browser.locatorClick("css=.lazy", { timeoutMs: 1_000 });
  assert.equal(evalAttempts, 3);

  mode = "multiple";
  evalAttempts = 0;
  await assert.rejects(() => browser.locatorClick("css=.dup", { timeoutMs: 1_000 }), /matched 2 elements/);
  assert.equal(evalAttempts, 1);

  mode = "always-missing";
  await assert.rejects(
    () => browser.locatorClick("css=.never", { timeoutMs: 120 }),
    /Timed out after 120ms waiting for locator/,
  );
});

test("setViewport, resetViewport, networkLogs, ariaSnapshot child iframes, secondary actions, dialogs, and events", async () => {
  const { browser, calls } = browserFixture();
  await browser.newTab();

  // Viewport override + reset + bounds validation
  const vp = await browser.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  assert.equal(vp.width, 390);
  const setCall = cdpCalls(calls, "Emulation.setDeviceMetricsOverride").at(-1);
  assert.deepEqual(setCall.params, { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await browser.resetViewport();
  assert.equal(cdpCalls(calls, "Emulation.clearDeviceMetricsOverride").length, 1);
  await assert.rejects(() => browser.setViewport({ width: 50, height: 800 }), /between 100 and 4096/);

  // Network logs tracking & filtering
  browser.handleCdpEvent({
    source: { tabId: 2 },
    method: "Network.requestWillBeSent",
    params: { requestId: "r-ok", type: "Fetch", request: { url: "https://api.example.com/ok", method: "GET" } },
  });
  browser.handleCdpEvent({
    source: { tabId: 2 },
    method: "Network.responseReceived",
    params: { requestId: "r-ok", type: "Fetch", response: { url: "https://api.example.com/ok", status: 200, statusText: "OK", mimeType: "application/json" } },
  });
  browser.handleCdpEvent({
    source: { tabId: 2 },
    method: "Network.requestWillBeSent",
    params: { requestId: "r-err", type: "XHR", request: { url: "https://api.example.com/fail", method: "POST" } },
  });
  browser.handleCdpEvent({
    source: { tabId: 2 },
    method: "Network.loadingFailed",
    params: { requestId: "r-err", errorText: "net::ERR_FAILED" },
  });
  const allNet = await browser.networkLogs();
  assert.equal(allNet.count, 2);
  const failedNet = await browser.networkLogs({ failedOnly: true, filter: "fail" });
  assert.equal(failedNet.count, 1);
  assert.equal(failedNet.requests[0].errorText, "net::ERR_FAILED");
  await browser.networkLogs({ clear: true });
  assert.equal((await browser.networkLogs()).count, 0);

  // Secondary action + getJsDialog
  await browser.getState({ screenshot: false });
  await assert.rejects(() => browser.performSecondaryAction("1", "Collapse"), /does not support secondary action/);

  browser.handleCdpEvent({
    source: { tabId: 2 },
    method: "Page.javascriptDialogOpening",
    params: { type: "prompt", message: "Your name?", defaultPrompt: "Ada" },
  });
  const dlg = await browser.getJsDialog();
  assert.equal(dlg.type, "prompt");
  await dlg.accept("Grace");
  assert.equal(await browser.getJsDialog(), null);

  // Filechooser waitForEvent always disables intercept in finally
  const chooserPromise = browser.waitForEvent("filechooser", { timeoutMs: 1_000 });
  setTimeout(() => {
    browser.handleCdpEvent({
      source: { tabId: 2 },
      method: "Page.fileChooserOpened",
      params: { backendNodeId: 77, mode: "selectMultiple" },
    });
  }, 15);
  const chooser = await chooserPromise;
  assert.equal(chooser.isMultiple(), true);
  await chooser.setFiles(["/tmp/a.txt"]);
  const interceptCalls = cdpCalls(calls, "Page.setInterceptFileChooserDialog").map((c) => c.params.enabled);
  assert.deepEqual(interceptCalls, [true, false]);

  // Download waitForEvent arms watchDownloads, awaits Bridge.downloadChanged complete, and unwatches
  const dlPromise = browser.waitForEvent("download", { timeoutMs: 1_000 });
  setTimeout(() => {
    browser.handleCdpEvent({
      source: { tabId: 2 },
      method: "Bridge.downloadCreated",
      params: { id: 9, url: "https://example.com/export.csv", filename: "", state: "in_progress" },
    });
    setTimeout(() => {
      browser.handleCdpEvent({
        source: { tabId: 2 },
        method: "Bridge.downloadChanged",
        params: { id: 9, filename: "/tmp/export.csv", state: "complete" },
      });
    }, 15);
  }, 15);
  const dl = await dlPromise;
  assert.equal(await dl.path({ timeoutMs: 1_000 }), "/tmp/export.csv");
  assert.equal(dl.suggestedFilename, "export.csv");
  assert.ok(calls.some((c) => c.kind === "rpc" && c.method === "watchDownloads"));
  assert.ok(calls.some((c) => c.kind === "rpc" && c.method === "unwatchDownloads"));

  // Expandable AX node secondary action + ariaSnapshot merging child iframes
  const frameBridge = new BridgeBrowser({
    request: async (method, params) => {
      if (method === "getTabs") return [{ id: 5, url: "https://example.com", title: "Main" }];
      if (method === "attach") return null;
      if (method === "executeCdp") {
        if (params.method === "Page.getFrameTree") {
          return {
            frameTree: {
              frame: { id: "main", url: "https://example.com" },
              childFrames: [{ frame: { id: "child-1", url: "https://child.example/widget" }, childFrames: [] }],
            },
          };
        }
        if (params.method === "Accessibility.getFullAXTree" && params.commandParams?.frameId === "child-1") {
          return {
            nodes: [
              { nodeId: "c1", role: { value: "RootWebArea" }, name: { value: "Widget" }, childIds: ["c2"] },
              { nodeId: "c2", parentId: "c1", role: { value: "button" }, name: { value: "Inside Frame" }, backendDOMNodeId: 201 },
            ],
          };
        }
        if (params.method === "Accessibility.getFullAXTree") {
          return {
            nodes: [
              { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Main" }, childIds: ["2"] },
              {
                nodeId: "2",
                parentId: "1",
                role: { value: "button" },
                name: { value: "Menu" },
                backendDOMNodeId: 101,
                properties: [{ name: "expanded", value: { value: false } }],
              },
            ],
          };
        }
        if (params.method === "DOM.getBoxModel") return { model: { border: [0, 0, 20, 0, 20, 20, 0, 20] } };
      }
      return {};
    },
    close: async () => {},
    sessionId: "s-aria",
    turnId: "t-aria",
  });
  await frameBridge.getState({ screenshot: false });
  const sec = await frameBridge.performSecondaryAction("1", "expand");
  assert.equal(sec.performed, "Expand");
  const aria = await frameBridge.ariaSnapshot();
  assert.match(aria.text, /\[iframe child-1 \(https:\/\/child\.example\/widget\)\]/);
  assert.match(aria.text, /- button "Inside Frame"/);

  // nameSession validates name/color and updates sessionName
  const named = await browser.nameSession("  Research  ", { color: "purple" });
  assert.deepEqual(named, { ok: true, name: "Research", color: "purple", groupId: 12, groupedTabs: 2, supported: true });
  assert.deepEqual(browser.sessionName, { name: "Research", color: "purple" });
  await assert.rejects(() => browser.nameSession(""), /non-empty/);
  await assert.rejects(() => browser.nameSession("Test", { color: "magenta" }), /Unsupported tab group color/);
});

test("lazy Network.enable, event-driven navigation wait, 2-call setValue, cached iframe routing, and parallel child AX frames", async () => {
  const cdpCallsList = [];
  let browserRef = null;
  const frameSessions = new Map([[1, new Map([["f-co-1", "sess-1"], ["f-co-2", "sess-2"]])]]);

  const request = async (method, params = {}) => {
    if (method === "getTabs") return [{ id: 1, url: "about:blank", title: "Blank" }];
    if (method === "attach") return null;
    if (method === "navigateTab") {
      browserRef.handleCdpEvent({ source: { tabId: 1 }, method: "Page.frameStartedLoading", params: { frameId: "main" } });
      setTimeout(() => {
        browserRef.handleCdpEvent({
          source: { tabId: 1 },
          method: "Page.frameNavigated",
          params: { frame: { id: "main", url: params.url, loaderId: "l1" } },
        });
        browserRef.handleCdpEvent({ source: { tabId: 1 }, method: "Page.domContentEventFired", params: {} });
        browserRef.handleCdpEvent({ source: { tabId: 1 }, method: "Page.loadEventFired", params: {} });
      }, 10);
      return null;
    }
    if (method === "executeCdp") {
      const m = params.method;
      cdpCallsList.push({ method: m, sessionId: params.target?.sessionId ?? null, params: params.commandParams });
      if (m === "Accessibility.getFullAXTree") {
        const fid = params.commandParams?.frameId;
        if (fid === "f-co-1") {
          await new Promise((r) => setTimeout(r, 20));
          return { nodes: [{ nodeId: "c1", role: { value: "RootWebArea" }, name: { value: "F1" } }] };
        }
        if (fid === "f-co-2") {
          await new Promise((r) => setTimeout(r, 5));
          return { nodes: [{ nodeId: "c2", role: { value: "RootWebArea" }, name: { value: "F2" } }] };
        }
        return { nodes: AX_NODES };
      }
      if (m === "Page.getFrameTree") {
        return {
          frameTree: {
            frame: { id: "main", url: "https://example.com" },
            childFrames: [
              { frame: { id: "f-co-1", url: "https://a.example" }, childFrames: [] },
              { frame: { id: "f-co-2", url: "https://b.example" }, childFrames: [] },
            ],
          },
        };
      }
      if (m === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (m === "DOM.querySelector") return { nodeId: 99 };
      if (m === "DOM.describeNode") return { node: { frameId: "f-co-1" } };
      if (m === "DOM.resolveNode") return { object: { objectId: "obj-1" } };
      if (m === "Runtime.callFunctionOn") return { result: { value: "done" } };
      if (m === "Runtime.evaluate") {
        const expr = params.commandParams?.expression || "";
        if (expr.includes("Locator did not match")) return { result: { value: { count: 1, clicked: true } } };
        return { result: { value: { title: "Ex", url: "https://example.com" } } };
      }
      return {};
    }
    return {};
  };

  browserRef = new BridgeBrowser({
    request,
    close: async () => {},
    sessionId: "s-opt",
    turnId: "t-opt",
    frameSessions,
  });

  // 1. Default goto does NOT enable Network and uses 0 readyState/location polls when events fire.
  await browserRef.goto("https://example.com/one", 1, { waitUntil: "load", timeoutMs: 2_000 });
  assert.equal(cdpCallsList.some((c) => c.method === "Network.enable"), false);
  assert.equal(
    cdpCallsList.filter((c) => c.method === "Runtime.evaluate" && (c.params.expression === "document.readyState" || c.params.expression === "location.href")).length,
    0,
  );

  // 2. waitUntil: "networkidle" or networkLogs enables Network lazily with zero-buffer params.
  await browserRef.networkLogs({ tabId: 1 });
  const netCall = cdpCallsList.find((c) => c.method === "Network.enable");
  assert.deepEqual(netCall?.params, { maxTotalBufferSize: 0, maxResourceBufferSize: 0 });

  // 3. Concurrent child AX tree fetch preserves BFS order (F1 before F2 even though F2 finishes first).
  const state = await browserRef.getState({ tabId: 1, screenshot: false });
  assert.ok(state.axText.indexOf("frame f-co-1") < state.axText.indexOf("frame f-co-2"));

  // 4. setValue skips DOM.scrollIntoViewIfNeeded and DOM.focus (only DOM.resolveNode + Runtime.callFunctionOn).
  cdpCallsList.length = 0;
  await browserRef.setValue("2", "Ada", { tabId: 1 });
  assert.deepEqual(cdpCallsList.map((c) => c.method), ["DOM.resolveNode", "Runtime.callFunctionOn"]);

  // 5. #resolveFrameRoute caches across repeated iframe calls and invalidates on navRevision change.
  cdpCallsList.length = 0;
  await browserRef.locatorClick("css=#ok", { tabId: 1, frame: "iframe#pay" });
  await browserRef.locatorClick("css=#ok", { tabId: 1, frame: "iframe#pay" });
  assert.equal(cdpCallsList.filter((c) => c.method === "DOM.querySelector").length, 1);

  browserRef.handleCdpEvent({
    source: { tabId: 1 },
    method: "Page.frameNavigated",
    params: { frame: { id: "main", url: "https://example.com/two" } },
  });
  await browserRef.locatorClick("css=#ok", { tabId: 1, frame: "iframe#pay" });
  assert.equal(cdpCallsList.filter((c) => c.method === "DOM.querySelector").length, 2);
});

test("stateful __buRt caches locator helper (~300B per call) and passive getContent avoids debugger attach", async () => {
  const vmCtx = vm.createContext({
    document: {},
    window: { innerWidth: 1280, innerHeight: 800, getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }) },
    CSS: { escape: (s) => String(s) },
    HTMLInputElement: class {},
    HTMLButtonElement: class {},
    HTMLTextAreaElement: class {},
    HTMLSelectElement: class {},
    HTMLElement: class {},
    ShadowRoot: class {},
    MutationObserver: class { observe() {} disconnect() {} },
    InputEvent: class { constructor(t) { this.type = t; } },
    Event: class { constructor(t) { this.type = t; } },
  });
  const btn = {
    nodeType: 1, tagName: "BUTTON", id: "save", innerText: "Save", textContent: "Save",
    children: [], childNodes: [], labels: [], shadowRoot: null,
    getAttribute: (k) => (k === "id" ? "save" : null),
    hasAttribute: (k) => k === "id",
    matches: () => false, closest: () => null, scrollIntoView() {}, focus() {},
    getBoundingClientRect: () => ({ left: 10, top: 20, right: 90, bottom: 50, x: 10, y: 20, width: 80, height: 30 }),
  };
  btn.ownerDocument = {
    defaultView: vmCtx.window,
    querySelectorAll: (css) => (css === "#save" ? [btn] : []),
    elementFromPoint: () => btn,
    getElementById: (id) => (id === "save" ? btn : null),
  };
  vmCtx.document = { ...btn.ownerDocument, documentElement: btn, children: [btn] };

  const evalExpressions = [];
  const attachedTabs = [];
  const request = async (method, params = {}) => {
    if (method === "getTabs") return [{ id: 1, url: "https://example.com", title: "Ex" }];
    if (method === "getUserTabs") return [{ id: 2, url: "https://user.example", title: "User Tab", owned: false, origin: "user" }];
    if (method === "readTabContext") return { title: "User Tab", url: "https://user.example", format: "text", text: "Passive body", truncated: false };
    if (method === "attach") { attachedTabs.push(params.tabId); return null; }
    if (method === "executeCdp" && params.method === "Runtime.evaluate") {
      evalExpressions.push(params.commandParams.expression);
      const val = vm.runInNewContext(params.commandParams.expression, vmCtx);
      return { result: { value: val } };
    }
    return {};
  };

  const browser = new BridgeBrowser({
    request,
    close: async () => {},
    sessionId: "s-rt",
    turnId: "t-rt",
    info: { apiSupportOverrides: { "BrowserUser.openTabs": true, "BrowserUser.getTabContext": true } },
  });

  // Passive getContent on unclaimed user tab 2 should NOT attach chrome.debugger!
  const passive = await browser.getContent(2);
  assert.equal(passive.text, "Passive body");
  assert.equal(passive.passive, true);
  assert.equal(attachedTabs.includes(2), false);

  // Stateful tab 1: first locator installs __buRt once, subsequent calls send tiny invocation (<400B).
  await browser.locatorCount("css=#save", { tabId: 1 });
  await browser.locatorClick("css=#save", { tabId: 1 });
  await browser.locatorText("css=#save", { tabId: 1 });
  assert.ok(evalExpressions[0].includes("Object.defineProperty(globalThis"));
  assert.ok(evalExpressions[1].length < 400);
  assert.ok(evalExpressions[2].length < 400);
  assert.ok(evalExpressions[3].length < 400);
});

test("screenshot caps wide viewports at maxWidth and batch supports get_content and evaluate", async () => {
  const calls = [];
  const browser = new BridgeBrowser({
    request: async (method, params = {}) => {
      calls.push({ method, params });
      if (method === "getTabs") return [{ id: 1, url: "https://example.com", title: "Ex" }];
      if (method === "attach") return null;
      if (method === "executeCdp") {
        const m = params.method;
        if (m === "Page.getLayoutMetrics") {
          return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 2560, clientHeight: 1440 } };
        }
        if (m === "Runtime.evaluate") {
          const expr = String(params.commandParams?.expression || "");
          if (expr === "window.devicePixelRatio") return { result: { value: 2 } };
          if (expr.includes("format =") || expr.includes("FORMAT = \"markdown\"")) {
            return { result: { value: { format: "markdown", text: "# Clean", content: "# Clean", truncated: false } } };
          }
          if (expr === "document.title") return { result: { value: "Ex Title" } };
          return { result: { value: { title: "Ex", url: "https://example.com" } } };
        }
        if (m === "Page.captureScreenshot") return { data: "abc" };
      }
      return {};
    },
    close: async () => {},
    sessionId: "s-cap",
    turnId: "t-cap",
  });

  await browser.screenshot(1, { maxWidth: 1280 });
  const shot = calls.find((c) => c.method === "executeCdp" && c.params.method === "Page.captureScreenshot");
  assert.equal(shot.params.commandParams.quality, 75);
  assert.equal(shot.params.commandParams.clip.scale, 0.25);

  const batchRes = await browser.batch([
    { action: "get_content", format: "markdown", max_chars: 2000 },
    { action: "evaluate", expression: "document.title" },
  ], { tabId: 1, returnState: "none" });
  assert.equal(batchRes.ok, true);
  assert.equal(batchRes.completed_steps[0].result.text, "# Clean");
  assert.equal(batchRes.completed_steps[1].result.value, "Ex Title");
});

test("unified AX baseline shares unchanged and diff state between ariaSnapshot() and getState()", async () => {
  let axNodes = [
    { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Ex" }, backendDOMNodeId: 1, childIds: ["2"] },
    { nodeId: "2", parentId: "1", role: { value: "button" }, name: { value: "Save" }, backendDOMNodeId: 20 },
  ];
  const browser = new BridgeBrowser({
    request: async (method, params = {}) => {
      if (method === "getTabs") return [{ id: 1, url: "https://example.com", title: "Ex" }];
      if (method === "attach") return null;
      if (method === "executeCdp") {
        if (params.method === "Accessibility.getFullAXTree") return { nodes: axNodes };
        if (params.method === "Page.getFrameTree") return { frameTree: { frame: { id: "f1", url: "https://example.com" }, childFrames: [] } };
        if (params.method === "Runtime.evaluate") return { result: { value: { title: "Ex", url: "https://example.com" } } };
      }
      return {};
    },
    close: async () => {},
    sessionId: "s-unify",
    turnId: "t-unify",
  });

  await browser.ariaSnapshot({ tabId: 1 });
  const unchangedAllowed = await browser.getState(1, { screenshot: false, diff: true, allowUnindexedBaseline: true });
  assert.equal(unchangedAllowed.mode, "unchanged");
  assert.match(unchangedAllowed.axText, /No accessibility changes since last ariaSnapshot\(\)\./);

  await browser.ariaSnapshot({ tabId: 1 });
  const needsIndices = await browser.getState(1, { screenshot: false, diff: true });
  assert.equal(needsIndices.mode, "full");
  assert.match(needsIndices.axText, /\d+ button "Save"/);

  await browser.ariaSnapshot({ tabId: 1 });
  axNodes = [
    { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Ex" }, backendDOMNodeId: 1, childIds: ["2", "3"] },
    { nodeId: "2", parentId: "1", role: { value: "button" }, name: { value: "Save" }, backendDOMNodeId: 20 },
    { nodeId: "3", parentId: "1", role: { value: "textbox" }, name: { value: "Email" }, backendDOMNodeId: 30 },
  ];
  const changedDiff = await browser.getState(1, { screenshot: false, diff: true });
  assert.equal(changedDiff.mode, "diff");
  assert.match(changedDiff.axText, /\[added\]/);
  assert.match(changedDiff.axText, /textbox "Email"/);
});

test("locatorAriaSnapshot skips error objectIds on missed first attempt and retries cleanly until element mounts", async () => {
  const rpcCalls = [];
  let attempts = 0;
  const browser = new BridgeBrowser({
    request: async (method, params = {}) => {
      rpcCalls.push({ method, cdpMethod: params.method, params });
      if (method === "getTabs") return [{ id: 1, url: "https://example.com", title: "Ex" }];
      if (method === "attach") return null;
      if (method === "executeCdp") {
        if (params.method === "Runtime.evaluate") {
          attempts += 1;
          if (attempts === 1) {
            return {
              result: { type: "object", subtype: "error", objectId: "err-1" },
              exceptionDetails: { exception: { description: "Error: Locator did not match any element: role=dialog" } },
            };
          }
          return { result: { type: "object", objectId: "node-1" } };
        }
        if (params.method === "DOM.describeNode") {
          assert.equal(params.commandParams?.objectId, "node-1");
          return { node: { backendNodeId: 50 } };
        }
        if (params.method === "Accessibility.getFullAXTree") {
          return {
            nodes: [
              { nodeId: "root", role: { value: "RootWebArea" }, backendDOMNodeId: 1, childIds: ["dlg"] },
              { nodeId: "dlg", parentId: "root", role: { value: "dialog" }, name: { value: "Details" }, backendDOMNodeId: 50, childIds: ["close"] },
              { nodeId: "close", parentId: "dlg", role: { value: "button" }, name: { value: "Close" }, backendDOMNodeId: 51 },
            ],
          };
        }
      }
      return {};
    },
    close: async () => {},
    sessionId: "s-retry",
    turnId: "t-retry",
  });

  const snap = await browser.locatorAriaSnapshot("role=dialog", { tabId: 1, timeoutMs: 500 });
  assert.equal(attempts, 2);
  assert.equal(snap.text, '- dialog "Details"\n  - button "Close"');
  const releases = rpcCalls
    .filter((c) => c.cdpMethod === "Runtime.releaseObject")
    .map((c) => c.params.commandParams?.objectId);
  assert.deepEqual(releases, ["err-1", "node-1"]);
});

test("endTurn clears attached/owned state cleanly and #cdp auto-reattaches after Debugger unattached", async () => {
  let nextId = 1;
  const owned = new Set();
  const attached = new Set();
  const tabUrls = new Map();
  const calls = [];
  let failOnceWithUnattached = false;

  const browser = new BridgeBrowser({
    request: async (method, params = {}) => {
      calls.push({ method, params });
      if (method === "createTab") {
        const id = nextId++;
        owned.add(id);
        tabUrls.set(id, "about:blank");
        return { id, url: "about:blank", title: "Blank" };
      }
      if (method === "getTabs") {
        return [...owned].map((id) => ({ id, url: tabUrls.get(id) ?? "https://example.com", title: "Ex" }));
      }
      if (method === "navigateTab") {
        tabUrls.set(params.tabId, params.url);
        return null;
      }
      if (method === "attach") {
        if (!owned.has(params.tabId)) throw new Error("Browser tab is unavailable to this session");
        attached.add(params.tabId);
        return null;
      }
      if (method === "markTab") return null;
      if (method === "turnEnded") {
        attached.clear();
        return null;
      }
      if (method === "executeCdp") {
        const id = params.target?.tabId;
        if (!attached.has(id) || failOnceWithUnattached) {
          failOnceWithUnattached = false;
          attached.delete(id);
          throw new Error("Debugger unattached");
        }
        if (params.method === "Runtime.evaluate") {
          const expr = params.commandParams?.expression;
          if (expr === "location.href") return { result: { value: tabUrls.get(id) ?? "about:blank" } };
          if (expr === "document.readyState") return { result: { value: "complete" } };
          return { result: { value: "ok" } };
        }
        return {};
      }
      return {};
    },
    close: async () => {},
    sessionId: "s-reattach",
    turnId: "t-1",
  });

  // Handoff tab survives turnEnded in backend, so next turn re-attaches automatically instead of seeing stale attached state
  const tab1 = await browser.newTab();
  const handoffId = Number(tab1.tab_id);
  await browser.endTurn({ keep: [{ tab_id: handoffId, mode: "handoff" }] });
  assert.equal(browser.attached.has(handoffId), false);
  assert.equal(browser.ownedTabs.has(handoffId), true);
  const titleRes = await browser.evaluate("document.title", { tabId: handoffId });
  assert.equal(titleRes.value, "ok");

  // Mid-turn sudden Debugger unattached triggers automatic single re-attach & retry
  failOnceWithUnattached = true;
  const retriedRes = await browser.evaluate("document.title", { tabId: handoffId });
  assert.equal(retriedRes.value, "ok");
  assert.ok(calls.filter((c) => c.method === "attach" && c.params.tabId === handoffId).length >= 2);

  // Deliverable tab is purged from ownedTabs/activeTabId on endTurn so next goto auto-creates instead of failing
  await browser.endTurn({ keep: [{ tab_id: handoffId, mode: "deliverable" }] });
  owned.delete(handoffId);
  assert.equal(browser.ownedTabs.has(handoffId), false);
  assert.equal(browser.activeTabId, null);
  const fresh = await browser.goto("https://example.com");
  assert.equal(fresh.tab_id, "2");
});

test("endTurn suppresses focus stealing by default, honors opt-in BROWSER_USE_ALLOW_TAB_FOCUS=1, and delegates group helpers", async () => {
  const { browser, calls } = browserFixture();
  const extraCalls = [];
  const origRequest = browser.request;
  browser.request = async (method, params) => {
    if (["listTabGroups", "ungroupTabs", "cleanupGroups"].includes(method)) {
      extraCalls.push({ method, params });
      if (method === "listTabGroups") return [{ id: 12, title: "QA", tabCount: 1 }];
      return { ok: true };
    }
    return await origRequest(method, params);
  };

  browser.sessionName = { name: "QA", color: "blue" };
  await browser.getState({ screenshot: false });
  const prevEnv = process.env.BROWSER_USE_ALLOW_TAB_FOCUS;
  delete process.env.BROWSER_USE_ALLOW_TAB_FOCUS;
  try {
    const beforeTurn = browser.turnId;
    const endRes = await browser.endTurn({
      keep: [{ tab_id: "1", mode: "deliverable", focus: true }],
      ungroup: true,
    });
    assert.equal(endRes.ungrouped, true);
    assert.equal(browser.sessionName, null);

    const markCall = calls.find((c) => c.kind === "rpc" && c.method === "markTab");
    assert.deepEqual(markCall.params, {
      session_id: "session-1",
      turn_id: beforeTurn,
      tabId: 1,
      status: "deliverable",
    });
    assert.equal(calls.some((c) => c.kind === "cdp" && c.method === "Page.bringToFront"), false);
    const endedCall = calls.find((c) => c.kind === "rpc" && c.method === "turnEnded");
    assert.deepEqual(endedCall.params, {
      session_id: "session-1",
      turn_id: beforeTurn,
      ungroup: true,
    });

    process.env.BROWSER_USE_ALLOW_TAB_FOCUS = "1";
    await browser.getState({ screenshot: false });
    const optTurn = browser.turnId;
    await browser.endTurn({
      keep: [{ tab_id: "1", mode: "deliverable", focus: true }],
    });
    const optMarkCall = calls.filter((c) => c.kind === "rpc" && c.method === "markTab").at(-1);
    assert.deepEqual(optMarkCall.params, {
      session_id: "session-1",
      turn_id: optTurn,
      tabId: 1,
      status: "deliverable",
      focus: true,
    });
    assert.equal(calls.some((c) => c.kind === "cdp" && c.method === "Page.bringToFront"), true);
  } finally {
    if (prevEnv === undefined) delete process.env.BROWSER_USE_ALLOW_TAB_FOCUS;
    else process.env.BROWSER_USE_ALLOW_TAB_FOCUS = prevEnv;
  }

  const groups = await browser.listTabGroups();
  assert.equal(groups.length, 1);
  await browser.ungroupTabs(["1"]);
  await browser.cleanupGroups({ ungroupFinished: true, keepTabIds: [1] });
  assert.deepEqual(extraCalls.map((c) => c.method), ["listTabGroups", "ungroupTabs", "cleanupGroups"]);
});
