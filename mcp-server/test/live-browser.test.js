import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { discoverEngine } from "../src/engine-discovery.js";
import { launchChromeForTesting } from "./chrome-for-testing.js";

/** @param {Client} client @param {string} code @param {Record<string,unknown>} [_meta] @returns {Promise<import('@modelcontextprotocol/sdk/types.js').CallToolResult>} */
async function execute(client, code, _meta) {
  const result = await client.callTool({name: "browser_js", arguments: {code, timeout_ms: 45000}, _meta}, undefined, {timeout: 50000});
  assert.notEqual(result.isError, true, JSON.stringify(result.content).slice(0, 2400));
  return result;
}

test("live original engine: locators, guarded evaluate, screenshots and cross-provider tab leases", {
  skip: !(process.env.BROWSER_USE_LIVE_SOCKET || process.env.BROWSER_USE_LIVE_BRIDGE_FILE || process.env.BROWSER_USE_TEST_CHROME),
  timeout: 120000,
}, async (t) => {
  const engine = await discoverEngine();
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-use-live-"));
  const fixtureRequests = new Map();
  const fixture = http.createServer((request, response) => {
    fixtureRequests.set(request.url, (fixtureRequests.get(request.url) ?? 0) + 1);
    response.writeHead(200, {"content-type": "text/html", "cache-control": "no-store"});
    if (request.url === "/frame") {
      response.end('<!doctype html><label>Frame name <input></label><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save frame</button><output role="status"></output>');
      return;
    }
    if (request.url === "/with-frame") {
      response.end(`<!doctype html><iframe title="Fixture frame" src="http://localhost:${fixture.address().port}/frame"></iframe>`);
      return;
    }
    if (request.url === "/dialogs") {
      response.end(`<!doctype html>
        <button onclick="setTimeout(() => { document.querySelector('output').textContent = String(confirm('Continue?')); }, 200)">Open confirm</button>
        <button onclick="setTimeout(() => { document.querySelector('output').textContent = prompt('Name?'); }, 200)">Open prompt</button>
        <output role="status"></output>`);
      return;
    }
    response.end('<!doctype html><title>Portable browser fixture</title><label>Name <input id="name"></label><button onclick="document.querySelector(\'#result\').textContent=\'Saved \'+document.querySelector(\'#name\').value">Save</button><output id="result"></output>');
  });
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  const frameOrigin = `http://localhost:${fixture.address().port}`;
  const clients = [];
  let chrome;
  try {
    if (process.env.BROWSER_USE_TEST_CHROME) chrome = await launchChromeForTesting(root, process.env.BROWSER_USE_TEST_CHROME);
    const bridgeFile = chrome?.descriptor ?? process.env.BROWSER_USE_LIVE_BRIDGE_FILE;
    for (const name of ["provider-one-live", "provider-two-live"]) {
      const client = new Client({name, version: "test"}, {capabilities: {elicitation: {form: {}}}});
      client.setRequestHandler(ElicitRequestSchema, async (request) => {
        // The test authorizes only its own ephemeral fixture, never other sites,
        // account state, credential UI, history, downloads, or external side effects.
        const meta = request.params._meta;
        return {action: [origin, frameOrigin].includes(meta?.origin) && meta?.tool_name === "access_browser_origin" ? "accept" : "decline"};
      });
      clients.push(client);
      await client.connect(new StdioClientTransport({command: process.execPath, args: [fileURLToPath(new URL("../src/portable-server.js", import.meta.url))], env: {
        ...process.env, BROWSER_USE_ENGINE_PATH: engine.path, BROWSER_USE_CONFIG_ROOT: root,
        ...(bridgeFile
          ? {BROWSER_USE_BRIDGE_FILE: bridgeFile}
          : {BROWSER_USE_BACKEND_PATHS: process.env.BROWSER_USE_LIVE_SOCKET}),
      }, stderr: "pipe"}));
      await execute(client, 'const browser = await agent.browsers.get("chrome"); nodeRepl.write((await browser.documentation()).length);');
    }
    const snapshot = await execute(clients[0], `const tab = await browser.tabs.new(); await tab.goto(${JSON.stringify(origin)}); nodeRepl.write(await tab.playwright.domSnapshot());`);
    assert.match(JSON.stringify(snapshot.content), /textbox.*Name/);
    const changed = await execute(clients[0], 'await tab.playwright.getByRole("textbox", {name:"Name"}).fill("portable"); await tab.playwright.getByRole("button", {name:"Save", exact:true}).click({timeoutMs:20000}); nodeRepl.write(await tab.playwright.domSnapshot());');
    assert.match(JSON.stringify(changed.content), /Saved portable/);
    const shot = await execute(clients[0], 'nodeRepl.emitImage(await tab.screenshot({fullPage:false}));');
    const image = shot.content.find((item) => item.type === "image");
    assert.ok(image && image.data.length > 100, "Expected an image from the Chrome screenshot");
    const mutation = await clients[0].callTool({name: "browser_js", arguments: {code: 'await tab.playwright.evaluate(() => { document.body.innerHTML = "mutated"; });'}});
    assert.equal(mutation.isError, true);
    const idResult = await execute(clients[0], 'nodeRepl.write(tab.id);');
    const tabId = idResult.content.find((item) => item.type === "text").text;
    const contention = await clients[1].callTool({name: "browser_js", arguments: {code: `const foreign = await browser.tabs.get(${JSON.stringify(tabId)}); await foreign.playwright.getByRole("textbox",{name:"Name"}).fill("stolen");`}});
    assert.equal(contention.isError, true, "The second session must not act on the first session's fixture tab");
    await execute(clients[1], `const tab = await browser.tabs.new(); await tab.goto(${JSON.stringify(origin)}); await tab.playwright.getByRole("textbox",{name:"Name"}).fill("second");`);
    const secondTab = (await execute(clients[1], "nodeRepl.write(tab.id);")).content[0].text;
    const scoped = {"ai.opencode/sessionID": "ses_fixture"};
    const scopedTabs = await execute(clients[1], 'const browser = await agent.browsers.get("chrome"); const tab = await browser.tabs.new(); nodeRepl.write(JSON.stringify((await browser.tabs.list()).map(t=>t.id)));', scoped);
    const scopedIds = JSON.parse(scopedTabs.content[0].text);
    assert.equal(scopedIds.length, 1);
    assert.notEqual(String(scopedIds[0]), secondTab);
    const scopedAccess = await clients[1].callTool({name: "browser_js", _meta: scoped, arguments: {code: `const foreign = await browser.tabs.get(${JSON.stringify(secondTab)}); await foreign.playwright.domSnapshot();`}});
    assert.equal(scopedAccess.isError, true, "Conversations on one connection cannot use one another's tabs");
    const scopedClosed = await clients[1].callTool({name: "browser_close_session", _meta: scoped, arguments: {}});
    assert.notEqual(scopedClosed.isError, true, JSON.stringify(scopedClosed));
    const unchanged = await execute(clients[0], 'nodeRepl.write(await tab.playwright.domSnapshot());');
    assert.match(JSON.stringify(unchanged.content), /Saved portable/);
    const dialogs = await execute(clients[0], `
      await tab.goto(${JSON.stringify(origin + "/dialogs")});
      const waitForDialog = async () => {
        for (let attempt = 0; attempt < 60; attempt++) {
          const dialog = await tab.getJsDialog();
          if (dialog) return dialog;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error("Fixture dialog did not open");
      };
      await tab.playwright.getByRole("button", {name:"Open confirm"}).click();
      const confirmDialog = await waitForDialog();
      nodeRepl.write(confirmDialog.type);
      await confirmDialog.dismiss();
      nodeRepl.write(await tab.playwright.getByRole("status").textContent());
      await tab.playwright.getByRole("button", {name:"Open prompt"}).click();
      const promptDialog = await waitForDialog();
      nodeRepl.write(promptDialog.type);
      await promptDialog.accept("portable-dialog");
      nodeRepl.write(await tab.playwright.getByRole("status").textContent());
    `);
    assert.deepEqual(dialogs.content.map((item) => item.text), ["confirm", "false", "prompt", "portable-dialog"]);
    if (chrome && process.env.BROWSER_USE_TEST_FRAMES === "1") {
      const iframe = await execute(clients[0], `await tab.goto(${JSON.stringify(origin + "/with-frame")}); const frame = tab.playwright.frameLocator('iframe[title="Fixture frame"]'); await frame.getByRole("textbox", {name:"Frame name"}).fill("nested"); await frame.getByRole("button", {name:"Save frame"}).click({timeoutMs:15000}); nodeRepl.write(await frame.getByRole("status").textContent());`);
      assert.match(JSON.stringify(iframe.content), /nested/);
    }
    for (const client of clients) {
      const ended = await client.callTool({name: "browser_end_turn", arguments: {}});
      assert.notEqual(ended.isError, true, JSON.stringify(ended));
    }
  } catch (error) {
    t.diagnostic(`HTTP requests received by the local fixture: ${JSON.stringify(Object.fromEntries(fixtureRequests))}`);
    throw error;
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await chrome?.close();
    fixture.closeAllConnections();
    await new Promise((resolve, reject) => fixture.close((error) => error ? reject(error) : resolve()));
    await rm(root, {recursive: true, force: true});
  }
});
