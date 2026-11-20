import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import {runInNewContext} from "node:vm";

/** @returns {{addListener:(listener:Function)=>void,removeListener:(listener:Function)=>void,emit:(...args:unknown[])=>Promise<unknown[]>}} */
function event() {
  const listeners = new Set();
  return {
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    async emit(...args) { return await Promise.all([...listeners].map((listener) => listener(...args))); },
  };
}

test("extension forwards iframe commands only in the owning Chrome debugger tree", async () => {
  const onEvent = event();
  const onMessage = event();
  const onClicked = event();
  const onDownloadCreated = event();
  const onDownloadChanged = event();
  const replies = [];
  const groupedCalls = [];
  const groupUpdates = [];
  let staleGroupId = false;
  let nextTab = 1;
  let nextRequest = 1;
  const port = {onMessage, onDisconnect: event(), postMessage: (reply) => replies.push(reply)};
  const chrome = {
    runtime: {connectNative: () => port},
    tabs: {
      onRemoved: event(),
      async create() { return {id: nextTab++}; },
      async group(opts) {
        groupedCalls.push({
          ...(opts.groupId !== undefined ? {groupId: opts.groupId} : {}),
          tabIds: [...opts.tabIds],
        });
        if (staleGroupId && opts.groupId === 77) throw new Error("No group with id: 77");
        return opts.groupId ?? (staleGroupId ? 88 : 77);
      },
    },
    tabGroups: {
      async update(groupId, props) {
        groupUpdates.push({groupId, ...props});
        return {id: groupId, ...props};
      },
    },
    action: {onClicked, async setBadgeText() {}},
    downloads: {onCreated: onDownloadCreated, onChanged: onDownloadChanged},
    debugger: {
      onEvent,
      onDetach: event(),
      async attach() {},
      /** @param {{tabId:number, sessionId?:string}} target @returns {Promise<string|undefined>} */
      async sendCommand(target) { return target.sessionId; },
    },
  };
  const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
  runInNewContext(source, {chrome, console});
  await onClicked.emit();
  /** @param {object} args @returns {Promise<{ok:boolean, value?:unknown, error?:string}>} */
  async function request(args) {
    const id = nextRequest++;
    await onMessage.emit({id, ...args});
    return replies.find((reply) => reply.id === id);
  }
  for (const tabId of [1, 2]) {
    assert.equal((await request({method: "createBlankTab"})).value.id, tabId);
    assert.equal((await request({method: "attach", tabId})).ok, true);
  }
  await onEvent.emit({tabId: 1}, "Target.attachedToTarget", {sessionId: "frame-root", targetInfo: {type: "iframe", targetId: "root"}});
  await onEvent.emit({tabId: 1, sessionId: "frame-root"}, "Target.attachedToTarget", {sessionId: "frame-child", targetInfo: {type: "iframe", targetId: "child"}});
  await onEvent.emit({tabId: 1}, "Target.attachedToTarget", {sessionId: "worker", targetInfo: {type: "worker", targetId: "worker"}});
  await onEvent.emit({tabId: 1}, "Page.frameDetached", {frameId: "root", reason: "swap"});
  assert.equal(replies.some((reply) => reply.params?.method === "Page.frameDetached"), false);
  await onEvent.emit({tabId: 1}, "Page.frameDetached", {frameId: "root", reason: "remove"});
  assert.equal(replies.some((reply) => reply.params?.method === "Page.frameDetached"), true);
  await onEvent.emit({tabId: 1}, "Accessibility.nodesUpdated", {nodes: []});
  await onEvent.emit({tabId: 1}, "Network.requestWillBeSent", {
    requestId: "req-1",
    request: {url: "https://api.example.com/data", method: "POST", headers: {Cookie: "secret=1"}},
  });
  await onEvent.emit({tabId: 1}, "Network.responseReceived", {
    requestId: "req-1",
    type: "Fetch",
    response: {url: "https://api.example.com/data", status: 200, mimeType: "application/json", headers: {"Set-Cookie": "s=1"}},
  });
  await onEvent.emit({tabId: 1}, "Network.dataReceived", {requestId: "req-1"});
  assert.equal(replies.some((reply) => reply.params?.method === "Accessibility.nodesUpdated"), true);
  const reqEv = replies.find((reply) => reply.params?.method === "Network.requestWillBeSent");
  assert.equal(reqEv.params.params.request.url, "https://api.example.com/data");
  assert.equal("headers" in reqEv.params.params.request, false);
  const respEv = replies.find((reply) => reply.params?.method === "Network.responseReceived");
  assert.equal(respEv.params.params.response.status, 200);
  assert.equal("headers" in respEv.params.params.response, false);
  assert.equal(replies.some((reply) => reply.params?.method === "Network.dataReceived"), false);

  // Downloads only forward while watched for an owned tab
  await onDownloadCreated.emit({id: 50, url: "https://example.com/ignored.zip", state: "in_progress"});
  assert.equal(replies.some((reply) => reply.params?.method === "Bridge.downloadCreated"), false);
  assert.equal((await request({method: "watchDownloads", tabId: 1})).ok, true);
  await onDownloadCreated.emit({id: 51, url: "https://example.com/report.csv", state: "in_progress"});
  await onDownloadChanged.emit({id: 51, filename: {current: "/tmp/report.csv"}, state: {current: "complete"}});
  assert.equal(replies.some((reply) => reply.params?.method === "Bridge.downloadCreated" && reply.tabId === 1), true);
  const changed = replies.find((reply) => reply.params?.method === "Bridge.downloadChanged");
  assert.equal(changed.params.params.filename, "/tmp/report.csv");
  assert.equal((await request({method: "unwatchDownloads", tabId: 1})).ok, true);
  await onDownloadCreated.emit({id: 52, url: "https://example.com/after.zip", state: "in_progress"});
  assert.equal(replies.some((reply) => reply.params?.params?.id === 52), false);

  // Tab group naming: groups owned tabs, updates title/color, recovers from stale groupId, and rejects foreign tab 99
  const grp1 = await request({method: "groupTabs", details: {tabIds: [1, 2], title: "Research", color: "purple"}});
  assert.equal(grp1.ok, true);
  assert.equal(grp1.value.groupId, 77);
  assert.equal(grp1.value.supported, true);
  assert.deepEqual(groupedCalls.at(-1), {tabIds: [1, 2]});
  assert.deepEqual(groupUpdates.at(-1), {groupId: 77, title: "Research", color: "purple"});

  staleGroupId = true;
  const grp2 = await request({method: "groupTabs", details: {tabIds: [1], groupId: 77, title: "Recovered", color: "green"}});
  assert.equal(grp2.ok, true);
  assert.equal(grp2.value.groupId, 88);
  assert.deepEqual(groupUpdates.at(-1), {groupId: 88, title: "Recovered", color: "green"});

  const foreignGrp = await request({method: "groupTabs", details: {tabIds: [1, 99], title: "Leak"}});
  assert.equal(foreignGrp.ok, false);
  assert.match(foreignGrp.error, /owned session tabs/);
  /** @param {number} tabId @param {string} childSession @returns {Promise<{ok:boolean, value?:unknown, error?:string}>} */
  const execute = (tabId, childSession) => request({method: "execute", tabId, details: {
    method: "Runtime.evaluate", params: {expression: "1 + 1"}, childSession,
  }});
  assert.equal((await execute(1, "frame-child")).value, "frame-child");
  assert.match((await execute(2, "frame-child")).error, /unavailable/);
  assert.match((await execute(1, "worker")).error, /unavailable/);
  await onEvent.emit({tabId: 1}, "Target.detachedFromTarget", {sessionId: "frame-root"});
  assert.match((await execute(1, "frame-child")).error, /unavailable/);
});

test("extension forwards compact CDP events and chunks large replies at 512KB", async () => {
  const onEvent = event();
  const onMessage = event();
  const onClicked = event();
  const sent = [];
  let nextTab = 1;
  let nextReq = 1;
  const chrome = {
    runtime: {connectNative: () => ({onMessage, onDisconnect: event(), postMessage: (msg) => sent.push(msg)})},
    tabs: {onRemoved: event(), async create() { return {id: nextTab++}; }},
    action: {onClicked, async setBadgeText() {}},
    downloads: {onCreated: event(), onChanged: event()},
    debugger: {
      onEvent,
      onDetach: event(),
      async attach() {},
      async sendCommand(_target, method) {
        if (method === "Page.medium") return {data: "M".repeat(300_000)};
        if (method === "Page.large") return {data: "L".repeat(600_000)};
        return {};
      },
    },
  };
  const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
  runInNewContext(source, {chrome, console});
  await onClicked.emit();

  await onMessage.emit({id: nextReq++, method: "createBlankTab"});
  await onMessage.emit({id: nextReq++, method: "attach", tabId: 1});
  await onEvent.emit({tabId: 1}, "Page.loadEventFired", {timestamp: 1});
  assert.equal(sent.some((m) => m.event === "onCDPEvent" && m.params?.method === "Page.loadEventFired"), true);

  sent.length = 0;
  const medId = nextReq++;
  await onMessage.emit({id: medId, method: "execute", tabId: 1, details: {method: "Page.medium", params: {}}});
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, medId);
  assert.equal(sent[0].ok, true);
  assert.equal(sent[0].value.data.length, 300_000);

  sent.length = 0;
  const bigId = nextReq++;
  await onMessage.emit({id: bigId, method: "execute", tabId: 1, details: {method: "Page.large", params: {}}});
  assert.equal(sent.length, 2);
  assert.equal(sent[0].index, 0);
  assert.equal(sent[0].final, false);
  assert.equal(sent[1].index, 1);
  assert.equal(sent[1].final, true);
  assert.equal(JSON.parse(sent[0].chunk + sent[1].chunk).data.length, 600_000);
});

test("extension auto-connects on service worker wake-up and skips reconnect after manual disconnect", async () => {
  const onEvent = event();
  const onMessage = event();
  const onDisconnect = event();
  const onClicked = event();
  const onInstalled = event();
  const onStartup = event();
  let connectCount = 0;
  let disconnectCalls = 0;
  const chrome = {
    runtime: {
      id: "ehooacpcolldccnemjebdnmfgmgekghn",
      onInstalled,
      onStartup,
      connectNative() {
        connectCount += 1;
        return {
          onMessage,
          onDisconnect,
          postMessage() {},
          disconnect() { disconnectCalls += 1; },
        };
      },
    },
    tabs: { onRemoved: event() },
    action: { onClicked, async setBadgeText() {} },
    downloads: { onCreated: event(), onChanged: event() },
    debugger: { onEvent, onDetach: event() },
  };
  const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
  runInNewContext(source, { chrome, console, setTimeout, clearTimeout });
  assert.equal(connectCount, 1);

  // Manual click disconnects and prevents auto-reconnect
  await onClicked.emit();
  assert.equal(disconnectCalls, 1);
  await onClicked.emit();
  assert.equal(connectCount, 2);

  // Startup / Installed hooks are idempotent while connected
  await onInstalled.emit();
  await onStartup.emit();
  assert.equal(connectCount, 2);
});

test("extension lists and claims existing user tabs, renders virtual cursor and favicon badges, and preserves user tabs on disconnect", async () => {
  const onEvent = event();
  const onMessage = event();
  const onDisconnect = event();
  const onClicked = event();
  const onRuntimeMessage = event();
  const replies = [];
  const tabMessages = [];
  const removedTabs = [];
  const detachedTabs = [];
  const scriptsInjected = [];
  const debuggerAttached = [];
  let boxModelCalls = 0;
  let pingReady = false;
  let nextReq = 1;

  const openTabs = new Map([
    [10, { id: 10, url: "https://congnghieptot.vn/new_admin/addnew_group/132", title: "Admin Form", active: true }],
    [11, { id: 11, url: "chrome://extensions", title: "Extensions", active: false }],
    [12, { id: 12, url: "https://secret.example", title: "Incognito", active: false, incognito: true }],
    [13, { id: 13, url: "https://docs.example/guide", title: "Docs Tab", active: false }],
  ]);

  const port = {
    onMessage,
    onDisconnect,
    postMessage: (msg) => replies.push(msg),
    disconnect() {},
  };

  const tabsCreated = event();
  const chrome = {
    runtime: {
      connectNative: () => port,
      onMessage: onRuntimeMessage,
      getURL: (p) => `chrome-extension://ehooacpcolldccnemjebdnmfgmgekghn/${p}`,
    },
    tabs: {
      onRemoved: event(),
      onCreated: tabsCreated,
      onUpdated: event(),
      onActivated: event(),
      async create(opts) {
        const t = { id: 20, url: opts.url || "about:blank", title: "New Tab", active: false };
        openTabs.set(t.id, t);
        return t;
      },
      async query() {
        return [...openTabs.values()];
      },
      async get(id) {
        return openTabs.get(id) ?? null;
      },
      async remove(id) {
        removedTabs.push(id);
        openTabs.delete(id);
      },
      async sendMessage(tabId, msg) {
        tabMessages.push({ tabId, msg });
        if (msg?.type === "CONTENT_PING") {
          return pingReady ? { ok: true } : null;
        }
        return { ok: true };
      },
    },
    scripting: {
      async executeScript(opts) {
        scriptsInjected.push(opts);
        if (typeof opts.func === "function") {
          return [{ result: { title: "Docs Tab", url: "https://docs.example/guide", format: opts.args?.[0]?.format || "markdown", text: "# Guide", content: "# Guide", truncated: false, headingsCount: 1, linksCount: 0, selection: "" } }];
        }
        pingReady = true;
        return [{ result: true }];
      },
    },
    action: { onClicked, async setBadgeText() {}, async setTitle() {} },
    downloads: { onCreated: event(), onChanged: event() },
    debugger: {
      onEvent,
      onDetach: event(),
      async attach({ tabId }) { debuggerAttached.push(tabId); },
      async detach({ tabId }) { detachedTabs.push(tabId); },
      async sendCommand(_target, method) {
        if (method === "DOM.getBoxModel") {
          boxModelCalls += 1;
          return { model: { border: [100, 200, 180, 200, 180, 240, 100, 240] } };
        }
        if (method === "Runtime.callFunctionOn") {
          return { result: { value: { status: "done", x: 140, y: 220, __cursorMove: true } } };
        }
        if (method === "Runtime.evaluate") {
          return { result: { value: { count: 1, filled: true, x: 320, y: 440, __cursorMove: true } } };
        }
        return {};
      },
    },
  };

  const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
  runInNewContext(source, { chrome, console });
  await onClicked.emit();

  async function request(args) {
    const id = nextReq++;
    await onMessage.emit({ id, ...args });
    return replies.find((r) => r.id === id);
  }

  // 1. listTabs exposes normal user tabs (10, 13) while excluding chrome:// (11) and incognito (12)
  const listed = await request({ method: "listTabs" });
  assert.equal(listed.ok, true);
  assert.equal(listed.value.length, 2);
  assert.equal(listed.value[0].id, 10);
  assert.equal(listed.value[0].owned, false);
  assert.equal(listed.value[0].origin, "user");

  // 1b. readTabContext reads tab 13 via chrome.scripting.executeScript without attaching chrome.debugger
  const passive = await request({ method: "readTabContext", tabId: 13, details: { format: "markdown", maxChars: 4000 } });
  assert.equal(passive.ok, true);
  assert.equal(passive.value.text, "# Guide");
  assert.equal(debuggerAttached.includes(13), false);

  // 2. claimTab rejects internal chrome:// tabs and claims user tab 10
  const badClaim = await request({ method: "claimTab", tabId: 11 });
  assert.equal(badClaim.ok, false);
  const claimed = await request({ method: "claimTab", tabId: 10 });
  assert.equal(claimed.ok, true);
  assert.equal(claimed.value.id, 10);
  assert.equal(claimed.value.origin, "user");

  // 3. attach dynamically injects content-script.js on CONTENT_PING miss and sends TAB_FAVICON_BADGE + AGENT_CURSOR_STATE
  assert.equal((await request({ method: "attach", tabId: 10 })).ok, true);
  assert.equal(scriptsInjected.filter((s) => Array.isArray(s.files)).length, 1);
  assert.ok(tabMessages.some((m) => m.tabId === 10 && m.msg.type === "TAB_FAVICON_BADGE" && m.msg.badge === "active"));
  assert.ok(tabMessages.some((m) => m.tabId === 10 && m.msg.type === "AGENT_CURSOR_STATE" && m.msg.state.isVisible === true));

  // 4. Cached contentScriptReadyTabs skips repeated CONTENT_PING, Runtime.callFunctionOn skips DOM.getBoxModel, and cursor still moves
  tabMessages.length = 0;
  boxModelCalls = 0;
  await request({
    method: "execute",
    tabId: 10,
    details: { method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 250, y: 180, buttons: 0 } },
  });
  const mouseMoveCursor = tabMessages.find((m) => m.msg.type === "AGENT_CURSOR_STATE")?.msg?.state?.cursor;
  assert.equal(mouseMoveCursor.x, 250);
  assert.equal(mouseMoveCursor.y, 180);
  assert.equal(tabMessages.filter((m) => m.msg.type === "CONTENT_PING").length, 0);

  tabMessages.length = 0;
  await request({
    method: "execute",
    tabId: 10,
    details: { method: "Runtime.callFunctionOn", params: { objectId: "obj-1", functionDeclaration: "function(){}" } },
  });
  assert.equal(boxModelCalls, 0);
  const callFnCursor = tabMessages.find((m) => m.msg.type === "AGENT_CURSOR_STATE")?.msg?.state?.cursor;
  assert.equal(callFnCursor.x, 140);
  assert.equal(callFnCursor.y, 220);

  tabMessages.length = 0;
  await request({
    method: "execute",
    tabId: 10,
    details: { method: "Runtime.evaluate", params: { expression: "fill()" } },
  });
  const evalCursor = tabMessages.find((m) => m.msg.type === "AGENT_CURSOR_STATE")?.msg?.state?.cursor;
  assert.equal(evalCursor.x, 320);
  assert.equal(evalCursor.y, 440);

  // 5. Creating & attaching a second tab clears the "active" badge on tab 10 so only 1 tab is active-badged at a time
  const created = await request({ method: "createBlankTab" });
  assert.equal(created.ok, true);
  tabMessages.length = 0;
  assert.equal((await request({ method: "attach", tabId: 20 })).ok, true);
  assert.ok(tabMessages.some((m) => m.tabId === 10 && m.msg.type === "TAB_FAVICON_BADGE" && m.msg.badge === null));
  assert.ok(tabMessages.some((m) => m.tabId === 20 && m.msg.type === "TAB_FAVICON_BADGE" && m.msg.badge === "active"));

  // 5b. Opening a popup child tab from owned tab 20 auto-owns child tab 21 and emits onTabCreated
  replies.length = 0;
  const popupTab = { id: 21, openerTabId: 20, url: "https://example.com/popup", title: "Popup", active: false };
  openTabs.set(21, popupTab);
  await tabsCreated.emit(popupTab);
  assert.ok(replies.some((m) => m.event === "onTabCreated" && m.tabId === 20 && m.params?.tab?.id === 21));

  // 6. Disconnecting closes ONLY agent tabs (20, 21) while preserving user tabs (10, 13)!
  await onClicked.emit();
  assert.deepEqual(removedTabs.sort((a, b) => a - b), [20, 21]);
  assert.equal(openTabs.has(10), true);
  assert.equal(openTabs.has(13), true);
  assert.ok(detachedTabs.includes(10));
});
