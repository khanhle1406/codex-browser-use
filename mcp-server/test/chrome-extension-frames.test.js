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
  const replies = [];
  let nextTab = 1;
  let nextRequest = 1;
  const port = {onMessage, onDisconnect: event(), postMessage: (reply) => replies.push(reply)};
  const chrome = {
    runtime: {connectNative: () => port},
    tabs: {onRemoved: event(), async create() { return {id: nextTab++}; }},
    action: {onClicked, async setBadgeText() {}},
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
