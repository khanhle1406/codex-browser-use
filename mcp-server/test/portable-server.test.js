import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "node:url";
import { createPortableServer, normalizeElicitation } from "../src/portable-server.js";
import { discoverEngine } from "../src/engine-discovery.js";

const fakeEngine = {path: "/fixture", version: "test", clientPath: "client", servicePath: "service", apiPath: "api", manifestPath: "manifest"};

/** @param {object} session @param {NodeJS.ProcessEnv} [env] @returns {Promise<{client:Client,close:()=>Promise<void>}>} */
async function connectFixture(session, env = {}) {
  const runtime = await createPortableServer({engine: fakeEngine, session, env});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({name: "portable-test", version: "1"});
  await runtime.server.connect(serverTransport);
  await client.connect(clientTransport);
  return {client, async close() { await client.close(); await runtime.close(); }};
}

test("MCP exposes original-engine JS surface without starting a browser for status", async () => {
  let calls = 0;
  const fixture = await connectFixture({
    async evaluate() {calls++; return {content: []};},
    async close() {},
  });
  try {
    const tools = await fixture.client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["browser_close_session", "browser_documentation", "browser_end_turn", "browser_js", "browser_reset", "browser_status"]);
    const status = await fixture.client.callTool({name: "browser_status", arguments: {}});
    const report = JSON.parse(status.content[0].text);
    assert.deepEqual(report.client, {name: "portable-test", version: "1"});
    assert.equal(report.approval, "MCP elicitation unavailable");
    assert.equal(report.bridge.state, "not configured");
    assert.equal(report.browserConnectivity, "not checked");
    assert.equal(calls, 0);
  } finally {await fixture.close();}
});

test("MCP status diagnoses a missing bridge descriptor without starting the engine", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-status-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const fixture = await connectFixture({
    async evaluate() { assert.fail("Status must not evaluate JS or open Chrome"); },
    async close() {},
  }, {BROWSER_USE_BRIDGE_FILE: path.join(root, "missing.json")});
  try {
    const status = await fixture.client.callTool({name: "browser_status", arguments: {}});
    const report = JSON.parse(status.content[0].text);
    assert.equal(report.bridge.state, "unavailable");
    assert.match(report.bridge.reason, /missing\.json/);
  } finally {await fixture.close();}
});

test("original origin prompts become valid MCP forms and preserve permission metadata", () => {
  const result = normalizeElicitation({message: "Allow access to http://localhost:8123?", meta: {codex_approval_kind: "browser_origin", origin: "http://localhost:8123"}});
  assert.deepEqual(result.requestedSchema, {type: "object", properties: {}});
  assert.equal(result._meta.origin, "http://localhost:8123");
  assert.equal(result._meta.codex_approval_kind, "browser_origin");
  assert.equal(result.meta, undefined);
  const schema = {type: "object", properties: {approved: {type: "boolean"}}, required: ["approved"]};
  assert.deepEqual(normalizeElicitation({message: "Confirm", requestedSchema: schema}).requestedSchema, schema);
  assert.throws(() => normalizeElicitation({message: "Credentials", meta: {codex_approval_kind: "browser_auth"}}), /secure credential-entry/);
  assert.throws(() => normalizeElicitation({message: "OTP", meta: {codex_approval_kind: "browser_email_otp"}}), /secure credential-entry/);
});

test("failed turn cleanup is returned as failure, never as a successful end-turn", async () => {
  const fixture = await connectFixture({
    async endTurn() {return {isError: true, content: [{type: "text", text: "cleanup failed"}]};},
    async close() {},
  });
  try {
    const result = await fixture.client.callTool({name: "browser_end_turn", arguments: {}});
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, "cleanup failed");
  } finally {await fixture.close();}
});

test("MCP preserves failed evaluation and remains usable after it", async () => {
  const fixture = await connectFixture({
    async evaluate(code) {
      if (code === "fail") throw new Error("Original engine denied this request");
      return {content: [{type: "text", text: code}]};
    },
    async close() {},
  });
  try {
    const failed = await fixture.client.callTool({name: "browser_js", arguments: {code: "fail"}});
    assert.equal(failed.isError, true);
    assert.match(failed.content[0].text, /denied/);
    const next = await fixture.client.callTool({name: "browser_js", arguments: {code: "next"}});
    assert.equal(next.content[0].text, "next");
  } finally {await fixture.close();}
});

test("MCP forwards multimodal output and serializes concurrent calls", async () => {
  let active = 0;
  let maximum = 0;
  const fixture = await connectFixture({
    async evaluate(code) {
      maximum = Math.max(maximum, ++active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return {content: [{type: "text", text: code}, {type: "image", mimeType: "image/png", data: "YWJj"}]};
    },
    async close() {},
  });
  try {
    const results = await Promise.all(["one", "two"].map((code) => fixture.client.callTool({name: "browser_js", arguments: {code}})));
    assert.equal(maximum, 1);
    assert.equal(results[0].content[1].type, "image");
    assert.equal(results[1].content[0].text, "two");
  } finally {await fixture.close();}
});

test("MCP reset interrupts active execution and rejects queued work from the old session", {timeout: 2000}, async () => {
  const started = Promise.withResolvers();
  const active = Promise.withResolvers();
  const evaluated = [];
  const fixture = await connectFixture({
    /** @param {string} code @returns {Promise<import('@modelcontextprotocol/sdk/types.js').CallToolResult>} */
    async evaluate(code) {
      evaluated.push(code);
      if (code === "active") {
        started.resolve();
        return active.promise;
      }
      return {content: []};
    },
    async reset() {
      active.resolve({isError: true, content: [{type: "text", text: "interrupted"}]});
    },
    async close() {
      active.resolve({content: []});
    },
  });
  try {
    const first = fixture.client.callTool({name: "browser_js", arguments: {code: "active"}});
    await started.promise;
    const queued = fixture.client.callTool({name: "browser_js", arguments: {code: "queued"}});
    await setImmediate();
    const reset = await fixture.client.callTool({name: "browser_reset", arguments: {}}, undefined, {timeout: 500});
    assert.notEqual(reset.isError, true);
    assert.equal((await first).isError, true);
    assert.match((await queued).content[0].text, /session changed/);
    assert.notEqual((await fixture.client.callTool({name: "browser_js", arguments: {code: "fresh"}})).isError, true);
    assert.deepEqual(evaluated, ["active", "fresh"]);
  } finally {
    await fixture.close();
  }
});

test("actual installed engine boots over stdio with separate persistent agent sessions", {timeout: 30_000}, async (t) => {
  let engine;
  try {engine = await discoverEngine();}
  catch (error) {t.skip(`Original local engine unavailable: ${error.message}`); return;}
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-use-mcp-"));
  const serverPath = fileURLToPath(new URL("../src/portable-server.js", import.meta.url));
  const clients = [];
  try {
    for (const provider of ["copilot-contract", "opencode-contract"]) {
      const client = new Client({name: provider, version: "test"}, {capabilities: provider === "opencode-contract" ? {elicitation: {form: {}}} : {}});
      if (provider === "opencode-contract") client.setRequestHandler(ElicitRequestSchema, async (request) => {
        assert.equal(request.params._meta.origin, "http://localhost:8123");
        assert.deepEqual(request.params.requestedSchema, {type: "object", properties: {}});
        return {action: "decline"};
      });
      const transport = new StdioClientTransport({command: process.execPath, args: [serverPath], env: {...process.env, BROWSER_USE_ENGINE_PATH: engine.path, BROWSER_USE_CONFIG_ROOT: root}, stderr: "pipe"});
      clients.push(client);
      await client.connect(transport);
    }
    const first = await clients[0].callTool({name: "browser_js", arguments: {code: 'const persistentValue = 41; nodeRepl.write(typeof agent.browsers.get);'}});
    assert.notEqual(first.isError, true, JSON.stringify(first));
    assert.match(JSON.stringify(first.content), /function/);
    const second = await clients[0].callTool({name: "browser_js", arguments: {code: "nodeRepl.write(await Promise.resolve(persistentValue + 1));"}});
    assert.notEqual(second.isError, true, JSON.stringify(second));
    assert.match(JSON.stringify(second.content), /42/);
    const isolated = await clients[1].callTool({name: "browser_js", arguments: {code: 'nodeRepl.write(typeof persistentValue); nodeRepl.write(typeof agent.browsers.get);'}});
    assert.notEqual(isolated.isError, true, JSON.stringify(isolated));
    assert.match(JSON.stringify(isolated.content), /undefined/);
    assert.match(JSON.stringify(isolated.content), /function/);
    const named = await clients[0].callTool({name: "browser_js", arguments: {session: "researcher-a", code: 'nodeRepl.write(typeof persistentValue); const persistentValue = "named";'}});
    assert.notEqual(named.isError, true, JSON.stringify(named));
    assert.match(JSON.stringify(named.content), /undefined/);
    const unchanged = await clients[0].callTool({name: "browser_js", arguments: {code: "nodeRepl.write(persistentValue);"}});
    assert.match(JSON.stringify(unchanged.content), /41/);
    const noApproval = await clients[0].callTool({name: "browser_js", arguments: {code: 'await nodeRepl.createElicitation({message:"Approve localhost?",meta:{codex_approval_kind:"browser_origin",origin:"http://localhost:8123"}});'}});
    assert.equal(noApproval.isError, true);
    assert.match(JSON.stringify(noApproval.content), /no access was granted/);
    const denied = await clients[1].callTool({name: "browser_js", arguments: {code: 'nodeRepl.write((await nodeRepl.createElicitation({message:"Approve localhost?",meta:{codex_approval_kind:"browser_origin",origin:"http://localhost:8123"}})).action);'}});
    assert.notEqual(denied.isError, true, JSON.stringify(denied));
    assert.match(JSON.stringify(denied.content), /decline/);
    const safety = await clients[0].callTool({name: "browser_js", arguments: {code: 'nodeRepl.write((await agent.documentation.get("browser-safety")).length);'}});
    assert.notEqual(safety.isError, true, JSON.stringify(safety));
    assert.match(safety.content[0].text, /\d{3,}/);
    const namedClosed = await clients[0].callTool({name: "browser_close_session", arguments: {session: "researcher-a"}});
    assert.notEqual(namedClosed.isError, true, JSON.stringify(namedClosed));
    const firstScope = {"ai.opencode/sessionID": "ses_first"};
    const secondScope = {"ai.opencode/sessionID": "ses_second"};
    const scopedClient = clients[1];
    const scopedValues = await Promise.all([firstScope, secondScope].map((_meta, index) =>
      scopedClient.callTool({name: "browser_js", _meta, arguments: {code: `const sharedName = ${index + 1}; nodeRepl.write(sharedName);`}})));
    assert.deepEqual(scopedValues.map((result) => result.content[0].text), ["1", "2"]);
    const closeFirst = await scopedClient.callTool({name: "browser_close_session", _meta: firstScope, arguments: {}});
    assert.notEqual(closeFirst.isError, true, JSON.stringify(closeFirst));
    const restarted = await scopedClient.callTool({name: "browser_js", _meta: firstScope, arguments: {code: "nodeRepl.write(typeof sharedName);"}});
    assert.equal(restarted.content[0].text, "undefined");
    const preserved = await scopedClient.callTool({name: "browser_js", _meta: secondScope, arguments: {code: "nodeRepl.write(sharedName);"}});
    assert.equal(preserved.content[0].text, "2");
    const malformed = await scopedClient.callTool({name: "browser_reset", _meta: {"ai.opencode/sessionID": 41}, arguments: {}});
    assert.equal(malformed.isError, true);
    assert.match(malformed.content[0].text, /Invalid OpenCode session metadata/);
    for (const client of clients) {
      const ended = await client.callTool({name: "browser_end_turn", arguments: {}});
      assert.notEqual(ended.isError, true, JSON.stringify(ended));
    }
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await rm(root, {recursive: true, force: true});
  }
});
