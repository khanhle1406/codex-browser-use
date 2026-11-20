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
