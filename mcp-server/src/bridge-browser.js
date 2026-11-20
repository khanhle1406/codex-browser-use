import { randomUUID } from "node:crypto";
import path from "node:path";
import { BridgeClient } from "./bridge-client.js";
import { assertReadOnly } from "./read-only.js";
import { buildAxDiff, buildAxState, buildDialogAxState, formatAriaSnapshot, mergeFrameAriaSnapshots, mergeFrameAxStates } from "./ax-tree.js";
import { extractContentExpression } from "./content-extractor.js";
import {
  LOCATOR_RUNTIME_VERSION,
  domSnapshotExpression,
  hitTestFunctionDeclaration,
  inspectElementAtPointExpression,
  locatorExpression,
  locatorInvokeExpression,
  locatorResolveNodeExpression,
  locatorRuntimeInstallExpression,
  selectOptionFunctionDeclaration,
  smartSetValueFunctionDeclaration,
  waitForTextExpression,
} from "./locators.js";

export { buildAxState };

const DEFAULT_LOAD_TIMEOUT_MS = 15_000;
const DEFAULT_LOCATOR_TIMEOUT_MS = 3_000;
const DEFAULT_SETTLE_TIMEOUT_MS = 5_000;
export const TAB_GROUP_COLORS = new Set(["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]);
const KEY_MODIFIERS = {
  alt: 1,
  option: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  super: 4,
  shift: 8,
  controlormeta: process.platform === "darwin" ? 4 : 2,
};
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
  ["up", { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 }],
  ["arrowdown", { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 }],
  ["down", { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 }],
  ["arrowleft", { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 }],
  ["left", { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 }],
  ["arrowright", { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 }],
  ["right", { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 }],
  ["home", { key: "Home", code: "Home", windowsVirtualKeyCode: 36 }],
  ["end", { key: "End", code: "End", windowsVirtualKeyCode: 35 }],
  ["pageup", { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 }],
  ["pagedown", { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 }],
  ["insert", { key: "Insert", code: "Insert", windowsVirtualKeyCode: 45 }],
]);

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
    return {
      key: token,
      code: `Digit${token}`,
      windowsVirtualKeyCode: token.charCodeAt(0),
      modifiers,
      text: modifiers === 0 ? token : undefined,
    };
  }
  const fn = /^f(\d{1,2})$/iu.exec(token);
  if (fn) {
    const number = Number(fn[1]);
    return { key: `F${number}`, code: `F${number}`, windowsVirtualKeyCode: 111 + number, modifiers };
  }
  throw new Error(`Unsupported key: ${token}`);
}

/** @param {string|string[]|undefined} modifiers @returns {number} */
function parseModifiers(modifiers) {
  if (!modifiers) return 0;
  const list = Array.isArray(modifiers) ? modifiers : String(modifiers).split("+");
  let mask = 0;
  for (const mod of list) {
    const part = String(mod).trim().toLowerCase();
    if (!part) continue;
    const bit = KEY_MODIFIERS[part];
    if (!bit) throw new Error(`Unknown key modifier: ${mod}`);
    mask |= bit;
  }
  return mask;
}

/** @param {string} button @returns {number} */
function buttonMask(button) {
  if (button === "left") return 1;
  if (button === "right") return 2;
  if (button === "middle") return 4;
  return 0;
}

/** @param {string} url @returns {string} */
export function normalizeUrl(url) {
  const value = String(url).trim();
  if (value === "about:blank") return value;
  if (/^(?:https?|about|data|file|blob|chrome-error):/iu.test(value)) return value;
  if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../")) {
    return `file://${path.resolve(value)}`;
  }
  if (/^[a-z]:[\\/]/iu.test(value)) return `file:///${value.replaceAll("\\", "/")}`;
  return `https://${value}`;
}

/**
 * Compare two URLs after the normalizations a browser applies, such as adding a
 * trailing slash to an origin and dropping an empty fragment.
 * @param {string} current
 * @param {string} target
 * @returns {boolean}
 */
export function sameUrl(current, target) {
  const normalize = (value) => {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname.replace(/\/+$/u, "")}${url.search}${url.hash}`;
    } catch {
      return value.replace(/\/+$/u, "");
    }
  };
  return normalize(current) === normalize(target);
}

/** @param {unknown} value @returns {string[]} */
function splitIndices(value) {
  if (value === undefined || value === null || value === "") return [];
  return String(value).split(/[,;\s]+/u).map((entry) => entry.trim()).filter(Boolean);
}

/** @param {unknown} ms @returns {Promise<void>} */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {Record<string, any>} params @returns {string} */
function formatConsoleArgs(params) {
  if (!Array.isArray(params?.args)) return "";
  return params.args.map((arg) => {
    if (arg.value !== undefined) return typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value);
    if (arg.description) return String(arg.description);
    return `[${arg.type ?? "unknown"}]`;
  }).join(" ");
}

/**
 * Browser facade over the project's Chrome bridge. Speaks CDP directly through the
 * extension + native host without requiring any proprietary runtime or Playwright install.
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
    /** @type {Map<number,{id:number,url?:string,title?:string,owned?:boolean,origin?:string}>} */
    this.tabs = new Map();
    /** @type {Set<number>} */
    this.ownedTabs = new Set();
    this.activeTabId = null;
    /** @type {Set<number>} */
    this.attached = new Set();
    /** @type {Map<number, Set<string>>} */
    this.enabledDomains = new Map();
    /** @type {Map<number, Map<string, Promise<void>>>} */
    this.enablingDomains = new Map();
    /** @type {Set<string>} */
    this.enabledChildAxSessions = new Set();
    /** @type {Map<number, {navRevision:number, routes:Map<string, any>}>} */
    this.frameRouteCache = new Map();
    /** @type {Map<string, number>} */
    this.locatorRuntimeInstalled = new Map();
    /** @type {Set<string>} */
    this.statelessEvalTabs = new Set();
    this.supportsPassiveRead = Boolean(info?.apiSupportOverrides?.["BrowserUser.getTabContext"]);
    /** @type {Map<number, Map<string,{backendDOMNodeId:number|null,role:string,name:string,frameId?:string|null,sessionId?:string|null,actions?:string[],dialogControl?:string}>>} */
    this.axCache = new Map();
    /** @type {Map<number, {documentKey:string, entries:Array<any>}>} */
    this.lastAxSnapshots = new Map();
    /** @type {Map<number, {hasEvents:boolean, loading:boolean, committed:boolean, painted:boolean, ready:boolean, navRevision:number, mainFrameId:string|null, loaderId:string|null, url:string|null, lastAxUpdateMs:number, dialog:null|{type:string,message:string,defaultPrompt:string,url:string}, fileChooser:null|{backendNodeId?:number,mode?:string,frameId?:string}, consoleLogs:Array<{level:string,message:string,timestamp:string,url?:string}>, inFlightRequests:Set<string>, notifications:string[]}>} */
    this.tabStates = new Map();
    this.sessionName = null;
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
    let browserRef = null;
    client.onEvent((method, params) => {
      if (method === "onCDPEvent") {
        browserRef?.handleCdpEvent(params);
      } else if (method === "onCDPDetach" && Number.isSafeInteger(params?.tabId)) {
        const tabId = params.tabId;
        browserRef?.#clearTabCaches(tabId);
        browserRef?.attached.delete(tabId);
        browserRef?.autoAttached.delete(tabId);
      } else if (method === "onTabCreated") {
        browserRef?.handleTabCreated(params);
      }
    });
    const info = await request("getInfo", { session_id: sessionId, turn_id: turnId });
    const envCursorMode = process.env.BROWSER_USE_CURSOR_MODE;
    if (envCursorMode === "fast" || envCursorMode === "smooth" || envCursorMode === "off") {
      await request("setConfig", { session_id: sessionId, turn_id: turnId, cursorMode: envCursorMode }).catch(() => {});
    }
    browserRef = new BridgeBrowser({ request, close: () => client.close(), sessionId, turnId, info: info ?? {}, frameSessions });
    return browserRef;
  }

  /** @param {Record<string, any>} params @returns {void} */
  handleTabCreated(params) {
    const tab = params?.tab;
    const openerTabId = params?.openerTabId;
    if (!tab || !Number.isSafeInteger(tab.id)) return;
    this.ownedTabs.add(tab.id);
    this.tabs.set(tab.id, { ...tab, owned: true, origin: "agent" });
    if (Number.isSafeInteger(openerTabId)) {
      const openerState = this.#tabState(openerTabId);
      openerState.popups.push({
        tab_id: String(tab.id),
        url: tab.url || "",
        title: tab.title || "",
        opener_tab_id: String(openerTabId),
        createdAtMs: Date.now(),
      });
      if (openerState.popups.length > 50) openerState.popups.shift();
      this.#pushNotification(openerState, `Popup tab ${tab.id} opened from tab ${openerTabId}.`);
      this.#notifyWaiters(openerState);
    }
  }

  /**
   * Handle incoming CDP events for iframe session tracking, navigation settling,
   * dialogs, file choosers, console messages, and active network requests.
   * @param {Record<string, any>} params
   */
  handleCdpEvent(params) {
    if (!params || typeof params !== "object") return;
    const tabId = params.source?.tabId;
    if (!Number.isSafeInteger(tabId)) return;
    const sessionId = params.source?.sessionId;
    const method = params.method;
    const event = params.params ?? {};

    if (method === "Target.attachedToTarget") {
      const frameId = event?.targetInfo?.targetId;
      const frameSessionId = event?.sessionId;
      if (event?.targetInfo?.type === "iframe" && typeof frameId === "string" && typeof frameSessionId === "string") {
        const map = this.frameSessions.get(tabId) ?? new Map();
        map.set(frameId, frameSessionId);
        this.frameSessions.set(tabId, map);
        this.#notifyWaiters(this.tabStates.get(tabId));
      }
      return;
    }
    if (method === "Target.detachedFromTarget") {
      const map = this.frameSessions.get(tabId);
      if (map && typeof event?.sessionId === "string") {
        for (const [frameId, id] of map) if (id === event.sessionId) map.delete(frameId);
      }
      if (typeof event?.sessionId === "string") {
        this.enabledChildAxSessions.delete(event.sessionId);
        this.#clearLocatorRuntime(tabId, event.sessionId);
      }
      this.frameRouteCache.delete(tabId);
      return;
    }

    const state = this.#tabState(tabId);
    state.hasEvents = true;

    if (method === "Accessibility.loadComplete" || method === "Accessibility.nodesUpdated") {
      state.lastAxUpdateMs = Date.now();
      return;
    }
    if (method === "Page.javascriptDialogOpening") {
      state.dialog = {
        type: String(event.type || "alert"),
        message: String(event.message || ""),
        defaultPrompt: String(event.defaultPrompt || ""),
        url: String(event.url || ""),
      };
      this.#pushNotification(state, `JavaScript ${state.dialog.type} dialog opened: ${JSON.stringify(state.dialog.message)}`);
      this.#notifyWaiters(state);
      return;
    }
    if (method === "Page.javascriptDialogClosed") {
      state.dialog = null;
      this.#notifyWaiters(state);
      return;
    }
    if (method === "Page.fileChooserOpened") {
      state.fileChooser = {
        backendNodeId: event.backendNodeId,
        mode: event.mode,
        frameId: event.frameId,
        openedAtMs: Date.now(),
      };
      this.#pushNotification(state, "File chooser opened; call browser_upload_files with file paths.");
      this.#notifyWaiters(state);
      return;
    }
    if (method === "Bridge.downloadCreated" || method === "Bridge.downloadChanged" ||
        method === "Page.downloadWillBegin" || method === "Page.downloadProgress") {
      const dlId = String(event.id ?? event.guid ?? "");
      if (dlId) {
        let entry = state.downloadById.get(dlId);
        if (!entry) {
          entry = {
            id: dlId,
            url: typeof event.url === "string" ? event.url : "",
            suggestedFilename: typeof event.suggestedFilename === "string"
              ? event.suggestedFilename
              : (typeof event.filename === "string" && event.filename ? path.basename(event.filename) : ""),
            filename: typeof event.filename === "string" ? event.filename : "",
            state: String(event.state || "in_progress"),
            error: typeof event.error === "string" ? event.error : null,
            createdAtMs: Date.now(),
          };
          state.downloadById.set(dlId, entry);
          state.downloads.push(entry);
          if (state.downloads.length > 100) {
            const removed = state.downloads.splice(0, state.downloads.length - 100);
            for (const item of removed) state.downloadById.delete(item.id);
          }
        } else {
          if (typeof event.url === "string" && event.url) entry.url = event.url;
          if (typeof event.filename === "string" && event.filename) {
            entry.filename = event.filename;
            if (!entry.suggestedFilename) entry.suggestedFilename = path.basename(event.filename);
          }
          if (typeof event.suggestedFilename === "string" && event.suggestedFilename) {
            entry.suggestedFilename = event.suggestedFilename;
          }
          if (typeof event.state === "string") entry.state = event.state;
          if (typeof event.error === "string") entry.error = event.error;
        }
        this.#notifyWaiters(state);
      }
      return;
    }
    if (method === "Runtime.consoleAPICalled") {
      const level = event.type === "warning" ? "warn" : (event.type || "log");
      this.#pushLog(state, {
        level,
        message: formatConsoleArgs(event),
        timestamp: new Date().toISOString(),
        url: event.stackTrace?.callFrames?.[0]?.url,
      });
      return;
    }
    if (method === "Runtime.exceptionThrown") {
      const details = event.exceptionDetails ?? {};
      const msg = details.exception?.description || details.text || "Uncaught exception";
      this.#pushLog(state, {
        level: "error",
        message: msg,
        timestamp: new Date().toISOString(),
        url: details.url,
      });
      this.#pushNotification(state, `Page exception: ${msg.split("\n")[0].slice(0, 160)}`);
      return;
    }
    if (method === "Network.requestWillBeSent" && typeof event.requestId === "string") {
      if (state.inFlightRequests.size < 256) state.inFlightRequests.add(event.requestId);
      const url = event.request?.url;
      if (typeof url === "string") {
        const entry = {
          requestId: event.requestId,
          url,
          method: String(event.request?.method || "GET"),
          resourceType: String(event.type || "Other"),
          status: null,
          statusText: null,
          mimeType: null,
          failed: false,
          errorText: null,
          timestamp: new Date().toISOString(),
        };
        state.networkById.set(event.requestId, entry);
        state.networkLogs.push(entry);
        if (state.networkLogs.length > 300) {
          const removed = state.networkLogs.splice(0, state.networkLogs.length - 300);
          for (const item of removed) state.networkById.delete(item.requestId);
        }
      }
      this.#notifyWaiters(state);
      return;
    }
    if (method === "Network.responseReceived" && typeof event.requestId === "string") {
      const resp = event.response ?? {};
      let entry = state.networkById.get(event.requestId);
      if (!entry && typeof resp.url === "string") {
        entry = {
          requestId: event.requestId,
          url: resp.url,
          method: "GET",
          resourceType: String(event.type || "Other"),
          status: null,
          statusText: null,
          mimeType: null,
          failed: false,
          errorText: null,
          timestamp: new Date().toISOString(),
        };
        state.networkById.set(event.requestId, entry);
        state.networkLogs.push(entry);
        if (state.networkLogs.length > 300) {
          const removed = state.networkLogs.splice(0, state.networkLogs.length - 300);
          for (const item of removed) state.networkById.delete(item.requestId);
        }
      }
      if (entry) {
        if (typeof resp.status === "number") entry.status = resp.status;
        if (typeof resp.statusText === "string") entry.statusText = resp.statusText;
        if (typeof resp.mimeType === "string") entry.mimeType = resp.mimeType;
        if (typeof event.type === "string" && entry.resourceType === "Other") entry.resourceType = event.type;
      }
      this.#notifyWaiters(state);
      return;
    }
    if (method === "Network.loadingFinished" && typeof event.requestId === "string") {
      state.inFlightRequests.delete(event.requestId);
      this.#notifyWaiters(state);
      return;
    }
    if (method === "Network.loadingFailed" && typeof event.requestId === "string") {
      state.inFlightRequests.delete(event.requestId);
      const entry = state.networkById.get(event.requestId);
      if (entry) {
        entry.failed = true;
        entry.errorText = typeof event.errorText === "string" ? event.errorText : "Request failed";
      }
      this.#notifyWaiters(state);
      return;
    }

    if (sessionId !== undefined) return;
    switch (method) {
      case "Page.frameStartedLoading":
        if (!state.mainFrameId || event.frameId === state.mainFrameId) {
          state.loading = true;
          state.committed = false;
          state.painted = false;
          state.ready = false;
          state.domContentLoaded = false;
          state.loaded = false;
          state.navRevision += 1;
          this.#clearLocatorRuntime(tabId);
          this.#notifyWaiters(state);
        }
        break;
      case "Page.frameNavigated":
        if (!event.frame?.parentId) {
          state.mainFrameId = event.frame?.id ?? state.mainFrameId;
          state.loaderId = event.frame?.loaderId ?? state.loaderId;
          state.url = event.frame?.url ?? state.url;
          state.committed = true;
          if (event.type === "BackForwardCacheRestore") {
            state.loading = false;
            state.painted = true;
            state.ready = true;
            state.domContentLoaded = true;
            state.loaded = true;
          }
          state.navRevision += 1;
          this.#clearLocatorRuntime(tabId);
          this.#notifyWaiters(state);
        }
        break;
      case "Page.navigatedWithinDocument":
        if (!state.mainFrameId || event.frameId === state.mainFrameId) {
          state.url = event.url ?? state.url;
          state.loading = false;
          state.committed = true;
          state.ready = true;
          state.domContentLoaded = true;
          state.loaded = true;
          state.navRevision += 1;
          this.#notifyWaiters(state);
        }
        break;
      case "Page.domContentEventFired":
        state.domContentLoaded = true;
        state.ready = true;
        this.#notifyWaiters(state);
        break;
      case "Page.loadEventFired":
        state.loading = false;
        state.painted = true;
        state.ready = true;
        state.domContentLoaded = true;
        state.loaded = true;
        this.#notifyWaiters(state);
        break;
      case "Page.frameStoppedLoading":
        if (!state.mainFrameId || event.frameId === state.mainFrameId) {
          state.loading = false;
          state.ready = true;
          state.domContentLoaded = true;
          state.loaded = true;
          this.#notifyWaiters(state);
        }
        break;
      case "Page.lifecycleEvent":
        if (event.name === "firstMeaningfulPaint" || event.name === "firstContentfulPaint") {
          state.painted = true;
          this.#notifyWaiters(state);
        } else if (event.name === "DOMContentLoaded") {
          state.domContentLoaded = true;
          state.ready = true;
          this.#notifyWaiters(state);
        } else if (event.name === "load" || event.name === "networkIdle") {
          state.loading = false;
          state.ready = true;
          state.domContentLoaded = true;
          state.loaded = true;
          this.#notifyWaiters(state);
        }
        break;
      default:
        break;
    }
  }

  #tabState(tabId) {
    let state = this.tabStates.get(tabId);
    if (!state) {
      state = {
        hasEvents: false,
        loading: false,
        committed: false,
        painted: false,
        ready: false,
        domContentLoaded: false,
        loaded: false,
        navRevision: 0,
        mainFrameId: null,
        loaderId: null,
        url: null,
        lastAxUpdateMs: 0,
        dialog: null,
        fileChooser: null,
        consoleLogs: [],
        networkLogs: [],
        networkById: new Map(),
        networkBodyCaptureEnabled: false,
        downloads: [],
        downloadById: new Map(),
        downloadWatchCount: 0,
        popups: [],
        viewportOverride: null,
        inFlightRequests: new Set(),
        notifications: [],
        waiters: new Set(),
      };
      this.tabStates.set(tabId, state);
    }
    return state;
  }

  #notifyWaiters(state) {
    if (!state?.waiters?.size) return;
    for (const wake of state.waiters) wake();
  }

  /** @param {number} tabId @param {number} maxWaitMs */
  async #waitForTabWakeup(tabId, maxWaitMs) {
    const waitMs = Math.max(1, Number(maxWaitMs) || 1);
    const state = this.#tabState(tabId);
    let wakeFn;
    let timer;
    await new Promise((resolve) => {
      wakeFn = () => {
        clearTimeout(timer);
        state.waiters.delete(wakeFn);
        resolve();
      };
      timer = setTimeout(wakeFn, waitMs);
      state.waiters.add(wakeFn);
    });
  }

  #pushLog(state, entry) {
    state.consoleLogs.push(entry);
    if (state.consoleLogs.length > 500) {
      state.consoleLogs.splice(0, state.consoleLogs.length - 500);
    }
  }

  #pushNotification(state, text) {
    if (state.notifications.at(-1) === text) return;
    state.notifications.push(text);
    if (state.notifications.length > 20) state.notifications.shift();
  }

  /** @param {number} tabId @returns {string[]} */
  drainNotifications(tabId) {
    const state = this.tabStates.get(tabId);
    if (!state || state.notifications.length === 0) return [];
    return state.notifications.splice(0, state.notifications.length);
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

  /** @param {number} tabId @param {string|null|undefined} sessionId @param {string} method @param {Record<string, unknown>} [params] */
  #cdpTarget(tabId, sessionId, method, params = {}) {
    return sessionId ? this.#cdpIn(tabId, sessionId, method, params) : this.#cdp(tabId, method, params);
  }

  /** @param {number} tabId @param {string|null} [sessionId] @returns {void} */
  #clearLocatorRuntime(tabId, sessionId = null) {
    if (sessionId !== null) {
      this.locatorRuntimeInstalled.delete(`${tabId}:${sessionId}`);
      return;
    }
    const prefix = `${tabId}:`;
    for (const key of this.locatorRuntimeInstalled.keys()) {
      if (key.startsWith(prefix)) this.locatorRuntimeInstalled.delete(key);
    }
  }

  /** @param {number} tabId @returns {void} */
  #clearTabCaches(tabId) {
    this.enabledDomains.delete(tabId);
    this.enablingDomains.delete(tabId);
    this.frameRouteCache.delete(tabId);
    this.#clearLocatorRuntime(tabId);
    this.#clearLocatorRuntime(tabId);
    const frameMap = this.frameSessions.get(tabId);
    if (frameMap) {
      for (const sessionId of frameMap.values()) this.enabledChildAxSessions.delete(sessionId);
    }
    this.frameSessions.delete(tabId);
  }

  /** @param {number} tabId @param {string} domain @param {string} method @param {Record<string, unknown>} [params] @param {boolean} [bestEffort] */
  async #ensureDomain(tabId, domain, method, params = {}, bestEffort = false) {
    let set = this.enabledDomains.get(tabId);
    if (!set) {
      set = new Set();
      this.enabledDomains.set(tabId, set);
    }
    if (set.has(domain)) return;

    let inflight = this.enablingDomains.get(tabId);
    if (!inflight) {
      inflight = new Map();
      this.enablingDomains.set(tabId, inflight);
    }
    const existing = inflight.get(domain);
    if (existing) {
      await existing;
      return;
    }

    const task = (async () => {
      try {
        await this.#cdp(tabId, method, params);
        set.add(domain);
      } catch (error) {
        if (!bestEffort) throw error;
      } finally {
        inflight.delete(domain);
      }
    })();
    inflight.set(domain, task);
    await task;
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

  /** @returns {boolean} */
  #supportsUserTabs() {
    return Boolean(
      this.info?.apiSupportOverrides?.["BrowserUser.openTabs"] ||
      this.info?.apiSupportOverrides?.["BrowserUser.claimTab"],
    );
  }

  /**
   * Claim an already-open user tab in Chrome so this session can inspect and control it.
   * Claimed user tabs are released (never closed) when the turn or session ends.
   * @param {unknown} tabId
   * @returns {Promise<{tab_id:string,title:string,url:string,active:boolean,owned:boolean,origin:string}>}
   */
  async claimTab(tabId) {
    this.#assertOpen();
    const id = Number(tabId);
    if (!Number.isSafeInteger(id)) throw new Error("A numeric tab_id is required");
    let tab;
    try {
      tab = await this.#rpc("claimUserTab", { tabId: id });
    } catch {
      throw new Error("Browser tab is unavailable to this session");
    }
    if (!Number.isSafeInteger(tab?.id)) throw new Error("Browser tab is unavailable to this session");
    this.ownedTabs.add(tab.id);
    this.tabs.set(tab.id, { ...tab, owned: true, origin: tab.origin || "user" });
    this.activeTabId = tab.id;
    await this.attach(tab.id);
    return {
      tab_id: String(tab.id),
      title: tab.title || "Untitled",
      url: tab.url || "",
      active: true,
      owned: true,
      origin: tab.origin || "user",
    };
  }

  /**
   * @param {{includeUserTabs?:boolean|"force"}} [options]
   * @returns {Promise<Array<{tab_id:string,title:string,url:string,active:boolean,owned?:boolean,origin?:string,browser_active?:boolean}>>}
   */
  async listTabs({ includeUserTabs = true } = {}) {
    this.#assertOpen();
    const fetchUserTabs = includeUserTabs === "force" || (includeUserTabs !== false && this.#supportsUserTabs());
    const [tabs, userTabs] = await Promise.all([
      this.#rpc("getTabs"),
      fetchUserTabs ? this.#rpc("getUserTabs").catch(() => []) : Promise.resolve([]),
    ]);
    this.tabs.clear();
    this.ownedTabs.clear();
    const result = [];
    for (const tab of Array.isArray(tabs) ? tabs : []) {
      if (!Number.isSafeInteger(tab?.id)) continue;
      this.ownedTabs.add(tab.id);
      this.tabs.set(tab.id, tab);
      result.push({
        tab_id: String(tab.id),
        title: tab.title || "Untitled",
        url: tab.url || "",
        active: tab.id === this.activeTabId,
        ...(fetchUserTabs ? { owned: true, origin: tab.origin || "agent" } : {}),
      });
    }
    if (this.activeTabId !== null && !this.ownedTabs.has(this.activeTabId)) this.activeTabId = null;
    if (this.activeTabId === null && this.ownedTabs.size > 0) {
      this.activeTabId = this.ownedTabs.values().next().value ?? null;
    }
    for (const tab of Array.isArray(userTabs) ? userTabs : []) {
      if (!Number.isSafeInteger(tab?.id) || this.ownedTabs.has(tab.id)) continue;
      this.tabs.set(tab.id, { ...tab, owned: false, origin: "user" });
      result.push({
        tab_id: String(tab.id),
        title: tab.title || "Untitled",
        url: tab.url || "",
        active: false,
        browser_active: Boolean(tab.active),
        owned: false,
        origin: "user",
      });
    }
    for (const entry of result) entry.active = Number(entry.tab_id) === this.activeTabId;
    return result;
  }

  /** @param {unknown} [tabId] @param {{autoCreate?:boolean}} [options] @returns {Promise<number>} */
  async #resolveTab(tabId, { autoCreate = false } = {}) {
    const hasExplicit = tabId !== undefined && tabId !== null && tabId !== "";
    const candidate = hasExplicit ? Number(tabId) : this.activeTabId;
    if (Number.isSafeInteger(candidate) && this.ownedTabs.has(candidate)) return candidate;
    await this.listTabs({ includeUserTabs: false });
    if (hasExplicit) {
      if (!Number.isSafeInteger(candidate)) throw new Error("A numeric tab_id is required");
      if (this.ownedTabs.has(candidate)) {
        this.activeTabId = candidate;
        return candidate;
      }
      if (this.#supportsUserTabs()) {
        await this.claimTab(candidate);
        return candidate;
      }
      throw new Error("Browser tab is unavailable to this session");
    }
    if (this.ownedTabs.size === 0) {
      if (autoCreate) {
        const created = await this.newTab();
        return Number(created.tab_id);
      }
      throw new Error("No browser tab exists in this session; call browser_new_tab first");
    }
    this.activeTabId = this.ownedTabs.values().next().value ?? null;
    return this.activeTabId;
  }

  /** @param {number} tabId @returns {Promise<void>} */
  async attach(tabId) {
    if (this.attached.has(tabId)) return;
    await this.#rpc("attach", { tabId });
    this.attached.add(tabId);
    this.axCache.delete(tabId);
    this.enabledDomains.delete(tabId);
    this.enablingDomains.delete(tabId);
    this.frameRouteCache.delete(tabId);
    this.#clearLocatorRuntime(tabId);
    this.#tabState(tabId);
    await this.#cdp(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  }

  /** @param {number} tabId @param {{network?:boolean}} [options] */
  async #enableInspectionDomains(tabId, { network = false } = {}) {
    const tasks = [
      this.#ensureDomain(tabId, "Page", "Page.enable", {}),
      this.#ensureDomain(tabId, "Lifecycle", "Page.setLifecycleEventsEnabled", { enabled: true }, true),
      this.#ensureDomain(tabId, "Runtime", "Runtime.enable", {}, true),
    ];
    if (network) {
      tasks.push(this.#ensureDomain(tabId, "Network", "Network.enable", {
        maxTotalBufferSize: 0,
        maxResourceBufferSize: 0,
      }, true));
    }
    await Promise.all(tasks);
  }

  /**
   * Name the current automation session and visually group owned tabs in a Chrome tab group.
   * @param {string} name
   * @param {{color?:string}} [options]
   */
  async nameSession(name, { color = "blue" } = {}) {
    this.#assertOpen();
    const raw = typeof name === "string" ? name.trim() : "";
    if (!raw) throw new Error("Session name must be a non-empty string");
    const title = raw.slice(0, 80);
    if (!TAB_GROUP_COLORS.has(color)) {
      throw new Error(`Unsupported tab group color: ${String(color)}`);
    }
    const res = await this.#rpc("nameSession", { name: title, color });
    this.sessionName = { name: title, color };
    return {
      ok: true,
      name: title,
      color,
      groupId: res?.groupId ?? null,
      groupedTabs: res?.groupedTabs ?? this.tabs.size,
      supported: res?.supported !== false,
    };
  }

  /** @param {string} [url] @returns {Promise<{tab_id:string,title:string,url:string,active:boolean}>} */
  async newTab(url) {
    this.#assertOpen();
    const tab = await this.#rpc("createTab");
    if (!Number.isSafeInteger(tab?.id)) throw new Error("Browser bridge returned a tab without an ID");
    this.ownedTabs.add(tab.id);
    this.tabs.set(tab.id, tab);
    this.activeTabId = tab.id;
    await this.attach(tab.id);
    if (url && normalizeUrl(url) !== "about:blank") await this.goto(url, tab.id);
    const current = (await this.#rpc("getTabs"))?.find((entry) => entry?.id === tab.id) ?? tab;
    this.ownedTabs.add(tab.id);
    this.tabs.set(tab.id, current);
    return { tab_id: String(tab.id), title: current.title || "Untitled", url: current.url || "", active: true };
  }

  /** @param {unknown} tabId */
  async selectTab(tabId) {
    const id = Number(tabId);
    if (!Number.isSafeInteger(id)) throw new Error("A numeric tab_id is required");
    const resolved = await this.#resolveTab(id);
    this.activeTabId = resolved;
    await this.attach(resolved);
    return { tab_id: String(resolved), ok: true };
  }

  /** @param {unknown} tabId @returns {Promise<{tab_id:string,closed:boolean}>} */
  async closeTab(tabId) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    await this.#cdp(id, "Page.close");
    this.tabs.delete(id);
    this.ownedTabs.delete(id);
    this.attached.delete(id);
    this.axCache.delete(id);
    this.lastAxSnapshots.delete(id);
    this.tabStates.delete(id);
    this.#clearTabCaches(id);
    this.autoAttached.delete(id);
    if (this.activeTabId === id) this.activeTabId = this.ownedTabs.values().next().value ?? null;
    return { tab_id: String(id), closed: true };
  }

  /** @param {string} url @param {unknown} [tabId] @param {{waitUntil?:string, timeoutMs?:number, trackNetwork?:boolean}} [options] */
  async goto(url, tabId, { waitUntil = "load", timeoutMs = DEFAULT_LOAD_TIMEOUT_MS, trackNetwork = false } = {}) {
    const id = await this.#resolveTab(tabId, { autoCreate: true });
    await this.attach(id);
    const target = normalizeUrl(url);
    const needNetwork = waitUntil === "networkidle" || trackNetwork || process.env.BROWSER_USE_TRACK_NETWORK === "1";
    await this.#enableInspectionDomains(id, { network: needNetwork }).catch((err) => {
      // Page.enable is required, best-effort domains already swallow errors inside #enableInspectionDomains.
      if (!this.enabledDomains.get(id)?.has("Page")) throw err;
    });
    this.lastAxSnapshots.delete(id);
    this.frameRouteCache.delete(id);
    const state = this.#tabState(id);
    state.committed = false;
    state.ready = false;
    state.domContentLoaded = false;
    state.loaded = false;
    state.loading = true;

    let committed = false;
    try {
      await this.#rpc("navigateTab", { tabId: id, url: target });
      await this.#waitForCommit(id, target, Math.min(5_000, timeoutMs));
      committed = true;
    } catch {
      // Fall back to CDP navigation when the tab-level navigation does not commit.
    }
    if (!committed) {
      await this.#navigateWithCdp(id, target);
      await this.#waitForCommit(id, target, timeoutMs);
    }
    if (waitUntil !== "commit") {
      await this.#waitForLoad(id, { waitUntil, timeoutMs });
    }
    state.url = target;
    state.committed = true;
    if (waitUntil !== "commit") {
      state.ready = true;
      state.loading = false;
    }
    return { tab_id: String(id), ok: true, url: target };
  }

  /** @param {unknown} [tabId] @returns {Promise<string>} */
  async url(tabId) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const current = await this.#evaluateRaw(id, "location.href").catch(() => null);
    if (typeof current === "string" && current) return current;
    return this.tabStates.get(id)?.url || this.tabs.get(id)?.url || "";
  }

  /** @param {unknown} [tabId] @returns {Promise<string>} */
  async title(tabId) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const current = await this.#evaluateRaw(id, "document.title").catch(() => null);
    if (typeof current === "string") return current;
    return this.tabs.get(id)?.title || "";
  }

  /** @param {unknown} tabId @param {"back"|"forward"} direction */
  async history(direction, tabId) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    this.lastAxSnapshots.delete(id);
    this.frameRouteCache.delete(id);
    const state = this.#tabState(id);
    state.committed = false;
    state.ready = false;
    state.domContentLoaded = false;
    state.loaded = false;
    state.loading = true;
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
    this.lastAxSnapshots.delete(id);
    this.frameRouteCache.delete(id);
    const state = this.#tabState(id);
    state.committed = false;
    state.ready = false;
    state.domContentLoaded = false;
    state.loaded = false;
    state.loading = true;
    await this.#cdp(id, "Page.reload");
    await this.#waitForLoad(id);
    return { tab_id: String(id), ok: true, reloaded: true };
  }

  /**
   * Capture a screenshot (defaults to fast 1x CSS-scaled JPEG for optimal token/speed balance).
   * Supports both screenshot(tabId, opts) and screenshot(opts).
   * @param {unknown} [tabIdOrOptions]
   * @param {{fullPage?:boolean, format?:"jpeg"|"png", quality?:number, clip?:{x:number,y:number,width:number,height:number}, scale?:"css"|"device"}} [maybeOptions]
   */
  async screenshot(tabIdOrOptions, maybeOptions) {
    let tabId = tabIdOrOptions;
    let options = maybeOptions;
    if (tabIdOrOptions && typeof tabIdOrOptions === "object" && !Array.isArray(tabIdOrOptions)) {
      options = tabIdOrOptions;
      tabId = options.tabId ?? options.tab_id;
    }
    const {
      fullPage = false,
      format = "jpeg",
      quality = 75,
      maxWidth = 1280,
      clip,
      scale = "css",
    } = options ?? {};

    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const state = this.tabStates.get(id);
    if (state?.dialog) {
      throw new Error(`Screenshot unavailable while a JavaScript ${state.dialog.type} dialog is open.`);
    }

    const fmt = format === "png" ? "png" : "jpeg";
    /** @type {Record<string, unknown>} */
    const params = { format: fmt, fromSurface: true };
    if (fmt === "jpeg") {
      params.quality = Math.max(10, Math.min(100, Number(quality) || 75));
      params.optimizeForSpeed = true;
    }

    let cssScale = 1;
    let metrics = null;
    if (scale === "css" && !clip) {
      const [dpr, layout] = await Promise.all([
        this.#evaluateRaw(id, "window.devicePixelRatio").catch(() => 1),
        this.#cdp(id, "Page.getLayoutMetrics").catch(() => null),
      ]);
      if (typeof dpr === "number" && Number.isFinite(dpr) && dpr > 1) cssScale = 1 / dpr;
      metrics = layout;
    } else if (scale === "css") {
      const dpr = await this.#evaluateRaw(id, "window.devicePixelRatio").catch(() => 1);
      if (typeof dpr === "number" && Number.isFinite(dpr) && dpr > 1) cssScale = 1 / dpr;
    }

    if (clip && Number.isFinite(clip.width) && Number.isFinite(clip.height)) {
      params.captureBeyondViewport = true;
      params.clip = { x: clip.x ?? 0, y: clip.y ?? 0, width: clip.width, height: clip.height, scale: cssScale };
    } else if (fullPage) {
      params.captureBeyondViewport = true;
      if (cssScale < 1) {
        const content = metrics?.cssContentSize;
        if (content?.width > 0 && content?.height > 0) {
          params.clip = { x: 0, y: 0, width: content.width, height: content.height, scale: cssScale };
        }
      }
    } else {
      const vp = metrics?.cssVisualViewport ?? metrics?.cssLayoutViewport;
      const capWidth = Number.isFinite(Number(maxWidth)) && Number(maxWidth) >= 320 ? Number(maxWidth) : 1280;
      const widthRatio = vp?.clientWidth > capWidth ? capWidth / vp.clientWidth : 1;
      const effectiveScale = cssScale * widthRatio;
      if (effectiveScale < 1 && vp?.clientWidth > 0 && vp?.clientHeight > 0) {
        params.clip = {
          x: vp.pageX ?? 0,
          y: vp.pageY ?? 0,
          width: vp.clientWidth,
          height: vp.clientHeight,
          scale: effectiveScale,
        };
      }
    }

    const capture = await this.#cdp(id, "Page.captureScreenshot", params);
    if (!capture || typeof capture.data !== "string") throw new Error("Browser screenshot returned no image data");
    return {
      tab_id: String(id),
      mimeType: fmt === "png" ? "image/png" : "image/jpeg",
      data: capture.data,
    };
  }

  /**
   * Capture accessibility state (with structural diffing and iframe merging) plus optional screenshot.
   * Supports both getState(options) and getState(tabId, options).
   * @param {unknown} [tabIdOrOptions]
   * @param {{screenshot?:boolean, fullPage?:boolean, format?:"jpeg"|"png", quality?:number, maxLines?:number, diff?:boolean, full?:boolean}} [maybeOptions]
   */
  async getState(tabIdOrOptions, maybeOptions) {
    let tabId = tabIdOrOptions;
    let options = maybeOptions;
    if (tabIdOrOptions && typeof tabIdOrOptions === "object" && !Array.isArray(tabIdOrOptions)) {
      options = tabIdOrOptions;
      tabId = options.tabId ?? options.tab_id;
    }
    const {
      screenshot = true,
      fullPage = false,
      format = "jpeg",
      quality = 75,
      maxLines = 2_000,
      diff = false,
      full = false,
      mode = "full",
      allowUnindexedBaseline = false,
    } = options ?? {};

    const id = await this.#resolveTab(tabId, { autoCreate: true });
    await this.attach(id);

    const tabState = this.#tabState(id);
    if (tabState.dialog) {
      const meta = this.tabs.get(id) ?? {};
      const dialogState = buildDialogAxState(tabState.dialog, {
        tab_id: String(id),
        title: meta.title || "",
        url: meta.url || tabState.url || "",
      });
      this.axCache.set(id, dialogState.index);
      return { ...dialogState, notifications: this.drainNotifications(id) };
    }

    await Promise.all([
      this.#enableInspectionDomains(id).catch(() => {}),
      this.#ensureDomain(id, "Accessibility", "Accessibility.enable"),
    ]);

    // Capture main frame AX tree, frame tree, location, and optional screenshot in parallel.
    const [mainTree, frameTreeResp, location, cap] = await Promise.all([
      this.#cdp(id, "Accessibility.getFullAXTree"),
      this.#cdp(id, "Page.getFrameTree").catch(() => null),
      this.#evaluateRaw(id, "({title: document.title, url: location.href})").catch(() => ({
        title: this.tabs.get(id)?.title ?? "",
        url: this.tabs.get(id)?.url ?? "",
      })),
      screenshot ? this.screenshot(id, { fullPage, format, quality }).catch(() => null) : null,
    ]);

    const frameTrees = [{
      nodes: mainTree?.nodes ?? [],
      frameId: null,
      sessionId: null,
      depth: 0,
    }];
    if (frameTreeResp?.frameTree) {
      await this.#collectChildFrames(id, frameTreeResp.frameTree, frameTrees);
    }

    const merged = mergeFrameAxStates(frameTrees, { maxLines, mode });
    this.axCache.set(id, merged.index);

    const title = String(location?.title || "");
    const url = String(location?.url || "");
    const documentKey = `${tabState.loaderId ?? ""}:${url}`;

    const useDiff = diff && !full;
    const prev = this.lastAxSnapshots.get(id);
    let diffResult = useDiff
      ? buildAxDiff(prev, { documentKey, lines: merged.lines, entries: merged.entries })
      : { mode: "full", lines: merged.lines };
    if (useDiff && prev?.hasIndexedBaseline === false && diffResult.mode === "unchanged") {
      diffResult = allowUnindexedBaseline
        ? { ...diffResult, lines: ["No accessibility changes since last ariaSnapshot()."] }
        : { mode: "full", lines: merged.lines };
    }

    this.lastAxSnapshots.set(id, { documentKey, entries: merged.entries, hasIndexedBaseline: true });

    const image = cap?.data ?? null;
    const screenshotMimeType = cap?.mimeType ?? null;

    const lines = [
      `Title: ${title}`,
      `URL: ${url}`,
      "<ax_state>",
      ...diffResult.lines,
      ...(merged.truncated && diffResult.mode === "full" ? ["...(truncated)"] : []),
      "</ax_state>",
    ];

    return {
      tab_id: String(id),
      title,
      url,
      mode: diffResult.mode,
      axText: lines.join("\n"),
      elementCount: merged.count,
      screenshotBase64: image,
      screenshotMimeType,
      notifications: this.drainNotifications(id),
    };
  }

  /** @param {number} tabId @param {Record<string, any>} frameTree @param {Array<any>} out */
  async #collectChildFrames(tabId, frameTree, out) {
    const attachedFrames = this.frameSessions.get(tabId);
    const queue = [];
    for (const child of frameTree.childFrames ?? []) queue.push({ node: child, depth: 1 });
    const candidates = [];
    while (queue.length > 0 && candidates.length < 8) {
      const { node, depth } = queue.shift();
      const frame = node?.frame;
      if (!frame?.id) continue;
      const childSessionId = attachedFrames?.get(frame.id) ?? null;
      if (childSessionId || (frame.url && frame.url !== "about:blank")) {
        candidates.push({ frameId: frame.id, url: frame.url, childSessionId, depth });
      }
      for (const grandChild of node.childFrames ?? []) queue.push({ node: grandChild, depth: depth + 1 });
    }
    const fetched = await Promise.all(candidates.map(async (item) => {
      try {
        if (item.childSessionId) {
          if (!this.enabledChildAxSessions.has(item.childSessionId)) {
            await this.#cdpIn(tabId, item.childSessionId, "Accessibility.enable", {}).then(
              () => { this.enabledChildAxSessions.add(item.childSessionId); },
              () => {},
            );
          }
          const tree = await this.#cdpIn(tabId, item.childSessionId, "Accessibility.getFullAXTree", { frameId: item.frameId });
          return { item, nodes: tree?.nodes };
        }
        const tree = await this.#cdp(tabId, "Accessibility.getFullAXTree", { frameId: item.frameId });
        return { item, nodes: tree?.nodes };
      } catch {
        return null;
      }
    }));
    for (const entry of fetched) {
      if (entry && Array.isArray(entry.nodes) && entry.nodes.length > 0) {
        out.push({
          nodes: entry.nodes,
          frameId: entry.item.frameId,
          sessionId: entry.item.childSessionId,
          url: entry.item.url,
          depth: entry.item.depth,
        });
      }
    }
  }

  /**
   * Click by element_index (or comma-separated indices) or viewport coordinates { x, y }.
   * @param {unknown} elementIndex
   * @param {{tabId?:unknown, clickCount?:number, button?:string, modifiers?:string|string[], x?:number, y?:number, settle?:boolean}} [options]
   */
  async click(elementIndex, { tabId, clickCount = 1, button = "left", modifiers, x, y, settle = false } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const modMask = parseModifiers(modifiers);

    if ((elementIndex === undefined || elementIndex === null || elementIndex === "") &&
        Number.isFinite(x) && Number.isFinite(y)) {
      await this.#clickPoint(id, Number(x), Number(y), { clickCount, button, modifiers: modMask });
      if (settle) await this.#waitForSettle(id, { expectNavigation: true });
      return { tab_id: String(id), ok: true, action: "click", x: Number(x), y: Number(y) };
    }

    const indices = splitIndices(elementIndex);
    if (indices.length === 0) throw new Error("An element index or (x, y) coordinates are required; call browser_get_state first");
    for (const index of indices) {
      const node = this.#axNode(id, index);
      if (node.dialogControl) {
        await this.handleDialog({ tabId: id, accept: node.dialogControl === "accept" });
        continue;
      }
      await this.#clickNode(id, node, { clickCount, button, modifiers: modMask });
    }
    if (settle) await this.#waitForSettle(id, { expectNavigation: true });
    return { tab_id: String(id), ok: true, action: "click", indices };
  }

  /** @param {unknown} elementIndex @param {string} value @param {{tabId?:unknown, settle?:boolean}} [options] */
  async setValue(elementIndex, value, { tabId, settle = false } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const node = this.#axNode(id, elementIndex);
    if (node.dialogControl === "prompt") {
      await this.handleDialog({ tabId: id, accept: true, promptText: String(value) });
      return { tab_id: String(id), ok: true, action: "set_value", index: String(elementIndex) };
    }
    const sessionId = node.sessionId ?? null;
    const { object } = await this.#cdpTarget(id, sessionId, "DOM.resolveNode", { backendNodeId: node.backendDOMNodeId });
    if (!object?.objectId) throw new Error("Browser element could not be resolved");
    const response = await this.#cdpTarget(id, sessionId, "Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: smartSetValueFunctionDeclaration(),
      arguments: [{ value: String(value) }],
      returnByValue: true,
    });
    if (response?.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "Failed to set element value");
    }
    const val = response?.result?.value;
    const status = val && typeof val === "object" ? val.status : val;
    if (status === "needs-click") {
      await this.#clickNode(id, node, { clickCount: 1, button: "left", modifiers: 0 });
    }
    if (settle) await this.#waitForSettle(id);
    return { tab_id: String(id), ok: true, action: "set_value", index: String(elementIndex) };
  }

  /** @param {string} text @param {{tabId?:unknown, elementIndex?:unknown, settle?:boolean}} [options] */
  async typeText(text, { tabId, elementIndex, settle = false } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    if (elementIndex !== undefined && elementIndex !== null && elementIndex !== "") {
      await this.click(elementIndex, { tabId: id });
    }
    await this.#cdp(id, "Input.insertText", { text: String(text) });
    if (settle) await this.#waitForSettle(id);
    return { tab_id: String(id), ok: true, action: "type_text" };
  }

  /** @param {string} combo @param {{tabId?:unknown, elementIndex?:unknown, settle?:boolean}} [options] */
  async pressKey(combo, { tabId, elementIndex, settle = false } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    if (elementIndex !== undefined && elementIndex !== null && elementIndex !== "") {
      const node = this.#axNode(id, elementIndex);
      await this.#scrollIntoView(id, node, node.sessionId).catch(() => {});
      await this.#cdpTarget(id, node.sessionId, "DOM.focus", { backendNodeId: node.backendDOMNodeId });
    }
    const key = await this.#sendKeyCombo(id, combo, null);
    if (settle) await this.#waitForSettle(id, { expectNavigation: key.key === "Enter" });
    return { tab_id: String(id), ok: true, action: "press_key", key: combo };
  }

  /** @param {number} tabId @param {string} combo @param {string|null} [sessionId] */
  async #sendKeyCombo(tabId, combo, sessionId = null) {
    const key = parseKeyCombo(combo);
    const base = {
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.windowsVirtualKeyCode,
      nativeVirtualKeyCode: key.windowsVirtualKeyCode,
      modifiers: key.modifiers,
      location: 0,
    };
    if (key.key === "Enter" && key.modifiers === 0) {
      await this.#cdpTarget(tabId, sessionId, "Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        ...base,
        commands: ["insertNewline"],
      });
      await this.#cdpTarget(tabId, sessionId, "Input.dispatchKeyEvent", {
        type: "char",
        ...base,
        text: key.text,
        unmodifiedText: key.text,
      });
    } else {
      await this.#cdpTarget(tabId, sessionId, "Input.dispatchKeyEvent", {
        type: key.text ? "keyDown" : "rawKeyDown",
        ...base,
        ...(key.text ? { text: key.text, unmodifiedText: key.text } : {}),
      });
    }
    await this.#cdpTarget(tabId, sessionId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
    return key;
  }

  /** @param {"up"|"down"|"left"|"right"} direction @param {{tabId?:unknown, elementIndex?:unknown, pages?:number, x?:number, y?:number}} [options] */
  async scroll(direction, { tabId, elementIndex, pages = 1, x, y } = {}) {
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
    if (Number.isFinite(x) && Number.isFinite(y)) {
      point = { x: Number(x), y: Number(y) };
    } else if (elementIndex !== undefined && elementIndex !== null && elementIndex !== "") {
      const node = this.#axNode(id, elementIndex);
      const box = await this.#boxModel(id, node, node.sessionId);
      point = { x: box.x, y: box.y };
    } else {
      const metrics = await this.#cdp(id, "Page.getLayoutMetrics");
      const viewport = metrics?.cssLayoutViewport ?? metrics?.layoutViewport ?? { clientWidth: 1280, clientHeight: 800 };
      point = { x: Math.floor(viewport.clientWidth / 2), y: Math.floor(viewport.clientHeight / 2) };
    }
    await this.#cdp(id, "Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, ...deltas });
    return { tab_id: String(id), ok: true, action: "scroll", direction, pages };
  }

  /**
   * Hover over an element_index, locator selector, or viewport coordinates (x, y).
   * @param {{tabId?:unknown, elementIndex?:unknown, selector?:string, frame?:string, force?:boolean, timeoutMs?:number, x?:number, y?:number}} [options]
   */
  async hover({ tabId, elementIndex, selector, frame, force = false, timeoutMs, x, y } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    let point;
    if (Number.isFinite(x) && Number.isFinite(y)) {
      point = { x: Number(x), y: Number(y) };
    } else if (selector) {
      const { inCrossOriginFrame, result: match } = await this.#runLocatorWithAutoWait(id, selector, {
        frame,
        mutation: "hover",
        force,
        timeoutMs,
      });
      if (inCrossOriginFrame) {
        return { tab_id: String(id), ok: true, action: "hover", selector, frame, ...match };
      }
      point = { x: match.x, y: match.y };
    } else if (elementIndex !== undefined && elementIndex !== null && elementIndex !== "") {
      const node = this.#axNode(id, elementIndex);
      point = await this.#boxModel(id, node, node.sessionId);
    } else {
      throw new Error("hover requires element_index, selector, or (x, y) coordinates");
    }
    await this.#cdp(id, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      button: "none",
      buttons: 0,
      clickCount: 0,
      modifiers: 0,
    });
    return { tab_id: String(id), ok: true, action: "hover", x: point.x, y: point.y };
  }

  /**
   * Drag from source (index or coordinates) to destination (index or coordinates).
   * @param {{tabId?:unknown, fromIndex?:unknown, toIndex?:unknown, fromX?:number, fromY?:number, toX?:number, toY?:number, steps?:number}} options
   */
  async drag({ tabId, fromIndex, toIndex, fromX, fromY, toX, toY, steps = 8 }) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const start = (fromIndex !== undefined && fromIndex !== null && fromIndex !== "")
      ? await this.#boxModel(id, this.#axNode(id, fromIndex))
      : { x: Number(fromX), y: Number(fromY) };
    const end = (toIndex !== undefined && toIndex !== null && toIndex !== "")
      ? await this.#boxModel(id, this.#axNode(id, toIndex))
      : { x: Number(toX), y: Number(toY) };
    if (!Number.isFinite(start.x) || !Number.isFinite(start.y) || !Number.isFinite(end.x) || !Number.isFinite(end.y)) {
      throw new Error("drag requires valid start and end coordinates or element indices");
    }
    const count = Math.max(2, Math.min(30, Number(steps) || 8));
    await this.#cdp(id, "Input.dispatchMouseEvent", { type: "mouseMoved", x: start.x, y: start.y, button: "none", buttons: 0, clickCount: 0, modifiers: 0 });
    await this.#cdp(id, "Input.dispatchMouseEvent", { type: "mousePressed", x: start.x, y: start.y, button: "left", buttons: 1, clickCount: 1, modifiers: 0 });
    for (let i = 1; i <= count; i++) {
      const ratio = i / count;
      await this.#cdp(id, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: start.x + (end.x - start.x) * ratio,
        y: start.y + (end.y - start.y) * ratio,
        button: "left",
        buttons: 1,
        clickCount: 0,
        modifiers: 0,
      });
    }
    await this.#cdp(id, "Input.dispatchMouseEvent", { type: "mouseReleased", x: end.x, y: end.y, button: "left", buttons: 0, clickCount: 1, modifiers: 0 });
    return { tab_id: String(id), ok: true, action: "drag", from: start, to: end };
  }

  /**
   * Select option(s) on a native <select> by element_index or locator.
   * @param {{tabId?:unknown, elementIndex?:unknown, selector?:string, frame?:string, value?:string|string[], label?:string|string[], index?:number|number[], force?:boolean, timeoutMs?:number}} options
   */
  async selectOption({ tabId, elementIndex, selector, frame, value, label, index, force = false, timeoutMs }) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const specs = [];
    const toList = (v) => (Array.isArray(v) ? v : [v]);
    if (value !== undefined) for (const v of toList(value)) specs.push({ value: String(v) });
    if (label !== undefined) for (const l of toList(label)) specs.push({ label: String(l) });
    if (index !== undefined) for (const idx of toList(index)) specs.push({ index: Number(idx) });
    if (specs.length === 0) throw new Error("selectOption requires value, label, or index");

    if (selector) {
      const { result } = await this.#runLocatorWithAutoWait(id, selector, {
        frame,
        mutation: "select",
        select: specs,
        force,
        timeoutMs,
      });
      return { tab_id: String(id), ok: true, action: "select_option", selector, ...(frame ? { frame } : {}), selected: result.selected };
    }

    if (elementIndex === undefined || elementIndex === null || elementIndex === "") {
      throw new Error("selectOption requires element_index or selector");
    }
    const node = this.#axNode(id, elementIndex);
    const sessionId = node.sessionId ?? null;
    const { object } = await this.#cdpTarget(id, sessionId, "DOM.resolveNode", { backendNodeId: node.backendDOMNodeId });
    if (!object?.objectId) throw new Error("Select element could not be resolved");
    const response = await this.#cdpTarget(id, sessionId, "Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: selectOptionFunctionDeclaration(),
      arguments: [{ value: specs }],
      returnByValue: true,
    });
    if (response?.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "selectOption failed");
    }
    return { tab_id: String(id), ok: true, action: "select_option", selected: response?.result?.value ?? [] };
  }

  /**
   * Resolve a locator selector (with auto-wait + frame routing) to its CDP backendDOMNodeId.
   * @param {number} id
   * @param {string} selector
   * @param {{frame?:string, timeoutMs?:number, fallbackCss?:boolean}} [options]
   * @returns {Promise<{backendNodeId:number|undefined, sessionId:string|null, sameOriginFrames:string[]|null}>}
   */
  async #resolveLocatorBackendNode(id, selector, { frame, timeoutMs, fallbackCss = false } = {}) {
    let backendNodeId;
    let sessionId = null;
    let sameOriginFrames = null;
    if (frame) {
      const resolved = await this.#resolveFrameRoute(id, frame);
      if (resolved.kind === "same-origin") sameOriginFrames = resolved.selectors;
      else sessionId = resolved.sessionId;
    }
    const waitBudget = timeoutMs !== undefined ? Math.max(0, Number(timeoutMs) || 0) : DEFAULT_LOCATOR_TIMEOUT_MS;
    const deadline = Date.now() + waitBudget;
    const expr = locatorResolveNodeExpression(selector, { sameOriginFrames });
    while (true) {
      const response = await this.#cdpTarget(id, sessionId, "Runtime.evaluate", {
        expression: expr,
        returnByValue: false,
        awaitPromise: false,
      });
      const objectId = response?.result?.objectId;
      if (response?.exceptionDetails) {
        if (objectId) {
          await this.#cdpTarget(id, sessionId, "Runtime.releaseObject", { objectId }).catch(() => {});
        }
        const msg = response.exceptionDetails.exception?.description || response.exceptionDetails.text || "Locator resolution failed";
        if (/did not match/i.test(msg) && Date.now() < deadline) {
          await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
          continue;
        }
        throw new Error(msg);
      }
      if (objectId && response?.result?.subtype !== "error") {
        let shouldRetry = false;
        try {
          const described = await this.#cdpTarget(id, sessionId, "DOM.describeNode", { objectId });
          backendNodeId = described?.node?.backendNodeId;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/Object id doesn't reference a Node|Could not find node/i.test(msg) && Date.now() < deadline) {
            shouldRetry = true;
          } else {
            throw err;
          }
        } finally {
          await this.#cdpTarget(id, sessionId, "Runtime.releaseObject", { objectId }).catch(() => {});
        }
        if (shouldRetry) {
          await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
          continue;
        }
        break;
      }
      break;
    }

    // Minimal test mock fallback when Runtime.evaluate does not yield remote objectIds.
    if (!Number.isSafeInteger(backendNodeId) && fallbackCss) {
      const css = selector.startsWith("css=") ? selector.slice(4) : selector;
      const frameDoc = await this.#cdpTarget(id, sessionId, "DOM.getDocument", { depth: 0 });
      const { nodeId } = await this.#cdpTarget(id, sessionId, "DOM.querySelector", { nodeId: frameDoc.root.nodeId, selector: css });
      if (nodeId) {
        const described = await this.#cdpTarget(id, sessionId, "DOM.describeNode", { nodeId });
        backendNodeId = described?.node?.backendNodeId;
      }
    }
    return { backendNodeId, sessionId, sameOriginFrames };
  }

  /**
   * Set files on a file input (<input type="file">) or pending file chooser.
   * Uses Shadow-DOM/locator node resolution with auto-wait first, falling back to DOM.querySelector on minimal mocks.
   * @param {string|string[]} files
   * @param {{tabId?:unknown, elementIndex?:unknown, selector?:string, frame?:string, timeoutMs?:number}} [options]
   */
  async uploadFiles(files, { tabId, elementIndex, selector, frame, timeoutMs } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const list = (Array.isArray(files) ? files : [files]).map((f) => String(f));
    if (list.length === 0 || list.some((f) => !path.isAbsolute(f))) {
      throw new Error("uploadFiles requires at least one non-empty absolute file path");
    }
    let backendNodeId;
    let sessionId = null;

    if (elementIndex !== undefined && elementIndex !== null && elementIndex !== "") {
      const node = this.#axNode(id, elementIndex);
      backendNodeId = node.backendDOMNodeId;
      sessionId = node.sessionId ?? null;
    } else if (selector) {
      const resolved = await this.#resolveLocatorBackendNode(id, selector, { frame, timeoutMs, fallbackCss: true });
      backendNodeId = resolved.backendNodeId;
      sessionId = resolved.sessionId;
      if (!Number.isSafeInteger(backendNodeId)) {
        throw new Error(`File input not matched: ${selector}`);
      }
    } else {
      const pending = this.#tabState(id).fileChooser;
      if (pending?.backendNodeId) {
        backendNodeId = pending.backendNodeId;
        if (pending.frameId) {
          sessionId = this.frameSessions.get(id)?.get(pending.frameId) ?? null;
        }
        this.#tabState(id).fileChooser = null;
      }
    }

    if (!Number.isSafeInteger(backendNodeId)) {
      throw new Error("uploadFiles requires element_index, locator for input[type=file], or an active file chooser");
    }
    await this.#cdpTarget(id, sessionId, "DOM.setFileInputFiles", { backendNodeId, files: list });
    return { tab_id: String(id), ok: true, action: "upload_files", files: list };
  }

  /**
   * Perform an action callback expected to trigger a navigation and wait for URL/load completion.
   * @template T
   * @param {() => Promise<T>} action
   * @param {{tabId?:unknown, url?:string|RegExp, waitUntil?:"commit"|"domcontentloaded"|"load"|"networkidle", timeoutMs?:number}} [options]
   * @returns {Promise<T>}
   */
  async expectNavigation(action, { tabId, url, waitUntil = "load", timeoutMs = DEFAULT_LOAD_TIMEOUT_MS } = {}) {
    if (typeof action !== "function") throw new Error("expectNavigation requires an async action function");
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    await this.#enableInspectionDomains(id, { network: waitUntil === "networkidle" }).catch(() => {});
    const state = this.#tabState(id);
    const startRev = state.navRevision;
    const startUrl = await this.#evaluateRaw(id, "location.href").catch(() => state.url || "");
    const actionResult = await action();
    const deadline = Date.now() + Math.max(100, Number(timeoutMs) || DEFAULT_LOAD_TIMEOUT_MS);
    let lastUrlPoll = 0;
    const matchesTargetUrl = (candidate) => typeof candidate === "string" && (url instanceof RegExp
      ? url.test(candidate)
      : (sameUrl(candidate, url) || candidate.includes(url)));
    while (Date.now() < deadline) {
      if (state.dialog) return actionResult;
      let urlMatched = false;
      if (url === undefined) {
        urlMatched = state.navRevision !== startRev;
      } else if (state.hasEvents && matchesTargetUrl(state.url)) {
        urlMatched = true;
      }
      if (!urlMatched) {
        const now = Date.now();
        if (!state.hasEvents || now - lastUrlPoll >= 300) {
          lastUrlPoll = now;
          const currentUrl = await this.#evaluateRaw(id, "location.href").catch(() => null);
          urlMatched = url === undefined
            ? (state.navRevision !== startRev || (typeof currentUrl === "string" && currentUrl !== startUrl))
            : matchesTargetUrl(currentUrl);
        }
      }
      if (urlMatched) {
        this.frameRouteCache.delete(id);
        if (waitUntil !== "commit") {
          await this.#waitForLoad(id, { waitUntil, timeoutMs: Math.max(100, deadline - Date.now()) });
        }
        return actionResult;
      }
      await this.#waitForTabWakeup(id, Math.min(state.hasEvents ? 200 : 80, Math.max(1, deadline - Date.now())));
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for navigation`);
  }

  /**
   * Wait for a tab event such as "filechooser" or "download".
   * Call before clicking the triggering control, then await the returned promise.
   * @param {"filechooser"|"download"} eventName
   * @param {{tabId?:unknown, timeoutMs?:number}} [options]
   */
  async waitForEvent(eventName, { tabId, timeoutMs = 30_000 } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const state = this.#tabState(id);
    const budget = Math.max(100, Number(timeoutMs) || 30_000);

    if (eventName === "filechooser") {
      await this.#ensureDomain(id, "Page", "Page.enable");
      state.fileChooser = null;
      await this.#cdp(id, "Page.setInterceptFileChooserDialog", { enabled: true });
      const armedAt = Date.now();
      const deadline = armedAt + budget;
      try {
        while (Date.now() < deadline) {
          if (state.fileChooser && state.fileChooser.openedAtMs >= armedAt &&
              Number.isSafeInteger(state.fileChooser.backendNodeId)) {
            const fc = state.fileChooser;
            state.fileChooser = null;
            const frameSessionId = fc.frameId ? (this.frameSessions.get(id)?.get(fc.frameId) ?? null) : null;
            return {
              isMultiple: () => fc.mode === "selectMultiple",
              mode: fc.mode || "selectSingle",
              backendNodeId: fc.backendNodeId,
              frameId: fc.frameId ?? null,
              setFiles: async (files) => {
                const list = (Array.isArray(files) ? files : [files]).map((f) => String(f));
                if (list.length === 0 || list.some((f) => !path.isAbsolute(f))) {
                  throw new Error("setFiles requires at least one non-empty absolute file path");
                }
                await this.#cdpTarget(id, frameSessionId, "DOM.setFileInputFiles", {
                  backendNodeId: fc.backendNodeId,
                  files: list,
                });
                return { tab_id: String(id), ok: true, files: list };
              },
            };
          }
          await this.#waitForTabWakeup(id, Math.min(80, Math.max(1, deadline - Date.now())));
        }
        throw new Error(`Timed out after ${budget}ms waiting for filechooser`);
      } finally {
        await this.#cdp(id, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
      }
    }

    if (eventName === "download") {
      await this.#ensureDomain(id, "Page", "Page.enable").catch(() => {});
      const knownIds = new Set(state.downloads.map((d) => d.id));
      state.downloadWatchCount = (state.downloadWatchCount ?? 0) + 1;
      if (state.downloadWatchCount === 1) {
        await this.#rpc("watchDownloads", { tabId: id }).catch((err) => {
          if (!/Unknown Chrome bridge request|Unsupported/i.test(String(err?.message))) throw err;
        });
      }
      let released = false;
      const releaseWatch = async () => {
        if (released) return;
        released = true;
        state.downloadWatchCount = Math.max(0, (state.downloadWatchCount ?? 1) - 1);
        if (state.downloadWatchCount === 0) {
          await this.#rpc("unwatchDownloads", { tabId: id }).catch(() => {});
        }
      };

      const deadline = Date.now() + budget;
      let matched = null;
      try {
        while (Date.now() < deadline) {
          matched = state.downloads.find((d) => !knownIds.has(d.id));
          if (matched) break;
          await this.#waitForTabWakeup(id, Math.min(80, Math.max(1, deadline - Date.now())));
        }
        if (!matched) {
          throw new Error(`Timed out after ${budget}ms waiting for download`);
        }
      } catch (err) {
        await releaseWatch();
        throw err;
      }

      if (matched.state === "complete" || matched.state === "interrupted") {
        await releaseWatch();
      }

      return {
        id: matched.id,
        get url() { return matched.url; },
        get suggestedFilename() { return matched.suggestedFilename || (matched.filename ? path.basename(matched.filename) : ""); },
        get state() { return matched.state; },
        path: async ({ timeoutMs: pathTimeoutMs = 120_000 } = {}) => {
          const pathDeadline = Date.now() + Math.max(100, Number(pathTimeoutMs) || 120_000);
          try {
            while (Date.now() < pathDeadline) {
              if (matched.state === "complete") {
                return matched.filename || matched.suggestedFilename || null;
              }
              if (matched.state === "interrupted") {
                throw new Error(`Download interrupted: ${matched.error || matched.suggestedFilename || matched.id}`);
              }
              await this.#waitForTabWakeup(id, Math.min(80, Math.max(1, pathDeadline - Date.now())));
            }
            throw new Error(`Timed out after ${pathTimeoutMs}ms waiting for download completion`);
          } finally {
            await releaseWatch();
          }
        },
      };
    }

    if (eventName === "popup") {
      const armedAt = Date.now();
      const seen = new Set(state.popups.map((p) => p.tab_id));
      const deadline = armedAt + budget;
      while (Date.now() < deadline) {
        const matched = state.popups.find((p) => !seen.has(p.tab_id));
        if (matched) {
          return {
            tab_id: matched.tab_id,
            opener_tab_id: matched.opener_tab_id,
            url: matched.url,
            title: matched.title,
          };
        }
        await this.#waitForTabWakeup(id, Math.min(80, Math.max(1, deadline - Date.now())));
      }
      throw new Error(`Timed out after ${budget}ms waiting for popup`);
    }

    throw new Error(`Unsupported waitForEvent target: ${String(eventName)}`);
  }

  /**
   * Wait for a selector state, visible text, URL substring/exact match, load state, or timeout.
   * @param {{tabId?:unknown, selector?:string, text?:string, url?:string|RegExp, loadState?:"domcontentloaded"|"load"|"networkidle", state?:"attached"|"detached"|"visible"|"hidden", frame?:string, timeoutMs?:number}} [options]
   */
  async waitFor({ tabId, selector, text, url, loadState, state = "visible", frame, timeoutMs = 10_000 } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const deadline = Date.now() + Math.max(100, Number(timeoutMs) || 10_000);

    if (loadState) {
      if (loadState === "networkidle") {
        await this.#enableInspectionDomains(id, { network: true }).catch(() => {});
      }
      await this.#waitForLoad(id, { waitUntil: loadState, timeoutMs });
      return { tab_id: String(id), ok: true, matched: "loadState", loadState };
    }

    if (url !== undefined) {
      const tabState = this.#tabState(id);
      let lastEvalAt = 0;
      const matchesUrl = (candidate) => typeof candidate === "string" && (url instanceof RegExp
        ? url.test(candidate)
        : (sameUrl(candidate, url) || candidate.includes(url)));
      while (Date.now() < deadline) {
        if (tabState.hasEvents && matchesUrl(tabState.url)) {
          return { tab_id: String(id), ok: true, matched: "url", url: tabState.url };
        }
        const now = Date.now();
        if (!tabState.hasEvents || now - lastEvalAt >= 350) {
          lastEvalAt = now;
          const current = await this.#evaluateRaw(id, "location.href").catch(() => null);
          if (matchesUrl(current)) {
            return { tab_id: String(id), ok: true, matched: "url", url: current };
          }
        }
        await this.#waitForTabWakeup(id, Math.min(tabState.hasEvents ? 200 : 80, Math.max(1, deadline - Date.now())));
      }
      throw new Error(`Timed out after ${timeoutMs}ms waiting for URL ${String(url)}`);
    }

    if (text !== undefined && !selector) {
      while (Date.now() < deadline) {
        const rem = Math.max(1, deadline - Date.now());
        const attemptStart = Date.now();
        const res = await this.#evaluateRaw(
          id,
          waitForTextExpression(text, { timeoutMs: Math.min(1_000, rem) }),
          { awaitPromise: true },
        ).catch(() => null);
        if (res?.matched === true || (typeof res === "string" && res.includes(text))) {
          return { tab_id: String(id), ok: true, matched: "text", text };
        }
        const left = deadline - Date.now();
        if (left <= 0) break;
        if (Date.now() - attemptStart < 20) await sleep(Math.min(50, left));
      }
      throw new Error(`Timed out after ${timeoutMs}ms waiting for text ${JSON.stringify(text)}`);
    }

    if (selector) {
      while (Date.now() < deadline) {
        const rem = Math.max(1, deadline - Date.now());
        const attemptStart = Date.now();
        const check = await this.#runLocator(id, selector, {
          frame,
          mutation: "wait",
          state,
          inPageWaitMs: Math.min(1_000, rem),
        }).then((r) => r.result).catch(() => null);
        if (check?.satisfied) {
          return { tab_id: String(id), ok: true, matched: "selector", selector, state };
        }
        const left = deadline - Date.now();
        if (left <= 0) break;
        if (Date.now() - attemptStart < 20) await sleep(Math.min(50, left));
      }
      throw new Error(`Timed out after ${timeoutMs}ms waiting for selector ${JSON.stringify(selector)} to become ${state}`);
    }

    await sleep(Math.min(10_000, Math.max(0, Number(timeoutMs) || 500)));
    return { tab_id: String(id), ok: true, waited_ms: timeoutMs };
  }

  /**
   * Invoke a secondary accessibility action exposed for an element (such as "Expand" or "Collapse").
   * @param {unknown} elementIndex
   * @param {string} action
   * @param {{tabId?:unknown, settle?:boolean}} [options]
   */
  async performSecondaryAction(elementIndex, action, { tabId, settle = true } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const node = this.#axNode(id, elementIndex);
    const available = Array.isArray(node.actions) ? node.actions : [];
    const wanted = String(action || "").trim().toLowerCase();
    const matched = available.find((entry) => String(entry).toLowerCase() === wanted);
    if (!matched) {
      const hint = available.length ? `; available: ${available.join(", ")}` : "";
      throw new Error(`Element index ${elementIndex} does not support secondary action ${JSON.stringify(action)}${hint}`);
    }
    await this.#clickNode(id, node, { clickCount: 1, button: "left", modifiers: 0 });
    if (settle) await this.#waitForSettle(id, { expectNavigation: false });
    return { tab_id: String(id), ok: true, action: "secondary_action", performed: matched, index: String(elementIndex) };
  }

  /**
   * Return the active JavaScript dialog descriptor (if any) with accept()/dismiss() helpers.
   * @param {unknown} [tabId]
   */
  async getJsDialog(tabId) {
    const id = await this.#resolveTab(tabId);
    const dialog = this.#tabState(id).dialog;
    if (!dialog) return null;
    return {
      type: dialog.type,
      message: dialog.message,
      defaultPrompt: dialog.defaultPrompt,
      url: dialog.url,
      accept: (promptText) => this.handleDialog({
        tabId: id,
        accept: true,
        ...(promptText !== undefined ? { promptText: String(promptText) } : {}),
      }),
      dismiss: () => this.handleDialog({ tabId: id, accept: false }),
    };
  }

  /**
   * Override viewport metrics for responsive / mobile UI testing.
   * @param {{tabId?:unknown, width:number, height:number, deviceScaleFactor?:number, mobile?:boolean}} options
   */
  async setViewport({ tabId, width, height, deviceScaleFactor = 1, mobile = false } = {}) {
    const w = Math.round(Number(width));
    const h = Math.round(Number(height));
    const dsf = Number(deviceScaleFactor);
    const mob = Boolean(mobile);
    if (!Number.isSafeInteger(w) || w < 100 || w > 4096 || !Number.isSafeInteger(h) || h < 100 || h > 4096) {
      throw new Error("Viewport width and height must be integers between 100 and 4096");
    }
    if (!Number.isFinite(dsf) || dsf < 0 || dsf > 8) {
      throw new Error("Viewport deviceScaleFactor must be a number between 0 and 8");
    }
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    await this.#cdp(id, "Emulation.setDeviceMetricsOverride", {
      width: w,
      height: h,
      deviceScaleFactor: dsf,
      mobile: mob,
    });
    this.#tabState(id).viewportOverride = { width: w, height: h, deviceScaleFactor: dsf, mobile: mob };
    return { tab_id: String(id), ok: true, width: w, height: h, deviceScaleFactor: dsf, mobile: mob };
  }

  /**
   * Clear any explicit viewport override on the tab.
   * @param {unknown} [tabId]
   */
  async resetViewport(tabId) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    await this.#cdp(id, "Emulation.clearDeviceMetricsOverride", {});
    this.#tabState(id).viewportOverride = null;
    return { tab_id: String(id), ok: true, reset: true };
  }

  /**
   * Read captured network requests/responses/failures for the active or specified tab.
   * @param {{tabId?:unknown, filter?:string, statusMin?:number, statusMax?:number, failedOnly?:boolean, resourceTypes?:string[], limit?:number, clear?:boolean}} [options]
   */
  async networkLogs({ tabId, filter, statusMin, statusMax, failedOnly = false, resourceTypes, limit = 100, clear = false } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    await this.#enableInspectionDomains(id, { network: true }).catch(() => {});
    const tabState = this.#tabState(id);
    let entries = tabState.networkLogs.map((entry) => ({ ...entry }));
    if (filter) {
      const needle = String(filter).toLowerCase();
      entries = entries.filter((entry) =>
        entry.url.toLowerCase().includes(needle) ||
        entry.method.toLowerCase().includes(needle) ||
        (entry.errorText && entry.errorText.toLowerCase().includes(needle)));
    }
    if (statusMin !== undefined) {
      const min = Number(statusMin);
      entries = entries.filter((entry) => typeof entry.status === "number" && entry.status >= min);
    }
    if (statusMax !== undefined) {
      const max = Number(statusMax);
      entries = entries.filter((entry) => typeof entry.status === "number" && entry.status <= max);
    }
    if (failedOnly === true) {
      entries = entries.filter((entry) => entry.failed === true || (typeof entry.status === "number" && entry.status >= 400));
    }
    if (Array.isArray(resourceTypes) && resourceTypes.length > 0) {
      const allowed = new Set(resourceTypes.map((r) => String(r).toLowerCase()));
      entries = entries.filter((entry) => allowed.has(entry.resourceType.toLowerCase()));
    }
    const sliced = entries.slice(-Math.max(1, Math.min(300, Number(limit) || 100)));
    if (clear) {
      tabState.networkLogs.length = 0;
      tabState.networkById.clear();
    }
    return { tab_id: String(id), count: sliced.length, requests: sliced };
  }

  /**
   * Enable network tracking, optionally with buffered response bodies for `networkResponseBody()`.
   * @param {{tabId?:unknown, captureBodies?:boolean}} [options]
   */
  async enableNetwork({ tabId, captureBodies = false } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const state = this.#tabState(id);
    if (captureBodies && !state.networkBodyCaptureEnabled) {
      await this.#cdp(id, "Network.enable", {
        maxTotalBufferSize: 8 * 1024 * 1024,
        maxResourceBufferSize: 2 * 1024 * 1024,
      });
      let set = this.enabledDomains.get(id);
      if (!set) {
        set = new Set();
        this.enabledDomains.set(id, set);
      }
      set.add("Network");
      state.networkBodyCaptureEnabled = true;
    } else {
      await this.#enableInspectionDomains(id, { network: true }).catch(() => {});
    }
    return { tab_id: String(id), ok: true, captureBodies: state.networkBodyCaptureEnabled };
  }

  /**
   * Read the captured response body for a network request ID via CDP `Network.getResponseBody`.
   * @param {string} requestId
   * @param {{tabId?:unknown, maxChars?:number}} [options]
   */
  async networkResponseBody(requestId, { tabId, maxChars = 64_000 } = {}) {
    const reqId = typeof requestId === "string" ? requestId.trim() : "";
    if (!reqId) throw new Error("networkResponseBody requires a non-empty requestId");
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const res = await this.#cdp(id, "Network.getResponseBody", { requestId: reqId });
    const raw = typeof res?.body === "string" ? res.body : "";
    const limit = Math.max(256, Math.min(2_000_000, Number(maxChars) || 64_000));
    const truncated = raw.length > limit;
    const body = truncated ? raw.slice(0, limit) : raw;
    return {
      tab_id: String(id),
      requestId: reqId,
      body,
      base64Encoded: Boolean(res?.base64Encoded),
      truncated,
      length: raw.length,
    };
  }

  /**
   * Capture a cropped screenshot clipped tightly around a locator match.
   * @param {string} selector
   * @param {{tabId?:unknown, frame?:string, force?:boolean, timeoutMs?:number, padding?:number, format?:"jpeg"|"png", quality?:number, scale?:"css"|"device"}} [options]
   */
  async elementScreenshot(selector, {
    tabId,
    frame,
    force = false,
    timeoutMs,
    padding = 0,
    format = "jpeg",
    quality = 75,
    scale = "css",
  } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const { result } = await this.#runLocatorWithAutoWait(id, selector, {
      frame,
      mutation: "box",
      force,
      timeoutMs,
    });
    const box = result?.box;
    if (!box || !Number.isFinite(box.width) || !Number.isFinite(box.height) || box.width <= 0 || box.height <= 0) {
      throw new Error(`Element has no visible bounding box: ${selector}`);
    }
    const pad = Math.max(0, Math.min(200, Number(padding) || 0));
    const clip = {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - pad),
      width: Math.max(1, box.width + pad * 2),
      height: Math.max(1, box.height + pad * 2),
    };
    const cap = await this.screenshot(id, { format, quality, scale, clip });
    return { ...cap, box: clip };
  }

  /**
   * Focus an AX element (if specified) and paste/insert text cleanly via `Input.insertText`.
   * @param {unknown} elementIndex
   * @param {string} text
   * @param {{tabId?:unknown, settle?:boolean}} [options]
   */
  async pasteText(elementIndex, text, { tabId, settle = false } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    if (elementIndex !== undefined && elementIndex !== null && elementIndex !== "") {
      const node = this.#axNode(id, elementIndex);
      const sessionId = node.sessionId ?? null;
      await this.#scrollIntoView(id, node, sessionId).catch(() => {});
      try {
        await this.#cdpTarget(id, sessionId, "DOM.focus", { backendNodeId: node.backendDOMNodeId });
      } catch {
        await this.#clickNode(id, node, { clickCount: 1, button: "left", modifiers: 0 });
      }
    }
    await this.#cdp(id, "Input.insertText", { text: String(text ?? "") });
    if (settle) await this.#waitForSettle(id);
    return { tab_id: String(id), ok: true, action: "paste" };
  }

  /**
   * Select matching text inside an input, textarea, contenteditable, or text element.
   * @param {unknown} elementIndex
   * @param {string} text
   * @param {{tabId?:unknown, settle?:boolean}} [options]
   */
  async selectText(elementIndex, text, { tabId, settle = false } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const needle = String(text ?? "");
    if (!needle) throw new Error("selectText requires non-empty text");
    if (elementIndex === undefined || elementIndex === null || elementIndex === "") {
      throw new Error("selectText requires element_index");
    }
    const node = this.#axNode(id, elementIndex);
    const sessionId = node.sessionId ?? null;
    const { object } = await this.#cdpTarget(id, sessionId, "DOM.resolveNode", { backendNodeId: node.backendDOMNodeId });
    if (!object?.objectId) throw new Error("Browser element could not be resolved");
    const response = await this.#cdpTarget(id, sessionId, "Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: `function (needle) {
        const query = String(needle || "");
        if (!query) return { selected: false };
        if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) {
          const val = String(this.value || "");
          const idx = val.indexOf(query);
          if (idx === -1) return { selected: false };
          this.focus();
          this.setSelectionRange(idx, idx + query.length);
          return { selected: true, start: idx, end: idx + query.length };
        }
        const doc = this.ownerDocument || document;
        const win = doc.defaultView || window;
        const walker = doc.createTreeWalker(this, NodeFilter.SHOW_TEXT);
        let current;
        while ((current = walker.nextNode())) {
          const str = current.nodeValue || "";
          const idx = str.indexOf(query);
          if (idx !== -1) {
            if (typeof this.focus === "function") this.focus();
            const range = doc.createRange();
            range.setStart(current, idx);
            range.setEnd(current, idx + query.length);
            const sel = win.getSelection();
            if (sel) {
              sel.removeAllRanges();
              sel.addRange(range);
            }
            return { selected: true, start: idx, end: idx + query.length };
          }
        }
        return { selected: false };
      }`,
      arguments: [{ value: needle }],
      returnByValue: true,
    });
    if (response?.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "selectText failed");
    }
    if (settle) await this.#waitForSettle(id);
    const outcome = (response?.result?.value && typeof response.result.value === "object")
      ? response.result.value
      : { selected: false };
    return { tab_id: String(id), ok: true, action: "select_text", ...outcome };
  }

  /**
   * Open up to 10 URLs in temporary parallel tabs, extract structured content, and close the temporary tabs.
   * @param {string[]} urls
   * @param {{format?:"markdown"|"tables"|"links"|"text", maxChars?:number, concurrency?:number, timeoutMs?:number, waitUntil?:string}} [options]
   */
  async extractUrlsContent(urls, {
    format = "markdown",
    maxChars = 16_000,
    concurrency = 3,
    timeoutMs = 15_000,
    waitUntil = "domcontentloaded",
  } = {}) {
    if (!Array.isArray(urls) || urls.length === 0) {
      throw new Error("tabs.content requires a non-empty array of URLs");
    }
    if (urls.length > 10) {
      throw new Error("tabs.content accepts at most 10 URLs per call");
    }
    const items = urls.map((u, idx) => ({ url: String(u), idx }));
    const results = new Array(items.length);
    const workers = Math.min(items.length, Math.max(1, Math.min(4, Number(concurrency) || 3)));
    const prevActive = this.activeTabId;
    let cursor = 0;

    try {
      await Promise.all(Array.from({ length: workers }, async () => {
        while (cursor < items.length) {
          const item = items[cursor++];
          let tempId = null;
          try {
            const tab = await this.newTab();
            tempId = tab.tab_id;
            await this.goto(item.url, tempId, { waitUntil, timeoutMs });
            const res = await this.getContent(tempId, { format, maxChars });
            const extractedText = String(res?.text ?? res?.content ?? "");
            results[item.idx] = {
              url: item.url,
              ok: true,
              title: res?.title ?? "",
              content: res?.content ?? extractedText,
              text: extractedText,
              ...(Array.isArray(res?.links) ? { links: res.links } : {}),
              ...(Array.isArray(res?.tables) ? { tables: res.tables } : {}),
              truncated: Boolean(res?.truncated),
            };
          } catch (error) {
            results[item.idx] = {
              url: item.url,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            };
          } finally {
            if (tempId != null) {
              await this.closeTab(tempId).catch(() => {});
            }
          }
        }
      }));
    } finally {
      if (prevActive !== null && this.tabs.has(prevActive)) {
        this.activeTabId = prevActive;
      }
    }
    return results;
  }

  /**
   * Read captured console messages and runtime exceptions for the active or specified tab.
   * @param {{tabId?:unknown, levels?:string[], filter?:string, limit?:number, clear?:boolean}} [options]
   */
  async consoleLogs({ tabId, levels, filter, limit = 100, clear = false } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    await this.#enableInspectionDomains(id).catch(() => {});
    const tabState = this.#tabState(id);
    let entries = [...tabState.consoleLogs];
    if (Array.isArray(levels) && levels.length > 0) {
      const allowed = new Set(levels.map((l) => String(l).toLowerCase()));
      entries = entries.filter((entry) => allowed.has(entry.level.toLowerCase()));
    }
    if (filter) {
      const needle = String(filter).toLowerCase();
      entries = entries.filter((entry) => entry.message.toLowerCase().includes(needle));
    }
    const sliced = entries.slice(-Math.max(1, Math.min(500, Number(limit) || 100)));
    if (clear) tabState.consoleLogs.length = 0;
    return { tab_id: String(id), count: sliced.length, logs: sliced };
  }

  /**
   * Inspect DOM elements at viewport coordinates (x, y) and generate ranked locators.
   * @param {number} x
   * @param {number} y
   * @param {{tabId?:unknown}} [options]
   */
  async inspectElement(x, y, { tabId } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const result = await this.#evaluateRaw(id, inspectElementAtPointExpression(x, y));
    return { tab_id: String(id), ...(result ?? { x, y, elements: [] }) };
  }

  /**
   * Return a clean Playwright-style YAML ARIA snapshot (with child iframes) without numeric clutter.
   * Also syncs the AX baseline in-memory so subsequent diff calls recognize unchanged trees.
   * @param {{tabId?:unknown, maxLines?:number, mode?:"full"|"compact"|"interactive"}} [options]
   */
  async ariaSnapshot({ tabId, maxLines = 2_000, mode = "compact" } = {}) {
    const id = await this.#resolveTab(tabId, { autoCreate: true });
    await this.attach(id);
    await Promise.all([
      this.#ensureDomain(id, "Page", "Page.enable").catch(() => {}),
      this.#ensureDomain(id, "Accessibility", "Accessibility.enable"),
    ]);
    const [mainTree, frameTreeResp] = await Promise.all([
      this.#cdp(id, "Accessibility.getFullAXTree"),
      this.#cdp(id, "Page.getFrameTree").catch(() => null),
    ]);
    const frameTrees = [{
      nodes: mainTree?.nodes ?? [],
      frameId: null,
      sessionId: null,
      depth: 0,
    }];
    if (frameTreeResp?.frameTree) {
      await this.#collectChildFrames(id, frameTreeResp.frameTree, frameTrees);
    }
    const snapshot = mergeFrameAriaSnapshots(frameTrees, { maxLines, mode });
    const tabState = this.#tabState(id);
    const url = String(frameTreeResp?.frameTree?.frame?.url || this.tabs.get(id)?.url || tabState.url || "");
    const documentKey = `${tabState.loaderId ?? ""}:${url}`;
    const baseline = mergeFrameAxStates(frameTrees, { maxLines, mode });
    this.axCache.set(id, baseline.index);
    this.lastAxSnapshots.set(id, { documentKey, entries: baseline.entries, hasIndexedBaseline: false });
    return { tab_id: String(id), ...snapshot };
  }

  /**
   * Return a YAML ARIA snapshot scoped strictly to the subtree matched by `selector`.
   * @param {string} selector
   * @param {{tabId?:unknown, frame?:string, maxLines?:number, mode?:"full"|"compact"|"interactive", timeoutMs?:number}} [options]
   */
  async locatorAriaSnapshot(selector, { tabId, frame, maxLines = 2_000, mode = "compact", timeoutMs } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const { backendNodeId, sessionId } = await this.#resolveLocatorBackendNode(id, selector, {
      frame,
      timeoutMs,
      fallbackCss: true,
    });
    if (!Number.isSafeInteger(backendNodeId)) {
      throw new Error(`Locator did not resolve to a DOM node: ${selector}`);
    }
    await this.#cdpTarget(id, sessionId, "Accessibility.enable", {}).catch(() => {});
    const tree = await this.#cdpTarget(id, sessionId, "Accessibility.getFullAXTree", {});
    let snapshot = formatAriaSnapshot(tree?.nodes ?? [], {
      maxLines,
      mode,
      rootBackendDOMNodeId: backendNodeId,
    });
    if (!snapshot.matched && !sessionId) {
      const frameTreeResp = await this.#cdp(id, "Page.getFrameTree").catch(() => null);
      if (frameTreeResp?.frameTree) {
        const childFrames = [];
        await this.#collectChildFrames(id, frameTreeResp.frameTree, childFrames);
        for (const child of childFrames) {
          const candidate = formatAriaSnapshot(child.nodes ?? [], {
            maxLines,
            mode,
            rootBackendDOMNodeId: backendNodeId,
          });
          if (candidate.matched) {
            snapshot = candidate;
            break;
          }
        }
      }
    }
    return {
      tab_id: String(id),
      selector,
      text: snapshot.text,
      lineCount: snapshot.lineCount,
      truncated: snapshot.truncated,
    };
  }

  /**
   * Return a compact visible DOM snapshot (with same-origin iframes) or YAML ARIA snapshot.
   * @param {{tabId?:unknown, maxChars?:number, maxLines?:number, format?:"dom"|"aria", mode?:"full"|"compact"|"interactive"}} [options]
   */
  async domSnapshot({ tabId, maxChars = 24_000, maxLines = 2_000, format = "dom", mode = "compact" } = {}) {
    if (format === "aria") {
      const aria = await this.ariaSnapshot({ tabId, maxLines, mode });
      return {
        tab_id: aria.tab_id,
        format: "aria",
        snapshot: aria.text,
        lineCount: aria.lineCount,
        truncated: aria.truncated,
      };
    }
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const result = await this.#evaluateRaw(id, domSnapshotExpression(maxChars));
    return { tab_id: String(id), format: "dom", ...(result ?? { title: "", url: "", truncated: false, snapshot: "" }) };
  }

  /** @param {string} selector @param {boolean} checked @param {{tabId?:unknown, frame?:string, force?:boolean, timeoutMs?:number, settle?:boolean}} [options] */
  async locatorCheck(selector, checked, { tabId, frame, force = false, timeoutMs, settle = true } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const action = checked ? "check" : "uncheck";
    const { inCrossOriginFrame, result: match } = await this.#runLocatorWithAutoWait(id, selector, {
      frame,
      mutation: action,
      force,
      timeoutMs,
      crossOriginOptions: { crossOriginDirect: true },
    });
    if (match.changed && !inCrossOriginFrame) {
      await this.#clickPoint(id, match.x, match.y, { clickCount: 1, button: "left", modifiers: 0 });
      if (settle) await this.#waitForSettle(id);
    }
    return {
      tab_id: String(id),
      ok: true,
      action,
      selector,
      checked: Boolean(match.checked),
      changed: Boolean(match.changed),
      ...(frame ? { frame } : {}),
    };
  }

  /** @param {string} selector @param {{tabId?:unknown, frame?:string}} [options] */
  async locatorCount(selector, { tabId, frame } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const { result } = await this.#runLocator(id, selector, { frame, mutation: "count" });
    return { tab_id: String(id), count: Number(result?.count ?? 0) };
  }

  /** @param {string} selector @param {{tabId?:unknown, frame?:string, mode?:"text"|"textContent"|"innerText", timeoutMs?:number}} [options] */
  async locatorText(selector, { tabId, frame, mode = "text", timeoutMs } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const mutation = mode === "innerText" ? "innerText" : (mode === "textContent" ? "textContent" : "text");
    const { result } = await this.#runLocatorWithAutoWait(id, selector, { frame, mutation, timeoutMs });
    return {
      tab_id: String(id),
      text: result?.text === null ? null : String(result?.text ?? ""),
    };
  }

  /** @param {string} selector @param {string} name @param {{tabId?:unknown, frame?:string, timeoutMs?:number}} [options] */
  async locatorAttribute(selector, name, { tabId, frame, timeoutMs } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const { result } = await this.#runLocatorWithAutoWait(id, selector, {
      frame,
      mutation: "attr",
      attrName: String(name),
      timeoutMs,
    });
    return { tab_id: String(id), value: result?.value ?? null };
  }

  /** @param {string} selector @param {{tabId?:unknown, frame?:string, timeoutMs?:number}} [options] */
  async locatorInputValue(selector, { tabId, frame, timeoutMs } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const { result } = await this.#runLocatorWithAutoWait(id, selector, { frame, mutation: "inputValue", timeoutMs });
    return { tab_id: String(id), value: String(result?.value ?? "") };
  }

  /** @param {string} selector @param {{tabId?:unknown, frame?:string, mode?:"allTextContents"|"allInnerTexts"}} [options] */
  async locatorAllTexts(selector, { tabId, frame, mode = "allTextContents" } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const mutation = mode === "allInnerTexts" ? "allInnerTexts" : "allTextContents";
    const { result } = await this.#runLocator(id, selector, { frame, mutation });
    return {
      tab_id: String(id),
      count: Number(result?.count ?? 0),
      values: Array.isArray(result?.values) ? result.values : [],
    };
  }

  /** @param {string} selector @param {"isVisible"|"isEnabled"|"isChecked"} stateKind @param {{tabId?:unknown, frame?:string}} [options] */
  async locatorState(selector, stateKind, { tabId, frame } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const { result } = await this.#runLocator(id, selector, { frame, mutation: stateKind });
    return { tab_id: String(id), value: Boolean(result?.value) };
  }

  /** @param {string} selector @param {string|Function} fnOrExpr @param {{tabId?:unknown, frame?:string, all?:boolean, arg?:unknown, hasArg?:boolean, timeoutMs?:number}} [options] */
  async locatorEvaluate(selector, fnOrExpr, { tabId, frame, all = false, arg, hasArg = false, timeoutMs } = {}) {
    const source = typeof fnOrExpr === "function" ? fnOrExpr.toString() : String(fnOrExpr);
    assertReadOnly(source);
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const opts = {
      frame,
      mutation: all ? "evalAll" : "eval",
      evalFn: source,
      evalArg: arg,
      hasEvalArg: Boolean(hasArg),
      asyncEval: true,
      timeoutMs,
    };
    const { result } = all
      ? await this.#runLocator(id, selector, opts)
      : await this.#runLocatorWithAutoWait(id, selector, opts);
    return { tab_id: String(id), count: Number(result?.count ?? 0), value: result?.value };
  }

  /** @param {string} selector @param {{tabId?:unknown, frame?:string, clickCount?:number, button?:string, modifiers?:string|string[], force?:boolean, timeoutMs?:number, settle?:boolean}} [options] */
  async locatorClick(selector, { tabId, frame, clickCount = 1, button = "left", modifiers, force = false, timeoutMs, settle = false } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const modMask = parseModifiers(modifiers);
    const { inCrossOriginFrame, result: match } = await this.#runLocatorWithAutoWait(id, selector, {
      frame,
      mutation: "point",
      crossOriginMutation: "click",
      force,
      timeoutMs,
    });
    if (!inCrossOriginFrame) {
      await this.#clickPoint(id, match.x, match.y, { clickCount, button, modifiers: modMask });
    }
    if (settle) await this.#waitForSettle(id, { expectNavigation: true });
    return { tab_id: String(id), ok: true, action: "locator_click", selector, ...(frame ? { frame } : {}) };
  }

  /** @param {string} selector @param {string} value @param {{tabId?:unknown, frame?:string, force?:boolean, timeoutMs?:number, settle?:boolean}} [options] */
  async locatorFill(selector, value, { tabId, frame, force = false, timeoutMs, settle = false } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    await this.#runLocatorWithAutoWait(id, selector, {
      frame,
      mutation: "fill",
      value: String(value),
      force,
      timeoutMs,
    });
    if (settle) await this.#waitForSettle(id);
    return { tab_id: String(id), ok: true, action: "locator_fill", selector, ...(frame ? { frame } : {}) };
  }

  /** @param {string} selector @param {{tabId?:unknown, frame?:string, force?:boolean, timeoutMs?:number, settle?:boolean}} [options] */
  async locatorClear(selector, { tabId, frame, force = false, timeoutMs, settle = false } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    await this.#runLocatorWithAutoWait(id, selector, {
      frame,
      mutation: "clear",
      force,
      timeoutMs,
    });
    if (settle) await this.#waitForSettle(id);
    return { tab_id: String(id), ok: true, action: "locator_clear", selector, ...(frame ? { frame } : {}) };
  }

  /** @param {string} selector @param {string} key @param {{tabId?:unknown, frame?:string, force?:boolean, timeoutMs?:number, settle?:boolean}} [options] */
  async locatorPress(selector, key, { tabId, frame, force = false, timeoutMs, settle = false } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const { sessionId } = await this.#runLocatorWithAutoWait(id, selector, {
      frame,
      mutation: "focus",
      force,
      timeoutMs,
    });
    const parsed = await this.#sendKeyCombo(id, key, sessionId ?? null);
    if (settle) await this.#waitForSettle(id, { expectNavigation: parsed.key === "Enter" });
    return { tab_id: String(id), ok: true, action: "locator_press", selector, key };
  }

  /** @param {string} selector @param {string} text @param {{tabId?:unknown, frame?:string, force?:boolean, timeoutMs?:number, sequentially?:boolean, delayMs?:number, settle?:boolean}} [options] */
  async locatorType(selector, text, { tabId, frame, force = false, timeoutMs, sequentially = false, delayMs = 0, settle = false } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const { sessionId } = await this.#runLocatorWithAutoWait(id, selector, {
      frame,
      mutation: "focus",
      force,
      timeoutMs,
    });
    const value = String(text);
    const targetSession = sessionId ?? null;
    if (!sequentially) {
      await this.#cdpTarget(id, targetSession, "Input.insertText", { text: value });
    } else {
      for (const ch of value) {
        if (ch === "\n" || ch === "\r") {
          await this.#sendKeyCombo(id, "Enter", targetSession);
        } else if (/^[\x20-\x7e]$/u.test(ch)) {
          await this.#cdpTarget(id, targetSession, "Input.dispatchKeyEvent", {
            type: "keyDown",
            key: ch,
            text: ch,
            unmodifiedText: ch,
          });
          await this.#cdpTarget(id, targetSession, "Input.dispatchKeyEvent", { type: "keyUp", key: ch });
        } else {
          await this.#cdpTarget(id, targetSession, "Input.insertText", { text: ch });
        }
        if (delayMs > 0) await sleep(delayMs);
      }
    }
    if (settle) await this.#waitForSettle(id);
    return { tab_id: String(id), ok: true, action: sequentially ? "locator_press_sequentially" : "locator_type", selector };
  }

  /**
   * Read an existing Chrome tab's content passively without attaching the Chrome debugger.
   * @param {unknown} tabId
   * @param {{format?:"markdown"|"text", maxChars?:number}} [options]
   */
  async readTabContext(tabId, { format = "markdown", maxChars = 16_000 } = {}) {
    this.#assertOpen();
    const id = Number(tabId ?? this.activeTabId);
    if (!Number.isSafeInteger(id)) throw new Error("A numeric tab_id is required");
    const res = await this.#rpc("readTabContext", {
      tabId: id,
      format: format === "text" ? "text" : "markdown",
      maxChars: Number.isFinite(Number(maxChars)) ? Number(maxChars) : 16_000,
    });
    return { tab_id: String(id), ...(res ?? {}) };
  }

  /** @param {unknown} tabId @param {{format?:string, maxChars?:number}} [options] */
  async getContent(tabId, options = {}) {
    const hasExplicit = tabId !== undefined && tabId !== null && tabId !== "";
    const numId = hasExplicit ? Number(tabId) : NaN;
    if (this.supportsPassiveRead && Number.isSafeInteger(numId) &&
        !this.attached.has(numId) && !this.ownedTabs.has(numId)) {
      try {
        const passive = await this.readTabContext(numId, {
          format: options?.format === "markdown" ? "markdown" : "text",
          maxChars: options?.maxChars,
        });
        return {
          tab_id: String(numId),
          text: String(passive?.text ?? passive?.content ?? ""),
          ...(passive?.format ? { format: passive.format } : {}),
          ...(passive?.title !== undefined ? { title: passive.title } : {}),
          ...(passive?.url !== undefined ? { url: passive.url } : {}),
          ...(passive?.truncated !== undefined ? { truncated: passive.truncated } : {}),
          passive: true,
        };
      } catch (err) {
        const msg = String(err?.message || err);
        if (!/No handler|not supported|Unknown/i.test(msg)) throw err;
      }
    }
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    if (options && (options.format || options.maxChars !== undefined)) {
      const fmt = options.format ?? "markdown";
      const maxChars = options.maxChars ?? 16_000;
      const extracted = await this.#evaluateRaw(id, extractContentExpression({ format: fmt, maxChars }));
      if (extracted && typeof extracted === "object") {
        return {
          tab_id: String(id),
          ...extracted,
          text: String(extracted.text ?? extracted.content ?? ""),
        };
      }
    }
    const text = await this.#evaluateRaw(id, "document.body ? document.body.innerText : ''");
    return { tab_id: String(id), text: String(text ?? "") };
  }

  /** @param {string} source @param {{tabId?:unknown, arg?:unknown, hasArg?:boolean}} [options] */
  async evaluate(source, { tabId, arg, hasArg = false } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const checked = assertReadOnly(source);
    const serializedArg = arg === undefined ? "undefined" : JSON.stringify(arg);
    const expression = hasArg ? `(${checked})(${serializedArg})` : checked;
    const value = await this.#evaluateRaw(id, expression, { awaitPromise: true });
    return { tab_id: String(id), value: value ?? null };
  }

  /**
   * Discover WebMCP tools registered via `navigator.modelContext` on the active document.
   * @param {unknown} [tabId]
   */
  async webmcpListTools(tabId) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const expr = `(() => {
      const ctx = navigator.modelContext || window.__webmcp || null;
      if (!ctx) return { supported: false, tools: [] };
      const raw = typeof ctx.listTools === "function" ? ctx.listTools() : (Array.isArray(ctx.tools) ? ctx.tools : []);
      const tools = Array.isArray(raw) ? raw.map((t) => ({
        name: String(t?.name || ""),
        description: t?.description ? String(t.description) : "",
        inputSchema: t?.inputSchema ?? null,
      })).filter((t) => t.name) : [];
      return { supported: true, tools };
    })()`;
    const res = await this.#evaluateRaw(id, expr);
    return { tab_id: String(id), supported: Boolean(res?.supported), tools: Array.isArray(res?.tools) ? res.tools : [] };
  }

  /**
   * Invoke a registered WebMCP tool on the active document.
   * @param {string} name
   * @param {Record<string, unknown>} [args]
   * @param {{tabId?:unknown}} [options]
   */
  async webmcpInvokeTool(name, args = {}, { tabId } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const expr = `(async () => {
      const toolName = ${JSON.stringify(String(name))};
      const payload = ${JSON.stringify(args ?? {})};
      const ctx = navigator.modelContext || window.__webmcp || null;
      if (!ctx) throw new Error("WebMCP is not supported on this page");
      if (typeof ctx.invokeTool === "function") return await ctx.invokeTool(toolName, payload);
      if (typeof ctx.callTool === "function") return await ctx.callTool(toolName, payload);
      const raw = typeof ctx.listTools === "function" ? ctx.listTools() : (Array.isArray(ctx.tools) ? ctx.tools : []);
      const match = Array.isArray(raw) ? raw.find((t) => t?.name === toolName) : null;
      if (!match || typeof match.execute !== "function") throw new Error("WebMCP tool not found: " + toolName);
      return await match.execute(payload);
    })()`;
    const result = await this.#evaluateRaw(id, expr, { awaitPromise: true, userGesture: true });
    return { tab_id: String(id), name: String(name), result: result ?? null };
  }

  /**
   * Inventory observable page assets (images, stylesheets, scripts, videos, fonts, inline SVGs).
   * @param {unknown} [tabId]
   * @param {{limit?:number}} [options]
   */
  async listPageAssets(tabId, { limit = 100 } = {}) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    const cap = Math.max(10, Math.min(500, Number(limit) || 100));
    const expr = `(() => {
      const cap = ${cap};
      const assets = [];
      const seen = new Set();
      const add = (kind, url, source) => {
        if (!url || seen.has(kind + "|" + url) || assets.length >= cap) return;
        seen.add(kind + "|" + url);
        assets.push({ kind, url: String(url).slice(0, 500), source });
      };
      for (const img of document.querySelectorAll("img[src]")) add("image", img.currentSrc || img.src, "img");
      for (const link of document.querySelectorAll('link[rel~="stylesheet"][href]')) add("stylesheet", link.href, "link");
      for (const sc of document.querySelectorAll("script[src]")) add("script", sc.src, "script");
      for (const vid of document.querySelectorAll("video[src], video source[src]")) add("video", vid.src, vid.tagName.toLowerCase());
      const fonts = document.fonts ? Array.from(document.fonts).slice(0, 30).map((f) => ({ family: f.family, status: f.status })) : [];
      const inlineSvgs = Array.from(document.querySelectorAll("svg")).slice(0, 20).map((svg, i) => ({
        index: i,
        id: svg.id || null,
        viewBox: svg.getAttribute("viewBox") || null,
        markupLength: (svg.outerHTML || "").length,
      }));
      return { url: location.href, assets, fonts, inlineSvgCount: document.querySelectorAll("svg").length, inlineSvgs };
    })()`;
    const res = await this.#evaluateRaw(id, expr);
    return { tab_id: String(id), ...(res ?? { assets: [], fonts: [], inlineSvgCount: 0, inlineSvgs: [] }) };
  }

  /** @param {{tabId?:unknown, accept:boolean, promptText?:string}} options */
  async handleDialog({ tabId, accept, promptText }) {
    const id = await this.#resolveTab(tabId);
    await this.attach(id);
    await this.#cdp(id, "Page.handleJavaScriptDialog", {
      accept: Boolean(accept),
      ...(promptText === undefined ? {} : { promptText: String(promptText) }),
    });
    const state = this.tabStates.get(id);
    if (state) state.dialog = null;
    return { tab_id: String(id), ok: true, action: "handle_dialog", accepted: Boolean(accept) };
  }

  /**
   * Execute a pipeline of browser actions in a single round-trip, settling between
   * navigation/click actions and optionally returning the resulting diff/full state/screenshot.
   * @param {Array<Record<string, any>>} steps
   * @param {{tabId?:unknown, returnState?:"diff"|"full"|"screenshot"|"both"|"none", mode?:"full"|"compact"|"interactive", maxLines?:number, stopOnError?:boolean}} [options]
   */
  async batch(steps, { tabId, returnState = "diff", mode = "full", maxLines = 1_500, stopOnError = true } = {}) {
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error("batch requires a non-empty array of steps");
    }
    let currentTabId = tabId;
    const completed = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i] ?? {};
      const stepTab = step.tab_id ?? step.tabId ?? currentTabId;
      try {
        let result;
        switch (step.action) {
          case "new_tab":
            result = await this.newTab(step.url);
            currentTabId = result.tab_id;
            break;
          case "select_tab":
            result = await this.selectTab(step.tab_id);
            currentTabId = result.tab_id;
            break;
          case "close_tab":
            result = await this.closeTab(stepTab);
            if (String(stepTab) === String(currentTabId)) currentTabId = undefined;
            break;
          case "goto":
            result = await this.goto(step.url, stepTab, { waitUntil: step.wait_until ?? "load" });
            currentTabId = result.tab_id;
            break;
          case "back":
            result = await this.history("back", stepTab);
            break;
          case "forward":
            result = await this.history("forward", stepTab);
            break;
          case "reload":
            result = await this.reload(stepTab);
            break;
          case "click":
            result = await this.click(step.element_index, {
              tabId: stepTab,
              clickCount: step.click_count ?? 1,
              button: step.mouse_button ?? "left",
              modifiers: step.modifiers,
              x: step.x,
              y: step.y,
              settle: true,
            });
            break;
          case "set_value":
            result = await this.setValue(step.element_index, step.value, { tabId: stepTab, settle: true });
            break;
          case "type_text":
            result = await this.typeText(step.text, { tabId: stepTab, elementIndex: step.element_index, settle: true });
            break;
          case "press_key":
            result = await this.pressKey(step.key, { tabId: stepTab, elementIndex: step.element_index, settle: true });
            break;
          case "select_option":
            result = await this.selectOption({
              tabId: stepTab,
              elementIndex: step.element_index,
              selector: step.selector,
              frame: step.frame,
              value: step.value,
              label: step.label,
              index: step.index,
            });
            break;
          case "hover":
            result = await this.hover({
              tabId: stepTab,
              elementIndex: step.element_index,
              selector: step.selector,
              frame: step.frame,
              x: step.x,
              y: step.y,
            });
            break;
          case "drag":
            result = await this.drag({
              tabId: stepTab,
              fromIndex: step.from_index,
              toIndex: step.to_index,
              fromX: step.from_x,
              fromY: step.from_y,
              toX: step.to_x,
              toY: step.to_y,
            });
            break;
          case "scroll":
            result = await this.scroll(step.direction, {
              tabId: stepTab,
              pages: step.pages ?? 1,
              elementIndex: step.element_index,
              x: step.x,
              y: step.y,
            });
            break;
          case "locator_click":
            result = await this.locatorClick(step.selector, {
              tabId: stepTab,
              frame: step.frame,
              clickCount: step.click_count ?? 1,
              button: step.mouse_button ?? "left",
              modifiers: step.modifiers,
              force: step.force === true,
              timeoutMs: step.timeout_ms,
              settle: true,
            });
            break;
          case "locator_fill":
            result = await this.locatorFill(step.selector, step.value, {
              tabId: stepTab,
              frame: step.frame,
              force: step.force === true,
              timeoutMs: step.timeout_ms,
              settle: true,
            });
            break;
          case "set_viewport":
            result = await this.setViewport({
              tabId: stepTab,
              width: step.width,
              height: step.height,
              deviceScaleFactor: step.device_scale_factor ?? 1,
              mobile: step.mobile === true,
            });
            break;
          case "reset_viewport":
            result = await this.resetViewport(stepTab);
            break;
          case "upload_files":
            result = await this.uploadFiles(step.files, {
              tabId: stepTab,
              elementIndex: step.element_index,
              selector: step.selector,
              frame: step.frame,
            });
            break;
          case "wait":
            result = await this.waitFor({
              tabId: stepTab,
              selector: step.selector,
              text: step.text,
              url: step.url,
              loadState: step.load_state,
              state: step.state,
              frame: step.frame,
              timeoutMs: step.timeout_ms ?? 10_000,
            });
            break;
          case "handle_dialog":
            result = await this.handleDialog({ tabId: stepTab, accept: step.accept, promptText: step.prompt_text });
            break;
          case "name_session":
            result = await this.nameSession(step.name, { color: step.color ?? "blue" });
            break;
          case "get_state":
            result = await this.getState(stepTab, {
              screenshot: false,
              diff: step.mode ? true : true,
              mode: step.mode ?? mode,
              maxLines,
            });
            break;
          case "get_content":
            result = await this.getContent(stepTab, {
              ...(step.format ? { format: step.format } : {}),
              ...(step.max_chars !== undefined ? { maxChars: step.max_chars } : {}),
            });
            break;
          case "read_tab":
            result = await this.readTabContext(stepTab, {
              format: step.format === "text" ? "text" : "markdown",
              maxChars: step.max_chars ?? 16_000,
            });
            break;
          case "evaluate":
            result = await this.evaluate(step.expression, { tabId: stepTab });
            break;
          default:
            throw new Error(`Unsupported batch action: ${String(step.action)}`);
        }
        completed.push({ step: i, action: step.action, ok: true, result });
      } catch (error) {
        const errText = error instanceof Error ? error.message : String(error);
        completed.push({ step: i, action: step.action, ok: false, error: errText });
        if (stopOnError) {
          let state = null;
          if (returnState !== "none") {
            state = await this.getState(currentTabId, {
              screenshot: returnState === "screenshot" || returnState === "both",
              diff: returnState === "diff",
              full: returnState === "full" || returnState === "both",
              mode,
              maxLines,
            }).catch(() => null);
          }
          return {
            ok: false,
            failed_step: i,
            error: errText,
            completed_steps: completed,
            state,
          };
        }
      }
    }

    let state = null;
    if (returnState !== "none") {
      const wantShot = returnState === "screenshot" || returnState === "both";
      const wantAx = returnState !== "screenshot";
      if (wantAx) {
        state = await this.getState(currentTabId, {
          screenshot: wantShot,
          diff: returnState === "diff",
          full: returnState === "full" || returnState === "both",
          mode,
          maxLines,
        }).catch(() => null);
      } else {
        const cap = await this.screenshot(currentTabId).catch(() => null);
        if (cap) state = { tab_id: cap.tab_id, screenshotBase64: cap.data, screenshotMimeType: cap.mimeType };
      }
    }
    return {
      ok: completed.every((c) => c.ok),
      completed_steps: completed,
      state,
    };
  }

  /** @param {{keep?:Array<{tab_id:unknown, mode?:string}>}} [options] */
  async endTurn({ keep = [] } = {}) {
    for (const entry of keep) {
      const id = await this.#resolveTab(entry?.tab_id);
      const mode = entry?.mode === "deliverable" ? "deliverable" : "handoff";
      if (mode === "deliverable" && this.attached.has(id)) {
        await this.#cdp(id, "Page.bringToFront").catch(() => {});
      }
      await this.#rpc("markTab", { tabId: id, status: mode });
    }
    await this.#rpc("turnEnded");
    this.turnId = randomUUID();
    this.axCache.clear();
    this.enabledDomains.clear();
    this.lastAxSnapshots.clear();
    this.frameSessions.clear();
    this.autoAttached.clear();
    this.locatorRuntimeInstalled.clear();
    this.statelessEvalTabs.clear();
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

  /** @param {number} tabId @param {{backendDOMNodeId:number|null}} node @param {string|null} [sessionId] */
  async #scrollIntoView(tabId, node, sessionId = null) {
    if (!Number.isSafeInteger(node.backendDOMNodeId)) return;
    await this.#cdpTarget(tabId, sessionId, "DOM.scrollIntoViewIfNeeded", { backendNodeId: node.backendDOMNodeId });
  }

  /** @param {number} tabId @param {{backendDOMNodeId:number|null}} node @param {string|null} [sessionId] */
  async #boxModel(tabId, node, sessionId = null) {
    await this.#scrollIntoView(tabId, node, sessionId).catch(() => {});
    const model = await this.#cdpTarget(tabId, sessionId, "DOM.getBoxModel", { backendNodeId: node.backendDOMNodeId });
    const quad = model?.model?.border;
    if (!Array.isArray(quad) || quad.length !== 8) throw new Error("Browser element has no visible box");
    const x = (quad[0] + quad[2]) / 2;
    const y = (quad[1] + quad[5]) / 2;
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Browser element has no visible box");
    return { x, y };
  }

  /** @param {number} tabId @param {{backendDOMNodeId:number|null, role:string, name:string, sessionId?:string|null}} node @param {{clickCount:number, button:string, modifiers:number}} options */
  async #clickNode(tabId, node, { clickCount, button, modifiers }) {
    const sessionId = node.sessionId ?? null;
    if (sessionId) {
      // Cross-origin iframe AX node: scroll & trigger click inside its debugger session.
      await this.#scrollIntoView(tabId, node, sessionId).catch(() => {});
      const { object } = await this.#cdpIn(tabId, sessionId, "DOM.resolveNode", { backendNodeId: node.backendDOMNodeId });
      if (!object?.objectId) throw new Error("Browser iframe element could not be resolved for clicking");
      await this.#cdpIn(tabId, sessionId, "Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: "function () { this.focus?.(); this.click(); }",
        userGesture: true,
      });
      return;
    }

    // Try fast Shadow-DOM-aware hit-test first; fall back cleanly to #boxModel on minimal mocks.
    let point = null;
    let resolvedObjectId = null;
    try {
      const quads = await this.#cdp(tabId, "DOM.getContentQuads", { backendNodeId: node.backendDOMNodeId });
      if (Array.isArray(quads?.quads) && quads.quads.length > 0) {
        const resolved = await this.#cdp(tabId, "DOM.resolveNode", { backendNodeId: node.backendDOMNodeId });
        resolvedObjectId = resolved?.object?.objectId ?? null;
        if (resolvedObjectId) {
          let hit = await this.#cdp(tabId, "Runtime.callFunctionOn", {
            objectId: resolvedObjectId,
            functionDeclaration: hitTestFunctionDeclaration(),
            returnByValue: true,
          });
          let val = hit?.result?.value;
          if (val && (val.offscreen || val.hitsTarget === false)) {
            await this.#scrollIntoView(tabId, node).catch(() => {});
            hit = await this.#cdp(tabId, "Runtime.callFunctionOn", {
              objectId: resolvedObjectId,
              functionDeclaration: hitTestFunctionDeclaration(),
              returnByValue: true,
            });
            val = hit?.result?.value;
          }
          if (val?.hitsTarget && val.point) {
            point = val.point;
          } else if (val && val.hitsTarget === false) {
            throw new Error(`Accessibility element (${node.role} "${node.name}") is covered by <${val.hitTag || "unknown"}> or not hittable`);
          }
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("not hittable")) throw error;
    } finally {
      if (resolvedObjectId) {
        await this.#cdp(tabId, "Runtime.releaseObject", { objectId: resolvedObjectId }).catch(() => {});
      }
    }

    if (!point) {
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
    }

    await this.#clickPoint(tabId, point.x, point.y, { clickCount, button, modifiers });
  }

  /** @param {number} tabId @param {number} x @param {number} y @param {{clickCount:number, button:string, modifiers?:number}} options */
  async #clickPoint(tabId, x, y, { clickCount, button, modifiers = 0 }) {
    const common = { x, y, button, clickCount, modifiers };
    await this.#cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...common, button: "none", buttons: 0, clickCount: 0 });
    await this.#cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...common, buttons: buttonMask(button) });
    await this.#cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...common, buttons: 0 });
  }

  /**
   * Build a classified Error preserving retryability and locator failure code.
   * @param {{error?:string, code?:string, retryable?:boolean}} result
   * @param {string} [fallback]
   */
  #locatorError(result, fallback = "Browser locator failed") {
    const err = new Error(String(result?.error || fallback));
    err.code = result?.code || "error";
    err.retryable = Boolean(result?.retryable);
    return err;
  }

  /**
   * Retry transient locator failures (not_found, not_visible, disabled, covered) up to `timeoutMs` (default 3000ms).
   * Fails immediately on structural errors (strict-mode multiple match, invalid locator, readonly).
   * @param {number} tabId
   * @param {string} selector
   * @param {Record<string, any>} [options]
   */
  async #runLocatorWithAutoWait(tabId, selector, { timeoutMs, ...options } = {}) {
    const budget = timeoutMs !== undefined ? Math.max(0, Number(timeoutMs) || 0) : DEFAULT_LOCATOR_TIMEOUT_MS;
    if (budget === 0) {
      return await this.#runLocator(tabId, selector, options);
    }
    const deadline = Date.now() + budget;
    while (true) {
      const rem = deadline - Date.now();
      const attemptStart = Date.now();
      try {
        return await this.#runLocator(tabId, selector, { ...options, inPageWaitMs: Math.min(800, Math.max(1, rem)) });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const contextLost = /Execution context was destroyed|Cannot find context/i.test(msg);
        if (!error?.retryable && !contextLost) throw error;
        const left = deadline - Date.now();
        if (left <= 0) {
          let hint = "";
          if (error?.code === "not_found" && !options.frame && this.locatorRuntimeInstalled.has(`${tabId}:main`)) {
            const cands = await Promise.race([
              this.#evaluateRaw(tabId, `(() => globalThis.__buRt?.suggestCandidates?.(${JSON.stringify(selector)}, 4) ?? [])()`).catch(() => []),
              sleep(250).then(() => []),
            ]);
            if (Array.isArray(cands) && cands.length > 0) {
              hint = ` | Closest visible matches: ${cands.join(", ")}`;
            }
          }
          const wrapped = new Error(`Timed out after ${budget}ms waiting for locator: ${msg}${hint}`);
          wrapped.code = error.code;
          throw wrapped;
        }
        if (Date.now() - attemptStart < 20) {
          await sleep(Math.min(50, left));
        }
      }
    }
  }

  /**
   * Execute a locator expression once in the main frame, same-origin iframe chain, or cross-origin frame session.
   * @param {number} tabId
   * @param {string} selector
   * @param {{frame?:string, crossOriginMutation?:string, crossOriginOptions?:Record<string, any>, mutation?:string, value?:string, select?:unknown, state?:string, inPageWaitMs?:number}} [options]
   * @returns {Promise<{inCrossOriginFrame:boolean, sessionId?:string, result:any}>}
   */
  async #runLocatorOnce(tabId, selector, { frame, crossOriginMutation, crossOriginOptions, ...options } = {}) {
    if (!frame) {
      return { inCrossOriginFrame: false, result: await this.#locator(tabId, selector, options) };
    }
    const resolved = await this.#resolveFrameRoute(tabId, frame);
    if (resolved.kind === "same-origin") {
      return {
        inCrossOriginFrame: false,
        result: await this.#locator(tabId, selector, { ...options, sameOriginFrames: resolved.selectors }),
      };
    }
    return {
      inCrossOriginFrame: true,
      sessionId: resolved.sessionId,
      result: await this.#locatorInSession(tabId, resolved.sessionId, selector, {
        ...options,
        ...(crossOriginOptions ?? {}),
        mutation: crossOriginMutation ?? options.mutation,
      }),
    };
  }

  /**
   * Execute a locator expression, invalidating cached frame routes once on stale frame/session errors.
   * @param {number} tabId
   * @param {string} selector
   * @param {Record<string, any>} [options]
   * @returns {Promise<{inCrossOriginFrame:boolean, sessionId?:string, result:any}>}
   */
  async #runLocator(tabId, selector, options = {}) {
    const frame = options.frame;
    if (!frame) return await this.#runLocatorOnce(tabId, selector, options);
    const hadCache = Boolean(this.frameRouteCache.get(tabId)?.routes?.has(String(frame)));
    try {
      return await this.#runLocatorOnce(tabId, selector, options);
    } catch (error) {
      if (hadCache) {
        const msg = error instanceof Error ? error.message : String(error);
        if (/frame|session|detach|unavailable/iu.test(msg)) {
          this.frameRouteCache.get(tabId)?.routes?.delete(String(frame));
          return await this.#runLocatorOnce(tabId, selector, options);
        }
      }
      throw error;
    }
  }

  /** @param {number} tabId @param {string|null} sessionId @returns {Promise<boolean>} */
  async #ensureLocatorRuntime(tabId, sessionId = null) {
    const cacheKey = `${tabId}:${sessionId ?? "main"}`;
    if (this.statelessEvalTabs.has(cacheKey)) return false;
    const rev = sessionId ? 0 : this.#tabState(tabId).navRevision;
    if (this.locatorRuntimeInstalled.get(cacheKey) === rev) return true;
    const response = await this.#cdpTarget(tabId, sessionId, "Runtime.evaluate", {
      expression: locatorRuntimeInstallExpression(),
      returnByValue: true,
      awaitPromise: false,
      userGesture: false,
      includeCommandLineAPI: false,
    }).catch(() => null);
    if (response?.exceptionDetails) {
      this.statelessEvalTabs.add(cacheKey);
      return false;
    }
    const val = response?.result?.value;
    if (val && typeof val === "object" && val.installed === true && val.v === LOCATOR_RUNTIME_VERSION) {
      this.locatorRuntimeInstalled.set(cacheKey, rev);
      return true;
    }
    this.statelessEvalTabs.add(cacheKey);
    return false;
  }

  /** @param {number} tabId @param {string|null} sessionId @param {string} selector @param {Record<string, any>} [options] */
  async #evaluateLocator(tabId, sessionId, selector, options = {}) {
    const userGesture = ["fill", "clear", "click", "select", "check", "uncheck"].includes(options.mutation);
    const awaitPromise = Boolean(
      options.asyncEval ||
      (options.inPageWaitMs ?? 0) > 0 ||
      options.mutation === "fill" ||
      options.mutation === "clear",
    );
    const cacheKey = `${tabId}:${sessionId ?? "main"}`;
    const runExpr = async (expression) => {
      const response = await this.#cdpTarget(tabId, sessionId, "Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise,
        userGesture,
        includeCommandLineAPI: false,
      });
      if (response?.exceptionDetails) {
        const details = response.exceptionDetails;
        throw new Error(details.exception?.description || details.text || "Browser locator failed");
      }
      return response?.result?.value;
    };

    let result;
    if (!this.statelessEvalTabs.has(cacheKey) && await this.#ensureLocatorRuntime(tabId, sessionId)) {
      result = await runExpr(locatorInvokeExpression(selector, options));
      if (result && result.__buRtMissing === true) {
        this.locatorRuntimeInstalled.delete(cacheKey);
        if (await this.#ensureLocatorRuntime(tabId, sessionId)) {
          result = await runExpr(locatorInvokeExpression(selector, options));
        }
        if (result && result.__buRtMissing === true) {
          this.statelessEvalTabs.add(cacheKey);
          result = await runExpr(locatorExpression(selector, options));
        }
      }
    } else {
      result = await runExpr(locatorExpression(selector, options));
    }
    if (result?.error) throw this.#locatorError(result);
    return result;
  }

  /** @param {number} tabId @param {string} selector @param {Record<string, any>} [options] */
  async #locator(tabId, selector, options = {}) {
    return await this.#evaluateLocator(tabId, null, selector, options);
  }

  /**
   * Resolve frame path into either same-origin CSS selector chain or cross-origin CDP sessionId, cached per navRevision.
   * @param {number} tabId
   * @param {string} framePath
   * @returns {Promise<{kind:"same-origin", selectors:string[]}|{kind:"cross-origin", sessionId:string}>}
   */
  async #resolveFrameRoute(tabId, framePath) {
    const normalizedPath = String(framePath);
    const state = this.#tabState(tabId);
    let tabCache = this.frameRouteCache.get(tabId);
    if (!tabCache || tabCache.navRevision !== state.navRevision) {
      tabCache = { navRevision: state.navRevision, routes: new Map() };
      this.frameRouteCache.set(tabId, tabCache);
    }
    const cached = tabCache.routes.get(normalizedPath);
    if (cached) {
      if (cached.kind === "same-origin") return cached;
      const frameMap = this.frameSessions.get(tabId);
      if (frameMap) {
        for (const sId of frameMap.values()) {
          if (sId === cached.sessionId) return cached;
        }
      }
      tabCache.routes.delete(normalizedPath);
    }

    const parts = normalizedPath.split(">>").map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0) throw new Error("A frame selector is required");
    await this.#ensureAutoAttach(tabId);
    let sessionId = null;
    let sameOriginOnly = true;
    for (const part of parts) {
      const exec = (method, params) => sessionId
        ? this.#cdpIn(tabId, sessionId, method, params)
        : this.#cdp(tabId, method, params);
      if (sessionId === null) {
        await this.#ensureDomain(tabId, "DOM", "DOM.enable");
      } else {
        await exec("DOM.enable", {});
      }
      const document = await exec("DOM.getDocument", { depth: 0 });
      const { nodeId } = await exec("DOM.querySelector", { nodeId: document.root.nodeId, selector: part });
      if (!nodeId) throw new Error(`No iframe matched: ${part}`);
      const described = await exec("DOM.describeNode", { nodeId });
      if (sameOriginOnly && described?.node?.contentDocument) {
        continue;
      }
      sameOriginOnly = false;
      const frameId = described?.node?.frameId;
      if (typeof frameId !== "string") throw new Error(`The element matched by ${part} is not a frame`);
      sessionId = await this.#waitForFrameSession(tabId, frameId);
    }
    const resolved = sameOriginOnly ? { kind: "same-origin", selectors: parts } : { kind: "cross-origin", sessionId };
    tabCache.routes.set(normalizedPath, resolved);
    return resolved;
  }

  /** @param {number} tabId @param {string} frameId @returns {Promise<string>} */
  async #waitForFrameSession(tabId, frameId) {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const sessionId = this.frameSessions.get(tabId)?.get(frameId);
      if (typeof sessionId === "string") return sessionId;
      await this.#waitForTabWakeup(tabId, Math.min(80, Math.max(1, deadline - Date.now())));
    }
    throw new Error("The cross-origin frame session is unavailable; this iframe may be same-process");
  }

  /** @param {number} tabId @param {string} sessionId @param {string} selector @param {Record<string, any>} [options] */
  async #locatorInSession(tabId, sessionId, selector, options = {}) {
    return await this.#evaluateLocator(tabId, sessionId, selector, options);
  }

  /** @param {number} tabId @param {string} expression @param {{awaitPromise?:boolean, userGesture?:boolean}} [options] */
  async #evaluateRaw(tabId, expression, { awaitPromise = false, userGesture = false } = {}) {
    const response = await this.#cdp(tabId, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture,
      includeCommandLineAPI: false,
    });
    if (response?.exceptionDetails) {
      const details = response.exceptionDetails;
      throw new Error(details.exception?.description || details.text || "Browser evaluation failed");
    }
    return response?.result?.value;
  }

  /**
   * Event-driven post-action settle: detects triggered navigations and waits briefly for
   * paint + AX quiet. Automatically a no-op when no event stream is active or a dialog is open.
   * @param {number} tabId
   * @param {{expectNavigation?:boolean, timeoutMs?:number}} [options]
   */
  async #waitForSettle(tabId, { expectNavigation = false, timeoutMs = DEFAULT_SETTLE_TIMEOUT_MS } = {}) {
    const state = this.tabStates.get(tabId);
    if (!state || !state.hasEvents || state.dialog) return;

    const startRev = state.navRevision;
    if (expectNavigation && !state.loading) {
      const detectDeadline = Date.now() + 30;
      while (Date.now() < detectDeadline) {
        if (state.dialog || state.loading || state.navRevision !== startRev) break;
        await this.#waitForTabWakeup(tabId, Math.max(1, detectDeadline - Date.now()));
      }
    }

    const navTriggered = state.loading || state.navRevision !== startRev;
    const effectiveWaitMs = navTriggered ? timeoutMs : Math.min(timeoutMs, 150);
    const deadline = Date.now() + effectiveWaitMs;
    while (state.loading && !state.dialog && Date.now() < deadline) {
      await this.#waitForTabWakeup(tabId, Math.min(35, Math.max(1, deadline - Date.now())));
    }

    // Wait briefly for AX updates to settle (60ms quiet window).
    const quietCap = navTriggered ? 250 : 100;
    const quietDeadline = Math.min(deadline, Date.now() + quietCap);
    while (!state.dialog && Date.now() < quietDeadline) {
      const sinceAx = Date.now() - Math.max(state.lastAxUpdateMs, 0);
      if (state.lastAxUpdateMs === 0 || sinceAx >= 60) break;
      await this.#waitForTabWakeup(tabId, Math.min(60 - sinceAx, Math.max(1, quietDeadline - Date.now())));
    }
  }

  /** @param {number} tabId @param {string} target @param {number} [timeoutMs] */
  async #waitForCommit(tabId, target, timeoutMs = DEFAULT_LOAD_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    const state = this.#tabState(tabId);
    let lastEvalAt = state.hasEvents ? Date.now() : 0;
    while (Date.now() < deadline) {
      if (state.committed && state.url && state.url !== "about:blank" && sameUrl(state.url, target)) return;
      const now = Date.now();
      if (!state.hasEvents || (!state.committed && now - lastEvalAt >= 400)) {
        lastEvalAt = now;
        const current = await this.#evaluateRaw(tabId, "location.href").catch(() => null);
        if (typeof current === "string" && current !== "about:blank" && sameUrl(current, target)) return;
      }
      await this.#waitForTabWakeup(tabId, Math.min(state.hasEvents ? 200 : 80, Math.max(1, deadline - Date.now())));
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
        await sleep(100);
      }
      const committed = typeof current === "string" && current !== "about:blank" &&
        (current === target || current.startsWith("data:"));
      if (!committed) throw new Error(`Browser navigation failed: ${navigation.errorText}`);
    }
  }

  /** @param {number} tabId @param {{waitUntil?:string, timeoutMs?:number}} [options] */
  async #waitForLoad(tabId, { waitUntil = "load", timeoutMs = DEFAULT_LOAD_TIMEOUT_MS } = {}) {
    const deadline = Date.now() + timeoutMs;
    const state = this.#tabState(tabId);
    let quietStart = null;
    let lastEvalAt = state.hasEvents ? Date.now() : 0;
    while (Date.now() < deadline) {
      if (state.dialog) return;
      let ready = null;
      if (state.hasEvents) {
        if (state.loaded) ready = "complete";
        else if (state.domContentLoaded) ready = "interactive";
      }
      const now = Date.now();
      if (ready === null && (!state.hasEvents || now - lastEvalAt >= 500)) {
        try {
          lastEvalAt = now;
          ready = await this.#evaluateRaw(tabId, "document.readyState");
        } catch {
          // The navigation may have replaced the execution context; retry.
        }
      }
      if (waitUntil === "domcontentloaded" && (ready === "interactive" || ready === "complete")) return;
      if (waitUntil === "load" && ready === "complete") return;
      if (waitUntil === "networkidle" && ready === "complete") {
        const inFlight = state.inFlightRequests.size;
        if (inFlight === 0) {
          quietStart ??= Date.now();
          const remainingQuiet = 350 - (Date.now() - quietStart);
          if (remainingQuiet <= 0) return;
          await this.#waitForTabWakeup(tabId, Math.min(remainingQuiet, Math.max(1, deadline - Date.now())));
          continue;
        }
        quietStart = null;
      }
      await this.#waitForTabWakeup(tabId, Math.min(state.hasEvents ? 250 : 80, Math.max(1, deadline - Date.now())));
    }
    throw new Error(`Browser navigation did not reach ${waitUntil} within ${timeoutMs}ms`);
  }
}
