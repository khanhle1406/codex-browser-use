const hostName = "com.portable_browser_use.bridge";
const TAB_GROUP_COLORS = new Set(["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]);
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
  /** @type {Map<number, {startedAt:number}>} */
  const downloadWatchers = new Map();
  /** @type {Map<number, {id:number,url?:string,filename?:string,state?:string,error?:string}>} */
  const trackedDownloads = new Map();
  let disconnected = false;

  /** @param {number} id @returns {void} */
  const forget = (id) => {
    owned.delete(id);
    attached.delete(id);
    frames.delete(id);
    downloadWatchers.delete(id);
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
    } else if (!/^(?:Page|Runtime|DOM)\./u.test(method) &&
        !["Accessibility.loadComplete", "Accessibility.nodesUpdated",
          "Network.requestWillBeSent", "Network.responseReceived",
          "Network.loadingFinished", "Network.loadingFailed"].includes(method)) {
      return;
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
    void chrome.action.setBadgeText({text: ""});
    chrome.tabs.onRemoved.removeListener(forget);
    chrome.debugger.onEvent.removeListener(onDebuggerEvent);
    chrome.debugger.onDetach.removeListener(onDebuggerDetach);
    chrome.downloads?.onCreated?.removeListener(onDownloadCreated);
    chrome.downloads?.onChanged?.removeListener(onDownloadChanged);
    downloadWatchers.clear();
    trackedDownloads.clear();
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
  void chrome.action.setBadgeText({text: "ON"});
}

chrome.action.onClicked.addListener(() => {
  if (disconnectActive) disconnectActive();
  else connect();
});

const autoConnect = () => {
  if (!disconnectActive) connect();
};

chrome.runtime.onInstalled?.addListener(autoConnect);
chrome.runtime.onStartup?.addListener(autoConnect);
