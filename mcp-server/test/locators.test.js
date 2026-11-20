import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { parse } from "acorn";
import {
  domSnapshotExpression,
  hitTestFunctionDeclaration,
  inspectElementAtPointExpression,
  locatorExpression,
  locatorResolveNodeExpression,
  selectOptionFunctionDeclaration,
  smartSetValueFunctionDeclaration,
  waitForTextExpression,
} from "../src/locators.js";

test("all generated browser expressions and functions parse cleanly as modern JS", () => {
  const expressions = [
    locatorExpression('css=.card >> has-text=Pro >> role=button[name="Buy"] >> first', { mutation: "point" }),
    locatorExpression("css=.row >> has-text=/I certify/i >> role=checkbox[name=/Agree/i]", { mutation: "check" }),
    locatorExpression("css=.row >> has-not-text=Disabled >> has=(css=.badge >> text=Live) >> has-not=(css=.archived)", { mutation: "point" }),
    locatorExpression("role=button >> and=(css=.primary)", { mutation: "point" }),
    locatorExpression("role=button >> or=(role=link)", { mutation: "allTextContents" }),
    locatorExpression("text=/Hello/i", { mutation: "uncheck", crossOriginDirect: true }),
    locatorExpression("css=input[type=radio]", { mutation: "evalAll", evalFn: "(els) => els.map((e) => e.id)" }),
    locatorExpression("css=input[type=radio]", { mutation: "evalAll", evalFn: "async (els, p) => els.map((e) => p + e.id)", evalArg: "id:", hasEvalArg: true, asyncEval: true }),
    locatorExpression("role=textbox >> first", { mutation: "eval", evalFn: "(el) => el.value" }),
    locatorExpression("role=textbox >> first", { mutation: "eval", evalFn: "async (el, suffix) => el.value + suffix", evalArg: "!", hasEvalArg: true, asyncEval: true }),
    locatorExpression("label=Email", { mutation: "fill", value: "ada@example.com", sameOriginFrames: ["iframe#checkout"] }),
    locatorExpression("label=Email", { mutation: "clear" }),
    locatorExpression("label=Email", { mutation: "attr", attrName: "data-id" }),
    locatorExpression("label=Email", { mutation: "inputValue" }),
    locatorExpression("label=Email", { mutation: "textContent" }),
    locatorExpression("label=Email", { mutation: "innerText" }),
    locatorExpression("label=Email", { mutation: "allTextContents" }),
    locatorExpression("label=Email", { mutation: "allInnerTexts" }),
    locatorExpression("label=Email", { mutation: "isVisible" }),
    locatorExpression("label=Email", { mutation: "isEnabled" }),
    locatorExpression("label=Email", { mutation: "isChecked" }),
    locatorExpression("label=Email", { mutation: "focus", force: true }),
    locatorExpression("placeholder=Search", { mutation: "wait", state: "visible" }),
    locatorExpression("testid=plan", { mutation: "select", select: [{ value: "pro" }] }),
    locatorResolveNodeExpression('css=.box >> has=(css=input[type="file"])'),
    locatorExpression("css=#ready", { mutation: "wait", state: "visible", inPageWaitMs: 500 }),
    waitForTextExpression("Ready", { timeoutMs: 500 }),
    inspectElementAtPointExpression(120, 240),
    domSnapshotExpression(12_000),
  ];
  for (const expr of expressions) {
    assert.doesNotThrow(() => parse(expr, { ecmaVersion: "latest" }));
  }

  const functions = [
    hitTestFunctionDeclaration(),
    smartSetValueFunctionDeclaration(),
    selectOptionFunctionDeclaration(),
  ];
  for (const fn of functions) {
    assert.doesNotThrow(() => parse(`(${fn})`, { ecmaVersion: "latest" }));
  }
});

test("locatorExpression executes filters, combinators, eval args, and structured hit-test errors in DOM VM", async () => {
  function makeEl(tag, opts = {}) {
    return {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      id: opts.id || "",
      innerText: opts.text ?? "",
      textContent: opts.text ?? "",
      value: opts.value ?? "",
      readOnly: Boolean(opts.readOnly),
      children: [],
      childNodes: [],
      labels: [],
      shadowRoot: null,
      ownerDocument: null,
      getAttribute(k) { return opts.attrs?.[k] ?? null; },
      hasAttribute(k) { return Boolean(opts.attrs && k in opts.attrs); },
      matches(sel) { return sel === ":disabled" ? Boolean(opts.disabled) : false; },
      closest() { return null; },
      contains(other) {
        if (other === this) return true;
        return this.children.some((c) => c.contains(other));
      },
      scrollIntoView() {},
      focus() {},
      dispatchEvent() {},
      getBoundingClientRect() { return opts.rect ?? { left: 10, top: 10, right: 110, bottom: 50, x: 10, y: 10, width: 100, height: 40 }; },
      querySelectorAll(css) {
        const out = [];
        const walk = (n) => {
          for (const c of n.children) {
            if ((css === ".row" && c.attrs?.class?.includes("row")) ||
                (css === ".badge" && c.attrs?.class?.includes("badge")) ||
                (css === "button" && c.tagName === "BUTTON") ||
                (css === "input" && c.tagName === "INPUT") ||
                (css === ".primary" && c.attrs?.class?.includes("primary")) ||
                (css === "#covered" && c.id === "covered") ||
                (css === "#missing" && false)) {
              out.push(c);
            }
            walk(c);
          }
        };
        walk(this);
        return out;
      },
      getRootNode() { return this.ownerDocument; },
      parentNode: null,
      attrs: opts.attrs,
    };
  }

  class HTMLInputElement {}
  class HTMLButtonElement {}
  class HTMLTextAreaElement {}
  class HTMLSelectElement {}
  class HTMLElement {}
  class ShadowRoot {}
  class InputEvent { constructor(t, init) { this.type = t; Object.assign(this, init); } }
  class Event { constructor(t, init) { this.type = t; Object.assign(this, init); } }

  const badge = makeEl("span", { text: "Live", attrs: { class: "badge" } });
  const btn1 = makeEl("button", { id: "b1", text: "Choose Pro", attrs: { "data-tier": "pro", class: "primary" } });
  const row1 = makeEl("div", { id: "r1", text: "Pro Plan Live", attrs: { class: "row" } });
  row1.children.push(badge, btn1);
  btn1.parentNode = row1;

  const btn2 = makeEl("button", { id: "covered", text: "Covered", attrs: { id: "covered" } });
  const blocker = makeEl("div", { id: "modal" });
  const row2 = makeEl("div", { id: "r2", text: "Archived Row", attrs: { class: "row" } });
  row2.children.push(btn2);
  btn2.parentNode = row2;

  const root = makeEl("body", {});
  root.children.push(row1, row2);
  row1.parentNode = root;
  row2.parentNode = root;
  row2.attrs = { class: "row" };

  let coveredActive = true;
  const doc = {
    body: root,
    documentElement: root,
    children: [root],
    querySelectorAll: (css) => root.querySelectorAll(css),
    elementFromPoint(x, y) {
      if (coveredActive && x >= 10 && y >= 10) return blocker;
      return btn1;
    },
    getElementById() { return null; },
  };
  for (const el of [root, row1, row2, badge, btn1, btn2, blocker]) el.ownerDocument = doc;

  const win = {
    innerWidth: 1280,
    innerHeight: 800,
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
  };
  const ctx = {
    window: win,
    document: doc,
    CSS: { escape: (s) => String(s) },
    HTMLInputElement,
    HTMLButtonElement,
    HTMLTextAreaElement,
    HTMLSelectElement,
    HTMLElement,
    ShadowRoot,
    InputEvent,
    Event,
  };
  const evalExpr = (expr) => vm.runInNewContext(expr, ctx);

  // Filter: has=(...) + has-not-text=... + attribute read
  const attrRes = evalExpr(locatorExpression("css=.row >> has=(css=.badge) >> has-not-text=Archived >> css=button", {
    mutation: "attr",
    attrName: "data-tier",
  }));
  assert.equal(attrRes.value, "pro");

  // Combinators: and=(...) and or=(...), plus allTextContents & isVisible
  const andRes = evalExpr(locatorExpression("css=button >> and=(css=.primary)", { mutation: "allTextContents" }));
  assert.deepEqual([...andRes.values], ["Choose Pro"]);
  const orRes = evalExpr(locatorExpression("css=.primary >> or=(css=#covered)", { mutation: "allTextContents" }));
  assert.deepEqual([...orRes.values], ["Choose Pro", "Covered"]);
  assert.equal(evalExpr(locatorExpression("css=.primary", { mutation: "isVisible" })).value, true);
  assert.equal(evalExpr(locatorExpression("css=#missing", { mutation: "isVisible" })).value, false);

  // Strict multiple match fails as non-retryable
  const multiRes = evalExpr(locatorExpression("css=button", { mutation: "point" }));
  assert.equal(multiRes.code, "multiple");
  assert.equal(multiRes.retryable, false);

  // Missing element fails as retryable
  const missRes = evalExpr(locatorExpression("css=#missing", { mutation: "point" }));
  assert.equal(missRes.code, "not_found");
  assert.equal(missRes.retryable, true);

  // Covered element fails as retryable, while force: true bypasses hit-test
  const covRes = evalExpr(locatorExpression("css=#covered", { mutation: "point" }));
  assert.equal(covRes.code, "covered");
  assert.equal(covRes.retryable, true);

  const forcedRes = evalExpr(locatorExpression("css=#covered", { mutation: "point", force: true }));
  assert.equal(forcedRes.count, 1);
  assert.equal(forcedRes.x, 60);

  // Async evaluate with arg
  const evalRes = await evalExpr(locatorExpression("css=.primary", {
    mutation: "eval",
    evalFn: "async (el, prefix) => prefix + el.id",
    evalArg: "btn:",
    hasEvalArg: true,
    asyncEval: true,
  }));
  assert.equal(evalRes.value, "btn:b1");
});

test("locatorExpression preserves required contract strings for compatibility", () => {
  const clickExpr = locatorExpression('role=button[name="Save"]', { mutation: "point" });
  assert.match(clickExpr, /Locator did not match/);
  const testIdExpr = locatorExpression("testid=email", { mutation: "fill", value: "x" });
  assert.match(testIdExpr, /data-testid/);
  const setValFn = smartSetValueFunctionDeclaration();
  assert.match(setValFn, /dispatchEvent\(new Event\("input"/);
  assert.match(setValFn, /scrollIntoView/);
});

test("in-page MutationObserver waits resolve selector and text in one evaluation", async () => {
  const observers = new Set();
  const notify = () => {
    for (const obs of [...observers]) {
      if (obs.active) obs.callback([], obs);
    }
  };
  class MutationObserver {
    constructor(cb) { this.callback = cb; this.active = false; }
    observe() { this.active = true; observers.add(this); }
    disconnect() { this.active = false; observers.delete(this); }
  }

  let hasBtn = false;
  let bodyText = "Loading...";
  const btn = {
    nodeType: 1,
    tagName: "BUTTON",
    id: "delayed",
    innerText: "Go",
    textContent: "Go",
    children: [],
    childNodes: [],
    labels: [],
    shadowRoot: null,
    getAttribute(k) { return k === "id" ? "delayed" : null; },
    hasAttribute(k) { return k === "id"; },
    matches() { return false; },
    closest() { return null; },
    scrollIntoView() {},
    getBoundingClientRect() { return { left: 0, top: 0, right: 80, bottom: 30, x: 0, y: 0, width: 80, height: 30 }; },
    getRootNode() { return doc; },
  };
  const body = {
    nodeType: 1,
    tagName: "BODY",
    children: [],
    childNodes: [],
    get innerText() { return bodyText; },
    querySelectorAll(css) { return css === "#delayed" && hasBtn ? [btn] : []; },
  };
  const doc = {
    body,
    documentElement: body,
    children: [body],
    querySelectorAll: (css) => body.querySelectorAll(css),
    elementFromPoint: () => btn,
    getElementById: (id) => (id === "delayed" && hasBtn ? btn : null),
  };
  btn.ownerDocument = doc;
  body.ownerDocument = doc;

  const ctx = {
    window: { innerWidth: 1280, innerHeight: 800, getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }) },
    document: doc,
    CSS: { escape: (s) => String(s) },
    HTMLInputElement: class {},
    HTMLButtonElement: class {},
    HTMLTextAreaElement: class {},
    HTMLSelectElement: class {},
    HTMLElement: class {},
    ShadowRoot: class {},
    MutationObserver,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
  };

  setTimeout(() => {
    hasBtn = true;
    bodyText = "Done loading!";
    notify();
  }, 25);

  const [selWait, txtWait] = await Promise.all([
    vm.runInNewContext(locatorExpression("css=#delayed", { mutation: "wait", state: "visible", inPageWaitMs: 500 }), ctx),
    vm.runInNewContext(waitForTextExpression("Done loading!", { timeoutMs: 500 }), ctx),
  ]);
  assert.equal(selWait.satisfied, true);
  assert.equal(txtWait.matched, true);
});
