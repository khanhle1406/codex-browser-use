import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { endianness, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { listenBackend } from "../src/backend-transport.js";
import { ReplSession } from "../src/repl-session.js";

/** @param {object} request @returns {Buffer} */
function frame(request) {
  const body = Buffer.from(JSON.stringify(request));
  const header = Buffer.alloc(4);
  if (endianness() === "LE") header.writeUInt32LE(body.length);
  else header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

test("private backend handles split frames and rejects unsupported methods", { timeout: 3000 }, async (t) => {
  const backend = await listenBackend(new Map([["test", async (params) => params]]));
  t.after(() => backend.close());
  assert.equal((await stat(path.dirname(backend.socketPath))).mode & 0o077, 0);
  const socket = createConnection(backend.socketPath);
  await once(socket, "connect");
  const input = frame({jsonrpc: "2.0", id: 0, method: "test", params: {name: "Tiếng Việt"}});
  const missing = frame({jsonrpc: "2.0", id: 1, method: "unsupported", params: {}});
  const result = (async () => {
    let buffered = Buffer.alloc(0);
    const replies = [];
    for await (const chunk of socket) {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4) {
        const length = endianness() === "LE" ? buffered.readUInt32LE() : buffered.readUInt32BE();
        if (buffered.length < length + 4) break;
        replies.push(JSON.parse(buffered.subarray(4, length + 4)));
        buffered = buffered.subarray(length + 4);
      }
      if (replies.length === 2) return replies;
    }
    throw new Error("Backend disconnected before both replies");
  })();
  socket.write(input.subarray(0, 2));
  socket.write(input.subarray(2, input.length - 4));
  socket.write(Buffer.concat([input.subarray(input.length - 4), missing]));
  const [echo, denied] = await result;
  assert.deepEqual(echo, {jsonrpc: "2.0", id: 0, result: {name: "Tiếng Việt"}});
  assert.deepEqual(denied, {jsonrpc: "2.0", id: 1, error: {code: -32601, message: "No handler registered for method: unsupported"}});
});

test("private backend pipelines concurrent RPCs without HoL blocking, enforces turn barrier, and decodes fragmented large frames", { timeout: 3000 }, async (t) => {
  const order = [];
  let fastStartedWhileSlowPending = false;
  let releaseSlow;
  const slowGate = new Promise((resolve) => { releaseSlow = resolve; });

  const backend = await listenBackend(new Map([
    ["slow", async () => {
      order.push("slow:start");
      await slowGate;
      order.push("slow:end");
      return { ok: "slow" };
    }],
    ["fast", async (params) => {
      order.push(`fast:${params.n ?? 0}`);
      if (!order.includes("slow:end")) fastStartedWhileSlowPending = true;
      return { ok: "fast", len: typeof params.payload === "string" ? params.payload.length : 0 };
    }],
    ["turnEnded", async () => {
      order.push("turnEnded");
      return null;
    }],
  ]));
  t.after(() => backend.close());

  const socket = createConnection(backend.socketPath);
  await once(socket, "connect");
  const replies = [];
  const waitForReply = new Map();
  let rx = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    rx = Buffer.concat([rx, chunk]);
    while (rx.length >= 4) {
      const length = endianness() === "LE" ? rx.readUInt32LE() : rx.readUInt32BE();
      if (rx.length < length + 4) break;
      const msg = JSON.parse(rx.subarray(4, length + 4).toString("utf8"));
      rx = rx.subarray(length + 4);
      replies.push(msg);
      waitForReply.get(msg.id)?.(msg);
    }
  });
  const awaitId = (id) => new Promise((resolve) => {
    const existing = replies.find((r) => r.id === id);
    if (existing) { resolve(existing); return; }
    waitForReply.set(id, resolve);
  });

  // 1. Slow request starts, then fast request completes before slow finishes (no HoL blocking).
  socket.write(Buffer.concat([
    frame({ jsonrpc: "2.0", id: 10, method: "slow", params: {} }),
    frame({ jsonrpc: "2.0", id: 11, method: "fast", params: { n: 1 } }),
    frame({ jsonrpc: "2.0", id: 12, method: "turnEnded", params: {} }),
  ]));
  const fastReply = await awaitId(11);
  assert.deepEqual(fastReply.result, { ok: "fast", len: 0 });
  assert.equal(fastStartedWhileSlowPending, true);
  assert.equal(replies.some((r) => r.id === 12), false, "turnEnded must wait for slow in-flight RPC");

  releaseSlow();
  const [slowReply, turnReply] = await Promise.all([awaitId(10), awaitId(12)]);
  assert.deepEqual(slowReply.result, { ok: "slow" });
  assert.equal(turnReply.result, null);
  assert.equal(order.indexOf("turnEnded") > order.indexOf("slow:end"), true);

  // 2. Fragmented 200KB request split across arbitrary tiny chunks.
  const largePayload = "Z".repeat(200_000);
  const largeFrame = frame({ jsonrpc: "2.0", id: 13, method: "fast", params: { payload: largePayload } });
  for (let off = 0; off < largeFrame.length; off += 4_096) {
    socket.write(largeFrame.subarray(off, off + 4_096));
    await new Promise((r) => setTimeout(r, 1));
  }
  const largeReply = await awaitId(13);
  assert.equal(largeReply.result.len, 200_000);
});

test("original browser engine discovers the project-owned fixture via framed RPC", {
  skip: !process.env.BROWSER_USE_TEST_ENGINE,
  timeout: 15000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "browser-backend-test-"));
  const identities = new Set();
  const listedBy = new Map();
  const backend = await listenBackend(new Map([
    ["getInfo", (params) => {
      assert.equal(typeof params.session_id, "string");
      assert.equal(typeof params.turn_id, "string");
      identities.add(params.session_id);
      return {type: "extension", family: "chrome", name: "Protocol test fixture", version: "0.0.0",
        capabilities: {browser: [], tab: []}, apiSupportOverrides: {"Tab.ax": false}};
    }],
    ["getTabs", ({session_id, turn_id}) => {
      assert.equal(identities.has(session_id), true);
      assert.equal(typeof turn_id, "string");
      listedBy.set(session_id, (listedBy.get(session_id) ?? 0) + 1);
      return [{id: 11, title: "Protocol fixture tab", url: "about:blank"}];
    }],
    ["turnEnded", () => null],
  ]));
  const sessions = Array.from({length: 2}, () => new ReplSession({
    enginePath: process.env.BROWSER_USE_TEST_ENGINE,
    hostConfigRoot: root,
    env: {BROWSER_USE_BACKEND_PATHS: backend.socketPath},
  }));
  try {
    const results = await Promise.all(sessions.map((session) => session.evaluate(
      'const browser = await agent.browsers.get("chrome"); nodeRepl.write(await browser.tabs.list());',
      {timeoutMs: 8000},
    )));
    for (const result of results) {
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.match(JSON.stringify(result.content), /Protocol fixture tab/);
    }
    assert.equal(identities.size, 2);
    assert.equal(listedBy.size, 2);
  } finally {
    try { await Promise.all(sessions.map((session) => session.close())); }
    finally {
      await backend.close();
      await rm(root, {recursive: true, force: true});
    }
  }
});
