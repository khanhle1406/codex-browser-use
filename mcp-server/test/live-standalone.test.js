import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { launchChromeForTesting } from "./chrome-for-testing.js";
import { BridgeBrowser } from "../src/bridge-browser.js";

const page = `<!doctype html><html><head><title>Live</title></head><body>
<label>Name <input id="name"></label>
<button onclick="document.getElementById('out').textContent='Hello '+document.getElementById('name').value">Save</button>
<p id="out">idle</p></body></html>`;

test("standalone core drives real Chrome", {
  skip: !process.env.BROWSER_USE_TEST_CHROME,
  timeout: 180_000,
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "browser-use-live-"));
  const server = http.createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(page);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const httpUrl = `http://127.0.0.1:${server.address().port}/`;
  const url = process.env.BROWSER_USE_LIVE_HTTP === "1" ? httpUrl : `data:text/html,${encodeURIComponent(page)}`;
  const chrome = await launchChromeForTesting(root, process.env.BROWSER_USE_TEST_CHROME, {
    headless: process.env.BROWSER_USE_HEADFUL !== "1",
  });
  const browser = await BridgeBrowser.connect({ bridgeFile: chrome.descriptor });
  const other = await BridgeBrowser.connect({ bridgeFile: chrome.descriptor });
  t.after(async () => {
    await other.close().catch(() => {});
    await browser.close().catch(() => {});
    await chrome.close().catch(() => {});
    server.closeAllConnections?.();
    server.close();
    await rm(root, { recursive: true, force: true });
  });

  const tab = await browser.newTab();
  const state = await browser.getState({ screenshot: true });
  assert.match(state.axText, /<ax_state>/);
  assert.equal(state.url, "about:blank");
  assert.ok(state.screenshotBase64?.length > 100);

  const otherTab = await other.newTab();
  await assert.rejects(() => browser.selectTab(otherTab.tab_id), /unavailable/);
  await assert.rejects(() => other.selectTab(tab.tab_id), /unavailable/);
  await other.endTurn();

  if (process.env.BROWSER_USE_LIVE_NAVIGATION !== "1") return;

  await browser.goto(url, tab.tab_id);
  const loaded = await browser.getState({ screenshot: true });
  assert.match(loaded.axText, /textbox "Name"/);
  assert.match(loaded.axText, /button "Save"/);
  await browser.locatorFill("css=#name", "Ada");
  await browser.locatorClick('role=button[name="Save"]');
  const content = await browser.getContent();
  assert.match(content.text, /Hello Ada/);
  assert.equal((await browser.evaluate("document.getElementById('out').textContent")).value, "Hello Ada");
  await assert.rejects(() => browser.evaluate("document.body.innerHTML = 'x'"), /read-only/);
});
