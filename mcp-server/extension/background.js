const hostName = "com.portable_browser_use.bridge";
const TAB_GROUP_COLORS = new Set(["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]);
const FALLBACK_FAVICON_DATA_URL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const CURSOR_SESSION_ID = "portable-browser-use";
const CURSOR_TURN_ID = "active-turn";
const COMPACT_EVENTS = new Set([
  "Target.attachedToTarget",
  "Target.detachedFromTarget",
  "Page.frameStartedLoading",
  "Page.frameStoppedLoading",
  "Page.frameNavigated",
  "Page.navigatedWithinDocument",
  "Page.domContentEventFired",
  "Page.loadEventFired",
  "Page.lifecycleEvent",
  "Page.frameDetached",
  "Page.javascriptDialogOpening",
  "Page.javascriptDialogClosed",
  "Page.fileChooserOpened",
  "Network.requestWillBeSent",
  "Network.responseReceived",
  "Network.loadingFinished",
  "Network.loadingFailed",
]);
/** @type {(() => void) | null} */
let disconnectActive = null;
let manualDisconnect = false;
/** @type {ReturnType<typeof setTimeout> | null} */
let reconnectTimer = null;
let reconnectAttempts = 0;

/** @param {chrome.tabs.Tab} tab @returns {{id:number,url?:string,title?:string,active:boolean}} */
function serializeTab(tab) {
  if (!Number.isSafeInteger(tab?.id)) throw new Error("Chrome returned a tab without an ID");
  return {id: tab.id, url: tab.url, title: tab.title, active: Boolean(tab.active)};
}

/** @param {string|undefined} url @returns {boolean} */
function isControllableTabUrl(url) {
  if (typeof url !== "string" || !url) return true;
  return !/^(?:chrome|chrome-extension|chrome-untrusted|devtools|edge|brave|vivaldi|opera|view-source):/iu.test(url.trim());
}

/** @returns {boolean} */
function canMessageTabs() {
  return typeof chrome.tabs?.sendMessage === "function";
}

/** @param {string|undefined} href @returns {boolean} */
function isBadgedFaviconUrl(href) {
  return typeof href === "string" && href.startsWith("data:image/svg+xml,") && href.includes("codex-favicon-badge");
}

/**
 * Self-contained DOM extractor injected via chrome.scripting.executeScript for zero-debugger passive reads.
 * @param {{format?:string,maxChars?:number}} [opts]
 */
function extractPassiveTabContext(opts = {}) {
  const format = opts?.format === "text" ? "text" : "markdown";
  const maxChars = Math.max(200, Number(opts?.maxChars) || 16_000);
  const title = document.title || "";
  const url = location.href || "";
  const selection = typeof window.getSelection === "function" ? String(window.getSelection() || "").trim() : "";
  const headingsCount = document.querySelectorAll("h1,h2,h3,h4,h5,h6").length;
  const linksCount = document.querySelectorAll("a[href]").length;

  const clip = (str) => {
    const clean = String(str || "").trim();
    if (clean.length <= maxChars) return { text: clean, truncated: false };
    return { text: clean.slice(0, maxChars) + "\n...(truncated)", truncated: true };
  };

  if (format === "text" || !document.body) {
    const raw = document.body ? (document.body.innerText || "") : "";
    const out = clip(raw);
    return { title, url, format: "text", text: out.text, content: out.text, truncated: out.truncated, headingsCount, linksCount, selection };
  }

  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "NAV", "HEADER", "FOOTER", "ASIDE"]);
  const pickRoot = () => {
    for (const sel of ["article", "main", '[role="main"]']) {
      const candidate = document.querySelector(sel);
      if (candidate && (candidate.innerText || "").trim().length >= 200) return candidate;
    }
    return document.body;
  };
  const root = pickRoot();
  const isHidden = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (SKIP.has(el.tagName) || el.getAttribute("aria-hidden") === "true" || el.hidden) return true;
    const st = getComputedStyle(el);
    return st && (st.display === "none" || st.visibility === "hidden");
  };
  const parts = [];
  let len = 0;
  let truncated = false;
  const push = (chunk) => {
    if (truncated || !chunk) return;
    if (len + chunk.length > maxChars) {
      parts.push(chunk.slice(0, Math.max(0, maxChars - len)));
      truncated = true;
      return;
    }
    parts.push(chunk);
    len += chunk.length;
  };
  const inlineText = (node) => (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
  const walk = (node) => {
    if (truncated || !node) return;
    if (node.nodeType === 3) {
      const t = (node.textContent || "").replace(/\s+/g, " ");
      if (t.trim()) push(t);
      return;
    }
    if (node.nodeType !== 1 || isHidden(node)) return;
    const tag = node.tagName;
    if (/^H[1-6]$/.test(tag)) {
      const txt = inlineText(node);
      if (txt) push(`\n\n${"#".repeat(Number(tag[1]))} ${txt}\n\n`);
      return;
    }
    if (tag === "A") {
      const txt = inlineText(node);
      const href = node.getAttribute("href") || "";
      if (txt) push(href && !href.startsWith("javascript:") ? `[${txt}](${href})` : txt);
      return;
    }
    if (tag === "PRE") {
      const code = (node.innerText || node.textContent || "").trim();
      if (code) push(`\n\n\`\`\`\n${code}\n\`\`\`\n\n`);
      return;
    }
    if (tag === "LI") {
      const txt = inlineText(node);
      if (txt) push(`\n- ${txt}`);
      return;
    }
    if (tag === "BLOCKQUOTE") {
      const txt = inlineText(node);
      if (txt) push(`\n> ${txt}\n`);
      return;
    }
    if (tag === "TR") {
      const cells = Array.from(node.children || []).map((c) => inlineText(c).replace(/\|/g, "\\|"));
      if (cells.some(Boolean)) push(`\n| ${cells.join(" | ")} |`);
      return;
    }
    const isBlock = /^(P|DIV|SECTION|ARTICLE|MAIN|TABLE|UL|OL|BR|HR)$/u.test(tag);
    if (isBlock) push("\n");
    for (const child of node.childNodes || []) {
      walk(child);
      if (truncated) break;
    }
    if (isBlock) push("\n");
  };
  walk(root);
  const md = parts.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() + (truncated ? "\n...(truncated)" : "");
  return { title, url, format: "markdown", text: md, content: md, truncated, headingsCount, linksCount, selection };
}

/** @returns {void} */
function connect() {
  const port = chrome.runtime.connectNative(hostName);
  /** @type {Set<number>} */
  const owned = new Set();
  /** @type {Set<number>} */
  const userOwned = new Set();
  /** @type {Set<number>} */
  const attached = new Set();
  /** @type {Map<number, Map<string,{parentId:string|null,targetId:string}>>} */
  const frames = new Map();
  /** @type {Map<number, {startedAt:number}>} */
  const downloadWatchers = new Map();
  /** @type {Map<number, {id:number,url?:string,filename?:string,state?:string,error?:string}>} */
  const trackedDownloads = new Map();
  /** @type {Map<number, {cursor:null|{x:number,y:number,visible:boolean,animateMovement?:boolean,moveSequence?:number},isVisible:boolean,sessionId:string|null,turnId:string|null}>} */
  const cursorStates = new Map();
  /** @type {Map<number, "active"|"deliverable"|"handoff">} */
  const badgeStates = new Map();
  /** @type {Map<number, string>} */
  const faviconCache = new Map();
  /** @type {Map<number, Promise<boolean>>} */
  const preparingContentScripts = new Map();
  /** @type {Set<number>} */
  const contentScriptReadyTabs = new Set();
  /** @type {Map<number, () => void>} */
  const cursorArrivalWaiters = new Map();
  /** @type {number|null} */
  let activeVisualTabId = null;
  /** @type {"fast"|"smooth"|"off"} */
  let cursorMode = "fast";
  let moveSeq = 0;
  let disconnected = false;

  /**
   * @template T
   * @param {Promise<T>} promise
   * @param {number} timeoutMs
   * @returns {Promise<T|null>}
   */
  async function withTimeout(promise, timeoutMs) {
    if (typeof setTimeout !== "function") return await promise.catch(() => null);
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    try {
      return await Promise.race([promise.catch(() => null), deadline]);
    } finally {
      if (timer !== undefined && typeof clearTimeout === "function") clearTimeout(timer);
    }
  }

  /** @param {number} tabId @returns {Promise<boolean>} */
  async function pingContentScript(tabId) {
    if (!canMessageTabs()) return false;
    const res = await withTimeout(chrome.tabs.sendMessage(tabId, {type: "CONTENT_PING"}), 350);
    return res?.ok === true;
  }

  /** @param {number} tabId @returns {Promise<boolean>} */
  async function prepareContentScript(tabId) {
    if (!canMessageTabs()) return false;
    if (contentScriptReadyTabs.has(tabId)) return true;
    if (await pingContentScript(tabId)) {
      contentScriptReadyTabs.add(tabId);
      return true;
    }
    let pending = preparingContentScripts.get(tabId);
    if (!pending) {
      pending = (async () => {
        if (typeof chrome.scripting?.executeScript !== "function") return false;
        const injected = await withTimeout(
          chrome.scripting.executeScript({
            target: {tabId},
            files: ["content-script.js"],
            injectImmediately: true,
          }),
          800,
        );
        if (injected === null) return false;
        const ok = await pingContentScript(tabId);
        if (ok) contentScriptReadyTabs.add(tabId);
        return ok;
      })().finally(() => {
        preparingContentScripts.delete(tabId);
      });
      preparingContentScripts.set(tabId, pending);
    }
    return await pending;
  }

  /** @param {number} tabId @returns {Promise<string>} */
  async function getFaviconDataUrl(tabId) {
    const cached = faviconCache.get(tabId);
    if (cached) return cached;
    if (typeof chrome.tabs?.get !== "function") return FALLBACK_FAVICON_DATA_URL;
    try {
      const tab = await chrome.tabs.get(tabId);
      const rawFav = tab?.favIconUrl;
      if (typeof rawFav === "string" && rawFav && !rawFav.startsWith("chrome://") && !isBadgedFaviconUrl(rawFav)) {
        if (rawFav.startsWith("data:")) {
          faviconCache.set(tabId, rawFav);
          return rawFav;
        }
        if (typeof fetch === "function" && typeof FileReader === "function") {
          const res = await withTimeout(fetch(rawFav), 600);
          if (res?.ok) {
            const blob = await res.blob();
            const dataUrl = await new Promise((resolve) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(typeof reader.result === "string" ? reader.result : rawFav);
              reader.onerror = () => resolve(rawFav);
              reader.readAsDataURL(blob);
            });
            faviconCache.set(tabId, dataUrl);
            return dataUrl;
          }
        }
        faviconCache.set(tabId, rawFav);
        return rawFav;
      }
      if (typeof tab?.url === "string" && tab.url && typeof chrome.runtime?.getURL === "function" &&
          typeof fetch === "function" && typeof FileReader === "function") {
        const faviconUrl = chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(tab.url)}&size=32`);
        const res = await withTimeout(fetch(faviconUrl), 600);
        if (res?.ok) {
          const blob = await res.blob();
          const dataUrl = await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(typeof reader.result === "string" ? reader.result : FALLBACK_FAVICON_DATA_URL);
            reader.onerror = () => resolve(FALLBACK_FAVICON_DATA_URL);
            reader.readAsDataURL(blob);
          });
          faviconCache.set(tabId, dataUrl);
          return dataUrl;
        }
      }
    } catch {
      // Fall back to transparent 1x1 data URL so content-script always renders the badge SVG.
    }
    return FALLBACK_FAVICON_DATA_URL;
  }

  /** @param {number} tabId @param {"active"|"deliverable"|"handoff"|null} badge @returns {Promise<void>} */
  async function updateTabFaviconBadge(tabId, badge) {
    if (badge) badgeStates.set(tabId, badge);
    else badgeStates.delete(tabId);
    if (!canMessageTabs()) return;
    try {
      if (badge) {
        if (!(await prepareContentScript(tabId))) return;
        const faviconDataUrl = await getFaviconDataUrl(tabId);
        const delivered = await withTimeout(chrome.tabs.sendMessage(tabId, {
          type: "TAB_FAVICON_BADGE",
          badge,
          faviconDataUrl,
        }), 500);
        if (!delivered) contentScriptReadyTabs.delete(tabId);
      } else {
        const delivered = await withTimeout(chrome.tabs.sendMessage(tabId, {
          type: "TAB_FAVICON_BADGE",
          badge: null,
          faviconDataUrl: null,
        }), 400);
        if (!delivered) contentScriptReadyTabs.delete(tabId);
      }
    } catch {
      // Ignore pages that do not accept content scripts.
    }
  }

  /** @param {number} tabId @returns {Promise<void>} */
  async function showTabCursor(tabId) {
    if (cursorMode === "off") return;
    const existing = cursorStates.get(tabId);
    const state = {
      cursor: existing?.cursor ? {...existing.cursor, visible: true} : null,
      isVisible: true,
      sessionId: CURSOR_SESSION_ID,
      turnId: CURSOR_TURN_ID,
    };
    cursorStates.set(tabId, state);
    if (!canMessageTabs()) return;
    if (!(await prepareContentScript(tabId))) return;
    const delivered = await withTimeout(chrome.tabs.sendMessage(tabId, {type: "AGENT_CURSOR_STATE", state}), 400);
    if (!delivered) contentScriptReadyTabs.delete(tabId);
  }

  /** @param {number} tabId @returns {Promise<void>} */
  async function hideTabCursor(tabId) {
    const existing = cursorStates.get(tabId);
    const state = {
      cursor: existing?.cursor ? {...existing.cursor, visible: false} : null,
      isVisible: false,
      sessionId: null,
      turnId: null,
    };
    cursorStates.set(tabId, state);
    if (!canMessageTabs()) return;
    await withTimeout(chrome.tabs.sendMessage(tabId, {type: "AGENT_CURSOR_STATE", state}), 350);
  }

  /**
   * @param {number} tabId
   * @param {number} x
   * @param {number} y
   * @param {{visible?:boolean, animate?:boolean, waitForArrival?:boolean}} [options]
   * @returns {Promise<void>}
   */
  async function updateCursorPosition(tabId, x, y, {visible = true, animate = true, waitForArrival = false} = {}) {
    if (cursorMode === "off" || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const prev = cursorStates.get(tabId)?.cursor;
    const targetX = Math.round(x);
    const targetY = Math.round(y);
    const dist = prev && Number.isFinite(prev.x) && Number.isFinite(prev.y)
      ? Math.hypot(targetX - prev.x, targetY - prev.y)
      : 999;
    const seq = ++moveSeq;
    const state = {
      cursor: {
        x: targetX,
        y: targetY,
        visible,
        animateMovement: animate,
        moveSequence: seq,
      },
      isVisible: visible,
      sessionId: visible ? CURSOR_SESSION_ID : null,
      turnId: visible ? CURSOR_TURN_ID : null,
    };
    cursorStates.set(tabId, state);
    if (!canMessageTabs()) return;
    const effectiveWait = cursorMode === "smooth" && waitForArrival && visible && animate && dist >= 4;
    if (contentScriptReadyTabs.has(tabId) && !effectiveWait) {
      try {
        const res = chrome.tabs.sendMessage(tabId, {type: "AGENT_CURSOR_STATE", state});
        if (res && typeof res.catch === "function") {
          void res.catch(() => contentScriptReadyTabs.delete(tabId));
        }
      } catch {
        contentScriptReadyTabs.delete(tabId);
      }
      return;
    }
    if (!(await prepareContentScript(tabId))) return;

    let arrivalPromise = null;
    if (effectiveWait && typeof setTimeout === "function") {
      arrivalPromise = new Promise((resolve) => {
        const timer = setTimeout(() => {
          cursorArrivalWaiters.delete(seq);
          resolve();
        }, 180);
        cursorArrivalWaiters.set(seq, () => {
          if (typeof clearTimeout === "function") clearTimeout(timer);
          cursorArrivalWaiters.delete(seq);
          resolve();
        });
      });
    }

    const delivered = await withTimeout(chrome.tabs.sendMessage(tabId, {type: "AGENT_CURSOR_STATE", state}), 400);
    if (!delivered) contentScriptReadyTabs.delete(tabId);
    if (arrivalPromise && delivered?.ok === true) {
      await arrivalPromise;
    } else if (arrivalPromise) {
      cursorArrivalWaiters.get(seq)?.();
    }
  }

  /** @param {number} tabId @returns {Promise<void>} */
  async function syncTabVisuals(tabId) {
    if (!canMessageTabs()) return;
    if (activeVisualTabId !== null && activeVisualTabId !== tabId) {
      const prevId = activeVisualTabId;
      activeVisualTabId = tabId;
      await hideTabCursor(prevId).catch(() => {});
      if (badgeStates.get(prevId) === "active") {
        await updateTabFaviconBadge(prevId, null).catch(() => {});
      }
    } else {
      activeVisualTabId = tabId;
    }
    const badge = badgeStates.get(tabId) ?? (attached.has(tabId) ? "active" : null);
    if (badge) await updateTabFaviconBadge(tabId, badge);
    if (attached.has(tabId) && cursorMode !== "off") {
      const state = cursorStates.get(tabId);
      if (state?.isVisible) {
        if (await prepareContentScript(tabId)) {
          const delivered = await withTimeout(chrome.tabs.sendMessage(tabId, {type: "AGENT_CURSOR_STATE", state}), 400);
          if (!delivered) contentScriptReadyTabs.delete(tabId);
        }
      } else {
        await showTabCursor(tabId);
      }
    }
  }

  /** @returns {Promise<void>} */
  async function cleanupStaleVisuals() {
    if (!canMessageTabs() || typeof chrome.tabs?.query !== "function") return;
    try {
      const tabs = await chrome.tabs.query({});
      if (!Array.isArray(tabs)) return;
      await Promise.allSettled(tabs.map(async (tab) => {
        if (!Number.isSafeInteger(tab?.id) || attached.has(tab.id) || badgeStates.has(tab.id)) return;
        const candidateUrl = tab.url || tab.pendingUrl || "";
        if (!isControllableTabUrl(candidateUrl)) return;
        await withTimeout(chrome.tabs.sendMessage(tab.id, {
          type: "TAB_FAVICON_BADGE",
          badge: null,
          faviconDataUrl: null,
        }), 250);
        await withTimeout(chrome.tabs.sendMessage(tab.id, {
          type: "AGENT_CURSOR_STATE",
          state: {cursor: null, isVisible: false, sessionId: null, turnId: null},
        }), 250);
      }));
    } catch {
      // Best-effort cleanup on startup/reconnect.
    }
  }

  /** @param {any} msg @param {chrome.runtime.MessageSender} sender @param {(response?: any) => void} sendResponse */
  function onRuntimeMessage(msg, sender, sendResponse) {
    if (msg?.type === "GET_AGENT_CURSOR_STATE") {
      const tabId = sender?.tab?.id;
      const state = (Number.isSafeInteger(tabId) && cursorStates.get(tabId)) || {
        cursor: null,
        isVisible: false,
        sessionId: null,
        turnId: null,
      };
      sendResponse({ok: true, state});
      return true;
    }
    if (msg?.type === "AGENT_CURSOR_ARRIVED") {
      if (Number.isInteger(msg.moveSequence)) {
        cursorArrivalWaiters.get(msg.moveSequence)?.();
      }
      sendResponse({ok: true});
      return true;
    }
    return false;
  }

  /** @param {number} tabId @param {chrome.tabs.TabChangeInfo} changeInfo */
  function onTabUpdated(tabId, changeInfo) {
    if (disconnected) return;
    if (changeInfo?.status === "loading" || changeInfo?.url) {
      contentScriptReadyTabs.delete(tabId);
    }
    if (changeInfo?.url || (changeInfo?.favIconUrl && !isBadgedFaviconUrl(changeInfo.favIconUrl))) {
      faviconCache.delete(tabId);
    }
    if (changeInfo?.status === "complete" && (attached.has(tabId) || badgeStates.has(tabId))) {
      void syncTabVisuals(tabId);
    }
  }

  /** @param {{tabId:number}} activeInfo */
  function onTabActivated(activeInfo) {
    const tabId = activeInfo?.tabId;
    if (!Number.isSafeInteger(tabId) || attached.has(tabId)) return;
    const badge = badgeStates.get(tabId);
    if (badge === "deliverable" || badge === "handoff") {
      void updateTabFaviconBadge(tabId, null);
    }
  }

  /** @param {number} id @returns {void} */
  const forget = (id) => {
    owned.delete(id);
    userOwned.delete(id);
    attached.delete(id);
    frames.delete(id);
    downloadWatchers.delete(id);
    cursorStates.delete(id);
    badgeStates.delete(id);
    faviconCache.delete(id);
    preparingContentScripts.delete(id);
    contentScriptReadyTabs.delete(id);
  };
  /** @param {chrome.tabs.Tab} tab @returns {void} */
  function onTabCreated(tab) {
    if (disconnected || !Number.isSafeInteger(tab?.id) || !Number.isSafeInteger(tab?.openerTabId)) return;
    if (!owned.has(tab.openerTabId) || owned.has(tab.id) || tab.incognito === true) return;
    const candidateUrl = tab.url || tab.pendingUrl || "";
    if (!isControllableTabUrl(candidateUrl)) return;
    owned.add(tab.id);
    port.postMessage({
      event: "onTabCreated",
      tabId: tab.openerTabId,
      params: {openerTabId: tab.openerTabId, tab: serializeTab(tab)},
    });
  }

  chrome.tabs.onRemoved.addListener(forget);
  chrome.tabs.onCreated?.addListener(onTabCreated);
  chrome.tabs.onUpdated?.addListener(onTabUpdated);
  chrome.tabs.onActivated?.addListener(onTabActivated);
  chrome.runtime.onMessage?.addListener(onRuntimeMessage);

  /** @param {{method:string,tabId?:number,details?:{method:string,params:object,childSession?:string,url?:string,tabIds?:number[],title?:string,color?:string,groupId?:number|null,status?:string,x?:number,y?:number,waitForArrival?:boolean}}} request @returns {Promise<unknown>} */
  async function handle({method, tabId, details}) {
    if (disconnected) throw new Error("Chrome bridge is disconnected");
    if (method === "createBlankTab") {
      const tab = serializeTab(await chrome.tabs.create({url: "about:blank", active: false}));
      if (disconnected) {
        await chrome.tabs.remove(tab.id);
        throw new Error("Chrome bridge disconnected during tab creation");
      }
      owned.add(tab.id);
      return tab;
    }
    if (method === "listTabs") {
      if (typeof chrome.tabs?.query !== "function") {
        const fallback = [];
        for (const id of owned) {
          try {
            const tab = await chrome.tabs.get(id);
            if (tab) fallback.push({...serializeTab(tab), owned: true, origin: userOwned.has(id) ? "user" : "agent"});
          } catch {
            // Skip closed tabs.
          }
        }
        return fallback;
      }
      const tabs = await chrome.tabs.query({});
      const out = [];
      for (const tab of Array.isArray(tabs) ? tabs : []) {
        if (!Number.isSafeInteger(tab?.id) || tab.incognito === true) continue;
        const candidateUrl = tab.url || tab.pendingUrl || "";
        if (!isControllableTabUrl(candidateUrl)) continue;
        out.push({
          ...serializeTab(tab),
          owned: owned.has(tab.id),
          origin: userOwned.has(tab.id) ? "user" : (owned.has(tab.id) ? "agent" : "user"),
        });
      }
      return out;
    }
    if (method === "claimTab") {
      if (!Number.isSafeInteger(tabId) || typeof chrome.tabs?.get !== "function") {
        throw new Error("Chrome tab is unavailable");
      }
      const tab = await chrome.tabs.get(tabId);
      if (!tab || !Number.isSafeInteger(tab.id) || tab.incognito === true) {
        throw new Error("Chrome tab is unavailable");
      }
      const candidateUrl = tab.url || tab.pendingUrl || "";
      if (!isControllableTabUrl(candidateUrl)) {
        throw new Error("Chrome internal tab cannot be claimed");
      }
      if (!owned.has(tab.id)) {
        owned.add(tab.id);
        userOwned.add(tab.id);
      }
      return {
        ...serializeTab(tab),
        owned: true,
        origin: userOwned.has(tab.id) ? "user" : "agent",
      };
    }
    if (method === "setConfig") {
      if (details?.cursorMode === "fast" || details?.cursorMode === "smooth" || details?.cursorMode === "off") {
        cursorMode = details.cursorMode;
      }
      return {ok: true, cursorMode};
    }
    if (method === "readTabContext") {
      if (!Number.isSafeInteger(tabId) || typeof chrome.tabs?.get !== "function") {
        throw new Error("Chrome tab is unavailable");
      }
      const tab = await chrome.tabs.get(tabId);
      if (!tab || !Number.isSafeInteger(tab.id) || tab.incognito === true) {
        throw new Error("Chrome tab is unavailable");
      }
      const candidateUrl = tab.url || tab.pendingUrl || "";
      if (!isControllableTabUrl(candidateUrl)) {
        throw new Error("Chrome internal tab cannot be read");
      }
      if (typeof chrome.scripting?.executeScript !== "function") {
        throw new Error("Chrome scripting API is unavailable");
      }
      const format = details?.format === "text" ? "text" : "markdown";
      const maxChars = Number.isFinite(Number(details?.maxChars)) ? Number(details.maxChars) : 16_000;
      const results = await withTimeout(
        chrome.scripting.executeScript({
          target: {tabId: tab.id},
          func: extractPassiveTabContext,
          args: [{format, maxChars}],
        }),
        5000,
      );
      const extracted = Array.isArray(results) ? results[0]?.result : null;
      if (!extracted || typeof extracted !== "object") {
        throw new Error("Failed to extract passive tab context");
      }
      return {
        ...extracted,
        title: extracted.title || tab.title || "",
        url: extracted.url || tab.url || "",
      };
    }
    if (method === "groupTabs") {
      const tabIds = Array.isArray(details?.tabIds) ? details.tabIds : [];
      if (tabIds.length === 0 || tabIds.some((id) => !Number.isSafeInteger(id) || !owned.has(id))) {
        throw new Error("Chrome bridge can only group owned session tabs");
      }
      if (typeof chrome.tabs?.group !== "function") {
        return {groupId: null, supported: false};
      }
      const title = typeof details?.title === "string" ? details.title.trim().slice(0, 80) : "";
      const color = TAB_GROUP_COLORS.has(details?.color) ? details.color : undefined;
      const requestedGroupId = Number.isSafeInteger(details?.groupId) ? details.groupId : null;
      let groupId;
      if (requestedGroupId !== null) {
        try {
          groupId = await chrome.tabs.group({groupId: requestedGroupId, tabIds});
        } catch {
          groupId = await chrome.tabs.group({tabIds});
        }
      } else {
        groupId = await chrome.tabs.group({tabIds});
      }
      if (Number.isSafeInteger(groupId) && typeof chrome.tabGroups?.update === "function") {
        const updateProps = {};
        if (title) updateProps.title = title;
        if (color) updateProps.color = color;
        if (Object.keys(updateProps).length > 0) {
          await chrome.tabGroups.update(groupId, updateProps).catch(() => {});
        }
      }
      return {groupId: Number.isSafeInteger(groupId) ? groupId : null, supported: true};
    }
    if (!Number.isSafeInteger(tabId) || !owned.has(tabId)) {
      if (method === "readTab") return null;
      if (method === "closeTab" || method === "releaseTab" || method === "markTab" || method === "moveCursor") return null;
      throw new Error("Unknown Chrome bridge request");
    }
    switch (method) {
      case "readTab": return serializeTab(await chrome.tabs.get(tabId));
      case "closeTab":
        await chrome.tabs.remove(tabId);
        forget(tabId);
        return null;
      case "releaseTab":
        if (attached.has(tabId)) {
          await chrome.debugger.detach({tabId}).catch(() => {});
          attached.delete(tabId);
          frames.delete(tabId);
        }
        await hideTabCursor(tabId);
        if (badgeStates.get(tabId) === "active") {
          await updateTabFaviconBadge(tabId, null);
        }
        owned.delete(tabId);
        userOwned.delete(tabId);
        return null;
      case "markTab": {
        const status = details?.status === "deliverable" ? "deliverable" : (details?.status === "handoff" ? "handoff" : null);
        if (status) {
          await updateTabFaviconBadge(tabId, status);
        }
        return null;
      }
      case "moveCursor":
        if (Number.isFinite(details?.x) && Number.isFinite(details?.y)) {
          await updateCursorPosition(tabId, Number(details.x), Number(details.y), {
            visible: true,
            animate: true,
            waitForArrival: details?.waitForArrival !== false,
          });
        }
        return null;
      case "attach":
        if (!attached.has(tabId)) {
          await chrome.debugger.attach({tabId}, "1.3");
          if (disconnected || !owned.has(tabId)) {
            await chrome.debugger.detach({tabId});
            throw new Error("Chrome bridge lost the tab during debugger attachment");
          }
          attached.add(tabId);
          frames.set(tabId, new Map());
        }
        badgeStates.set(tabId, "active");
        await syncTabVisuals(tabId);
        return null;
      case "detach":
        if (attached.has(tabId)) {
          await chrome.debugger.detach({tabId});
          attached.delete(tabId);
          frames.delete(tabId);
        }
        await hideTabCursor(tabId);
        if (badgeStates.get(tabId) === "active") {
          await updateTabFaviconBadge(tabId, null);
        }
        return null;
      case "navigate":
        if (typeof details?.url !== "string") throw new Error("Chrome bridge navigation requires a URL");
        await chrome.tabs.update(tabId, {url: details.url});
        return null;
      case "watchDownloads":
        downloadWatchers.set(tabId, {startedAt: Date.now()});
        return null;
      case "unwatchDownloads":
        downloadWatchers.delete(tabId);
        return null;
      case "execute": {
        if (!attached.has(tabId)) throw new Error("Debugger unattached");
        const sessionId = details.childSession;
        if (sessionId !== undefined && !frames.get(tabId)?.has(sessionId)) {
          throw new Error("Child debugger session is unavailable to this tab");
        }
        const target = sessionId === undefined ? {tabId} : {tabId, sessionId};
        const cdpMethod = details.method;
        const cdpParams = details.params;

        if (canMessageTabs() && cursorMode !== "off") {
          if (cdpMethod === "Input.dispatchMouseEvent" && Number.isFinite(cdpParams?.x) && Number.isFinite(cdpParams?.y)) {
            if (cdpParams.type === "mouseMoved") {
              const wait = cursorMode === "smooth" && !cdpParams.buttons;
              if (wait) {
                await updateCursorPosition(tabId, Number(cdpParams.x), Number(cdpParams.y), {
                  visible: true,
                  animate: true,
                  waitForArrival: true,
                });
              } else {
                void updateCursorPosition(tabId, Number(cdpParams.x), Number(cdpParams.y), {
                  visible: true,
                  animate: true,
                  waitForArrival: false,
                });
              }
            } else if (cdpParams.type === "mousePressed" || cdpParams.type === "mouseWheel") {
              void updateCursorPosition(tabId, Number(cdpParams.x), Number(cdpParams.y), {
                visible: true,
                animate: true,
                waitForArrival: false,
              });
            }
          } else if (cdpMethod === "DOM.focus" &&
              (cdpParams?.objectId || Number.isSafeInteger(cdpParams?.backendNodeId))) {
            const boxReq = cdpParams.objectId
              ? {objectId: cdpParams.objectId}
              : {backendNodeId: cdpParams.backendNodeId};
            const box = await chrome.debugger.sendCommand(target, "DOM.getBoxModel", boxReq).catch(() => null);
            const quad = box?.model?.border;
            if (Array.isArray(quad) && quad.length === 8) {
              const cx = (quad[0] + quad[2]) / 2;
              const cy = (quad[1] + quad[5]) / 2;
              if (Number.isFinite(cx) && Number.isFinite(cy)) {
                const wait = cursorMode === "smooth";
                if (wait) {
                  await updateCursorPosition(tabId, cx, cy, {visible: true, animate: true, waitForArrival: true});
                } else {
                  void updateCursorPosition(tabId, cx, cy, {visible: true, animate: true, waitForArrival: false});
                }
              }
            }
          }
        }

        const result = await chrome.debugger.sendCommand(target, cdpMethod, cdpParams);

        if (canMessageTabs() && cursorMode !== "off" &&
            (cdpMethod === "Runtime.evaluate" || cdpMethod === "Runtime.callFunctionOn")) {
          const val = result?.result?.value;
          if (val && typeof val === "object" && Number.isFinite(val.x) && Number.isFinite(val.y) &&
              (val.__cursorMove === true || val.hovered === true)) {
            const wait = cursorMode === "smooth";
            if (wait) {
              await updateCursorPosition(tabId, Number(val.x), Number(val.y), {
                visible: true,
                animate: true,
                waitForArrival: true,
              });
            } else {
              void updateCursorPosition(tabId, Number(val.x), Number(val.y), {
                visible: true,
                animate: true,
                waitForArrival: false,
              });
            }
          }
        }
        return result;
      }
      default: throw new Error("Unknown Chrome bridge request");
    }
  }

  /** @param {Map<string,{parentId:string|null,targetId:string}>} tree @param {string} id @returns {void} */
  function dropFrame(tree, id) {
    if (!tree.delete(id)) return;
    for (const [child, frame] of tree) {
      if (frame.parentId === id) dropFrame(tree, child);
    }
  }

  /** @param {chrome.debugger.DebuggerSession} source @param {string} method @param {object} params @returns {void} */
  function onDebuggerEvent(source, method, params) {
    const {tabId, sessionId} = source;
    const tree = frames.get(tabId);
    if (disconnected || !tree || (sessionId !== undefined && !tree.has(sessionId))) return;
    if (method === "Target.attachedToTarget") {
      if (params?.targetInfo?.type !== "iframe" || typeof params.sessionId !== "string" ||
          typeof params.targetInfo.targetId !== "string") return;
      tree.set(params.sessionId, {parentId: sessionId ?? null, targetId: params.targetInfo.targetId});
    } else if (method === "Target.detachedFromTarget") {
      if (!tree.has(params?.sessionId)) return;
      dropFrame(tree, params.sessionId);
    } else if (!/^(?:Page|Runtime|DOM)\./u.test(method) &&
        !["Accessibility.loadComplete", "Accessibility.nodesUpdated",
          "Network.requestWillBeSent", "Network.responseReceived",
          "Network.loadingFinished", "Network.loadingFailed"].includes(method)) {
      return;
    }
    if (sessionId === undefined && (method === "Page.frameStartedLoading" ||
        (method === "Page.frameNavigated" && !params?.frame?.parentId))) {
      contentScriptReadyTabs.delete(tabId);
    }
    if (method === "Page.loadEventFired" && sessionId === undefined && attached.has(tabId)) {
      void syncTabVisuals(tabId);
    }
    if (method === "Page.frameDetached" && params?.reason === "swap") {
      // The renderer lost its local frame. A debugger session for the same
      // frame is already attached, and will signal its own detach separately.
      for (const frame of tree.values()) {
        if (frame.parentId === (sessionId ?? null) && frame.targetId === params.frameId) return;
      }
    }
    let outgoingParams = params;
    if (method === "Network.requestWillBeSent") {
      outgoingParams = {
        requestId: params?.requestId,
        loaderId: params?.loaderId,
        documentURL: params?.documentURL,
        frameId: params?.frameId,
        type: params?.type,
        timestamp: params?.timestamp,
        request: params?.request ? {url: params.request.url, method: params.request.method} : undefined,
      };
    } else if (method === "Network.responseReceived") {
      outgoingParams = {
        requestId: params?.requestId,
        loaderId: params?.loaderId,
        frameId: params?.frameId,
        type: params?.type,
        timestamp: params?.timestamp,
        response: params?.response ? {
          url: params.response.url,
          status: params.response.status,
          statusText: params.response.statusText,
          mimeType: params.response.mimeType,
          fromDiskCache: params.response.fromDiskCache,
          fromServiceWorker: params.response.fromServiceWorker,
        } : undefined,
      };
    }
    const event = {event: "onCDPEvent", tabId, params: {source: {tabId, sessionId}, method, params: outgoingParams}};
    if (COMPACT_EVENTS.has(method) || JSON.stringify(event).length < 256 * 1024) {
      port.postMessage(event);
    }
  }

  /** @param {string} method @param {{id:number,url?:string,filename?:string,state?:string,error?:string}} payload @returns {void} */
  function emitDownloadEvent(method, payload) {
    if (disconnected || downloadWatchers.size === 0) return;
    for (const tabId of downloadWatchers.keys()) {
      if (!owned.has(tabId)) continue;
      port.postMessage({
        event: "onCDPEvent",
        tabId,
        params: {source: {tabId}, method, params: payload},
      });
    }
  }

  /** @param {chrome.downloads.DownloadItem} item @returns {void} */
  function onDownloadCreated(item) {
    if (disconnected || downloadWatchers.size === 0 || !Number.isSafeInteger(item?.id)) return;
    const entry = {
      id: item.id,
      url: item.finalUrl || item.url || undefined,
      filename: item.filename || undefined,
      state: item.state || "in_progress",
      error: item.error || undefined,
    };
    if (entry.state === "complete" || entry.state === "interrupted") {
      trackedDownloads.delete(item.id);
    } else {
      trackedDownloads.set(item.id, entry);
    }
    emitDownloadEvent("Bridge.downloadCreated", entry);
  }

  /** @param {chrome.downloads.DownloadDelta} delta @returns {void} */
  function onDownloadChanged(delta) {
    if (disconnected || downloadWatchers.size === 0 || !Number.isSafeInteger(delta?.id)) return;
    const existing = trackedDownloads.get(delta.id);
    if (!existing) return;
    const updated = {
      id: delta.id,
      url: delta.url?.current ?? existing.url,
      filename: delta.filename?.current ?? existing.filename,
      state: delta.state?.current ?? existing.state,
      error: delta.error?.current ?? existing.error,
    };
    if (updated.state === "complete" || updated.state === "interrupted") {
      trackedDownloads.delete(delta.id);
    } else {
      trackedDownloads.set(delta.id, updated);
    }
    emitDownloadEvent("Bridge.downloadChanged", updated);
  }

  /** @param {chrome.debugger.Debuggee} source @param {string} reason @returns {void} */
  function onDebuggerDetach(source, reason) {
    frames.delete(source.tabId);
    if (Number.isSafeInteger(source.tabId)) {
      if (activeVisualTabId === source.tabId) activeVisualTabId = null;
      void hideTabCursor(source.tabId);
      if (badgeStates.get(source.tabId) === "active") {
        void updateTabFaviconBadge(source.tabId, null);
      }
      if (reason === "canceled_by_user" && userOwned.has(source.tabId)) {
        owned.delete(source.tabId);
        userOwned.delete(source.tabId);
      }
    }
    if (!attached.delete(source.tabId) || disconnected) return;
    port.postMessage({event: "onCDPDetach", tabId: source.tabId, params: {tabId: source.tabId, reason}});
  }

  chrome.debugger.onEvent.addListener(onDebuggerEvent);
  chrome.debugger.onDetach.addListener(onDebuggerDetach);
  chrome.downloads?.onCreated?.addListener(onDownloadCreated);
  chrome.downloads?.onChanged?.addListener(onDownloadChanged);

  /** @returns {void} */
  function onDisconnect() {
    if (disconnected) return;
    disconnected = true;
    const error = chrome.runtime.lastError?.message;
    if (error) console.warn("Portable Browser Bridge:", error);
    disconnectActive = null;
    void chrome.action.setBadgeText({text: manualDisconnect ? "OFF" : ""});
    void chrome.action.setTitle?.({title: "Portable Browser Bridge (Disconnected — click to connect)"});
    chrome.tabs.onRemoved.removeListener(forget);
    chrome.tabs.onCreated?.removeListener(onTabCreated);
    chrome.tabs.onUpdated?.removeListener(onTabUpdated);
    chrome.tabs.onActivated?.removeListener(onTabActivated);
    chrome.runtime.onMessage?.removeListener(onRuntimeMessage);
    chrome.debugger.onEvent.removeListener(onDebuggerEvent);
    chrome.debugger.onDetach.removeListener(onDebuggerDetach);
    chrome.downloads?.onCreated?.removeListener(onDownloadCreated);
    chrome.downloads?.onChanged?.removeListener(onDownloadChanged);
    downloadWatchers.clear();
    trackedDownloads.clear();
    for (const waiter of cursorArrivalWaiters.values()) waiter();
    cursorArrivalWaiters.clear();
    const closing = [...owned].filter((id) => !userOwned.has(id));
    const releasing = [...userOwned];
    const currentlyAttached = [...attached];
    owned.clear();
    userOwned.clear();
    attached.clear();
    frames.clear();
    for (const id of releasing) {
      if (currentlyAttached.includes(id)) {
        void chrome.debugger.detach({tabId: id}).catch(() => {});
      }
      void hideTabCursor(id);
      void updateTabFaviconBadge(id, null);
    }
    cursorStates.clear();
    badgeStates.clear();
    faviconCache.clear();
    preparingContentScripts.clear();
    contentScriptReadyTabs.clear();
    void Promise.allSettled(closing.map((id) => chrome.tabs.remove(id))).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") console.warn("Portable Browser Bridge tab cleanup:", result.reason);
      }
    });
    if (!manualDisconnect && chrome.runtime?.id && typeof setTimeout === "function" && reconnectAttempts < 5) {
      const delayMs = Math.min(10_000, 1_500 * (2 ** reconnectAttempts));
      reconnectAttempts += 1;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!disconnectActive && !manualDisconnect) connect();
      }, delayMs);
    }
  }

  port.onMessage.addListener(async (request) => {
    if (!Number.isSafeInteger(request?.id)) return;
    reconnectAttempts = 0;
    let reply;
    try { reply = {id: request.id, ok: true, value: await handle(request)}; }
    catch (error) { reply = {id: request.id, ok: false, error: error.message}; }
    if (disconnected) return;
    const val = reply.value;
    if (!reply.ok || val === null || val === undefined || typeof val === "boolean" || typeof val === "number") {
      port.postMessage(reply);
      return;
    }
    const serialized = JSON.stringify(val);
    const size = 512 * 1024;
    if (serialized.length <= size) port.postMessage(reply);
    else if (serialized.length > size * 64) {
      port.postMessage({id: reply.id, ok: false, error: "Chrome native response exceeds bridge limit"});
    } else {
      for (let offset = 0; offset < serialized.length; offset += size) {
        port.postMessage({id: reply.id, index: offset / size, final: offset + size >= serialized.length,
          chunk: serialized.slice(offset, offset + size)});
      }
    }
  });
  port.onDisconnect.addListener(onDisconnect);
  disconnectActive = () => {
    onDisconnect();
    port.disconnect();
  };
  void chrome.action.setBadgeText({text: ""});
  void chrome.action.setTitle?.({title: "Portable Browser Bridge (Connected)"});
  void cleanupStaleVisuals();
}

chrome.action.onClicked.addListener(() => {
  if (disconnectActive) {
    manualDisconnect = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    disconnectActive();
  } else {
    manualDisconnect = false;
    reconnectAttempts = 0;
    connect();
  }
});

const autoConnect = () => {
  if (!disconnectActive && !manualDisconnect) {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    connect();
  }
};

const resetAndAutoConnect = () => {
  manualDisconnect = false;
  reconnectAttempts = 0;
  autoConnect();
};

chrome.runtime.onInstalled?.addListener(resetAndAutoConnect);
chrome.runtime.onStartup?.addListener(resetAndAutoConnect);
if (chrome.runtime?.id) autoConnect();
