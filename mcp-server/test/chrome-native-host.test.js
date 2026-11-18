import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { endianness, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { readBackend } from "../src/backend-discovery.js";
import { ReplSession } from "../src/repl-session.js";

/** @returns {{addListener:(listener:Function)=>void,removeListener:(listener:Function)=>void,emit:(...args:unknown[])=>Promise<void>}} */
function event() {
  const listeners = new Set();
  return {
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    async emit(...args) { await Promise.all([...listeners].map((listener) => listener(...args))); },
  };
}

/** @param {import("node:child_process").ChildProcessWithoutNullStreams} child @returns {Promise<{tabs:Map<number,object>,disconnect:()=>Promise<void>}>} */
async function attachSimulatedChrome(child) {
  let nextId = 1;
  const tabs = new Map([[99, {id: 99, url: "https://private.example/"}]]);
  const onMessage = event();
  const onDisconnect = event();
  const onClicked = event();
  const onRemoved = event();
  const onDebugEvent = event();
  const onDebugDetach = event();
  const attached = new Set();
  const little = endianness() === "LE";
  const chrome = {
    runtime: {
      /** @param {string} name @returns {object} */
      connectNative(name) {
        assert.equal(name, "com.portable_browser_use.bridge");
        return {onMessage, onDisconnect,
          /** @param {object} message @returns {void} */
          postMessage(message) {
            const body = Buffer.from(JSON.stringify(message));
            const header = Buffer.alloc(4);
            if (little) header.writeUInt32LE(body.length);
            else header.writeUInt32BE(body.length);
            child.stdin.write(Buffer.concat([header, body]));
          },
          disconnect() { child.stdin.end(); },
        };
      },
    },
    action: {onClicked, async setBadgeText() {}},
    debugger: {
      onEvent: onDebugEvent,
      onDetach: onDebugDetach,
      /** @param {{tabId:number}} target @returns {Promise<void>} */
      async attach({tabId}) {
        assert.notEqual(tabId, 99);
        attached.add(tabId);
      },
      /** @param {{tabId:number}} target @returns {Promise<void>} */
      async detach({tabId}) {
        attached.delete(tabId);
        await onDebugDetach.emit({tabId}, "target_closed");
      },
      /** @param {{tabId:number}} target @param {string} method @param {Record<string,unknown>} params @returns {Promise<unknown>} */
      async sendCommand({tabId}, method, params) {
        assert.equal(attached.has(tabId), true);
        const tab = tabs.get(tabId);
        const frameId = `frame-${tabId}`;
        if (method === "Page.getFrameTree") return {frameTree: {frame: {id: frameId, url: tab.url}}};
        if (method === "Page.getLayoutMetrics") {
          const viewport = {pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600, scale: 1};
          return {cssLayoutViewport: viewport, cssVisualViewport: viewport,
            cssContentSize: {x: 0, y: 0, width: 800, height: 600}};
        }
        if (method === "Runtime.evaluate") return {result: {value: {href: tab.url, readyState: "complete"}}};
        if (method === "Page.navigate") {
          tab.url = params.url;
          await onDebugEvent.emit({tabId}, "Page.frameNavigated", {frame: {id: frameId, url: tab.url}});
          await onDebugEvent.emit({tabId}, "Page.loadEventFired", {timestamp: 1});
          return {frameId};
        }
        if (method === "Page.captureScreenshot") return {data: "A".repeat(200_000)};
        return {};
      },
    },
    tabs: {
      onRemoved,
      /** @param {{url:string,active:boolean}} options @returns {Promise<object>} */
      async create(options) {
        const tab = {id: nextId++, ...options};
        tabs.set(tab.id, tab);
        return tab;
      },
      /** @param {number} id @returns {Promise<object>} */
      async get(id) {
        assert.notEqual(id, 99, "Extension must not read a pre-existing tab");
        return tabs.get(id);
      },
      /** @param {number} id @returns {Promise<void>} */
      async remove(id) {
        assert.notEqual(id, 99, "Extension must not remove a pre-existing tab");
        tabs.delete(id);
        await onRemoved.emit(id);
      },
    },
  };
  let pending = Buffer.alloc(0);
  child.stdout.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const length = little ? pending.readUInt32LE() : pending.readUInt32BE();
      if (pending.length < 4 + length) break;
      const request = JSON.parse(pending.subarray(4, 4 + length));
      pending = pending.subarray(4 + length);
      void onMessage.emit(request);
    }
  });
  const extension = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
  runInNewContext(extension, {chrome, console});
  await onClicked.emit();
  return {tabs, disconnect: () => onClicked.emit()};
}

test("original engine uses project native host and extension tab protocol across two workers", {
  skip: !process.env.BROWSER_USE_TEST_ENGINE,
  timeout: 20000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "portable-native-"));
  const descriptor = path.join(root, "bridge.json");
  const host = spawn(process.execPath, [fileURLToPath(new URL("../bin/chrome-native-host.js", import.meta.url)), descriptor]);
  const exited = once(host, "exit");
  let errors = "";
  host.stderr.on("data", (chunk) => { errors += chunk; });
  const sessions = [];
  try {
    const chrome = await attachSimulatedChrome(host);
    for (let i = 0; ; i++) {
      try { await readBackend(descriptor); break; }
      catch (error) {
        if (i >= 100 || host.exitCode !== null || error.code !== "ENOENT") throw new Error(errors || error.message);
        await pause(20);
      }
    }
    for (let i = 0; i < 2; i++) sessions.push(new ReplSession({
      enginePath: process.env.BROWSER_USE_TEST_ENGINE,
      hostConfigRoot: root,
      env: {BROWSER_USE_BRIDGE_FILE: descriptor},
      onElicitation: async (request) => ({
        action: request.meta?.origin === "http://127.0.0.1:31337" ? "accept" : "decline",
      }),
    }));
    const results = await Promise.all(sessions.map((session) => session.evaluate(
      'const browser = await agent.browsers.get("chrome"); const tab = await browser.tabs.new(); nodeRepl.write(JSON.stringify((await browser.tabs.list()).map(t=>t.id)));',
    )));
    const ids = results.map((result) => {
      assert.notEqual(result.isError, true, JSON.stringify(result));
      const own = JSON.parse(result.content[0].text);
      assert.equal(own.length, 1);
      return Number(own[0]);
    });
    assert.notEqual(ids[0], ids[1]);
    const page = await sessions[0].evaluate('await tab.goto("http://127.0.0.1:31337/fixture"); nodeRepl.write(await tab.url());', {timeoutMs: 6000});
    assert.notEqual(page.isError, true, JSON.stringify(page));
    assert.match(page.content[0].text, /127\.0\.0\.1:31337\/fixture/);
    const image = await sessions[0].evaluate("nodeRepl.emitImage(await tab.screenshot({fullPage:false}));", {timeoutMs: 6000});
    assert.notEqual(image.isError, true, JSON.stringify(image).slice(0, 1000));
    assert.equal(image.content.find((item) => item.type === "image")?.data.length, 200_000);
    const foreign = await sessions[1].evaluate(`await (await browser.tabs.get(${JSON.stringify(String(ids[0]))})).screenshot({fullPage:false});`);
    assert.equal(foreign.isError, true);
    const kept = await sessions[0].evaluate("await tab.markDeliverable();");
    assert.notEqual(kept.isError, true, JSON.stringify(kept));
    const ended = await Promise.all(sessions.map((session) => session.endTurn()));
    for (const result of ended) assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.deepEqual([...chrome.tabs.keys()].sort(), [ids[0], 99].sort());
    await Promise.all(sessions.map((session) => session.close()));
    await chrome.disconnect();
    assert.deepEqual(await exited, [0, null], errors);
    assert.deepEqual([...chrome.tabs.keys()].sort(), [ids[0], 99].sort());
    await assert.rejects(readBackend(descriptor), {code: "ENOENT"});
  } finally {
    await Promise.allSettled(sessions.map((session) => session.close()));
    if (host.exitCode === null && host.signalCode === null) {
      host.kill();
      await exited;
    }
    await rm(root, {recursive: true, force: true});
  }
});
