const hostName = "com.portable_browser_use.bridge";
/** @type {(() => void) | null} */
let disconnectActive = null;

/** @param {chrome.tabs.Tab} tab @returns {{id:number,url?:string,title?:string,active:boolean}} */
function serializeTab(tab) {
  if (!Number.isSafeInteger(tab.id)) throw new Error("Chrome returned a tab without an ID");
  return {id: tab.id, url: tab.url, title: tab.title, active: tab.active};
}

/** @returns {void} */
function connect() {
  const port = chrome.runtime.connectNative(hostName);
  /** @type {Set<number>} */
  const owned = new Set();
  /** @type {Set<number>} */
  const attached = new Set();
  /** @type {Map<number, Map<string,{parentId:string|null,targetId:string}>>} */
  const frames = new Map();
  let disconnected = false;

  /** @param {number} id @returns {void} */
  const forget = (id) => {
    owned.delete(id);
    attached.delete(id);
    frames.delete(id);
  };
  chrome.tabs.onRemoved.addListener(forget);

  /** @param {{method:string,tabId?:number,details?:{method:string,params:object,childSession?:string}}} request @returns {Promise<unknown>} */
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
    if (!Number.isSafeInteger(tabId) || !owned.has(tabId)) {
      if (method === "readTab") return null;
      if (method === "closeTab" || method === "releaseTab") return null;
      throw new Error("Unknown Chrome bridge request");
    }
    switch (method) {
      case "readTab": return serializeTab(await chrome.tabs.get(tabId));
      case "closeTab":
        await chrome.tabs.remove(tabId);
        owned.delete(tabId);
        return null;
      case "releaseTab":
        if (attached.has(tabId)) {
          await chrome.debugger.detach({tabId});
          attached.delete(tabId);
          frames.delete(tabId);
        }
        owned.delete(tabId);
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
        return null;
      case "detach":
        if (attached.has(tabId)) {
          await chrome.debugger.detach({tabId});
          attached.delete(tabId);
          frames.delete(tabId);
        }
        return null;
      case "navigate":
        if (typeof details?.url !== "string") throw new Error("Chrome bridge navigation requires a URL");
        await chrome.tabs.update(tabId, {url: details.url});
        return null;
      case "execute": {
        if (!attached.has(tabId)) throw new Error("Debugger unattached");
        const sessionId = details.childSession;
        if (sessionId !== undefined && !frames.get(tabId)?.has(sessionId)) {
          throw new Error("Child debugger session is unavailable to this tab");
        }
        const target = sessionId === undefined ? {tabId} : {tabId, sessionId};
        return await chrome.debugger.sendCommand(target, details.method, details.params);
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
    } else if (!/^(?:Page|Runtime|DOM)\./u.test(method)) return;
    if (method === "Page.frameDetached" && params?.reason === "swap") {
      // The renderer lost its local frame. A debugger session for the same
      // frame is already attached, and will signal its own detach separately.
      for (const frame of tree.values()) {
        if (frame.parentId === (sessionId ?? null) && frame.targetId === params.frameId) return;
      }
    }
    const event = {event: "onCDPEvent", tabId, params: {source: {tabId, sessionId}, method, params}};
    if (JSON.stringify(event).length < 128 * 1024) port.postMessage(event);
  }

  /** @param {chrome.debugger.Debuggee} source @param {string} reason @returns {void} */
  function onDebuggerDetach(source, reason) {
    frames.delete(source.tabId);
    if (!attached.delete(source.tabId) || disconnected) return;
    port.postMessage({event: "onCDPDetach", tabId: source.tabId, params: {tabId: source.tabId, reason}});
  }

  chrome.debugger.onEvent.addListener(onDebuggerEvent);
  chrome.debugger.onDetach.addListener(onDebuggerDetach);

  /** @returns {void} */
  function onDisconnect() {
    if (disconnected) return;
    disconnected = true;
    const error = chrome.runtime.lastError?.message;
    if (error) console.warn("Portable Browser Bridge:", error);
    disconnectActive = null;
    void chrome.action.setBadgeText({text: ""});
    chrome.tabs.onRemoved.removeListener(forget);
    chrome.debugger.onEvent.removeListener(onDebuggerEvent);
    chrome.debugger.onDetach.removeListener(onDebuggerDetach);
    const closing = [...owned];
    owned.clear();
    attached.clear();
    frames.clear();
    void Promise.allSettled(closing.map((id) => chrome.tabs.remove(id))).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") console.warn("Portable Browser Bridge tab cleanup:", result.reason);
      }
    });
  }

  port.onMessage.addListener(async (request) => {
    if (!Number.isSafeInteger(request?.id)) return;
    let reply;
    try { reply = {id: request.id, ok: true, value: await handle(request)}; }
    catch (error) { reply = {id: request.id, ok: false, error: error.message}; }
    if (disconnected) return;
    const serialized = JSON.stringify(reply.value ?? null);
    const size = 128 * 1024;
    if (!reply.ok || serialized.length <= size) port.postMessage(reply);
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
  void chrome.action.setBadgeText({text: "ON"});
}

chrome.action.onClicked.addListener(() => {
  if (disconnectActive) disconnectActive();
  else connect();
});
