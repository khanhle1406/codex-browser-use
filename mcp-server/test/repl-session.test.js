import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ReplSession } from "../src/repl-session.js";

/** @param {import('../src/repl-session.js').EvaluationResult} result @returns {string} */
function text(result) {
  return result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

test("persistent await bindings can be redeclared, including destructuring and classes", async (t) => {
  const session = new ReplSession();
  t.after(() => session.close());
  assert.equal(text(await session.evaluate("const value = await Promise.resolve(41); value")), "41");
  assert.equal(text(await session.evaluate("const value = 42; value")), "42");
  assert.equal(text(await session.evaluate("let { answer } = { answer: value }; answer")), "42");
  assert.equal(text(await session.evaluate("let { answer } = { answer: 43 }; answer")), "43");
  assert.equal(text(await session.evaluate("class Counter { read() { return answer; } }; new Counter().read()")), "43");
  assert.equal(text(await session.evaluate("class Counter { read() { return 44; } }; new Counter().read()")), "44");
});

test("concurrent calls execute serially and dynamic imports work", async (t) => {
  const session = new ReplSession();
  t.after(() => session.close());
  const first = session.evaluate("var value = await new Promise(resolve => setTimeout(() => resolve(1), 40)); value");
  const second = session.evaluate("value += 1; value");
  assert.equal(text(await first), "1");
  assert.equal(text(await second), "2");
  assert.equal(text(await session.evaluate("const { basename } = await import('node:path'); basename('/example/file.txt')")), "file.txt");
});

test("text and image output is returned as MCP content", async (t) => {
  const session = new ReplSession();
  t.after(() => session.close());
  const result = await session.evaluate("console.log('observed %d', 3); nodeRepl.write('state'); nodeRepl.emitImage({bytes:new Uint8Array([1,2,3]), mimeType:'image/png'}); void 0");
  assert.deepEqual(result.content, [
    { type: "text", text: "observed 3" },
    { type: "text", text: "state" },
    { type: "image", mimeType: "image/png", data: "AQID" },
  ]);
});

test("syntax, synchronous and asynchronous errors remain visible and session recovers", async (t) => {
  const session = new ReplSession();
  t.after(() => session.close());
  for (const code of ["const =", "throw new Error('sync failure')", "await Promise.reject(new Error('async failure'))"]) {
    const result = await session.evaluate(code);
    assert.equal(result.isError, true);
    assert.match(text(result), /Error:/);
  }
  assert.equal(text(await session.evaluate("2 + 2")), "4");
});

test("timeout stops even CPU-bound code and resets all bindings", async (t) => {
  const session = new ReplSession();
  t.after(() => session.close());
  await session.evaluate("const saved = 9");
  await assert.rejects(session.evaluate("while (true) {}", { timeoutMs: 50 }), /timed out/);
  assert.equal(text(await session.evaluate("typeof saved")), "undefined");
});

test("reset and close release workers and close prevents subsequent evaluations", async () => {
  const session = new ReplSession();
  await session.evaluate("var saved = 9");
  await session.endTurn();
  assert.equal(text(await session.evaluate("saved")), "9");
  await session.reset();
  assert.equal(text(await session.evaluate("typeof saved")), "undefined");
  await session.close();
  await assert.rejects(session.evaluate("1"), /closed/);
});

test("invalid timeouts are rejected before a worker starts", async () => {
  const session = new ReplSession();
  await assert.rejects(session.evaluate("1", { timeoutMs: 0 }), /timeoutMs/);
  assert.equal(session.child, null);
  await session.close();
});

test("cancellation terminates the current worker before another request starts", async (t) => {
  const session = new ReplSession();
  t.after(() => session.close());
  await session.evaluate("const saved = 9");
  const controller = new AbortController();
  const pending = session.evaluate("while (true) {}", { signal: controller.signal });
  setTimeout(() => controller.abort(), 40);
  await assert.rejects(pending, /cancelled/);
  assert.equal(text(await session.evaluate("typeof saved")), "undefined");
});

/** @param {import('node:test').TestContext} t @param {string} source @returns {Promise<string>} */
async function engineFixture(t, source) {
  const root = await mkdtemp(path.join(tmpdir(), "browser-repl-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, "scripts", "browser-client.mjs"), source);
  return root;
}

test("approval requests cross the process boundary and turns renew without discarding session", async (t) => {
  const root = await engineFixture(t, `export async function setupBrowserRuntime() {
    const host = globalThis.nodeRepl;
    host.addTurnEndedHandler({timeoutMs:1000, run: async (turn) => host.write('ended:' + turn.turn_id)});
    return {metadata: () => JSON.parse(host.requestMeta['x-codex-turn-metadata']), ask: () => host.createElicitation({message:'Allow browser access?'})};
  }`);
  const requests = [];
  const session = new ReplSession({ enginePath: root, hostConfigRoot: path.join(root, "config"), onElicitation: async (request) => { requests.push(request); return { action: "accept" }; } });
  t.after(() => session.close());
  const firstTurn = text(await session.evaluate("agent.metadata().turn_id"));
  const firstSession = text(await session.evaluate("agent.metadata().session_id"));
  assert.equal(text(await session.evaluate("(await agent.ask()).action")), "accept");
  assert.deepEqual(requests, [{ message: "Allow browser access?" }]);
  assert.equal(text(await session.endTurn()), `ended:${firstTurn}`);
  assert.notEqual(text(await session.evaluate("agent.metadata().turn_id")), firstTurn);
  assert.equal(text(await session.evaluate("agent.metadata().session_id")), firstSession);
});

test("missing approval support fails closed and lifecycle cleanup errors are reported", async (t) => {
  const root = await engineFixture(t, `export async function setupBrowserRuntime() {
    const host = globalThis.nodeRepl;
    host.addTurnEndedHandler({timeoutMs:1000, run: async () => { throw new Error('cleanup failed'); }});
    return {ask: () => host.createElicitation({message:'Allow browser access?'})};
  }`);
  const session = new ReplSession({ enginePath: root, hostConfigRoot: path.join(root, "config") });
  assert.equal((await session.evaluate("await agent.ask()")).isError, true);
  await assert.rejects(session.close(), /cleanup failed/);
  assert.equal(session.child, null);
});

test("session variables are isolated between simultaneous provider connections", async (t) => {
  const first = new ReplSession();
  const second = new ReplSession();
  t.after(() => Promise.all([first.close(), second.close()]));
  await first.evaluate("const secretInFirstSession = 42");
  assert.equal(text(await second.evaluate("typeof secretInFirstSession")), "undefined");
});

test("large output is bounded and response metadata stays outside model-visible content", async (t) => {
  const root = await engineFixture(t, `export async function setupBrowserRuntime() { return {display: () => console.log('original engine display')}; }`);
  const session = new ReplSession({ enginePath: root, hostConfigRoot: path.join(root, "config") });
  t.after(() => session.close());
  assert.equal(text(await session.evaluate("agent.display()")), "original engine display");
  const result = await session.evaluate("nodeRepl.setResponseMeta({example:'meta'}); nodeRepl.emitContentItem('engine notification'); nodeRepl.write('a'.repeat(3*1024*1024)); void 0");
  assert.match(text(result), /truncated/);
  assert.equal(result.content[0].text, "engine notification");
  assert.ok(text(result).length < 150);
  assert.deepEqual(result._meta, { example: "meta" });
});


test("closing an executing session interrupts it instead of waiting for its deadline", async () => {
  const session = new ReplSession();
  await session.evaluate("1");
  const active = session.evaluate("await new Promise(() => {})", { timeoutMs: 300000 });
  const rejected = assert.rejects(active, /closed during execution/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await session.close();
  await rejected;
  assert.equal(session.child, null);
});


test("close rejects queued work and prevents delayed side effects after shutdown", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "browser-repl-shutdown-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "late.txt");
  const session = new ReplSession();
  await session.evaluate("1");
  const active = session.evaluate(`const fs = await import('node:fs'); await new Promise(resolve => setTimeout(resolve, 150)); fs.writeFileSync(${JSON.stringify(target)}, 'late')`);
  const activeRejected = assert.rejects(active, /closed during execution/);
  const queued = session.evaluate("42");
  const queuedRejected = assert.rejects(queued, /closed/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await session.close();
  await Promise.all([activeRejected, queuedRejected]);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await assert.rejects(access(target));
  await assert.rejects(session.evaluate("1"), /closed/);
  assert.equal(session.child, null);
});

test("reset interrupts CPU-bound code and rejects work queued before the reset", async (t) => {
  const session = new ReplSession();
  t.after(() => session.close());
  await session.evaluate("1");
  const active = session.evaluate("while (true) {}", { timeoutMs: 300000 });
  const activeRejected = assert.rejects(active, /reset during execution/);
  const queued = session.evaluate("42");
  const queuedRejected = assert.rejects(queued, /reset before/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await session.reset();
  await Promise.all([activeRejected, queuedRejected]);
  assert.equal(text(await session.evaluate("21 * 2")), "42");
});


test("worker replacements never reuse ended or interrupted browser identities", async (t) => {
  const root = await engineFixture(t, `export async function setupBrowserRuntime() {
    return {metadata: () => JSON.parse(globalThis.nodeRepl.requestMeta['x-codex-turn-metadata'])};
  }`);
  const session = new ReplSession({ enginePath: root, hostConfigRoot: path.join(root, "config"), requestMeta: { "x-codex-turn-metadata": { session_id: "initial", turn_id: "initial", model: "test-model" } } });
  t.after(() => session.close());
  /** @returns {Promise<{session_id: string, turn_id: string, model: string}>} */
  const identity = async () => JSON.parse(text(await session.evaluate("JSON.stringify(agent.metadata())")));
  const initial = await identity();
  assert.notEqual(initial.session_id, "initial");
  assert.notEqual(initial.turn_id, "initial");
  assert.equal(initial.model, "test-model");
  await session.endTurn();
  const ended = await identity();
  assert.equal(ended.session_id, initial.session_id);
  assert.notEqual(ended.turn_id, initial.turn_id);
  await session.reset();
  const reset = await identity();
  assert.notEqual(reset.session_id, initial.session_id);
  assert.notEqual(reset.turn_id, initial.turn_id);
  assert.notEqual(reset.turn_id, ended.turn_id);
  await assert.rejects(session.evaluate("while (true) {}", { timeoutMs: 50 }), /timed out/);
  const interrupted = await identity();
  assert.notEqual(interrupted.session_id, reset.session_id);
  assert.notEqual(interrupted.turn_id, reset.turn_id);
  assert.equal(interrupted.model, "test-model");
});
