import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createTabHandlers } from "../src/backend-tabs.js";
import { listenBackend } from "../src/backend-transport.js";
import { ReplSession } from "../src/repl-session.js";

test("page commands reject foreign tabs, browser-wide access and unenforceable network rules", async () => {
  const executed = [];
  const session = {session_id: "page", turn_id: "page-1"};
  const other = {session_id: "other", turn_id: "other-1"};
  const first = new AbortController();
  const second = new AbortController();
  const handlers = createTabHandlers({
    async createBlankTab() { return {id: 1}; },
    async readTab() { return {id: 1}; },
    async closeTab() {},
    async attach() {},
    async detach() {},
    /** @param {number} tabId @param {string} method @returns {Promise<object>} */
    async execute(tabId, method) {
      executed.push({tabId, method});
      return {};
    },
  }, {name: "Command fixture", version: "0.0.0", childFrames: true});
  try {
    handlers.get("getInfo")(session, first.signal, () => undefined);
    handlers.get("getInfo")(other, second.signal, () => undefined);
    await handlers.get("createTab")(session, first.signal);
    const target = {tabId: 1};
    await assert.rejects(handlers.get("attach")({...session, tabId: 1,
      networkPolicy: {constraints: [{kind: "domains", mode: "allowlist", patterns: []}]}}, first.signal), /cannot enforce/);
    await handlers.get("attach")({...session, tabId: 1}, first.signal);
    await assert.rejects(handlers.get("executeCdp")({...other, target, method: "Page.getFrameTree", commandParams: {}}, second.signal), /unavailable/);
    await assert.rejects(handlers.get("executeCdp")({...session, target, method: "Storage.getCookies", commandParams: {}}, first.signal), /Unsupported/);
    await assert.rejects(handlers.get("executeCdp")({...session, target, method: "Page.navigate", commandParams: {url: "javascript:alert(1)"}}, first.signal), /HTTP/);
    await assert.rejects(handlers.get("executeCdp")({...session, target: {...target, targetId: "different-target"}, method: "Page.getFrameTree", commandParams: {}}, first.signal), /child debugger session/);
    await assert.rejects(handlers.get("executeCdp")({...session, target, method: "Target.setAutoAttach",
      commandParams: {autoAttach: true, flatten: true, waitForDebuggerOnStart: false}}, first.signal), /child iframe targets/);
    await assert.rejects(handlers.get("executeCdp")({...other, target, method: "Page.handleJavaScriptDialog",
      commandParams: {accept: true}}, second.signal), /unavailable/);
    await assert.rejects(handlers.get("executeCdp")({...session, target, method: "Page.handleJavaScriptDialog",
      commandParams: {accept: true, promptText: 42}}, first.signal), /Invalid browser dialog/);
    await assert.rejects(handlers.get("executeCdp")({...session, target, method: "DOM.setFileInputFiles",
      commandParams: {backendNodeId: 1, files: ["relative/file.txt"]}}, first.signal), /absolute/);
    await handlers.get("executeCdp")({...session, target, method: "DOM.setFileInputFiles",
      commandParams: {backendNodeId: 1, files: ["/tmp/upload.txt"]}}, first.signal);
    await handlers.get("executeCdp")({...session, target, method: "DOMSnapshot.captureSnapshot",
      commandParams: {computedStyles: []}}, first.signal);
    await handlers.get("executeCdp")({...session, target, method: "Page.getFrameTree", commandParams: {}}, first.signal);
    await handlers.get("executeCdp")({...session, target, method: "Page.handleJavaScriptDialog",
      commandParams: {accept: true, promptText: "fixture"}}, first.signal);
    await assert.rejects(handlers.get("executeCdp")({...session, target, method: "Network.getResponseBody",
      commandParams: {requestId: ""}}, first.signal), /non-empty requestId/);
    await handlers.get("executeCdp")({...session, target, method: "Network.getResponseBody",
      commandParams: {requestId: "req-1"}}, first.signal);
    assert.deepEqual(executed, [
      {tabId: 1, method: "DOM.setFileInputFiles"},
      {tabId: 1, method: "DOMSnapshot.captureSnapshot"},
      {tabId: 1, method: "Page.getFrameTree"},
      {tabId: 1, method: "Page.handleJavaScriptDialog"},
      {tabId: 1, method: "Network.getResponseBody"},
    ]);
    await handlers.get("turnEnded")(session, first.signal);
  } finally {
    first.abort();
    second.abort();
  }
});

test("nameSession isolates tab groups per session, auto-groups new tabs, and validates inputs", async () => {
  let nextId = 1;
  let nextGroup = 10;
  const grouped = [];
  const tabs = new Map([[99, {id: 99, url: "https://private.example/"}]]);
  const first = new AbortController();
  const second = new AbortController();
  const a = {session_id: "sess-a", turn_id: "turn-a"};
  const b = {session_id: "sess-b", turn_id: "turn-b"};

  const handlers = createTabHandlers({
    async createBlankTab() {
      const tab = {id: nextId++, url: "about:blank", title: "Blank"};
      tabs.set(tab.id, tab);
      return tab;
    },
    async readTab(id) { return tabs.get(id) ?? null; },
    async closeTab(id) { tabs.delete(id); },
    async groupTabs(tabIds, options) {
      assert.equal(tabIds.includes(99), false);
      const groupId = options.groupId ?? nextGroup++;
      grouped.push({tabIds, title: options.title, color: options.color, groupId});
      return {groupId, supported: true};
    },
  }, {name: "Group fixture", version: "0.0.0"});

  try {
    handlers.get("getInfo")(a, first.signal, () => undefined);
    handlers.get("getInfo")(b, second.signal, () => undefined);

    // Existing tab in session A gets grouped when nameSession is called after createTab
    const tabA1 = await handlers.get("createTab")(a, first.signal);
    const namedA = await handlers.get("nameSession")({...a, name: "Alpha Flow", color: "purple"}, first.signal);
    assert.equal(namedA.groupId, 10);
    assert.equal(namedA.groupedTabs, 1);
    assert.equal(namedA.title, "Alpha Flow");

    // Subsequent tab in session A automatically joins group 10; session B stays isolated in group 11
    const tabA2 = await handlers.get("createTab")(a, first.signal);
    await handlers.get("nameSession")({...b, name: "Beta Flow", color: "orange"}, second.signal);
    const tabB1 = await handlers.get("createTab")(b, second.signal);

    assert.deepEqual(grouped, [
      {tabIds: [tabA1.id], title: "Alpha Flow", color: "purple", groupId: 10},
      {tabIds: [tabA2.id], title: "Alpha Flow", color: "purple", groupId: 10},
      {tabIds: [tabB1.id], title: "Beta Flow", color: "orange", groupId: 11},
    ]);

    await assert.rejects(handlers.get("nameSession")({...a, name: "   "}, first.signal), /non-empty/);
    await assert.rejects(handlers.get("nameSession")({...a, name: "Bad Color", color: "neon"}, first.signal), /color/);

    await handlers.get("turnEnded")(a, first.signal);
    await handlers.get("turnEnded")(b, second.signal);
  } finally {
    first.abort();
    second.abort();
  }
});

test("getUserTabs and claimUserTab allow claiming open user tabs, enforce session isolation, and release rather than close user tabs on turnEnded", async () => {
  const tabs = new Map([
    [50, { id: 50, url: "https://congnghieptot.vn/new_admin/addnew_group/132", title: "Existing User Tab", active: true }],
  ]);
  const closed = [];
  const released = [];
  const marked = [];
  const first = new AbortController();
  const second = new AbortController();
  const a = { session_id: "sess-a", turn_id: "turn-a1" };
  const b = { session_id: "sess-b", turn_id: "turn-b1" };

  const handlers = createTabHandlers({
    async createBlankTab() {
      const tab = { id: 60, url: "about:blank", title: "Agent Tab" };
      tabs.set(tab.id, tab);
      return tab;
    },
    async listTabs() {
      return [...tabs.values()];
    },
    async claimTab(id) {
      const tab = tabs.get(id);
      if (!tab) throw new Error("No tab");
      return { ...tab, owned: true, origin: "user" };
    },
    async readTabContext(id, opts) {
      const tab = tabs.get(id);
      if (!tab) throw new Error("No tab");
      return { title: tab.title, url: tab.url, format: opts?.format || "markdown", text: "# Passive", truncated: false };
    },
    async readTab(id) { return tabs.get(id) ?? null; },
    async closeTab(id) { closed.push(id); tabs.delete(id); },
    async releaseTab(id) { released.push(id); },
    async markTab(id, status) { marked.push({ id, status }); },
    async attach() {},
    async detach() {},
    async execute() { return {}; },
  }, { name: "User tab fixture", version: "0.5.5" });

  try {
    const infoA = handlers.get("getInfo")(a, first.signal, () => undefined);
    handlers.get("getInfo")(b, second.signal, () => undefined);
    assert.equal(infoA.apiSupportOverrides["BrowserUser.openTabs"], true);
    assert.equal(infoA.apiSupportOverrides["BrowserUser.getTabContext"], true);

    // Passive read works before claiming without adding tab 50 to session A
    const readA = await handlers.get("readTabContext")({ ...a, tabId: 50, format: "markdown" }, first.signal);
    assert.equal(readA.text, "# Passive");

    const openForA = await handlers.get("getUserTabs")(a, first.signal);
    assert.equal(openForA.length, 1);
    assert.equal(openForA[0].id, 50);
    assert.equal(openForA[0].owned, false);

    // Session A claims user tab 50
    const claimed = await handlers.get("claimUserTab")({ ...a, tabId: 50 }, first.signal);
    assert.equal(claimed.id, 50);
    assert.equal(claimed.owned, true);
    assert.equal(claimed.origin, "user");

    // Session B cannot see, read passively, or claim tab 50 while Session A owns it
    const openForB = await handlers.get("getUserTabs")(b, second.signal);
    assert.equal(openForB.length, 0);
    await assert.rejects(handlers.get("readTabContext")({ ...b, tabId: 50 }, second.signal), /unavailable/);
    await assert.rejects(handlers.get("claimUserTab")({ ...b, tabId: 50 }, second.signal), /unavailable/);

    // Session A also creates an ephemeral agent tab 60, then ends turn without marking either tab
    await handlers.get("createTab")(a, first.signal);
    await handlers.get("turnEnded")(a, first.signal);

    // Ephemeral agent tab 60 is closed, while claimed user tab 50 is released and left open!
    assert.deepEqual(closed, [60]);
    assert.deepEqual(released, [50]);
    assert.equal(tabs.has(50), true);
  } finally {
    first.abort();
    second.abort();
  }
});

test("claimUserTab groups claimed user tabs into the session group (or default group) and keeps them grouped after turnEnded", async () => {
  const tabs = new Map([
    [51, { id: 51, url: "https://example.com/user-tab", title: "User Tab", active: true }],
  ]);
  const grouped = [];
  const released = [];
  const ungrouped = [];
  const ac = new AbortController();
  const sess = { session_id: "sess-group-user", turn_id: "turn-1" };

  const handlers = createTabHandlers({
    async createBlankTab() { return { id: 61, url: "about:blank" }; },
    async listTabs() { return [...tabs.values()]; },
    async claimTab(id) { return { ...tabs.get(id), owned: true, origin: "user" }; },
    async readTab(id) { return tabs.get(id) ?? null; },
    async closeTab(id) { tabs.delete(id); },
    async releaseTab(id) { released.push(id); },
    async groupTabs(tabIds, opts) {
      const gid = opts.groupId ?? 88;
      grouped.push({ tabIds, title: opts.title, color: opts.color, groupId: gid });
      return { groupId: gid, supported: true };
    },
    async ungroupTabs(tabIds) { ungrouped.push(tabIds); },
  }, { name: "Group claimed tab fixture", version: "4.7.1" });

  try {
    handlers.get("getInfo")(sess, ac.signal, () => {});
    // Claiming without prior nameSession auto-creates default session group
    const claimed = await handlers.get("claimUserTab")({ ...sess, tabId: 51 }, ac.signal);
    assert.equal(claimed.id, 51);
    assert.equal(grouped.length, 1);
    assert.deepEqual(grouped[0], { tabIds: [51], title: "🔎 Browser Use", color: "blue", groupId: 88 });

    // Calling nameSession afterward reuses the same groupId 88 to rename/recolor it
    const named = await handlers.get("nameSession")({ ...sess, name: "CNT Admin", color: "green" }, ac.signal);
    assert.equal(named.groupId, 88);
    assert.equal(named.groupedTabs, 1);
    assert.deepEqual(grouped[1], { tabIds: [51], title: "CNT Admin", color: "green", groupId: 88 });

    // Ending turn releases tab 51 without closing or ungrouping it
    await handlers.get("turnEnded")(sess, ac.signal);
    assert.deepEqual(released, [51]);
    assert.deepEqual(ungrouped, []);
    assert.equal(tabs.has(51), true);
  } finally {
    ac.abort();
  }
});

test("onTabCreated auto-claims popup child tabs into the opener's session and tab group", async () => {
  let emitDriverEvent = () => {};
  const notifications = [];
  const grouped = [];
  const tabs = new Map([[1, { id: 1, url: "https://app.example/", title: "App" }]]);
  const acA = new AbortController();
  const acB = new AbortController();
  const sessA = { session_id: "sess-a", turn_id: "t-a1" };
  const sessB = { session_id: "sess-b", turn_id: "t-b1" };

  const handlers = createTabHandlers({
    async createBlankTab() { return tabs.get(1); },
    async readTab(id) { return tabs.get(id) ?? null; },
    async closeTab(id) { tabs.delete(id); },
    async groupTabs(tabIds, opts) { grouped.push({ tabIds, title: opts.title }); return { groupId: 77, supported: true }; },
    onEvent(fn) { emitDriverEvent = fn; },
  }, { name: "Popup fixture", version: "0.6.0" });

  try {
    handlers.get("getInfo")(sessA, acA.signal, (method, params) => notifications.push({ method, params }));
    handlers.get("getInfo")(sessB, acB.signal, () => {});
    await handlers.get("createTab")(sessA, acA.signal);
    await handlers.get("nameSession")({ ...sessA, name: "Work", color: "blue" }, acA.signal);

    // Driver emits onTabCreated for child popup 99 opened from tab 1
    const child = { id: 99, url: "https://app.example/popup", title: "Popup", active: false };
    tabs.set(99, child);
    emitDriverEvent("onTabCreated", 1, { openerTabId: 1, tab: child });
    await Promise.resolve();

    const aTabs = await handlers.get("getTabs")(sessA, acA.signal);
    const bTabs = await handlers.get("getTabs")(sessB, acB.signal);
    assert.deepEqual(aTabs.map((t) => t.id), [1, 99]);
    assert.deepEqual(bTabs, []);
    assert.equal(notifications.some((n) => n.method === "onTabCreated" && n.params.tab.id === 99), true);
    assert.equal(grouped.some((g) => g.tabIds.includes(99) && g.title === "Work"), true);
    await handlers.get("turnEnded")(sessA, acA.signal);
    assert.equal(tabs.size, 0);
  } finally {
    acA.abort();
    acB.abort();
  }
});

/** @returns {{tabs:Map<number,object>,handlers:ReturnType<typeof createTabHandlers>}} */
function fixture() {
  let next = 1;
  const tabs = new Map([[99, {id: 99, url: "https://private.example/"}]]);
  const handlers = createTabHandlers({
    async createBlankTab() {
      const tab = {id: next++, url: "about:blank", title: "Blank fixture"};
      tabs.set(tab.id, tab);
      return tab;
    },
    /** @param {number} id @returns {Promise<object|null>} */
    async readTab(id) {
      return tabs.get(id) ?? null;
    },
    /** @param {number} id @returns {Promise<void>} */
    async closeTab(id) {
      tabs.delete(id);
    },
  }, {name: "Project-owned tab fixture", version: "0.0.0"});
  return {tabs, handlers};
}

test("a tab cannot be read or retained by a different session or a renamed connection", async () => {
  const {tabs, handlers} = fixture();
  const a = {session_id: "a", turn_id: "a-1"};
  const b = {session_id: "b", turn_id: "b-1"};
  const one = new AbortController();
  const two = new AbortController();
  handlers.get("getInfo")(a, one.signal);
  handlers.get("getInfo")(b, two.signal);
  try {
    const {id} = await handlers.get("createTab")(a, one.signal);
    assert.deepEqual(await handlers.get("getTabs")(b, two.signal), []);
    await assert.rejects(handlers.get("getCommittedTabUrl")({...b, tabId: id}, two.signal), /unavailable/);
    assert.throws(() => handlers.get("markTab")({...b, tabId: id, status: "handoff"}, two.signal), /unavailable/);
    assert.throws(() => handlers.get("getInfo")(a, two.signal), /another connection/);
    assert.deepEqual(await handlers.get("getTabs")(a, one.signal), [tabs.get(id)]);
    await handlers.get("turnEnded")(a, one.signal);
    assert.deepEqual([...tabs.keys()], [99]);
    await assert.rejects(handlers.get("createTab")(a, one.signal), /turn has ended/);
  } finally {
    one.abort();
    two.abort();
  }
});

test("two original engine workers create scoped tabs and preserve handoffs across turns", {
  skip: !process.env.BROWSER_USE_TEST_ENGINE,
  timeout: 15000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "browser-tabs-test-"));
  const {tabs, handlers} = fixture();
  const backend = await listenBackend(handlers);
  const sessions = Array.from({length: 2}, () => new ReplSession({
    enginePath: process.env.BROWSER_USE_TEST_ENGINE,
    hostConfigRoot: root,
    env: {BROWSER_USE_BACKEND_PATHS: backend.socketPath},
  }));
  /** @param {ReplSession} session @param {string} code @returns {Promise<string>} */
  async function run(session, code) {
    const result = await session.evaluate(code, {timeoutMs: 6000});
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
  }
  try {
    const [a, b] = await Promise.all(sessions.map((session) => run(session,
      'const browser = await agent.browsers.get("chrome"); const tab = await browser.tabs.new(); nodeRepl.write(tab.id);')));
    assert.notEqual(a, b);
    const own = 'nodeRepl.write(JSON.stringify((await browser.tabs.list()).map(({id}) => id)));';
    assert.deepEqual(JSON.parse(await run(sessions[0], own)).map(String), [a]);
    assert.deepEqual(JSON.parse(await run(sessions[1], own)).map(String), [b]);
    await run(sessions[0], 'await tab.markHandoff();');
    await run(sessions[1], 'await tab.markDeliverable(); const temporary = await browser.tabs.new(); nodeRepl.write(temporary.id);');
    const ended = await Promise.all(sessions.map((session) => session.endTurn()));
    for (const result of ended) assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.deepEqual([...tabs.keys()].map(String).sort(), ["99", a, b].sort());
    assert.deepEqual(JSON.parse(await run(sessions[0], own)).map(String), [a]);
    assert.deepEqual(JSON.parse(await run(sessions[1], own)), []);
    await sessions[0].endTurn();
    assert.deepEqual([...tabs.keys()].map(String).sort(), ["99", b].sort());
  } finally {
    try { await Promise.all(sessions.map((session) => session.close())); }
    finally {
      await backend.close();
      await rm(root, {recursive: true, force: true});
    }
  }
});

test("navigateTab validates schemes and delegates owned tabs to the driver", async () => {
  const navigations = [];
  const watches = [];
  const first = new AbortController();
  const second = new AbortController();
  const session = {session_id: "nav", turn_id: "nav-1"};
  const other = {session_id: "other-nav", turn_id: "other-nav-1"};
  const handlers = createTabHandlers({
    async createBlankTab() { return {id: 1}; },
    async readTab() { return {id: 1}; },
    async closeTab() {},
    async attach() {},
    async detach() {},
    async execute() { return {}; },
    /** @param {number} id @param {string} url */
    async navigate(id, url) { navigations.push({id, url}); },
    /** @param {number} id */
    async watchDownloads(id) { watches.push({op: "watch", id}); },
    /** @param {number} id */
    async unwatchDownloads(id) { watches.push({op: "unwatch", id}); },
  }, {name: "Navigate fixture", version: "0.0.0"});
  try {
    handlers.get("getInfo")(session, first.signal, () => undefined);
    handlers.get("getInfo")(other, second.signal, () => undefined);
    await handlers.get("createTab")(session, first.signal);
    await handlers.get("attach")({...session, tabId: 1}, first.signal);
    await handlers.get("navigateTab")({...session, tabId: 1, url: "file:///tmp/index.html"}, first.signal);
    await handlers.get("navigateTab")({...session, tabId: 1, url: "data:text/html,<h1>x</h1>"}, first.signal);
    assert.deepEqual(navigations.map((entry) => entry.url), ["file:///tmp/index.html", "data:text/html,<h1>x</h1>"]);
    await assert.rejects(handlers.get("navigateTab")({...session, tabId: 1, url: "javascript:alert(1)"}, first.signal), /HTTP/);
    await assert.rejects(handlers.get("navigateTab")({...session, tabId: 99, url: "https://example.com/"}, first.signal), /unavailable/);

    // Viewport override, file chooser interception validation, and owned download watchers
    await handlers.get("executeCdp")({...session, target: {tabId: 1}, method: "Emulation.setDeviceMetricsOverride",
      commandParams: {width: 390, height: 844, deviceScaleFactor: 2, mobile: true}}, first.signal);
    await handlers.get("executeCdp")({...session, target: {tabId: 1}, method: "Emulation.clearDeviceMetricsOverride",
      commandParams: {}}, first.signal);
    await assert.rejects(handlers.get("executeCdp")({...session, target: {tabId: 1}, method: "Emulation.setDeviceMetricsOverride",
      commandParams: {width: 50, height: 844, deviceScaleFactor: 1, mobile: false}}, first.signal), /viewport/);
    await handlers.get("executeCdp")({...session, target: {tabId: 1}, method: "Page.setInterceptFileChooserDialog",
      commandParams: {enabled: true}}, first.signal);
    await assert.rejects(handlers.get("executeCdp")({...session, target: {tabId: 1}, method: "Page.setInterceptFileChooserDialog",
      commandParams: {enabled: "yes"}}, first.signal), /boolean/);

    await handlers.get("watchDownloads")({...session, tabId: 1}, first.signal);
    await assert.rejects(handlers.get("watchDownloads")({...other, tabId: 1}, second.signal), /unavailable/);
    await handlers.get("unwatchDownloads")({...session, tabId: 1}, first.signal);
    assert.deepEqual(watches, [{op: "watch", id: 1}, {op: "unwatch", id: 1}]);

    await handlers.get("turnEnded")(session, first.signal);
  } finally {
    first.abort();
    second.abort();
  }
});

test("session groupId persists across turns for deliverable tabs and turnEnded({ ungroup: true }) dissolves the group cleanly", async () => {
  let nextId = 1;
  let nextGroup = 90;
  const grouped = [];
  const ungrouped = [];
  const tabs = new Map();
  const ac1 = new AbortController();
  const s1 = { session_id: "persist-sess", turn_id: "turn-1" };
  const s2 = { session_id: "persist-sess", turn_id: "turn-2" };

  const handlers = createTabHandlers({
    async createBlankTab() {
      const tab = { id: nextId++, url: "about:blank", title: "Preview" };
      tabs.set(tab.id, tab);
      return tab;
    },
    async readTab(id) { return tabs.get(id) ?? null; },
    async closeTab(id) { tabs.delete(id); },
    async releaseTab() {},
    async markTab() {},
    async groupTabs(tabIds, opts) {
      const gid = opts.groupId ?? nextGroup++;
      grouped.push({ tabIds, title: opts.title, groupId: gid, sessionId: opts.sessionId });
      return { groupId: gid, supported: true };
    },
    async ungroupTabs(tabIds) {
      ungrouped.push([...tabIds]);
      return { ok: true, ungrouped: tabIds.length, supported: true };
    },
  }, { name: "Persist group fixture", version: "0.6.3" });

  try {
    handlers.get("getInfo")(s1, ac1.signal, () => undefined);
    await handlers.get("nameSession")({ ...s1, name: "Preview QA", color: "blue" }, ac1.signal);
    const t1 = await handlers.get("createTab")(s1, ac1.signal);
    await handlers.get("markTab")({ ...s1, tabId: t1.id, status: "deliverable", focus: true }, ac1.signal);
    await handlers.get("turnEnded")(s1, ac1.signal);
    assert.equal(ungrouped.length, 0);

    // Turn 2 on the same session reuses exact same groupId 90!
    const t2 = await handlers.get("createTab")(s2, ac1.signal);
    assert.equal(grouped.at(-1).groupId, 90);
    assert.equal(grouped.at(-1).sessionId, "persist-sess");
    assert.equal(nextGroup, 91);

    // Marking t2 deliverable and passing ungroup: true dissolves group and resets groupId
    await handlers.get("markTab")({ ...s2, tabId: t2.id, status: "deliverable" }, ac1.signal);
    await handlers.get("turnEnded")({ ...s2, ungroup: true }, ac1.signal);
    assert.deepEqual(ungrouped, [[t2.id]]);

    // Turn 3 creates a fresh groupId 91 now that the previous group was dissolved
    const s3 = { session_id: "persist-sess", turn_id: "turn-3" };
    await handlers.get("createTab")(s3, ac1.signal);
    assert.equal(grouped.at(-1).groupId, 91);
  } finally {
    ac1.abort();
  }
});
