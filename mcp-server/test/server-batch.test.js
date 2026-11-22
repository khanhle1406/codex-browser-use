import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BridgeBrowser } from "../src/bridge-browser.js";
import { createStandaloneServer } from "../src/server.js";

function richMockBridge() {
  const tabs = new Map();
  let nextTab = 10;
  let pageUrl = "about:blank";
  let pageTitle = "Blank";
  let valueText = "";
  let selectValue = "free";
  let uploaded = [];
  const calls = [];

  const cdp = async (tabId, _sessionId, method, params = {}) => {
    calls.push({ kind: "cdp", tabId, method, params });
    switch (method) {
      case "Page.enable":
      case "Page.setLifecycleEventsEnabled":
      case "Runtime.enable":
      case "Network.enable":
      case "Accessibility.enable":
      case "DOM.enable":
      case "DOM.scrollIntoViewIfNeeded":
      case "DOM.focus":
      case "Emulation.setFocusEmulationEnabled":
      case "Emulation.setDeviceMetricsOverride":
      case "Emulation.clearDeviceMetricsOverride":
      case "Page.setInterceptFileChooserDialog":
      case "Page.bringToFront":
      case "Runtime.releaseObject":
        return {};
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: "main-frame", loaderId: "loader-1", url: tabs.get(tabId)?.url ?? pageUrl }, childFrames: [] } };
      case "Page.navigate": {
        pageUrl = params.url;
        pageTitle = "App";
        const tab = tabs.get(tabId);
        if (tab) {
          tab.url = pageUrl;
          tab.title = pageTitle;
        }
        return { frameId: "main-frame" };
      }
      case "Page.getLayoutMetrics":
        return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 800 }, cssLayoutViewport: { clientWidth: 1280, clientHeight: 800 } };
      case "Page.captureScreenshot":
        return { data: "LzlqLzRBQVFTa1pKUmdBQkFRQUFBUUFC" };
      case "Page.close":
        tabs.delete(tabId);
        return {};
      case "Page.handleJavaScriptDialog":
        return {};
      case "Network.getResponseBody":
        return { body: JSON.stringify({ ok: true, requestId: params.requestId }), base64Encoded: false };
      case "Accessibility.getFullAXTree":
        return {
          nodes: [
            { nodeId: "1", role: { value: "RootWebArea" }, name: { value: pageTitle }, backendDOMNodeId: 1, childIds: ["2", "3", "4"] },
            { nodeId: "2", parentId: "1", role: { value: "textbox" }, name: { value: "Email" }, value: { value: valueText }, backendDOMNodeId: 20 },
            { nodeId: "3", parentId: "1", role: { value: "button" }, name: { value: "Save" }, backendDOMNodeId: 30 },
            { nodeId: "4", parentId: "1", role: { value: "combobox" }, name: { value: "Plan" }, value: { value: selectValue }, backendDOMNodeId: 40 },
          ],
        };
      case "DOM.getContentQuads":
        return { quads: [[10, 20, 110, 20, 110, 60, 10, 60]] };
      case "DOM.getBoxModel":
        return { model: { border: [10, 20, 110, 20, 110, 60, 10, 60] } };
      case "DOM.resolveNode":
        return { object: { objectId: "obj-1" } };
      case "DOM.getDocument":
        return { root: { nodeId: 1 } };
      case "DOM.querySelector":
        return { nodeId: params.selector.includes("missing") ? 0 : 77 };
      case "DOM.describeNode":
        return { node: { backendNodeId: 77 } };
      case "DOM.setFileInputFiles":
        uploaded = params.files;
        return {};
      case "Runtime.callFunctionOn":
        if (params.functionDeclaration.includes("createTreeWalker")) {
          return { result: { value: { selected: true, start: 0, end: 4 } } };
        }
        if (params.functionDeclaration.includes("hitsTarget")) {
          return { result: { value: { hitsTarget: true, point: { x: 60, y: 40 }, width: 100, height: 40 } } };
        }
        if (params.functionDeclaration.includes("HTMLSelectElement") && params.arguments?.[0]?.value) {
          const spec = params.arguments[0].value;
          if (Array.isArray(spec)) {
            selectValue = spec[0]?.value ?? spec[0]?.label ?? "pro";
            return { result: { value: [selectValue] } };
          }
          valueText = String(spec);
          return { result: { value: "done" } };
        }
        return { result: { value: "done" } };
      case "Input.dispatchMouseEvent":
      case "Input.dispatchKeyEvent":
      case "Input.insertText":
        return {};
      case "Runtime.evaluate": {
        const expr = params.expression;
        const tabUrl = tabs.get(tabId)?.url ?? pageUrl;
        const tabTitle = tabs.get(tabId)?.title ?? pageTitle;
        if (expr === "location.href") return { result: { value: tabUrl } };
        if (expr === "document.title") return { result: { value: tabTitle } };
        if (expr === "document.readyState") return { result: { value: "complete" } };
        if (expr === "window.devicePixelRatio") return { result: { value: 2 } };
        if (expr.includes("document.body ? document.body.innerText")) return { result: { value: `Email=${valueText} Plan=${selectValue}` } };
        if (expr.includes("BOILERPLATE_TAGS")) {
          return {
            result: {
              value: {
                title: tabTitle,
                url: tabUrl,
                format: expr.includes('"links"') ? "links" : (expr.includes('"tables"') ? "tables" : "markdown"),
                content: `# ${tabUrl}`,
                text: `# ${tabUrl}`,
                ...(expr.includes('"links"') ? { links: [{ text: "Item", href: `${tabUrl}/item` }] } : {}),
                ...(expr.includes('"tables"') ? { tables: [[["H1", "H2"], ["a", "b"]]] } : {}),
                truncated: false,
              },
            },
          };
        }
        if (expr.includes("document.elementsFromPoint")) {
          return { result: { value: { x: 60, y: 40, elements: [{ tagName: "button", candidates: ['role=button[name="Save"]'] }] } } };
        }
        if (expr.includes("<!-- same-origin iframe -->")) {
          return { result: { value: { title: tabTitle, url: tabUrl, truncated: false, snapshot: '<button role="button">Save</button>' } } };
        }
        if (expr.startsWith("({title:") || expr.startsWith("({ title:")) return { result: { value: { title: tabTitle, url: tabUrl } } };
        if (expr.includes("Locator did not match")) {
          if (expr.includes("missing")) return { result: { value: { error: "Locator did not match any element: missing" } } };
          if (expr.includes('const mutation = "wait"')) return { result: { value: { count: 1, visibleCount: 1, satisfied: true } } };
          if (expr.includes('const mutation = "hover"')) return { result: { value: { count: 1, hovered: true, x: 60, y: 40 } } };
          if (expr.includes('const mutation = "box"')) return { result: { value: { count: 1, box: { x: 10, y: 20, width: 100, height: 40 } } } };
          if (expr.includes('const mutation = "select"')) return { result: { value: { count: 1, selected: ["pro"] } } };
          if (expr.includes('const mutation = "check"')) return { result: { value: { count: 1, changed: true, checked: true, x: 60, y: 40 } } };
          if (expr.includes('const mutation = "uncheck"')) return { result: { value: { count: 1, changed: true, checked: false, x: 60, y: 40 } } };
          if (expr.includes('const mutation = "evalAll"')) return { result: { value: { count: 2, value: ["free", "pro"] } } };
          if (expr.includes('const mutation = "eval"')) return { result: { value: { count: 1, value: "Save" } } };
          if (expr.includes('const mutation = "count"')) return { result: { value: { count: 2 } } };
          if (expr.includes('const mutation = "text"') || expr.includes('const mutation = "textContent"') || expr.includes('const mutation = "innerText"')) {
            return { result: { value: { count: 1, text: "Save" } } };
          }
          if (expr.includes('const mutation = "attr"')) return { result: { value: { count: 1, value: "btn-save" } } };
          if (expr.includes('const mutation = "inputValue"')) return { result: { value: { count: 1, value: valueText } } };
          if (expr.includes('const mutation = "clear"')) return { result: { value: { count: 1, cleared: true } } };
          if (expr.includes('const mutation = "focus"')) return { result: { value: { count: 1, focused: true } } };
          if (expr.includes('const mutation = "scrollIntoView"')) return { result: { value: { count: 1, scrolled: true, box: { x: 10, y: 20, width: 100, height: 40 } } } };
          if (expr.includes('const mutation = "allTextContents"') || expr.includes('const mutation = "allInnerTexts"')) {
            return { result: { value: { count: 2, values: ["A", "B"] } } };
          }
          if (expr.includes('const mutation = "isVisible"') || expr.includes('const mutation = "isEnabled"') || expr.includes('const mutation = "isChecked"')) {
            return { result: { value: { value: true } } };
          }
          return { result: { value: { count: 1, x: 60, y: 40 } } };
        }
        try {
          const val = vm.runInNewContext(expr, {
            document: { title: tabTitle, body: { innerText: `Email=${valueText}` } },
            location: { href: tabUrl },
          });
          return { result: { value: val } };
        } catch {
          return { result: { value: null } };
        }
      }
      default:
        throw new Error(`Unexpected CDP method: ${method}`);
    }
  };

  const request = async (method, params = {}) => {
    calls.push({ kind: "rpc", method, params });
    if (method === "executeCdp") return cdp(params.target.tabId, params.target.sessionId, params.method, params.commandParams);
    switch (method) {
      case "getInfo": return { type: "extension", family: "chrome", name: "Mock", version: "0.5.4" };
      case "getTabs": return [...tabs.values()];
      case "createTab": {
        const id = nextTab++;
        tabs.set(id, { id, url: "about:blank", title: "Blank" });
        return tabs.get(id);
      }
      case "navigateTab":
        pageUrl = params.url;
        pageTitle = "App";
        tabs.get(params.tabId).url = pageUrl;
        tabs.get(params.tabId).title = pageTitle;
        return null;
      case "nameSession":
        return { title: params.name, color: params.color, groupId: 25, groupedTabs: tabs.size, supported: true };
      case "attach":
      case "watchDownloads":
      case "unwatchDownloads":
      case "markTab":
      case "turnEnded":
        return null;
      default:
        throw new Error(`Unexpected rpc: ${method}`);
    }
  };

  const browser = new BridgeBrowser({ request, close: async () => {}, sessionId: "s-1", turnId: "t-1" });
  return { browser, calls, getUploaded: () => uploaded };
}

test("MCP server exposes 36 tools and runs batch, diff-first state, CSS-scaled JPEG screenshots, and specialized tools", async (t) => {
  const { browser, calls, getUploaded } = richMockBridge();
  const server = createStandaloneServer({ getBrowser: async () => browser, resetBrowser: async () => {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const listed = await client.listTools();
  assert.equal(listed.tools.length, 36);
  assert.ok(listed.tools.some((tool) => tool.name === "browser_run"));
  assert.ok(listed.tools.some((tool) => tool.name === "browser_batch"));
  assert.ok(listed.tools.some((tool) => tool.name === "browser_upload_files"));
  assert.ok(listed.tools.some((tool) => tool.name === "browser_network_logs"));
  assert.ok(listed.tools.some((tool) => tool.name === "browser_set_viewport"));
  assert.ok(listed.tools.some((tool) => tool.name === "browser_name_session"));

  // 1. browser_goto auto-creates a tab and returns <ax_state> without requiring new_tab first
  const nav = await client.callTool({ name: "browser_goto", arguments: { url: "https://example.com" } });
  assert.notEqual(nav.isError, true);
  assert.match(nav.content[0].text, /1 textbox "Email"/);
  assert.equal(nav.content.some((c) => c.type === "image"), false);

  // 2. Second browser_get_state defaults to diff + no screenshot -> unchanged
  const unchanged = await client.callTool({ name: "browser_get_state", arguments: {} });
  assert.match(unchanged.content[0].text, /No accessibility changes/);
  assert.equal(unchanged.content.some((c) => c.type === "image"), false);

  // 3. browser_batch chains set_value + select_option + click + wait in one MCP call and returns diff
  const batched = await client.callTool({
    name: "browser_batch",
    arguments: {
      steps: [
        { action: "set_value", element_index: "1", value: "ada@example.com" },
        { action: "select_option", element_index: "3", value: "pro" },
        { action: "click", element_index: "2" },
        { action: "wait", selector: "css=.done" },
      ],
      return_state: "diff",
    },
  });
  assert.notEqual(batched.isError, true);
  assert.match(batched.content[0].text, /"completed_steps":4/);
  assert.match(batched.content[0].text, /ada@example\.com/);

  // 4. Failing step in browser_batch stops cleanly and returns diagnostics + current state
  const failedBatch = await client.callTool({
    name: "browser_batch",
    arguments: {
      steps: [
        { action: "hover", element_index: "2" },
        { action: "locator_click", selector: "css=.missing" },
      ],
      return_state: "full",
    },
  });
  assert.equal(failedBatch.isError, true);
  assert.match(failedBatch.content[0].text, /"failed_step":1/);
  assert.match(failedBatch.content[0].text, /<ax_state>/);

  // 5. Screenshot defaults to JPEG quality 80 with 1x CSS scale when DPR=2
  const shot = await client.callTool({ name: "browser_screenshot", arguments: {} });
  assert.equal(shot.content[0].mimeType, "image/jpeg");
  const lastCap = calls.filter((c) => c.method === "Page.captureScreenshot").at(-1);
  assert.equal(lastCap.params.format, "jpeg");
  assert.equal(lastCap.params.clip.scale, 0.5);

  // 6. Specialized tools: upload, drag, inspect_element, dom_snapshot, console_logs
  const up = await client.callTool({
    name: "browser_upload_files",
    arguments: { selector: "css=input[type=file]", files: ["/tmp/demo.txt"] },
  });
  assert.notEqual(up.isError, true);
  assert.deepEqual(getUploaded(), ["/tmp/demo.txt"]);

  const dragRes = await client.callTool({
    name: "browser_drag",
    arguments: { from_x: 10, from_y: 10, to_x: 100, to_y: 50, steps: 3 },
  });
  assert.notEqual(dragRes.isError, true);

  const inspect = await client.callTool({ name: "browser_inspect_element", arguments: { x: 60, y: 40 } });
  assert.match(inspect.content[0].text, /role=button/);

  const snap = await client.callTool({ name: "browser_dom_snapshot", arguments: {} });
  assert.match(snap.content[0].text, /Save/);

  // Feed console + dialog CDP events and verify console_logs + dialog AX rendering
  browser.handleCdpEvent({
    source: { tabId: 10 },
    method: "Runtime.consoleAPICalled",
    params: { type: "error", args: [{ value: "Boom" }] },
  });
  const logs = await client.callTool({ name: "browser_console_logs", arguments: { levels: ["error"] } });
  assert.match(logs.content[0].text, /Boom/);

  browser.handleCdpEvent({
    source: { tabId: 10 },
    method: "Page.javascriptDialogOpening",
    params: { type: "confirm", message: "Delete item?" },
  });
  const dialogState = await client.callTool({ name: "browser_get_state", arguments: {} });
  assert.match(dialogState.content[0].text, /JavaScript confirm dialog/);
  assert.match(dialogState.content[0].text, /<notifications>/);

  // 7. browser_batch can end_turn and keep tab inline
  await client.callTool({ name: "browser_handle_dialog", arguments: { accept: true } });
  const batchEnd = await client.callTool({
    name: "browser_batch",
    arguments: {
      steps: [{ action: "wait", selector: "css=.done" }],
      return_state: "none",
      end_turn: true,
      keep: "deliverable",
    },
  });
  assert.notEqual(batchEnd.isError, true);
  assert.match(batchEnd.content[0].text, /"ended": true/);
  assert.ok(calls.some((c) => c.kind === "rpc" && c.method === "markTab" && c.params.status === "deliverable"));
});

test("browser_run executes 1-shot script, viewImage, read-only guards, inline deliverable end_turn, and timeout", async (t) => {
  const { browser, calls } = richMockBridge();
  const server = createStandaloneServer({ getBrowser: async () => browser, resetBrowser: async () => {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-run-agent", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  // 1-shot script: goto -> fill -> click -> evaluate(fn) -> viewImage -> markDeliverable
  const okRun = await client.callTool({
    name: "browser_run",
    arguments: {
      code: `
        await page.goto("https://example.com");
        await page.fill('css=input[name="email"]', "grace@example.com");
        await page.click("css=button.save");
        const meta = await page.evaluate(() => ({ title: document.title, url: location.href }));
        log("visited", meta.url);
        await viewImage();
        page.markDeliverable();
        return { title: meta.title, url: meta.url };
      `,
    },
  });
  assert.notEqual(okRun.isError, true);
  const body = JSON.parse(okRun.content[0].text);
  assert.equal(body.ok, true);
  assert.equal(body.result.url, "https://example.com");
  assert.equal(body.end_turn.ended, true);
  assert.match(body.logs[0], /visited https:\/\/example\.com/);
  assert.equal(okRun.content[1].type, "image");
  assert.equal(okRun.content[1].mimeType, "image/jpeg");
  assert.equal(calls.some((c) => c.kind === "cdp" && c.method === "Page.bringToFront"), false);
  assert.ok(calls.some((c) => c.kind === "rpc" && c.method === "markTab" && c.params.status === "deliverable"));

  // Read-only evaluate rejection skips noisy <ax_state> dump
  await client.callTool({ name: "browser_goto", arguments: { url: "https://example.com" } });
  const badEval = await client.callTool({
    name: "browser_run",
    arguments: {
      code: `await page.evaluate("document.title = 'hacked'");`,
    },
  });
  assert.equal(badEval.isError, true);
  assert.match(badEval.content[0].text, /read-only/i);
  assert.doesNotMatch(badEval.content[0].text, /<ax_state>/);

  // Timeout enforcement
  const timedOut = await client.callTool({
    name: "browser_run",
    arguments: {
      timeout_ms: 500,
      code: `await sleep(5000); return "late";`,
    },
  });
  assert.equal(timedOut.isError, true);
  assert.match(timedOut.content[0].text, /timed out/i);
});

test("browser_run persists variables & locators across turns, supports fluent check/evaluateAll/ariaSnapshot, and resets cleanly", async (t) => {
  const { browser } = richMockBridge();
  const server = createStandaloneServer({ getBrowser: async () => browser, resetBrowser: async () => {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-persistent-run", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  // Turn 1: create top-level state, fluent Locator, check, evaluateAll, and ariaSnapshot
  const r1 = await client.callTool({
    name: "browser_run",
    arguments: {
      code: `
        await page.goto("https://example.com");
        const saveBtn = page.getByRole("button", { name: "Save", exact: true }).filter({ visible: true }).first();
        await page.getByRole("checkbox", { name: /Agree/i }).check();
        const opts = await page.getByRole("radio").evaluateAll((els) => els.map((e) => e.id));
        const aria = await page.ariaSnapshot();
        return { opts, ariaLines: aria.split("\\n"), url: await page.url(), title: await page.title() };
      `,
    },
  });
  assert.notEqual(r1.isError, true);
  const d1 = JSON.parse(r1.content[0].text);
  assert.deepEqual(d1.result.opts, ["free", "pro"]);
  assert.ok(d1.result.ariaLines.some((l) => l.includes('- button "Save"')));
  assert.equal(d1.result.url, "https://example.com");
  assert.equal(d1.result.title, "App");

  // Turn 2: reuse `saveBtn` and `opts` from Turn 1 and redeclare `const opts`, plus test page.* shorthands
  const r2 = await client.callTool({
    name: "browser_run",
    arguments: {
      code: `
        await saveBtn.click();
        const txt = await saveBtn.textContent();
        const pageInner = await page.innerText("css=button");
        const pageText = await page.textContent("css=button");
        const bodyInner = await page.innerText();
        const bodyText = await page.textContent();
        const btnAttr = await page.getAttribute("css=button", "id");
        await page.check('role=checkbox[name="Agree"]');
        const count = await page.locator("css=input[type=radio]").count();
        const opts = [...opts, "enterprise"];
        return { txt, pageInner, pageText, bodyInner, bodyText, btnAttr, count, opts };
      `,
    },
  });
  assert.notEqual(r2.isError, true);
  const d2 = JSON.parse(r2.content[0].text);
  assert.equal(d2.result.txt, "Save");
  assert.equal(d2.result.pageInner, "Save");
  assert.equal(d2.result.pageText, "Save");
  assert.equal(d2.result.bodyInner, "Save");
  assert.equal(d2.result.bodyText, "Save");
  assert.equal(d2.result.btnAttr, "btn-save");
  assert.equal(d2.result.count, 2);
  assert.deepEqual(d2.result.opts, ["free", "pro", "enterprise"]);

  // Reset persisted context via reset_context: true
  const r3 = await client.callTool({
    name: "browser_run",
    arguments: {
      reset_context: true,
      code: `return typeof saveBtn;`,
    },
  });
  assert.notEqual(r3.isError, true);
  assert.equal(JSON.parse(r3.content[0].text).result, "undefined");

  // browser_dom_snapshot format="aria" works directly as well
  const ariaSnap = await client.callTool({
    name: "browser_dom_snapshot",
    arguments: { format: "aria" },
  });
  assert.notEqual(ariaSnap.isError, true);
  assert.match(ariaSnap.content[0].text, /"format": "aria"/);
  assert.match(ariaSnap.content[0].text, /- textbox \\"Email\\"/);
});

test("MCP server supports v4.4 multi-tab handles, diff-first ax.write modes, evaluate(fn, arg), viewport tools, network logs, and notifications", async (t) => {
  const { browser, calls } = richMockBridge();
  const server = createStandaloneServer({ getBrowser: async () => browser, resetBrowser: async () => {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-v44-agent", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  // 1. browser_set_viewport + browser_batch viewport steps + browser_network_logs
  const vpSet = await client.callTool({
    name: "browser_batch",
    arguments: {
      steps: [
        { action: "goto", url: "https://shop.example" },
        { action: "set_viewport", width: 390, height: 844, device_scale_factor: 2, mobile: true },
      ],
      return_state: "none",
    },
  });
  assert.notEqual(vpSet.isError, true);
  assert.ok(calls.some((c) => c.method === "Emulation.setDeviceMetricsOverride" && c.params.width === 390));

  const vpReset = await client.callTool({ name: "browser_set_viewport", arguments: { reset: true } });
  assert.notEqual(vpReset.isError, true);
  assert.ok(calls.some((c) => c.method === "Emulation.clearDeviceMetricsOverride"));

  browser.handleCdpEvent({
    source: { tabId: 10 },
    method: "Network.requestWillBeSent",
    params: { requestId: "n1", type: "Fetch", request: { url: "https://shop.example/api/cart", method: "POST" } },
  });
  browser.handleCdpEvent({
    source: { tabId: 10 },
    method: "Network.responseReceived",
    params: { requestId: "n1", type: "Fetch", response: { url: "https://shop.example/api/cart", status: 500, statusText: "Err", mimeType: "application/json" } },
  });
  const netRes = await client.callTool({
    name: "browser_network_logs",
    arguments: { failed_only: true, status_min: 500, clear: true },
  });
  assert.match(netRes.content[0].text, /\/api\/cart/);
  assert.match(netRes.content[0].text, /"status": 500/);

  // 2. browser_run: multi-tab parallel handles, pinned locators, diff-first ax.write + screenshot, evaluate(fn, arg), and dev logs
  const multi = await client.callTool({
    name: "browser_run",
    arguments: {
      code: `
        const tabA = await browser.tabs.new();
        const tabB = await browser.tabs.new();
        await Promise.all([
          tabA.goto("https://alpha.example"),
          tabB.goto("https://beta.example"),
        ]);
        const locA = tabA.getByRole("button", { name: "Save" }).filter({ has: tabA.locator("css=.icon"), hasNotText: "Archive" });
        const attr = await locA.getAttribute("data-id");
        const vis = await locA.isVisible();
        await tabA.locator("css=input").clear();
        const listTexts = await tabB.locator("css=.item").or(tabB.locator("css=.badge")).allTextContents();
        const doubled = await tabA.evaluate((x) => x.n * 2, { n: 21 });
        await tabA.ax.write();
        await tabA.ax.write("screenshot");
        const gotDiff = await tabA.ax.get();
        await tabA.markDeliverable();
        return {
          tabAId: tabA.id,
          tabBId: tabB.id,
          attr,
          vis,
          listTexts,
          doubled,
          gotDiffHasUnchanged: gotDiff.includes("No accessibility changes"),
          devNetCount: (await tabA.dev.network()).length,
        };
      `,
    },
  });
  assert.notEqual(multi.isError, true, JSON.stringify(multi));
  const mBody = JSON.parse(multi.content[0].text);
  assert.notEqual(mBody.result.tabAId, mBody.result.tabBId);
  assert.equal(mBody.result.attr, "btn-save");
  assert.equal(mBody.result.vis, true);
  assert.deepEqual(mBody.result.listTexts, ["A", "B"]);
  assert.equal(mBody.result.doubled, 42);
  assert.equal(mBody.result.gotDiffHasUnchanged, true);
  assert.equal(multi.content[1].type, "image");

  // Verify locA sent its attribute check to tabA's tabId (not tabB)
  const attrCdp = calls.filter((c) => c.method === "Runtime.evaluate" && String(c.params?.expression).includes('"attr"'));
  assert.ok(attrCdp.some((c) => String(c.tabId) === mBody.result.tabAId));

  // 3. Notifications drain into browser_run output even when return_state: "none"
  await client.callTool({ name: "browser_goto", arguments: { url: "https://notify.example" } });
  const runTargetTab = browser.activeTabId;
  browser.handleCdpEvent({
    source: { tabId: runTargetTab },
    method: "Runtime.exceptionThrown",
    params: { exceptionDetails: { text: "ReferenceError: oops" } },
  });
  const notifRun = await client.callTool({
    name: "browser_run",
    arguments: {
      return_state: "none",
      code: `return "done";`,
    },
  });
  assert.notEqual(notifRun.isError, true);
  assert.match(notifRun.content[0].text, /<notifications>/);
  assert.match(notifRun.content[0].text, /ReferenceError: oops/);

  // 4. browser_name_session tool, batch step, and browser.nameSession() in browser_run
  const namedTool = await client.callTool({
    name: "browser_name_session",
    arguments: { name: "Audit Session", color: "cyan" },
  });
  assert.notEqual(namedTool.isError, true);
  assert.match(namedTool.content[0].text, /"name": "Audit Session"/);
  assert.match(namedTool.content[0].text, /"groupId": 25/);

  const batchNamed = await client.callTool({
    name: "browser_batch",
    arguments: {
      steps: [{ action: "name_session", name: "Batch Group", color: "yellow" }],
      return_state: "none",
    },
  });
  assert.notEqual(batchNamed.isError, true);

  const runNamed = await client.callTool({
    name: "browser_run",
    arguments: {
      code: `return await browser.nameSession("Checkout", "green");`,
    },
  });
  assert.notEqual(runNamed.isError, true);
  assert.equal(JSON.parse(runNamed.content[0].text).result.color, "green");
  assert.ok(calls.filter((c) => c.kind === "rpc" && c.method === "nameSession").length >= 3);
});

test("MCP server lists and auto-claims already-open Chrome user tabs via browser_list_tabs, browser_select_tab, tab_id, and browser.user", async (t) => {
  const ownedTabs = new Map();
  const userTabs = new Map([
    [132, { id: 132, url: "https://congnghieptot.vn/new_admin/addnew_group/132", title: "Admin Group 132", active: true }],
  ]);
  const calls = [];
  const browser = new BridgeBrowser({
    info: { apiSupportOverrides: { "BrowserUser.openTabs": true, "BrowserUser.claimTab": true } },
    request: async (method, params = {}) => {
      calls.push({ method, params });
      if (method === "getTabs") return [...ownedTabs.values()];
      if (method === "getUserTabs") return [...userTabs.values()];
      if (method === "claimUserTab") {
        const tab = userTabs.get(params.tabId);
        if (!tab) throw new Error("Browser tab is unavailable");
        const claimed = { ...tab, owned: true, origin: "user" };
        ownedTabs.set(tab.id, claimed);
        return claimed;
      }
      if (method === "attach") return null;
      if (method === "executeCdp") {
        if (params.method === "Runtime.evaluate") {
          return { result: { value: "Existing form data from tab 132" } };
        }
        return {};
      }
      return {};
    },
    close: async () => {},
    sessionId: "s-user-tab",
    turnId: "t-user-tab",
  });

  const server = createStandaloneServer({ getBrowser: async () => browser, resetBrowser: async () => {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-user-tab-agent", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  // 1. browser_list_tabs shows open user tab 132 with owned: false, origin: "user"
  const listed = JSON.parse((await client.callTool({ name: "browser_list_tabs", arguments: {} })).content[0].text);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].tab_id, "132");
  assert.equal(listed[0].owned, false);
  assert.equal(listed[0].origin, "user");

  // 2. Passing tab_id="132" directly to browser_evaluate auto-claims tab 132 and reads its live DOM
  const evalRes = JSON.parse((await client.callTool({
    name: "browser_evaluate",
    arguments: { tab_id: "132", expression: "document.querySelector('form').innerText" },
  })).content[0].text);
  assert.equal(evalRes.tab_id, "132");
  assert.equal(evalRes.value, "Existing form data from tab 132");
  assert.ok(calls.some((c) => c.method === "claimUserTab" && c.params.tabId === 132));

  // 3. browser_run can also discover and claim user tabs via browser.user.openTabs() / browser.tabs.get()
  const runRes = JSON.parse((await client.callTool({
    name: "browser_run",
    arguments: {
      return_state: "none",
      code: `
        const open = await browser.user.openTabs();
        const tab = await browser.user.claimTab(open[0]);
        const val = await tab.evaluate(() => document.body.innerText);
        return { id: tab.id, val };
      `,
    },
  })).content[0].text);
  assert.equal(runRes.ok, true);
  assert.equal(runRes.result.id, "132");
  assert.equal(runRes.result.val, "Existing form data from tab 132");
});

test("MCP tool profiles reduce compact schema bytes by >=75% and support WebMCP, assets, and popup handles", async (t) => {
  const mkPair = async (profile) => {
    const ownedTabs = new Map([[1, { id: 1, url: "https://app.example/", title: "App" }]]);
    let browserRef = null;
    const browser = new BridgeBrowser({
      request: async (method, params = {}) => {
        if (method === "getTabs") return [...ownedTabs.values()];
        if (method === "attach" || method === "markTab" || method === "turnEnded") return null;
        if (method === "executeCdp" && params.method === "Runtime.evaluate") {
          const expr = String(params.commandParams?.expression || "");
          if (expr.includes("navigator.modelContext") && expr.includes("invokeTool")) {
            return { result: { value: { count: 42 } } };
          }
          if (expr.includes("navigator.modelContext")) {
            return { result: { value: { supported: true, tools: [{ name: "searchCatalog", description: "Search" }] } } };
          }
          if (expr.includes("document.fonts")) {
            return { result: { value: { url: "https://app.example/", assets: [{ kind: "image", url: "https://app.example/a.png", source: "img" }], fonts: [], inlineSvgCount: 1, inlineSvgs: [] } } };
          }
          return { result: { value: "ok" } };
        }
        return {};
      },
      close: async () => {},
      sessionId: `s-${profile}`,
      turnId: `t-${profile}`,
    });
    browserRef = browser;
    const server = createStandaloneServer({ profile, getBrowser: async () => browserRef, resetBrowser: async () => {} });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: `c-${profile}`, version: "1.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    t.after(async () => { await client.close(); await server.close(); });
    return { client, browser };
  };

  const fullEnv = await mkPair("full");
  const stdEnv = await mkPair("standard");
  const cmpEnv = await mkPair("compact");

  const fullList = await fullEnv.client.listTools();
  const stdList = await stdEnv.client.listTools();
  const cmpList = await cmpEnv.client.listTools();

  assert.equal(fullList.tools.length, 36);
  assert.equal(stdList.tools.length, 14);
  assert.equal(cmpList.tools.length, 7);

  const fullBytes = JSON.stringify(fullList.tools).length;
  const cmpBytes = JSON.stringify(cmpList.tools).length;
  assert.ok(cmpBytes <= fullBytes * 0.25, `Expected compact schema (${cmpBytes}B) <= 25% of full (${fullBytes}B)`);

  // Verify WebMCP + assets + waitForEvent('popup') inside compact browser_run
  setTimeout(() => {
    cmpEnv.browser.handleTabCreated({
      openerTabId: 1,
      tab: { id: 2, url: "https://app.example/popup", title: "Popup" },
    });
  }, 15);
  const rawCall = await cmpEnv.client.callTool({
    name: "browser_run",
    arguments: {
      return_state: "none",
      code: `
        const tools = await page.webmcp.listTools();
        const invoked = await page.webmcp.invokeTool("searchCatalog", { q: "pump" });
        const assets = await page.assets.list();
        const popup = await page.waitForEvent("popup", { timeoutMs: 1000 });
        return { toolsCount: tools.tools.length, invoked, assetsCount: assets.assets.length, popupId: popup.id };
      `,
    },
  });
  const rawText = rawCall.content[0].text;
  const res = JSON.parse(rawText.split("\n<notifications>")[0]);
  assert.match(rawText, /Popup tab 2 opened from tab 1/);
  assert.equal(res.ok, true);
  assert.deepEqual(res.result, {
    toolsCount: 1,
    invoked: { tab_id: "1", name: "searchCatalog", result: { count: 42 } },
    assetsCount: 1,
    popupId: "2",
  });
});

test("MCP server v4.7.0 supports 300s browser_run, saveFile/readFile/saveScreenshot, nodeRepl, elementScreenshot, ax.paste/selectText, dev.responseBody, and tabs.content", async (t) => {
  const workDir = await mkdtemp(path.join(tmpdir(), "browser-v47-"));
  t.after(() => rm(workDir, { recursive: true, force: true }));
  const { browser, calls } = richMockBridge();
  const server = createStandaloneServer({ getBrowser: async () => browser, resetBrowser: async () => {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-v47-agent", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const dataPath = path.join(workDir, "nested", "data.json");
  const pageShotPath = path.join(workDir, "shots", "page.jpg");
  const elShotPath = path.join(workDir, "shots", "elem.png");

  const res = await client.callTool({
    name: "browser_run",
    arguments: {
      timeout_ms: 250_000,
      return_state: "none",
      code: `
        const tab = await browser.tabs.new("https://v47.example");
        await tab.ax.get();
        await tab.ax.paste("1", "pasted-value");
        const sel = await tab.ax.selectText("1", "past");
        await tab.dev.enableNetwork({ captureBodies: true });
        const respBody = await tab.dev.responseBody("req-42");

        const written = await saveFile(${JSON.stringify(dataPath)}, { count: 2, ok: true });
        const loaded = JSON.parse(await readFile(${JSON.stringify(dataPath)}));
        nodeRepl.write("repl-msg");

        const elCap = await tab.locator("css=button").screenshot({ padding: 4 });
        const savedPageShot = await saveScreenshot(${JSON.stringify(pageShotPath)}, { emit: true });
        const savedElShot = await tab.locator("css=button").saveScreenshot(${JSON.stringify(elShotPath)}, { padding: 2 });

        const batchRead = await browser.tabs.content(["https://one.example", "https://two.example"]);
        const linksRead = await browser.tabs.content(["https://links.example"], { format: "links" });
        const scheduledEnd = await browser.end_turn({ keep: [{ tab_id: tab.id, mode: "deliverable" }] });
        return { sel, respBody, written, loaded, elBox: elCap.box, savedPageShot, savedElShot, batchRead, linksRead, scheduledEnd };
      `,
    },
  });

  assert.notEqual(res.isError, true, JSON.stringify(res));
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.saved_files));
  assert.equal(body.saved_files.length, 3);
  assert.deepEqual(
    body.saved_files.map((f) => ({ path: f.path, kind: f.kind, positive: f.bytes > 0 })),
    [
      { path: dataPath, kind: "file", positive: true },
      { path: pageShotPath, kind: "screenshot", positive: true },
      { path: elShotPath, kind: "screenshot", positive: true },
    ],
  );
  assert.ok(body.end_turn);
  assert.equal(body.result.scheduledEnd.scheduled, true);
  assert.deepEqual(body.logs, ["repl-msg"]);
  assert.equal(body.result.sel.selected, true);
  assert.equal(JSON.parse(body.result.respBody.body).requestId, "req-42");
  assert.equal(body.result.loaded.count, 2);
  assert.equal(body.result.savedElShot.mimeType, "image/png");
  assert.deepEqual(body.result.elBox, { x: 6, y: 16, width: 108, height: 48 });
  assert.equal(body.result.batchRead.length, 2);
  assert.equal(body.result.batchRead[0].content, "# https://one.example");
  assert.equal(body.result.batchRead[1].content, "# https://two.example");
  assert.deepEqual(body.result.linksRead[0].links, [{ text: "Item", href: "https://links.example/item" }]);
  assert.equal(res.content[1].type, "image");

  const diskJson = JSON.parse(await readFile(dataPath, "utf8"));
  assert.equal(diskJson.ok, true);
  assert.ok((await readFile(pageShotPath)).byteLength > 0);
  assert.ok((await readFile(elShotPath)).byteLength > 0);
  assert.ok(calls.some((c) => c.method === "Network.enable" && c.params.maxTotalBufferSize > 0));
  assert.ok(calls.some((c) => c.method === "Network.getResponseBody" && c.params.requestId === "req-42"));
  assert.ok(calls.some((c) => c.method === "Input.insertText" && c.params.text === "pasted-value"));
  assert.ok(calls.filter((c) => c.method === "Page.close").length >= 2);
});

test("browser_run suppresses <ax_state> on static/read-only errors and attaches compact <ax_state> on locator errors", async (t) => {
  const { browser, calls } = richMockBridge();
  const server = createStandaloneServer({ getBrowser: async () => browser, resetBrowser: async () => {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-error-state", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  await client.callTool({
    name: "browser_run",
    arguments: { code: `await page.goto("https://example.com"); return "ready";` },
  });

  const axBeforeStatic = calls.filter((c) => c.method === "Accessibility.getFullAXTree").length;
  const readOnlyErr = await client.callTool({
    name: "browser_run",
    arguments: { code: `return await page.evaluate(() => { el.value = "x"; });` },
  });
  assert.equal(readOnlyErr.isError, true);
  assert.match(readOnlyErr.content[0].text, /Browser evaluate is read-only/);
  assert.doesNotMatch(readOnlyErr.content[0].text, /<ax_state>/);

  const syntaxErr = await client.callTool({
    name: "browser_run",
    arguments: { code: `const broken = ;` },
  });
  assert.equal(syntaxErr.isError, true);
  assert.doesNotMatch(syntaxErr.content[0].text, /<ax_state>/);
  assert.equal(calls.filter((c) => c.method === "Accessibility.getFullAXTree").length, axBeforeStatic);

  const locatorErr = await client.callTool({
    name: "browser_run",
    arguments: { code: `await page.locator("css=.missing").click({ timeoutMs: 120 });` },
  });
  assert.equal(locatorErr.isError, true);
  assert.match(locatorErr.content[0].text, /<ax_state>/);
  assert.ok(calls.filter((c) => c.method === "Accessibility.getFullAXTree").length > axBeforeStatic);
});

test("locator.ariaSnapshot() returns scoped subtree and unindexed ariaSnapshot baseline avoids redundant diff dumps", async (t) => {
  const { browser, calls } = richMockBridge();
  const originalRequest = browser.request;
  let resolveCount = 0;
  browser.request = async (method, params = {}) => {
    if (method === "executeCdp" && params.method === "Runtime.evaluate" && params.commandParams?.returnByValue === false) {
      resolveCount += 1;
      return { result: { objectId: `remote-${resolveCount}` } };
    }
    if (method === "executeCdp" && params.method === "DOM.describeNode") {
      return { node: { backendNodeId: 30 } };
    }
    return originalRequest(method, params);
  };

  const server = createStandaloneServer({ getBrowser: async () => browser, resetBrowser: async () => {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-scoped-aria", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const scoped = await client.callTool({
    name: "browser_run",
    arguments: {
      code: `
        await page.goto("https://example.com");
        const btnAria = await page.locator("css=button").ariaSnapshot();
        await page.ariaSnapshot();
        return btnAria;
      `,
    },
  });
  assert.notEqual(scoped.isError, true, JSON.stringify(scoped));
  const payload = JSON.parse(scoped.content[0].text);
  assert.equal(payload.result, '- button "Save"');
  assert.doesNotMatch(payload.result, /textbox "Email"/);

  const errAfterAria = await client.callTool({
    name: "browser_run",
    arguments: { code: `await page.locator("css=.missing").click({ timeoutMs: 120 });` },
  });
  assert.equal(errAfterAria.isError, true);
  assert.match(errAfterAria.content[0].text, /No accessibility changes since last ariaSnapshot\(\)\./);
  assert.doesNotMatch(errAfterAria.content[0].text, /textbox "Email"/);
  assert.ok(resolveCount >= 1);
  assert.ok(calls.some((c) => c.method === "Accessibility.getFullAXTree"));
});

test("browser_run honors end_turn=false with keep, scroll(dir, pages), Playwright ergonomics, and opt-in deliverable focus", async (t) => {
  const { browser, calls } = richMockBridge();
  const dir = await mkdtemp(path.join(tmpdir(), "browser-use-ergonomics-"));
  const server = createStandaloneServer({ getBrowser: async () => browser, resetBrowser: async () => {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-ergonomics", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const shotPath = path.join(dir, "ergo.jpg");
  const stayAlive = await client.callTool({
    name: "browser_run",
    arguments: {
      end_turn: false,
      keep: "handoff",
      code: `
        const consoleMsgs = [];
        const pageErrors = [];
        page.on("console", (m) => consoleMsgs.push(m.type() + ":" + m.text()));
        page.on("pageerror", (e) => pageErrors.push(e.message));
        const tab = await browser.tabs.new("https://example.com");
        await tab.scroll("down", 5);
        await page.setViewportSize({ width: 390, height: 844, mobile: true });
        await page.keyboard.press("End");
        await page.locator("css=button", { hasText: "Save" }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: ${JSON.stringify(shotPath)} });
        return { consoleMsgs, pageErrors, id: tab.id };
      `,
    },
  });
  assert.notEqual(stayAlive.isError, true, JSON.stringify(stayAlive));
  const body = JSON.parse(stayAlive.content[0].text);
  assert.equal(body.end_turn, undefined);
  assert.equal(body.saved_files?.[0]?.path, shotPath);
  const wheel = calls.find((c) => c.method === "Input.dispatchMouseEvent" && c.params?.type === "mouseWheel");
  assert.equal(wheel?.params?.deltaY, 2500);
  const vpCall = calls.find((c) => c.method === "Emulation.setDeviceMetricsOverride");
  assert.equal(vpCall?.params?.width, 390);
  assert.equal(vpCall?.params?.height, 844);
  assert.equal(calls.some((c) => c.method === "Input.dispatchKeyEvent" && c.params?.key === "End"), true);
  assert.equal(calls.some((c) => c.kind === "rpc" && c.method === "turnEnded"), false);

  // Verify console & pageerror delivery + opt-in focus: true brings deliverable to front
  const eventsRun = await client.callTool({
    name: "browser_run",
    arguments: {
      code: `
        const msgs = [];
        const errs = [];
        page.on("console", (m) => msgs.push(m.type() + ":" + m.text()));
        page.on("pageerror", (e) => errs.push(e.message));
        log("armed");
        return { tabId: page.id };
      `,
    },
  });
  assert.notEqual(eventsRun.isError, true);

  // Test BridgeBrowser event dispatching directly and focus:true on markDeliverable
  const seen = [];
  const off = browser.addEventListener((ev) => seen.push(ev));
  const curId = browser.activeTabId;
  browser.handleCdpEvent({
    source: { tabId: curId },
    method: "Runtime.consoleAPICalled",
    params: { type: "error", args: [{ value: "boom" }] },
  });
  browser.handleCdpEvent({
    source: { tabId: curId },
    method: "Runtime.exceptionThrown",
    params: { exceptionDetails: { text: "Uncaught Err" } },
  });
  off();
  assert.equal(seen.length, 2);
  assert.equal(seen[0].kind, "console");
  assert.equal(seen[0].entry.message, "boom");
  assert.equal(seen[1].kind, "pageerror");

  const focusEnd = await client.callTool({
    name: "browser_run",
    arguments: {
      code: `
        await page.goto("https://example.com/final");
        page.markDeliverable({ focus: true });
      `,
    },
  });
  assert.notEqual(focusEnd.isError, true);
  assert.equal(calls.some((c) => c.kind === "cdp" && c.method === "Page.bringToFront"), true);
});
