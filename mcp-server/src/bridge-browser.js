import { randomUUID } from "node:crypto";
import { BridgeClient } from "./bridge-client.js";
import { assertReadOnly } from "./read-only.js";

const DEFAULT_LOAD_TIMEOUT_MS = 15_000;
const KEY_MODIFIERS = { alt: 1, option: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, super: 4, shift: 8 };
const SPECIAL_KEYS = new Map([
  ["enter", { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" }],
  ["return", { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" }],
  ["tab", { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }],
  ["escape", { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }],
  ["esc", { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }],
  ["backspace", { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 }],
  ["delete", { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 }],
  ["space", { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " }],
  ["arrowup", { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 }],
  ["arrowdown", { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 }],
  ["arrowleft", { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 }],
  ["arrowright", { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 }],
  ["home", { key: "Home", code: "Home", windowsVirtualKeyCode: 36 }],
  ["end", { key: "End", code: "End", windowsVirtualKeyCode: 35 }],
  ["pageup", { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 }],
  ["pagedown", { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 }],
  ["insert", { key: "Insert", code: "Insert", windowsVirtualKeyCode: 45 }],
]);
const STATEFUL_PROPERTIES = new Set([
  "checked", "disabled", "expanded", "focused", "invalid", "modal", "multiselectable", "pressed",
  "readonly", "required", "selected",
]);

/**
 * Build a compact, indexed accessibility snapshot from CDP AX nodes.
 * @param {Array<Record<string, any>>} nodes
 * @param {{maxLines?:number}} [options]
 * @returns {{lines:string[], index:Map<string,{backendDOMNodeId:number, role:string, name:string}>, count:number, truncated:boolean}}
 */
export function buildAxState(nodes, { maxLines = 2_000 } = {}) {
  const byId = new Map();
  for (const node of nodes) if (node && typeof node.nodeId === "string") byId.set(node.nodeId, node);
  /** @type {Map<string, Array<Record<string, any>>>} */
  const children = new Map();
  /** @type {Array<Record<string, any>>} */
  const roots = [];
  for (const node of nodes) {
    if (!node || typeof node.nodeId !== "string") continue;
    const parent = typeof node.parentId === "string" ? byId.get(node.parentId) : undefined;
    if (parent) {
      const list = children.get(parent.nodeId) ?? [];
      list.push(node);
      children.set(parent.nodeId, list);
    } else {
      roots.push(node);
    }
  }

  const lines = [];
  const index = new Map();
  let next = 0;
  let truncated = false;
  /** @param {Record<string, any>} node @param {number} depth */
  const visit = (node, depth) => {
    if (truncated) return;
    const role = node.role?.value ?? "unknown";
    const name = String(node.name?.value ?? "").replace(/\s+/g, " ").trim();
    const value = node.value?.value;
    const transparent = node.ignored === true || role === "none" || role === "LineBreak" ||
      role === "InlineTextBox" || role === "generic";
    if (!transparent) {
      if (lines.length >= maxLines) {
        truncated = true;
        return;
      }
      const idx = next++;
      if (Number.isSafeInteger(node.backendDOMNodeId)) {
        index.set(String(idx), { backendDOMNodeId: node.backendDOMNodeId, role, name });
      }
      let line = `${"  ".repeat(depth)}${idx} ${role}`;
      if (name) line += ` "${name}"`;
      const text = value === undefined || value === null ? "" : String(value).trim();
      if (text) line += ` (value: "${text.replace(/\s+/g, " ")}")`;
      const states = formatStates(node.properties);
      if (states) line += ` ${states}`;
      lines.push(line);
    }
    const childDepth = transparent ? depth : depth + 1;
    const ordered = Array.isArray(node.childIds) && node.childIds.length > 0
      ? node.childIds.map((id) => byId.get(id)).filter(Boolean)
      : children.get(node.nodeId) ?? [];
    for (const child of ordered) visit(child, childDepth);
  };
  for (const root of roots) visit(root, 0);
  return { lines, index, count: next, truncated };
}

/** @param {unknown} properties @returns {string} */
function formatStates(properties) {
  if (!Array.isArray(properties)) return "";
  const parts = [];
  for (const property of properties) {
    const name = property?.name;
    if (typeof name !== "string" || !STATEFUL_PROPERTIES.has(name)) continue;
    const raw = property?.value?.value;
    if (raw === true) parts.push(name);
    else if (typeof raw === "string" || typeof raw === "number") parts.push(`${name}=${raw}`);
  }
  return parts.length ? `[${parts.join(" ")}]` : "";
}

/**
 * Parse a key or chord such as "Return", "Tab" or "super+a".
 * @param {string} combo
 * @returns {{key:string, code:string, windowsVirtualKeyCode:number, modifiers:number, text?:string}}
 */
export function parseKeyCombo(combo) {
  const parts = String(combo).split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error("A key is required");
  const token = parts.pop();
  let modifiers = 0;
  for (const part of parts) {
    const mask = KEY_MODIFIERS[part.toLowerCase()];
    if (!mask) throw new Error(`Unknown key modifier: ${part}`);
    modifiers |= mask;
  }
  const special = SPECIAL_KEYS.get(token.toLowerCase());
  if (special) return { ...special, modifiers };
  if (/^[a-z]$/iu.test(token)) {
    const upper = token.toUpperCase();
    return {
      key: token,
      code: `Key${upper}`,
      windowsVirtualKeyCode: upper.charCodeAt(0),
      modifiers,
      text: modifiers === 0 ? token : undefined,
    };
  }
  if (/^[0-9]$/u.test(token)) {
    return { key: token, code: `Digit${token}`, windowsVirtualKeyCode: token.charCodeAt(0), modifiers, text: modifiers === 0 ? token : undefined };
  }
  const fn = /^f(\d{1,2})$/iu.exec(token);
  if (fn) {
    const number = Number(fn[1]);
    return { key: `F${number}`, code: `F${number}`, windowsVirtualKeyCode: 111 + number, modifiers };
  }
  throw new Error(`Unsupported key: ${token}`);
}

/** @param {string} url @returns {string} */
export function normalizeUrl(url) {
  const value = String(url).trim();
  if (value === "about:blank") return value;
  if (/^(?:https?|about|data):/iu.test(value)) return value;
  return `https://${value}`;
}

/**
 * Browser facade over the project's Chrome bridge. It speaks CDP directly and
 * does not require the OpenAI engine or Playwright.
 */
export class BridgeBrowser {
  /**
   * @param {{request:(method:string,params?:Record<string,unknown>)=>Promise<unknown>, close:()=>Promise<void>, sessionId:string, turnId:string, info?:Record<string,unknown>, frameSessions?:Map<number, Map<string,string>>}} options
   */
  constructor({ request, close, sessionId, turnId, info = {}, frameSessions = new Map() }) {
    this.request = request;
    this.closeFn = close;
    this.sessionId = sessionId;
    this.turnId = turnId;
    this.info = info;
    this.frameSessions = frameSessions;
    this.autoAttached = new Set();
    /** @type {Map<number,{id:number,url?:string,title?:string}>} */
    this.tabs = new Map();
    this.activeTabId = null;
    /** @type {Set<number>} */
    this.attached = new Set();
    /** @type {Map<number, Map<string,{backendDOMNodeId:number,role:string,name:string}>>} */
    this.axCache = new Map();
    this.closed = false;
  }

  /**
   * @param {{bridgeFile:string, sessionId?:string, turnId?:string, requestTimeoutMs?:number}} options
   * @returns {Promise<BridgeBrowser>}
   */
  static async connect({ bridgeFile, sessionId = randomUUID(), turnId = randomUUID(), requestTimeoutMs }) {
    const client = new BridgeClient({ bridgeFile, requestTimeoutMs });
    await client.connect();
    const request = (method, params = {}) => client.request(method, params);
    const frameSessions = new Map();
    client.onEvent((method, params) => {
      if (method !== "onCDPEvent" || !params || typeof params !== "object") return;
      const tabId = params.source?.tabId;
      if (!Number.isSafeInteger(tabId)) return;
      const event = params.params;
      if (params.method === "Target.attachedToTarget") {
        const frameId = event?.targetInfo?.targetId;
        const sessionIdForFrame = event?.sessionId;
        if (event?.targetInfo?.type === "iframe" && typeof frameId === "string" && typeof sessionIdForFrame === "string") {
          const map = frameSessions.get(tabId) ?? new Map();
          map.set(frameId, sessionIdForFrame);
          frameSessions.set(tabId, map);
        }
      } else if (params.method === "Target.detachedFromTarget") {
        const map = frameSessions.get(tabId);
        const sessionIdForFrame = event?.sessionId;
        if (map && typeof sessionIdForFrame === "string") {
          for (const [frameId, id] of map) if (id === sessionIdForFrame) map.delete(frameId);
        }
      }
    });
    const info = await request("getInfo", { session_id: sessionId, turn_id: turnId });
    return new BridgeBrowser({ request, close: () => client.close(), sessionId, turnId, info: info ?? {}, frameSessions });
  }

  /** @param {string} method @param {Record<string, unknown>} [params] */
  #rpc(method, params = {}) {
    return this.request(method, { session_id: this.sessionId, turn_id: this.turnId, ...params });
  }

  /** @param {number} tabId @param {string} method @param {Record<string, unknown>} [params] */
  #cdp(tabId, method, params = {}) {
    return this.#rpc("executeCdp", { target: { tabId }, method, commandParams: params });
  }

  /** @param {number} tabId @param {string} sessionId @param {string} method @param {Record<string, unknown>} [params] */
  #cdpIn(tabId, sessionId, method, params = {}) {
    return this.#rpc("executeCdp", { target: { tabId, sessionId }, method, commandParams: params });
  }

  /** @param {number} tabId @returns {Promise<void>} */
  async #ensureAutoAttach(tabId) {
    if (this.autoAttached.has(tabId)) return;
    await this.#cdp(tabId, "Target.setAutoAttach", {
      autoAttach: true,
      flatten: true,
      waitForDebuggerOnStart: false,
      filter: [{ type: "iframe", exclude: false }],
    });
    this.autoAttached.add(tabId);
  }

  /** @returns {Promise<Array<{tab_id:string,title:string,url:string,active:boolean}>>} */
  async listTabs() {
    this.#assertOpen();
    const tabs = await this.#rpc("getTabs");
    this.tabs.clear();
    const result = [];
    for (const tab of Array.isArray(tabs) ? tabs : []) {
      if (!Number.isSafeInteger(tab?.id)) continue;
      this.tabs.set(tab.id, tab);
      result.push({
        tab_id: String(tab.id),
        title: tab.title || "Untitled",
        url: tab.url || "",
        active: tab.id === this.activeTabId,
      });
    }
    if (this.activeTabId !== null && !this.tabs.has(this.activeTabId)) this.activeTabId = null;
    if (this.activeTabId === null && result.length > 0) this.activeTabId = this.tabs.keys().next().value ?? null;
    for (const entry of result) entry.active = Number(entry.tab_id) === this.activeTabId;
    return result;
  }

  /** @param {unknown} [tabId] @returns {Promise<number>} */
  async #resolveTab(tabId) {
    const candidate = tabId === undefined || tabId === null || tabId === "" ? this.activeTabId : Number(tabId);
    if (Number.isSafeInteger(candidate) && this.tabs.has(candidate)) return candidate;
    const tabs = await this.listTabs();
    if (candidate !== null && Number.isSafeInteger(candidate)) {
      const found = tabs.find((tab) => Number(tab.tab_id) === candidate);
      if (!found) throw new Error("Browser tab is unavailable to this session");
      this.activeTabId = candidate;
      return candidate;
    }
    if (tabs.length === 0) throw new Error("No browser tab exists in this session; call browser_new_tab first");
    this.activeTabId = Number(tabs[0].tab_id);
    return this.activeTabId;
  }

  /** @param {number} tabId @returns {Promise<void>} */
  async attach(tabId) {
    if (this.attached.has(tabId)) return;
    await this.#rpc("attach", { tabId });
    this.attached.add(tabId);
    this.axCache.delete(tabId);
  }

  /** @param {string} [url] @returns {Promise<{tab_id:string,title:string,url:string,active:boolean}>} */
  async newTab(url) {
    this.#assertOpen();
    const tab = await this.#rpc("createTab");
    if (!Number.isSafeInteger(tab?.id)) throw new Error("Browser bridge returned a tab without an ID");
    this.tabs.set(tab.id, tab);
    this.activeTabId = tab.id;
    await this.attach(tab.id);
    if (url && normalizeUrl(url) !== "about:blank") await this.goto(url, tab.id);
    return { tab_id: String(tab.id), title: tab.title || "Untitled", url: tab.url || "", active: true };
  }

  /** @param {unknown} tabId */
  async selectTab(tabId) {
    const id = Number(tabId);
    if (!Number.isSafeInteger(id)) throw new Error("A numeric tab_id is required");
    const tabs = await this.listTabs();
    if (!tabs.some((tab) => Number(tab.tab_id) === id)) throw new Error("Browser tab is unavailable to this session");
    this.activeTabId = id;
    await this.attach(id);
    return { tab_id: String(id), ok: true };
  }

  /** @param {unknown} tabId @returns {Promise<{tab_id:string,closed:boolean}>} */
  async closeTab(tabId) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    await this.#cdp(id, "Page.close");
    this.tabs.delete(id);
    this.attached.delete(id);
    this.axCache.delete(id);
    this.frameSessions.delete(id);
    this.autoAttached.delete(id);
    if (this.activeTabId === id) this.activeTabId = this.tabs.keys().next().value ?? null;
    return { tab_id: String(id), closed: true };
  }

  /** @param {unknown} tabId @param {string} url */
  async goto(url, tabId) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const target = normalizeUrl(url);
    await this.#cdp(id, "Page.enable");
    let committed = false;
    try {
      await this.#rpc("navigateTab", { tabId: id, url: target });
      await this.#waitForCommit(id, target, 5_000);
      committed = true;
    } catch {
      // Fall back to CDP navigation when the tab-level navigation does not commit.
    }
    if (!committed) {
      await this.#navigateWithCdp(id, target);
      await this.#waitForCommit(id, target);
    }
    await this.#waitForLoad(id);
    return { tab_id: String(id), ok: true, url: target };
  }

  /** @param {unknown} tabId @param {"back"|"forward"} direction */
  async history(direction, tabId) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const history = await this.#cdp(id, "Page.getNavigationHistory");
    const entries = Array.isArray(history?.entries) ? history.entries : [];
    const delta = direction === "back" ? -1 : 1;
    const entry = entries[(history?.currentIndex ?? 0) + delta];
    if (!entry || !Number.isSafeInteger(entry.id)) throw new Error(`No browser history entry to go ${direction}`);
    await this.#cdp(id, "Page.navigateToHistoryEntry", { entryId: entry.id });
    await this.#waitForLoad(id);
    return { tab_id: String(id), ok: true, direction };
  }

  /** @param {unknown} tabId */
  async reload(tabId) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    await this.#cdp(id, "Page.reload");
    await this.#waitForLoad(id);
    return { tab_id: String(id), ok: true, reloaded: true };
  }

  /** @param {unknown} tabId @param {{fullPage?:boolean}} [options] */
  async screenshot(tabId, { fullPage = false } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const capture = await this.#cdp(id, "Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: fullPage,
      fromSurface: true,
    });
    if (!capture || typeof capture.data !== "string") throw new Error("Browser screenshot returned no image data");
    return { tab_id: String(id), mimeType: "image/png", data: capture.data };
  }

  /**
   * @param {unknown} tabId
   * @param {{screenshot?:boolean, maxLines?:number}} [options]
   */
  async getState(tabId, { screenshot = true, maxLines = 2_000 } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    await this.#cdp(id, "Accessibility.enable");
    const tree = await this.#cdp(id, "Accessibility.getFullAXTree");
    const snapshot = buildAxState(tree?.nodes ?? [], { maxLines });
    this.axCache.set(id, snapshot.index);
    const location = await this.#evaluateRaw(id, "({title: document.title, url: location.href})");
    let image = null;
    if (screenshot) {
      try {
        image = (await this.screenshot(id)).data;
      } catch {
        image = null;
      }
    }
    const lines = [
      `Title: ${location?.title || ""}`,
      `URL: ${location?.url || ""}`,
      "<ax_state>",
      ...snapshot.lines,
      ...(snapshot.truncated ? ["...(truncated)"] : []),
      "</ax_state>",
    ];
    return {
      tab_id: String(id),
      title: String(location?.title || ""),
      url: String(location?.url || ""),
      axText: lines.join("\n"),
      elementCount: snapshot.count,
      screenshotBase64: image,
    };
  }

  /**
   * @param {unknown} elementIndex
   * @param {{tabId?:unknown, clickCount?:number, button?:string}} [options]
   */
  async click(elementIndex, { tabId, clickCount = 1, button = "left" } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const indices = splitIndices(elementIndex);
    if (indices.length === 0) throw new Error("An element index is required; call browser_get_state first");
    for (const index of indices) {
      const node = this.#axNode(id, index);
      await this.#clickNode(id, node, { clickCount, button });
    }
    return { tab_id: String(id), ok: true, action: "click", indices };
  }

  /** @param {unknown} elementIndex @param {string} value @param {{tabId?:unknown}} [options] */
  async setValue(elementIndex, value, { tabId } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const node = this.#axNode(id, elementIndex);
    await this.#scrollIntoView(id, node).catch(() => {});
    await this.#cdp(id, "DOM.focus", { backendNodeId: node.backendDOMNodeId });
    const { object } = await this.#cdp(id, "DOM.resolveNode", { backendNodeId: node.backendDOMNodeId });
    if (!object?.objectId) throw new Error("Browser element could not be resolved");
    await this.#cdp(id, "Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: `function (value) {
        const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(this), "value");
        if (descriptor?.set) descriptor.set.call(this, value); else this.value = value;
        this.dispatchEvent(new Event("input", { bubbles: true }));
        this.dispatchEvent(new Event("change", { bubbles: true }));
      }`,
      arguments: [{ value: String(value) }],
    });
    return { tab_id: String(id), ok: true, action: "set_value", index: String(elementIndex) };
  }

  /** @param {string} text @param {{tabId?:unknown, elementIndex?:unknown}} [options] */
  async typeText(text, { tabId, elementIndex } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    if (elementIndex !== undefined && elementIndex !== null) {
      await this.click(elementIndex, { tabId: id });
    }
    await this.#cdp(id, "Input.insertText", { text: String(text) });
    return { tab_id: String(id), ok: true, action: "type_text" };
  }

  /** @param {string} combo @param {{tabId?:unknown, elementIndex?:unknown}} [options] */
  async pressKey(combo, { tabId, elementIndex } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    if (elementIndex !== undefined && elementIndex !== null) {
      const node = this.#axNode(id, elementIndex);
      await this.#scrollIntoView(id, node).catch(() => {});
      await this.#cdp(id, "DOM.focus", { backendNodeId: node.backendDOMNodeId });
    }
    const key = parseKeyCombo(combo);
    const base = {
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.windowsVirtualKeyCode,
      nativeVirtualKeyCode: key.windowsVirtualKeyCode,
      modifiers: key.modifiers,
    };
    await this.#cdp(id, "Input.dispatchKeyEvent", { type: key.text ? "keyDown" : "rawKeyDown", ...base, ...(key.text ? { text: key.text } : {}) });
    await this.#cdp(id, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
    return { tab_id: String(id), ok: true, action: "press_key", key: combo };
  }

  /** @param {"up"|"down"|"left"|"right"} direction @param {{tabId?:unknown, elementIndex?:unknown, pages?:number}} [options] */
  async scroll(direction, { tabId, elementIndex, pages = 1 } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const delta = 500 * Math.max(1, Number(pages) || 1);
    const deltas = {
      up: { deltaX: 0, deltaY: -delta },
      down: { deltaX: 0, deltaY: delta },
      left: { deltaX: -delta, deltaY: 0 },
      right: { deltaX: delta, deltaY: 0 },
    }[direction];
    if (!deltas) throw new Error(`Unsupported scroll direction: ${direction}`);
    let point = { x: 0, y: 0 };
    if (elementIndex !== undefined && elementIndex !== null) {
      const box = await this.#boxModel(id, this.#axNode(id, elementIndex));
      point = { x: box.x, y: box.y };
    } else {
      const metrics = await this.#cdp(id, "Page.getLayoutMetrics");
      const viewport = metrics?.cssLayoutViewport ?? metrics?.layoutViewport ?? { clientWidth: 1280, clientHeight: 800 };
      point = { x: Math.floor(viewport.clientWidth / 2), y: Math.floor(viewport.clientHeight / 2) };
    }
    await this.#cdp(id, "Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, ...deltas });
    return { tab_id: String(id), ok: true, action: "scroll", direction, pages };
  }

  /** @param {string} selector @param {{tabId?:unknown, frame?:string}} [options] */
  async locatorClick(selector, { tabId, frame } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    if (frame) {
      const sessionId = await this.#frameSession(id, frame);
      await this.#locatorInSession(id, sessionId, selector, { mutation: "click" });
      return { tab_id: String(id), ok: true, action: "locator_click", selector, frame };
    }
    const match = await this.#locator(id, selector, { mutation: "point" });
    await this.#clickPoint(id, match.x, match.y, { clickCount: 1, button: "left" });
    return { tab_id: String(id), ok: true, action: "locator_click", selector };
  }

  /** @param {string} selector @param {string} value @param {{tabId?:unknown, frame?:string}} [options] */
  async locatorFill(selector, value, { tabId, frame } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    if (frame) {
      const sessionId = await this.#frameSession(id, frame);
      await this.#locatorInSession(id, sessionId, selector, { mutation: "fill", value: String(value) });
      return { tab_id: String(id), ok: true, action: "locator_fill", selector, frame };
    }
    await this.#locator(id, selector, { mutation: "fill", value: String(value) });
    return { tab_id: String(id), ok: true, action: "locator_fill", selector };
  }

  /** @param {unknown} tabId */
  async getContent(tabId) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const text = await this.#evaluateRaw(id, "document.body ? document.body.innerText : ''");
    return { tab_id: String(id), text: String(text ?? "") };
  }

  /** @param {string} source @param {{tabId?:unknown}} [options] */
  async evaluate(source, { tabId } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const expression = assertReadOnly(source);
    const value = await this.#evaluateRaw(id, expression, { awaitPromise: true });
    return { tab_id: String(id), value: value ?? null };
  }

  /** @param {{tabId?:unknown, accept:boolean, promptText?:string}} options */
  async handleDialog({ tabId, accept, promptText }) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    await this.#cdp(id, "Page.handleJavaScriptDialog", {
      accept: Boolean(accept),
      ...(promptText === undefined ? {} : { promptText: String(promptText) }),
    });
    return { tab_id: String(id), ok: true, action: "handle_dialog", accepted: Boolean(accept) };
  }

  /** @param {{keep?:Array<{tab_id:unknown, mode?:string}>}} [options] */
  async endTurn({ keep = [] } = {}) {
    for (const entry of keep) {
      const id = await this.#resolveTab(entry?.tab_id);
      const mode = entry?.mode === "deliverable" ? "deliverable" : "handoff";
      await this.#rpc("markTab", { tabId: id, status: mode });
    }
    await this.#rpc("turnEnded");
    this.turnId = randomUUID();
    this.axCache.clear();
    this.frameSessions.clear();
    this.autoAttached.clear();
    return { ok: true, ended: true, nextTurnId: this.turnId };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.closeFn();
  }

  #assertOpen() {
    if (this.closed) throw new Error("Browser session is closed");
  }

  /** @param {number} tabId @param {unknown} index */
  #axNode(tabId, index) {
    const key = String(index).trim();
    const node = this.axCache.get(tabId)?.get(key);
    if (!node) throw new Error(`Element index ${key} not found in the current accessibility tree. Call browser_get_state first.`);
    return node;
  }

  /** @param {number} tabId @param {{backendDOMNodeId:number}} node */
  async #scrollIntoView(tabId, node) {
    await this.#cdp(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId: node.backendDOMNodeId });
  }

  /** @param {number} tabId @param {{backendDOMNodeId:number}} node */
  async #boxModel(tabId, node) {
    await this.#scrollIntoView(tabId, node).catch(() => {});
    const model = await this.#cdp(tabId, "DOM.getBoxModel", { backendNodeId: node.backendDOMNodeId });
    const quad = model?.model?.border;
    if (!Array.isArray(quad) || quad.length !== 8) throw new Error("Browser element has no visible box");
    const x = (quad[0] + quad[2]) / 2;
    const y = (quad[1] + quad[5]) / 2;
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Browser element has no visible box");
    return { x, y };
  }

  /** @param {number} tabId @param {{backendDOMNodeId:number, role:string, name:string}} node @param {{clickCount:number, button:string}} options */
  async #clickNode(tabId, node, { clickCount, button }) {
    let point;
    try {
      point = await this.#boxModel(tabId, node);
    } catch {
      await this.#cdp(tabId, "DOM.focus", { backendNodeId: node.backendDOMNodeId });
      const { object } = await this.#cdp(tabId, "DOM.resolveNode", { backendNodeId: node.backendDOMNodeId });
      if (!object?.objectId) throw new Error("Browser element could not be resolved for clicking");
      await this.#cdp(tabId, "Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: "function () { this.click(); }",
      });
      return;
    }
    await this.#clickPoint(tabId, point.x, point.y, { clickCount, button });
  }

  /** @param {number} tabId @param {number} x @param {number} y @param {{clickCount:number, button:string}} options */
  async #clickPoint(tabId, x, y, { clickCount, button }) {
    const common = { x, y, button, clickCount, modifiers: 0 };
    await this.#cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...common, button: "none", clickCount: 0 });
    await this.#cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...common });
    await this.#cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...common });
  }

  /** @param {number} tabId @param {string} selector @param {{mutation?:string, value?:string}} [options] */
  async #locator(tabId, selector, options = {}) {
    const result = await this.#evaluateRaw(tabId, locatorExpression(selector, options));
    if (result?.error) throw new Error(String(result.error));
    return result;
  }

  /** @param {number} tabId @param {string} framePath @returns {Promise<string>} */
  async #frameSession(tabId, framePath) {
    const parts = String(framePath).split(">>").map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0) throw new Error("A frame selector is required");
    await this.#ensureAutoAttach(tabId);
    let sessionId = null;
    for (const part of parts) {
      const exec = (method, params) => sessionId
        ? this.#cdpIn(tabId, sessionId, method, params)
        : this.#cdp(tabId, method, params);
      await exec("DOM.enable", {});
      const document = await exec("DOM.getDocument", { depth: 0 });
      const { nodeId } = await exec("DOM.querySelector", { nodeId: document.root.nodeId, selector: part });
      if (!nodeId) throw new Error(`No iframe matched: ${part}`);
      const described = await exec("DOM.describeNode", { nodeId });
      const frameId = described?.node?.frameId;
      if (typeof frameId !== "string") throw new Error(`The element matched by ${part} is not a frame`);
      sessionId = await this.#waitForFrameSession(tabId, frameId);
    }
    return sessionId;
  }

  /** @param {number} tabId @param {string} frameId @returns {Promise<string>} */
  async #waitForFrameSession(tabId, frameId) {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const sessionId = this.frameSessions.get(tabId)?.get(frameId);
      if (typeof sessionId === "string") return sessionId;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("The cross-origin frame session is unavailable; this iframe may be same-process");
  }

  /** @param {number} tabId @param {string} sessionId @param {string} selector @param {{mutation?:string, value?:string}} [options] */
  async #locatorInSession(tabId, sessionId, selector, options = {}) {
    const response = await this.#cdpIn(tabId, sessionId, "Runtime.evaluate", {
      expression: locatorExpression(selector, options),
      returnByValue: true,
      awaitPromise: false,
    });
    if (response?.exceptionDetails) {
      const details = response.exceptionDetails;
      throw new Error(details.exception?.description || details.text || "Browser locator failed");
    }
    const value = response?.result?.value;
    if (value?.error) throw new Error(String(value.error));
    return value;
  }

  /** @param {number} tabId @param {string} expression @param {{awaitPromise?:boolean}} [options] */
  async #evaluateRaw(tabId, expression, { awaitPromise = false } = {}) {
    const response = await this.#cdp(tabId, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: false,
      includeCommandLineAPI: false,
    });
    if (response?.exceptionDetails) {
      const details = response.exceptionDetails;
      throw new Error(details.exception?.description || details.text || "Browser evaluation failed");
    }
    return response?.result?.value;
  }

  /** @param {number} tabId @param {string} target @param {number} [timeoutMs] */
  async #waitForCommit(tabId, target, timeoutMs = DEFAULT_LOAD_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = await this.#evaluateRaw(tabId, "location.href").catch(() => null);
      if (typeof current === "string" && current !== "about:blank" &&
          (current === target || current.startsWith("data:") || target.startsWith("data:"))) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Browser navigation did not commit to ${target} within ${timeoutMs}ms`);
  }

  /** @param {number} tabId @param {string} target */
  async #navigateWithCdp(tabId, target) {
    const navigation = await this.#cdp(tabId, "Page.navigate", { url: target });
    if (navigation && typeof navigation === "object" && navigation.errorText) {
      let current = null;
      for (let attempt = 0; attempt < 20; attempt++) {
        current = await this.#evaluateRaw(tabId, "location.href").catch(() => null);
        if (typeof current === "string" && current !== "about:blank") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const committed = typeof current === "string" && current !== "about:blank" &&
        (current === target || current.startsWith("data:"));
      if (!committed) throw new Error(`Browser navigation failed: ${navigation.errorText}`);
    }
  }

  /** @param {number} tabId */
  async #waitForLoad(tabId) {
    const deadline = Date.now() + DEFAULT_LOAD_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const ready = await this.#evaluateRaw(tabId, "document.readyState");
        if (ready === "complete") return;
      } catch {
        // The navigation may have replaced the execution context; retry.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Browser navigation did not reach document.readyState=complete within ${DEFAULT_LOAD_TIMEOUT_MS}ms`);
  }
}

/** @param {unknown} value @returns {string[]} */
function splitIndices(value) {
  if (value === undefined || value === null || value === "") return [];
  return String(value).split(/[,;\s]+/u).map((entry) => entry.trim()).filter(Boolean);
}

/**
 * @param {string} selector
 * @param {{mutation?:string, value?:string}} options
 * @returns {string}
 */
function locatorExpression(selector, options) {
  return `(() => {
    const raw = ${JSON.stringify(selector)};
    const mutation = ${JSON.stringify(options.mutation ?? null)};
    const nextValue = ${JSON.stringify(options.value ?? null)};
    const fail = (message) => ({error: message});
    let nodes;
    try {
      if (raw.startsWith("text=")) {
        const text = raw.slice(5).trim();
        const all = Array.from(document.querySelectorAll("body *")).filter((el) => (el.innerText || "").includes(text));
        nodes = all.filter((el) => !Array.from(el.children).some((child) => (child.innerText || "").includes(text)));
      } else if (raw.startsWith("role=")) {
        const match = /^role=([a-zA-Z]+)(?:\\[name=(?:"([^"]*)"|'([^']*)')\\])?$/.exec(raw);
        if (!match) return fail("Invalid role locator");
        const role = match[1].toLowerCase();
        const name = match[2] !== undefined ? match[2] : match[3];
        const implicit = {a: "link", button: "button", h1: "heading", h2: "heading", h3: "heading", img: "img", input: "textbox", li: "listitem", main: "main", nav: "navigation", select: "combobox", textarea: "textbox", ul: "list"};
        nodes = Array.from(document.querySelectorAll("*")).filter((el) => {
          const actual = (el.getAttribute("role") || implicit[el.tagName.toLowerCase()] || "").toLowerCase();
          if (actual !== role) return false;
          if (name === undefined) return true;
          return (el.getAttribute("aria-label") || el.innerText || el.value || "").trim() === name;
        });
      } else if (raw.startsWith("testid=")) {
        nodes = Array.from(document.querySelectorAll('[data-testid="' + CSS.escape(raw.slice(7)) + '"]'));
      } else {
        nodes = Array.from(document.querySelectorAll(raw.startsWith("css=") ? raw.slice(4) : raw));
      }
    } catch (error) {
      return fail("Invalid locator: " + error.message);
    }
    if (nodes.length === 0) return fail("Locator did not match any element: " + raw);
    if (nodes.length > 1) return fail("Locator matched " + nodes.length + " elements; narrow it: " + raw);
    const element = nodes[0];
    if (mutation === "click") {
      element.scrollIntoView({block: "center", inline: "center"});
      element.click();
      return {count: 1, clicked: true};
    }
    if (mutation === "fill") {
      element.scrollIntoView({block: "center", inline: "center"});
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
      if (descriptor?.set) descriptor.set.call(element, nextValue); else element.value = nextValue;
      element.dispatchEvent(new Event("input", {bubbles: true}));
      element.dispatchEvent(new Event("change", {bubbles: true}));
      return {count: 1, filled: true};
    }
    element.scrollIntoView({block: "center", inline: "center"});
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return fail("Locator matched an element with no visible box: " + raw);
    return {count: 1, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: rect.width, height: rect.height};
  })()`;
}
