import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { configureClient, installExtension, installRules, installSkill } from "../src/install.js";
import { EXTENSION_ID, EXTENSION_VERSION, extensionSource } from "../src/extension.js";

async function extensionFixture(root, version = EXTENSION_VERSION) {
  const source = path.join(root, "source");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "manifest.json"), JSON.stringify({ manifest_version: 3, version }));
  await writeFile(path.join(source, "background.js"), "// fixture\n");
  return source;
}

test("installExtension copies once and replaces with a backup on version change", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "browser-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await extensionFixture(root);
  const destination = path.join(root, "installed");

  const first = await installExtension({ source, destination });
  assert.equal(first.changed, true);
  assert.equal(first.id, EXTENSION_ID);
  assert.equal(first.version, EXTENSION_VERSION);
  assert.equal(JSON.parse(await readFile(path.join(destination, "manifest.json"), "utf8")).version, EXTENSION_VERSION);

  const second = await installExtension({ source, destination });
  assert.equal(second.changed, false);
  assert.equal(second.backup, null);

  await writeFile(path.join(destination, "manifest.json"), JSON.stringify({ manifest_version: 3, version: "0.0.1" }));
  const third = await installExtension({ source, destination });
  assert.equal(third.changed, true);
  assert.equal(third.backup, `${destination}.bak`);
  assert.equal(JSON.parse(await readFile(path.join(third.backup, "manifest.json"), "utf8")).version, "0.0.1");
});

test("installExtension rejects a bundle whose version is not the expected release", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "browser-install-bad-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await extensionFixture(root, "9.9.9");
  await assert.rejects(
    () => installExtension({ source, destination: path.join(root, "installed") }),
    /Bundled extension is 9\.9\.9, expected/,
  );
});

test("configureClient merges one entry, preserves unrelated settings, and backs up", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "browser-client-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, ".commandcode", "mcp.json");
  await mkdir(path.dirname(file), { recursive: true });
  const original = { theme: "dark", mcpServers: { other: { command: "other" } } };
  await writeFile(file, JSON.stringify(original));

  const result = await configureClient({ client: "commandcode", bridgeFile: "/bridge.json", write: true, home });
  assert.equal(result.written, true);
  assert.equal(result.backup, `${file}.bak`);
  const merged = JSON.parse(await readFile(file, "utf8"));
  assert.equal(merged.theme, "dark");
  assert.deepEqual(merged.mcpServers.other, { command: "other" });
  assert.equal(merged.mcpServers["browser-use"].transport, "stdio");
  assert.deepEqual(merged.mcpServers["browser-use"].env, { BROWSER_USE_BRIDGE_FILE: "/bridge.json" });
  assert.deepEqual(JSON.parse(await readFile(`${file}.bak`, "utf8")), original);
});

test("configureClient prints instead of writing when write is false or the client is print-only", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "browser-client-print-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const preview = await configureClient({ client: "commandcode", bridgeFile: "/bridge.json", write: false, home });
  assert.equal(preview.written, false);
  assert.equal(preview.config.mcpServers["browser-use"].transport, "stdio");
  const opencode = await configureClient({ client: "opencode", bridgeFile: "/bridge.json", write: true, home });
  assert.equal(opencode.written, false);
  assert.equal(opencode.config.mcp.servers["browser-use"].type, "local");
  await assert.rejects(
    () => configureClient({ client: "invented", bridgeFile: "/bridge.json", write: true, home }),
    /Unknown client/,
  );
});

test("installSkill writes SKILL.md and companion references/cookbook.md with backup on overwrite", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "browser-skill-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const agy = await installSkill({ client: "antigravity", home });
  assert.equal(agy.written, true);
  assert.equal(agy.file, path.join(home, ".gemini", "config", "skills", "codex-browser-use", "SKILL.md"));
  assert.equal(agy.backup, null);
  assert.ok(agy.files.includes("SKILL.md"));
  assert.ok(agy.files.includes("references/cookbook.md"));
  assert.ok(agy.files.includes("references/tools.md"));
  assert.match(await readFile(agy.file, "utf8"), /browser_batch/);
  assert.match(await readFile(path.join(agy.dir, "references", "cookbook.md"), "utf8"), /saveFile/);

  await writeFile(agy.file, "old skill\n");
  const updated = await installSkill({ client: "agy", home });
  assert.equal(updated.backup, `${agy.file}.bak`);
  assert.equal(await readFile(updated.backup, "utf8"), "old skill\n");

  const cursor = await installSkill({ client: "cursor", home });
  assert.equal(cursor.file, path.join(home, ".cursor", "skills", "codex-browser-use", "SKILL.md"));
  assert.ok(cursor.files.includes("references/cookbook.md"));
  const windsurf = await installSkill({ client: "windsurf", home });
  assert.equal(windsurf.file, path.join(home, ".codeium", "windsurf", "skills", "codex-browser-use", "SKILL.md"));
});

test("installRules writes client-appropriate rule files and skips skill-only clients", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "browser-rules-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const agy = await installRules({ client: "antigravity", home });
  assert.equal(agy.written, true);
  assert.equal(agy.file, path.join(home, ".gemini", "config", "rules", "browser_use.md"));
  assert.match(await readFile(agy.file, "utf8"), /trigger: always_on/);

  await writeFile(agy.file, "old rule\n");
  const agyUpdated = await installRules({ client: "antigravity", home });
  assert.equal(agyUpdated.backup, `${agy.file}.bak`);
  assert.equal(await readFile(agyUpdated.backup, "utf8"), "old rule\n");

  const cc = await installRules({ client: "commandcode", home });
  assert.equal(cc.written, true);
  assert.equal(cc.file, path.join(home, ".agents", "rules", "browser_use.md"));

  const cursor = await installRules({ client: "cursor", home });
  assert.equal(cursor.written, true);
  assert.equal(cursor.file, path.join(home, ".cursor", "rules", "browser_use.mdc"));
  assert.match(await readFile(cursor.file, "utf8"), /alwaysApply: true/);

  const windsurf = await installRules({ client: "windsurf", home });
  assert.equal(windsurf.written, true);
  assert.equal(windsurf.file, path.join(home, ".codeium", "windsurf", "rules", "browser_use.md"));

  const claude = await installRules({ client: "claude_code", home });
  assert.equal(claude.written, false);
  assert.equal(claude.skipped, true);
  assert.equal(claude.file, null);

  const codex = await installRules({ client: "codex", home });
  assert.equal(codex.written, false);
  assert.equal(codex.skipped, true);
});

test("bundled extension manifest bundles 16/32/48/128 PNG icons matching EXTENSION_VERSION", async () => {
  const manifest = JSON.parse(await readFile(path.join(extensionSource, "manifest.json"), "utf8"));
  assert.equal(manifest.version, EXTENSION_VERSION);
  for (const size of ["16", "32", "48", "128"]) {
    assert.equal(manifest.icons?.[size], `icons/icon-${size}.png`);
    assert.equal(manifest.action?.default_icon?.[size], `icons/icon-${size}.png`);
    const bytes = await readFile(path.join(extensionSource, manifest.icons[size]));
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  }
});

test("bundled content-script renders inline SVG cursor without cross-origin extension URLs", async () => {
  const manifest = JSON.parse(await readFile(path.join(extensionSource, "manifest.json"), "utf8"));
  assert.equal(manifest.web_accessible_resources, undefined);

  const contentScript = await readFile(path.join(extensionSource, "content-script.js"), "utf8");
  assert.equal(contentScript.includes("chrome.runtime.getURL"), false);
  assert.equal(contentScript.includes("cursor-chat.png"), false);
  assert.equal(contentScript.includes("chrome-extension://"), false);
  assert.equal(contentScript.includes('createElementNS("http://www.w3.org/2000/svg","svg")'), true);
});

test("bundled content-script tolerates invalidated chrome.runtime without throwing sendMessage errors", async () => {
  const source = await readFile(path.join(extensionSource, "content-script.js"), "utf8");
  const windowListeners = new Map();
  const docListeners = new Map();
  const observerCallbacks = [];
  const createEl = () => ({
    style: { setProperty() {} },
    dataset: {},
    children: [],
    isConnected: true,
    setAttribute() {},
    appendChild(c) { this.children.push(c); return c; },
    replaceChildren(...c) { this.children = c; },
    attachShadow() { return createEl(); },
    remove() { this.isConnected = false; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
  });
  const docEl = createEl();
  const mockDoc = {
    documentElement: docEl,
    head: null,
    getElementById: () => null,
    querySelectorAll: () => [],
    createElement: createEl,
    createElementNS: () => createEl(),
    dispatchEvent() {},
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { docListeners.get(type)?.delete(fn); },
  };
  const chromeObj = {
    runtime: {
      id: "ehooacpcolldccnemjebdnmfgmgekghn",
      sendMessage: () => Promise.resolve({ ok: false }),
      onMessage: { addListener() {}, removeListener() {} },
    },
  };
  const sandbox = {
    window: {
      innerWidth: 1280,
      innerHeight: 800,
      setTimeout,
      clearTimeout,
      requestAnimationFrame: () => 0,
      cancelAnimationFrame() {},
      addEventListener(type, fn) {
        if (!windowListeners.has(type)) windowListeners.set(type, new Set());
        windowListeners.get(type).add(fn);
      },
      removeEventListener(type, fn) { windowListeners.get(type)?.delete(fn); },
      dispatchEvent() {},
      postMessage() {},
    },
    document: mockDoc,
    chrome: chromeObj,
    Event: class Event {},
    CustomEvent: class CustomEvent { constructor(_t, i) { this.detail = i?.detail; } },
    HTMLDivElement: class HTMLDivElement {},
    HTMLLinkElement: class HTMLLinkElement {},
    SVGElement: class SVGElement {},
    AbortController: class AbortController { constructor() { this.signal = { aborted: false, addEventListener() {}, removeEventListener() {} }; } abort() { this.signal.aborted = true; } },
    MutationObserver: class MutationObserver { constructor(cb) { observerCallbacks.push(cb); } observe() {} disconnect() {} },
    TextEncoder,
    TextDecoder,
    URL,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    requestIdleCallback: () => 0,
    cancelIdleCallback() {},
    performance: { now: () => 0 },
  };
  sandbox.globalThis = sandbox;
  sandbox.location = { href: "https://example.com" };

  await assert.doesNotReject(async () => {
    await runInNewContext(source, sandbox);
    // Simulate extension reload invalidating chrome.runtime completely (undefined)
    chromeObj.runtime = undefined;
    for (const fn of windowListeners.get("pageshow") ?? []) fn();
    for (const cb of observerCallbacks) cb([]);
    // Also simulate entirely undefined chrome object
    sandbox.chrome = undefined;
    for (const fn of windowListeners.get("pageshow") ?? []) fn();
    for (const cb of observerCallbacks) cb([]);
  });
});

test("bundled content-script animates Bezier cursor moves and VisualViewport resizes without rt name collision", async () => {
  const source = await readFile(new URL("../extension/content-script.js", import.meta.url), "utf8");
  const windowListeners = new Map();
  const vvListeners = new Map();
  const messageListeners = new Set();
  const createEl = () => ({
    style: { setProperty() {} },
    dataset: {},
    children: [],
    isConnected: true,
    setAttribute() {},
    appendChild(c) { this.children.push(c); return c; },
    replaceChildren(...c) { this.children = c; },
    attachShadow() { return createEl(); },
    remove() { this.isConnected = false; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
  });
  const docEl = createEl();
  const vv = {
    width: 1280,
    height: 800,
    offsetLeft: 0,
    offsetTop: 0,
    addEventListener(type, fn) {
      if (!vvListeners.has(type)) vvListeners.set(type, new Set());
      vvListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { vvListeners.get(type)?.delete(fn); },
  };
  let nowMs = 0;
  let rafId = 0;
  const rafQueue = [];
  const sandbox = {
    window: {
      innerWidth: 1280,
      innerHeight: 800,
      visualViewport: vv,
      setTimeout,
      clearTimeout,
      requestAnimationFrame: (cb) => { rafQueue.push(cb); return ++rafId; },
      cancelAnimationFrame() {},
      addEventListener(type, fn) {
        if (!windowListeners.has(type)) windowListeners.set(type, new Set());
        windowListeners.get(type).add(fn);
      },
      removeEventListener(type, fn) { windowListeners.get(type)?.delete(fn); },
      dispatchEvent() {},
      postMessage() {},
    },
    visualViewport: vv,
    document: {
      documentElement: docEl,
      head: null,
      getElementById: () => null,
      querySelectorAll: () => [],
      createElement: createEl,
      createElementNS: () => createEl(),
      dispatchEvent() {},
      addEventListener() {},
      removeEventListener() {},
    },
    chrome: {
      runtime: {
        id: "ehooacpcolldccnemjebdnmfgmgekghn",
        sendMessage: () => Promise.resolve({ ok: true }),
        onMessage: {
          addListener(fn) { messageListeners.add(fn); },
          removeListener(fn) { messageListeners.delete(fn); },
        },
      },
    },
    Event: class Event {},
    CustomEvent: class CustomEvent { constructor(_t, i) { this.detail = i?.detail; } },
    HTMLDivElement: class HTMLDivElement {},
    HTMLLinkElement: class HTMLLinkElement {},
    SVGElement: class SVGElement {},
    AbortController: class AbortController { constructor() { this.signal = { aborted: false, addEventListener() {}, removeEventListener() {} }; } abort() { this.signal.aborted = true; } },
    MutationObserver: class MutationObserver { observe() {} disconnect() {} },
    TextEncoder,
    TextDecoder,
    URL,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (cb) => { rafQueue.push(cb); return ++rafId; },
    cancelAnimationFrame() {},
    requestIdleCallback: () => 0,
    cancelIdleCallback() {},
    performance: { now: () => nowMs },
  };
  sandbox.globalThis = sandbox;
  sandbox.location = { href: "https://example.com" };

  runInNewContext(source, sandbox);
  assert.ok(messageListeners.size >= 1);

  const sendState = (state) => {
    for (const fn of messageListeners) {
      fn({ type: "AGENT_CURSOR_STATE", state }, {}, () => {});
    }
  };

  // Two cursor updates >100px apart trigger Bezier planning rt({bounds,end,start}) + ve(e.segments), followed by resize
  assert.doesNotThrow(() => {
    sendState({
      isVisible: true,
      sessionId: "sess-1",
      turnId: "turn-1",
      cursor: { x: 40, y: 40, visible: true, animateMovement: true, moveSequence: 1 },
    });
    sendState({
      isVisible: true,
      sessionId: "sess-1",
      turnId: "turn-1",
      cursor: { x: 420, y: 310, visible: true, animateMovement: true, moveSequence: 2 },
    });
    nowMs = 16;
    while (rafQueue.length > 0 && nowMs <= 64) {
      const cb = rafQueue.shift();
      cb?.(nowMs);
      nowMs += 16;
    }
    for (const fn of vvListeners.get("resize") ?? []) fn();
    for (const fn of windowListeners.get("resize") ?? []) fn();
  });
});
