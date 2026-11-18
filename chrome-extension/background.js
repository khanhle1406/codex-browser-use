const HOST_NAME = "com.antigravity.browserhost";
let nativePort = null;
const attachedTabs = new Set();
const cursorStates = new Map(); // tabId -> state
let moveSeq = 0;

function connectNative() {
  try {
    nativePort = chrome.runtime.connectNative(HOST_NAME);
    console.log("[Antigravity Extension] Connected to native host:", HOST_NAME);

    nativePort.onMessage.addListener(async (msg) => {
      try {
        await handleMessage(msg);
      } catch (err) {
        if (msg.id) {
          sendResponse(msg.id, null, err.message);
        }
      }
    });

    nativePort.onDisconnect.addListener(() => {
      console.warn("[Antigravity Extension] Disconnected from native host:", chrome.runtime.lastError?.message);
      nativePort = null;
      setTimeout(connectNative, 3000);
    });
  } catch (err) {
    console.error("[Antigravity Extension] Failed to connect native host:", err);
    setTimeout(connectNative, 3000);
  }
}

function sendResponse(id, result, error = null) {
  if (nativePort) {
    nativePort.postMessage({ id, result, error });
  }
}

async function ensureAttached(tabId) {
  if (!attachedTabs.has(tabId)) {
    await chrome.debugger.attach({ tabId }, "1.3");
    attachedTabs.add(tabId);
  }
}

async function getFaviconDataUrl(tab) {
  if (!tab || !tab.url) return null;
  if (tab.favIconUrl && !tab.favIconUrl.startsWith("chrome://")) {
    try {
      const res = await fetch(tab.favIconUrl);
      if (res.ok) {
        const blob = await res.blob();
        return await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = () => resolve(tab.favIconUrl);
          reader.readAsDataURL(blob);
        });
      }
    } catch {}
    return tab.favIconUrl;
  }
  try {
    const faviconUrl = chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(tab.url)}&size=32`);
    const res = await fetch(faviconUrl);
    if (res.ok) {
      const blob = await res.blob();
      return await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    }
  } catch {}
  return null;
}

async function updateTabFaviconBadge(tabId, badge) {
  try {
    if (badge) {
      const tab = await chrome.tabs.get(tabId);
      const faviconDataUrl = await getFaviconDataUrl(tab);
      await chrome.tabs.sendMessage(tabId, {
        type: "TAB_FAVICON_BADGE",
        badge: "active",
        faviconDataUrl,
      });
    } else {
      await chrome.tabs.sendMessage(tabId, {
        type: "TAB_FAVICON_BADGE",
        badge: null,
        faviconDataUrl: null,
      });
    }
  } catch (err) {
    // Tab might be chrome:// or content script not ready
  }
}

async function updateCursorState(tabId, x, y, visible = true) {
  moveSeq += 1;
  const state = {
    cursor: {
      x,
      y,
      visible,
      animateMovement: true,
      moveSequence: moveSeq,
    },
    isVisible: visible,
    sessionId: "antigravity-session",
    turnId: "turn-1",
  };
  cursorStates.set(tabId, state);
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "AGENT_CURSOR_STATE",
      state,
    });
  } catch {}
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) {
    attachedTabs.delete(source.tabId);
    updateTabFaviconBadge(source.tabId, null);
    updateCursorState(source.tabId, 0, 0, false);
    if (nativePort) {
      nativePort.postMessage({
        event: "debugger_detached",
        tabId: source.tabId,
      });
    }
  }
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (nativePort) {
    nativePort.postMessage({
      event: "cdp_event",
      tabId: source.tabId,
      method,
      params,
    });
  }
});

// Listen to content script queries
chrome.runtime.onMessage.addListener((msg, sender, sendResponseCallback) => {
  if (msg?.type === "GET_AGENT_CURSOR_STATE") {
    const tabId = sender.tab?.id;
    const state = (tabId && cursorStates.get(tabId)) || {
      cursor: null,
      isVisible: false,
      sessionId: null,
      turnId: null,
    };
    sendResponseCallback({ ok: true, state });
    return true;
  }
  if (msg?.type === "AGENT_CURSOR_ARRIVED") {
    sendResponseCallback({ ok: true });
    return true;
  }
  return false;
});

async function handleMessage(msg) {
  const { id, method, params = {} } = msg;

  switch (method) {
    case "list_tabs": {
      const tabs = await chrome.tabs.query({});
      const list = tabs.map((t) => ({
        tabId: t.id,
        title: t.title || "",
        url: t.url || "",
        active: !!t.active,
        windowId: t.windowId,
        attached: attachedTabs.has(t.id),
      }));
      sendResponse(id, list);
      break;
    }

    case "new_tab": {
      const tab = await chrome.tabs.create({ url: params.url || "about:blank" });
      sendResponse(id, {
        tabId: tab.id,
        title: tab.title || "",
        url: tab.url || "",
        windowId: tab.windowId,
      });
      break;
    }

    case "select_tab": {
      const tab = await chrome.tabs.update(params.tabId, { active: true });
      if (tab.windowId) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      sendResponse(id, { tabId: tab.id, success: true });
      break;
    }

    case "close_tab": {
      await chrome.tabs.remove(params.tabId);
      sendResponse(id, { tabId: params.tabId, closed: true });
      break;
    }

    case "attach_debugger": {
      await ensureAttached(params.tabId);
      await updateTabFaviconBadge(params.tabId, "active");
      await updateCursorState(params.tabId, 500, 300, true);
      sendResponse(id, { tabId: params.tabId, attached: true });
      break;
    }

    case "detach_debugger": {
      if (attachedTabs.has(params.tabId)) {
        await chrome.debugger.detach({ tabId: params.tabId });
        attachedTabs.delete(params.tabId);
      }
      await updateTabFaviconBadge(params.tabId, null);
      await updateCursorState(params.tabId, 0, 0, false);
      sendResponse(id, { tabId: params.tabId, detached: true });
      break;
    }

    case "move_mouse": {
      const { tabId, x, y } = params;
      await updateCursorState(tabId, x, y, true);
      sendResponse(id, { tabId, moved: true, x, y });
      break;
    }

    case "send_cdp": {
      await ensureAttached(params.tabId);
      const result = await chrome.debugger.sendCommand(
        { tabId: params.tabId },
        params.cdpMethod,
        params.cdpParams || {}
      );
      sendResponse(id, result);
      break;
    }

    default:
      sendResponse(id, null, `Unknown extension method: ${method}`);
  }
}

connectNative();
