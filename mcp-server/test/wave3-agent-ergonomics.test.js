import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { buildAxDiff, formatAriaSnapshot, mergeFrameAriaSnapshots } from "../src/ax-tree.js";
import { BridgeBrowser } from "../src/bridge-browser.js";
import { extractContentExpression } from "../src/content-extractor.js";
import { locatorExpression } from "../src/locators.js";
import { assertReadOnly } from "../src/read-only.js";
import { BrowserScriptSession } from "../src/script-runner.js";
import { createStandaloneServer } from "../src/server.js";

test("read-only evaluate allows Set/Map/URLSearchParams, reduce accumulators, nested writes, delete, Object.assign, and return", () => {
  assert.doesNotThrow(() => assertReadOnly(`
    const seen = new Set();
    seen.add("a");
    seen.clear();
    const map = new Map();
    map.set("k", 1);
    map.delete("k");
    const params = new URLSearchParams();
    params.append("q", "ok");
    const out = { meta: { total: 0 }, tmp: 1 };
    out.meta.total = 5;
    delete out.tmp;
    Object.assign(out, { ok: true });
    const grouped = [1, 2].reduce((acc, n) => {
      acc[String(n)] = n * 2;
      return acc;
    }, {});
    return { meta: out.meta, grouped, q: params.toString() };
  `));

  assert.throws(() => assertReadOnly("document.body.innerHTML = 'x'"), /read-only/);
  assert.throws(() => assertReadOnly("const o = {}; o.__proto__.polluted = 1"), /assignment is not allowed/);
  assert.throws(() => assertReadOnly("delete document.body.dataset.x"), /delete is not allowed/);
  assert.throws(() => assertReadOnly("Object.assign(document.body.style, { color: 'red' })"), /Object\.assign\(\) is not allowed/);
});

test("AX diff invalidates across mode changes or pure removals and ARIA snapshot emits badges, placeholder, and truncation", () => {
  const prevEntries = [
    { idx: 0, key: "button:Save", line: '[0] button "Save"', body: 'button "Save"' },
    { idx: 1, key: "button:Delete", line: '[1] button "Delete"', body: 'button "Delete"' },
  ];
  const modeChanged = buildAxDiff(
    { documentKey: "1:https://example.com", mode: "compact", entries: prevEntries },
    { documentKey: "1:https://example.com", mode: "full", lines: ['[0] button "Save"'], entries: [prevEntries[0]] },
  );
  assert.equal(modeChanged.mode, "full");

  const pureRemoval = buildAxDiff(
    { documentKey: "1:https://example.com", mode: "compact", entries: prevEntries },
    { documentKey: "1:https://example.com", mode: "compact", lines: ['[0] button "Save"'], entries: [prevEntries[0]] },
  );
  assert.equal(pureRemoval.mode, "full");
  assert.equal(pureRemoval.removed, 1);

  const nodes = [
    { nodeId: "r", role: { value: "RootWebArea" }, childIds: ["d"] },
    {
      nodeId: "d",
      role: { value: "dialog" },
      name: { value: "Edit" },
      properties: [{ name: "modal", value: { value: true } }],
      childIds: ["acc", "inp"],
    },
    {
      nodeId: "acc",
      role: { value: "button" },
      name: { value: "More" },
      properties: [
        { name: "expanded", value: { value: false } },
        { name: "haspopup", value: { value: "menu" } },
      ],
    },
    {
      nodeId: "inp",
      role: { value: "textbox" },
      name: { value: "Email" },
      properties: [
        { name: "readonly", value: { value: true } },
        { name: "invalid", value: { value: true } },
        { name: "placeholder", value: { value: "you@example.com" } },
      ],
    },
  ];
  const snap = formatAriaSnapshot(nodes, { mode: "full", maxLines: 20 });
  assert.match(snap.text, /\[modal\]/);
  assert.match(snap.text, /\[expanded=false\]/);
  assert.match(snap.text, /\[haspopup=menu\]/);
  assert.match(snap.text, /\[readonly\]/);
  assert.match(snap.text, /\[invalid\]/);
  assert.match(snap.text, /- \/placeholder: you@example\.com/);

  const truncatedSnap = mergeFrameAriaSnapshots([{ nodes, frameId: null }], { mode: "full", maxLines: 2 });
  assert.equal(truncatedSnap.truncated, true);
  assert.match(truncatedSnap.text, /\.\.\.\(truncated\)$/);
});

test("locators support opacity:0 inputs, apostrophes in regex pipelines, role attributes, case-insensitive text/alt/title, and detailed covered errors", () => {
  const createEl = (tag, opts = {}) => {
    const attrs = new Map(Object.entries(opts.attrs || {}));
    const el = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      id: opts.id || "",
      className: opts.className || "",
      innerText: opts.text || "",
      textContent: opts.text || "",
      checked: Boolean(opts.checked),
      selected: Boolean(opts.selected),
      open: Boolean(opts.open),
      disabled: Boolean(opts.disabled),
      value: opts.value ?? "",
      children: [],
      labels: opts.labels || [],
      style: opts.style || {},
      getAttribute: (k) => (attrs.has(k) ? String(attrs.get(k)) : null),
      hasAttribute: (k) => attrs.has(k),
      matches: (sel) => sel === ":disabled" && Boolean(opts.disabled),
      closest: (sel) => {
        if (opts.closestLink && String(sel).includes("a")) return opts.closestLink;
        return null;
      },
      scrollIntoView: () => {},
      getBoundingClientRect: () => opts.rect || { x: 10, y: 10, left: 10, top: 10, right: 90, bottom: 40, width: 80, height: 30 },
    };
    el.querySelectorAll = (sel) => findByCss(el, sel);
    return el;
  };

  const linkWrap = createEl("a", { attrs: { href: "/go" } });
  const heading = createEl("h2", { text: "Quarterly Report", attrs: { id: "h2-el" } });
  const checkbox = createEl("input", {
    attrs: { type: "checkbox", "aria-label": "Accept Terms" },
    checked: true,
    style: { opacity: "0" },
  });
  const logo = createEl("img", { attrs: { alt: "Acme Logo", title: "Go Home" } });
  const cardBtn = createEl("button", { text: "It's fine here" });
  const coveredBtn = createEl("button", { text: "Blocked", id: "blocked-btn" });
  const overlayEl = createEl("div", { id: "toast", className: "modal-mask banner", attrs: { role: "alert" } });

  const allNodes = [linkWrap, heading, checkbox, logo, cardBtn, coveredBtn];
  const findByCss = (_root, sel) => {
    const out = [];
    for (const n of allNodes) {
      if (sel.includes("[aria-checked]") || sel.includes('type="checkbox"')) {
        if (n.tagName === "INPUT" && n.getAttribute("type") === "checkbox") out.push(n);
      } else if (sel.includes("[alt]") && n.hasAttribute("alt")) {
        out.push(n);
      } else if (sel.includes("[title]") && n.hasAttribute("title")) {
        out.push(n);
      } else if (sel.includes("h2") && n.tagName === "H2") {
        out.push(n);
      } else if (sel.includes("button") && n.tagName === "BUTTON") {
        out.push(n);
      }
    }
    return out;
  };

  const doc = {
    nodeType: 9,
    documentElement: createEl("html"),
    querySelectorAll: (sel) => findByCss(doc, sel),
    elementFromPoint: () => overlayEl,
    createTreeWalker: () => {
      let i = -1;
      const tns = allNodes
        .filter((n) => n.textContent)
        .map((n) => ({ nodeValue: n.textContent, parentElement: n }));
      return { nextNode: () => tns[++i] ?? null };
    },
  };
  for (const n of allNodes) {
    n.ownerDocument = doc;
    n.parentNode = doc.documentElement;
  }

  const ctx = {
    document: doc,
    NodeFilter: { SHOW_TEXT: 4 },
    CSS: { escape: (s) => s },
    window: {
      getComputedStyle: (el) => ({
        display: "block",
        visibility: "visible",
        opacity: el?.style?.opacity ?? "1",
      }),
    },
    HTMLInputElement: function HTMLInputElement() {},
    HTMLButtonElement: function HTMLButtonElement() {},
    HTMLSelectElement: function HTMLSelectElement() {},
    HTMLTextAreaElement: function HTMLTextAreaElement() {},
    getComputedStyle: (el) => ctx.window.getComputedStyle(el),
  };
  ctx.document.defaultView = ctx.window;

  // opacity:0 checkbox should be visible
  const cbVis = vm.runInNewContext(locatorExpression("role=checkbox[checked=true]", { mutation: "isVisible" }), ctx);
  assert.equal(cbVis.error, undefined);
  assert.equal(cbVis.value, true);

  // role[level=2] heading match
  const h2Res = vm.runInNewContext(locatorExpression('role=heading[name="Quarterly Report"][level=2]', { mutation: "textContent" }), ctx);
  assert.equal(h2Res.error, undefined);
  assert.equal(h2Res.text, "Quarterly Report");

  // regex apostrophe inside >> pipeline + case-insensitive alt=/title=
  const rxRes = vm.runInNewContext(locatorExpression('text=/It\'s fine/i >> first', { mutation: "textContent" }), ctx);
  assert.equal(rxRes.error, undefined);
  assert.equal(rxRes.text, "It's fine here");

  const altRes = vm.runInNewContext(locatorExpression('alt="acme"[exact=false]', { mutation: "attr", attrName: "alt" }), ctx);
  assert.equal(altRes.error, undefined);
  assert.equal(altRes.value, "Acme Logo");

  // detailed covered error message
  const covRes = vm.runInNewContext(locatorExpression('text=blocked', { mutation: "point" }), ctx);
  assert.equal(covRes.code, "covered");
  assert.match(covRes.error, /<div#toast\.modal-mask\.banner\[role=alert\]>/);
});

test("content-extractor caps large tables payload against MAX_CHARS", () => {
  const makeCell = (txt) => ({
    nodeType: 1,
    tagName: "TD",
    textContent: txt,
    innerText: txt,
    childNodes: [{ nodeType: 3, nodeValue: txt }],
  });
  const row = (i) => ({
    nodeType: 1,
    tagName: "TR",
    children: [makeCell(`k-${i}`), makeCell("x".repeat(120))],
  });
  const trs = Array.from({ length: 40 }, (_, i) => row(i));
  const tbl = {
    nodeType: 1,
    tagName: "TABLE",
    children: trs,
    querySelectorAll: (sel) => (sel === "thead tr, tr" || sel === "tr" ? trs : []),
    getBoundingClientRect: () => ({ width: 500, height: 400 }),
  };
  const body = {
    querySelectorAll: (sel) => {
      if (sel.includes("table")) return [tbl];
      return [];
    },
  };
  const ctx = {
    document: { title: "Big", URL: "https://example.com", body, querySelectorAll: body.querySelectorAll },
    location: { href: "https://example.com" },
    window: { getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }) },
  };
  const res = vm.runInNewContext(extractContentExpression({ format: "tables", maxChars: 1200 }), ctx);
  assert.equal(res.truncated, true);
  assert.ok(res.tables[0].rows.length < 40);
  assert.ok(JSON.stringify(res.tables).length <= 1400);
});

test("script-runner exposes Web globals, Playwright parity methods, opts.timeout, interval cleanup, and source location metadata", async () => {
  const calls = [];
  const fakeBrowser = {
    activeTabId: "1",
    ownedTabs: new Set([1]),
    supportsPassiveRead: true,
    sessionColor: null,
    sessionLabel: null,
    drainNotifications: () => [],
    listTabs: async () => [{ tab_id: "1", title: "Home", url: "https://example.com" }],
    goto: async (_u, _id, opts) => { calls.push(["goto", opts.timeoutMs]); return { tab_id: "1", ok: true }; },
    locatorFocus: async (sel, opts) => { calls.push(["focus", sel, opts.timeoutMs]); return { tab_id: "1", ok: true }; },
    locatorBoundingBox: async (sel, opts) => { calls.push(["box", sel, opts.timeoutMs]); return { x: 1, y: 2, width: 30, height: 40 }; },
    locatorEvaluate: async (sel, _fn, opts) => ({ tab_id: "1", value: opts.evalOnly ? null : `<span>${sel}</span>` }),
    locatorState: async (_sel, mode) => ({ tab_id: "1", value: mode === "isVisible" ? false : false }),
    history: async (dir) => { calls.push(["history", dir]); return { tab_id: "1", ok: true }; },
    waitFor: async (opts) => { calls.push(["waitFor", opts]); return { tab_id: "1", ok: true }; },
    evaluate: async () => ({ tab_id: "1", value: { width: 1280, height: 720 } }),
  };

  const session = new BrowserScriptSession();
  const ok = await session.run(fakeBrowser, `
    const encoded = Buffer.from(new TextEncoder().encode("hi")).toString("base64");
    const cloned = structuredClone({ encoded, b: btoa("ok"), a: atob("b2s=") });
    await page.goto("https://example.com", { timeout: 2222 });
    const h = page.getByRole("heading", { name: "Title", level: 2 });
    await h.focus({ timeout: 3333 });
    const box = await h.boundingBox({ timeout: 4444 });
    const hidden = await h.isHidden();
    const disabled = await h.isDisabled();
    const html = await h.innerHTML();
    const alt = page.getByAltText("Logo");
    const titleLoc = page.getByTitle("Tooltip");
    await page.goBack();
    await page.goForward();
    await page.waitForSelector("css=#ready", { timeout: 5555 });
    const vp = await page.viewportSize();
    return { cloned, box, hidden, disabled, html, altSel: alt.selector, titleSel: titleLoc.selector, vp };
  `, { tabId: "1" });

  assert.equal(ok.value.cloned.encoded, "aGk=");
  assert.equal(ok.value.cloned.b, "b2s=");
  assert.equal(ok.value.cloned.a, "ok");
  assert.deepEqual(ok.value.box, { x: 1, y: 2, width: 30, height: 40 });
  assert.equal(ok.value.hidden, true);
  assert.equal(ok.value.disabled, true);
  assert.match(ok.value.html, /level=2/);
  assert.match(ok.value.altSel, /^alt="Logo"/);
  assert.match(ok.value.titleSel, /^title="Tooltip"/);
  assert.deepEqual(ok.value.vp, { width: 1280, height: 720 });
  assert.deepEqual(calls.find((c) => c[0] === "goto"), ["goto", 2222]);
  assert.deepEqual(calls.find((c) => c[0] === "focus"), ["focus", 'role=heading[name="Title"][exact=false][level=2]', 3333]);
  assert.deepEqual(calls.find((c) => c[0] === "box"), ["box", 'role=heading[name="Title"][exact=false][level=2]', 4444]);
  assert.ok(calls.some((c) => c[0] === "history" && c[1] === "back"));
  assert.ok(calls.some((c) => c[0] === "history" && c[1] === "forward"));

  // Error telemetry preserves user code line number, logs, savedFiles, and clears active intervals
  let intervalTicks = 0;
  await assert.rejects(() => session.run(fakeBrowser, [
    'log("step-before-fail");',
    'setInterval(() => { intervalTicks++; }, 5);',
    'throw new Error("boom");',
  ].join("\n"), { tabId: "1" }), (err) => {
    assert.equal(err.message, "boom");
    assert.equal(err.browserRunMeta?.location?.line, 3);
    assert.deepEqual(err.browserRunMeta?.partial_logs, ["step-before-fail"]);
    return true;
  });
  const snapshotTicks = intervalTicks;
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(intervalTicks, snapshotTicks);
});

test("BridgeBrowser caps raw getContent at 16000 chars and skips passive read for tables", async () => {
  const cdpCalls = [];
  const rpcCalls = [];
  const browser = new BridgeBrowser({
    request: async (method, params = {}) => {
      rpcCalls.push(method);
      if (method === "getTabs") return [{ id: 2, url: "https://example.com", title: "Ex" }];
      if (method === "attach") return null;
      if (method === "claimTab") return { ok: true };
      if (method === "executeCdp") {
        cdpCalls.push(params.method);
        if (params.method === "Runtime.evaluate") {
          const expr = String(params.commandParams?.expression || "");
          if (expr.includes("tablesCount")) {
            return { result: { value: { format: "tables", text: "|a|\n|b|", tables: [{ headers: ["a"], rows: [["b"]] }], tablesCount: 1, linksCount: 0, truncated: false } } };
          }
          return { result: { value: "z".repeat(20_000) } };
        }
      }
      return {};
    },
    close: async () => {},
    sessionId: "s-w3",
    turnId: "t-w3",
    info: { apiSupportOverrides: { "BrowserUser.openTabs": true, "BrowserUser.getTabContext": true } },
  });

  const tableRes = await browser.getContent(2, { format: "tables" });
  assert.equal(rpcCalls.includes("readTabContext"), false);
  assert.equal(tableRes.format, "tables");
  assert.equal(tableRes.tablesCount, 1);

  const rawRes = await browser.getContent(2);
  assert.equal(rawRes.text.length, 16_000);
  assert.equal(rawRes.truncated, true);
  assert.ok(cdpCalls.includes("Runtime.evaluate"));
});

test("MCP server Wave 3 defaults: ENOENT skips getState, batch/content deduplicate, and end_turn accepts string keep", async () => {
  const missingFile = `/tmp/wave3-missing-${Date.now()}.json`;
  rmSync(missingFile, { force: true });

  let getStateCalls = 0;
  let endTurnArgs = null;
  let batchArgs = null;
  const fakeBrowser = {
    activeTabId: "1",
    ownedTabs: new Set([1]),
    drainNotifications: () => [],
    getState: async (_tabId, opts) => {
      getStateCalls++;
      return { tab_id: "1", mode: opts?.mode, tree: '[0] button "OK"' };
    },
    getContent: async () => ({
      tab_id: "1",
      format: "links",
      text: "- [Home](https://example.com)",
      content: "- [Home](https://example.com)",
      links: [{ text: "Home", href: "https://example.com" }],
    }),
    batch: async (steps, opts) => {
      batchArgs = { steps, opts };
      return {
        ok: true,
        completed_steps: [
          { step: 1, action: "evaluate", ok: true, result: { value: 123 } },
          { step: 2, action: "click", ok: true, result: { ok: true } },
        ],
        state: { tab_id: "1", mode: opts.mode, axText: '[0] button "OK"' },
      };
    },
    endTurn: async (opts) => {
      endTurnArgs = opts;
      return { ended: true, kept: opts.keep };
    },
  };

  const server = createStandaloneServer({
    profile: "full",
    getBrowser: async () => fakeBrowser,
  });
  const tools = new Map();
  for (const [name, entry] of Object.entries(server._registeredTools || {})) {
    tools.set(name, entry);
  }
  assert.ok(tools.has("browser_run"));

  const enoentRes = await tools.get("browser_run").handler({
    code: `log("trying");\nreturn await readFile(${JSON.stringify(missingFile)});`,
  });
  assert.equal(enoentRes.isError, true);
  assert.equal(getStateCalls, 0);
  const errText = enoentRes.content[0].text;
  assert.match(errText, /ENOENT/);
  assert.match(errText, /"partial_logs"/);

  const lineErrRes = await tools.get("browser_run").handler({
    code: `log("step1");\nthrow new Error("script-boom");`,
  });
  assert.equal(lineErrRes.isError, true);
  assert.match(lineErrRes.content[0].text, /script-boom \(at line 2:\d+\)/);

  const batchRes = await tools.get("browser_batch").handler({
    steps: [{ action: "evaluate", expression: "123" }, { action: "click", element_index: 0 }],
    return_state: "diff",
  });
  assert.equal(batchArgs.opts.mode, "compact");
  const batchMeta = JSON.parse(batchRes.content[0].text.split("\n")[0]);
  assert.equal(batchMeta.step_results[0].result.value, 123);

  const contentRes = await tools.get("browser_get_content").handler({ format: "links" });
  const contentPayload = JSON.parse(contentRes.content[0].text);
  assert.equal("content" in contentPayload, false);

  const endRes = await tools.get("browser_end_turn").handler({ keep: "deliverable" });
  assert.equal(endRes.isError, undefined);
  assert.deepEqual(endTurnArgs.keep, [{ tab_id: "1", mode: "deliverable" }]);
});
