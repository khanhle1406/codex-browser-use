import {validateNetworkPolicy, validatePageCommand} from "./backend-page-commands.js";

/** @typedef {{id:number, title?:string, url?:string, active?:boolean, owned?:boolean, origin?:"agent"|"user"}} BrowserTab */
/** @typedef {{createBlankTab:()=>Promise<BrowserTab>, listTabs?:()=>Promise<BrowserTab[]>, claimTab?:(id:number)=>Promise<BrowserTab>, readTab:(id:number)=>Promise<BrowserTab|null>, closeTab:(id:number)=>Promise<void>, releaseTab?:(id:number)=>Promise<void>, markTab?:(id:number,status:TabMark)=>Promise<void>, moveCursor?:(id:number,x:number,y:number,waitForArrival?:boolean)=>Promise<void>, attach?:(id:number)=>Promise<void>, detach?:(id:number)=>Promise<void>, navigate?:(id:number,url:string)=>Promise<void>, watchDownloads?:(id:number)=>Promise<void>, unwatchDownloads?:(id:number)=>Promise<void>, groupTabs?:(tabIds:number[],options:{title?:string,color?:string,groupId?:number|null})=>Promise<{groupId:number|null,supported?:boolean}>, execute?:(id:number,method:string,params:RpcParams,childSession?:string)=>Promise<unknown>, onEvent?:(listener:(method:string, id:number, params:RpcParams)=>void)=>void}} TabDriver */
/** @typedef {"handoff"|"deliverable"} TabMark */
/** @typedef {{id:string, turn:string|null, ended:Set<string>, tabs:Map<number,TabMark|null>, userTabs:Set<number>, attached:Set<number>, group:null|{title:string,color:string,groupId:number|null}, groupLock:Promise<void>, notify:Notify, cleanup?:Promise<void>}} TabSession */
/** @typedef {Record<string,unknown>} RpcParams */
/** @typedef {(method:string,params:RpcParams)=>void} Notify */
/** @typedef {(params:RpcParams,signal:AbortSignal,notify:Notify)=>unknown|Promise<unknown>} RpcHandler */

const TAB_GROUP_COLORS = new Set(["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]);

/** @param {unknown} value @param {string} field @returns {string} */
function identity(value, field) {
  if (typeof value !== "string" || !/^[\w-]{1,128}$/u.test(value)) {
    throw new Error(`Invalid browser request ${field}`);
  }
  return value;
}

/** @param {unknown} value @returns {TabMark} */
function mark(value) {
  if (value !== "handoff" && value !== "deliverable") throw new Error("Invalid browser tab mark");
  return value;
}

/** @param {TabSession} session @param {unknown} id @returns {number} */
function requireOwnedTab(session, id) {
  if (typeof id !== "number" || !session.tabs.has(id)) {
    throw new Error("Browser tab is unavailable to this session");
  }
  return id;
}

/**
 * Implement the installed engine's tab lifecycle for project-created tabs.
 * Driver methods operate on fresh tabs and treat already closed tabs as closed.
 * @param {TabDriver} driver
 * @param {{name:string, version:string, childFrames?:boolean, onCleanupError?:(error:unknown)=>void}} options
 * @returns {ReadonlyMap<string,RpcHandler>}
 */
export function createTabHandlers(driver, options) {
  /** @type {Map<string,AbortSignal>} */
  const connections = new Map();
  /** @type {WeakMap<AbortSignal,TabSession>} */
  const sessions = new WeakMap();
  /** @type {Map<number,TabSession>} */
  const owners = new Map();
  driver.onEvent?.((method, id, params) => {
    const session = owners.get(id);
    if (!session?.attached.has(id)) return;
    if (method === "onCDPDetach") session.attached.delete(id);
    session.notify(method, params);
  });

  /** @param {TabSession} session @param {number} id @returns {void} */
  function release(session, id) {
    session.tabs.delete(id);
    session.userTabs.delete(id);
    session.attached.delete(id);
    owners.delete(id);
  }

  /** @param {TabSession} session @param {number[]} tabIds */
  function applySessionGroup(session, tabIds) {
    const run = async () => {
      if (!session.group || !driver.groupTabs) {
        return { groupId: session.group?.groupId ?? null, supported: false };
      }
      const ownedIds = tabIds.filter((id) => session.tabs.has(id) && !session.userTabs.has(id));
      if (ownedIds.length === 0) {
        return { groupId: session.group.groupId, supported: true };
      }
      try {
        const res = await driver.groupTabs(ownedIds, session.group);
        if (Number.isSafeInteger(res?.groupId)) {
          session.group.groupId = res.groupId;
        }
        return { groupId: session.group.groupId, supported: res?.supported !== false };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/Unknown Chrome bridge request/i.test(message)) {
          return { groupId: null, supported: false };
        }
        throw error;
      }
    };
    const next = (session.groupLock ?? Promise.resolve()).then(run, run);
    session.groupLock = next.catch(() => {});
    return next;
  }

  /** @param {TabSession} session @param {boolean} disconnected @returns {Promise<void>} */
  async function cleanTabs(session, disconnected) {
    const results = await Promise.allSettled([...session.tabs].map(async ([id, status]) => {
      const isUserTab = session.userTabs.has(id);
      if (session.attached.has(id)) {
        await driver.detach?.(id);
        session.attached.delete(id);
      }
      if (status === "handoff" && !disconnected) return;
      if (status === null && !isUserTab) await driver.closeTab(id);
      else await driver.releaseTab?.(id);
      release(session, id);
    }));
    if (session.tabs.size === 0 && session.group) {
      session.group.groupId = null;
    }
    const errors = results.filter((result) => result.status === "rejected");
    if (errors.length) throw new AggregateError(errors.map((error) => error.reason), "Browser tab cleanup failed");
  }

  /** @param {RpcParams} params @param {AbortSignal} signal @returns {TabSession} */
  function getSession(params, signal) {
    signal.throwIfAborted();
    const id = identity(params.session_id, "session_id");
    const session = sessions.get(signal);
    if (!session || session.id !== id) throw new Error("Browser session does not match this connection");
    return session;
  }

  /** @param {RpcParams} params @param {AbortSignal} signal @returns {TabSession} */
  function activateTurn(params, signal) {
    const session = getSession(params, signal);
    const turn = identity(params.turn_id, "turn_id");
    if (session.ended.has(turn)) throw new Error("Browser turn has ended");
    if (session.turn !== null && session.turn !== turn) throw new Error("Browser session has an unfinished turn");
    if (session.turn === null) {
      session.turn = turn;
      for (const id of session.tabs.keys()) session.tabs.set(id, null);
    }
    return session;
  }

  /** @param {RpcParams} params @param {AbortSignal} signal @returns {Promise<void>} */
  async function endTurn(params, signal) {
    const session = getSession(params, signal);
    const turn = identity(params.turn_id, "turn_id");
    if (session.turn !== turn) return;
    session.cleanup = cleanTabs(session, false);
    try { await session.cleanup; }
    finally { session.cleanup = undefined; }
    session.ended.add(turn);
    session.turn = null;
  }

  /** @type {Map<string,RpcHandler>} */
  const handlers = new Map([
    ["getInfo", (params, signal, notify) => {
      signal.throwIfAborted();
      const id = identity(params.session_id, "session_id");
      identity(params.turn_id, "turn_id");
      const existing = connections.get(id);
      if (existing && existing !== signal) throw new Error("Browser session is open on another connection");
      if (sessions.has(signal)) getSession(params, signal);
      else {
        /** @type {TabSession} */
        const session = {
          id,
          turn: null,
          ended: new Set(),
          tabs: new Map(),
          userTabs: new Set(),
          attached: new Set(),
          group: null,
          groupLock: Promise.resolve(),
          notify,
        };
        sessions.set(signal, session);
        connections.set(id, signal);
        signal.addEventListener("abort", () => {
          void Promise.allSettled([session.cleanup]).then(() => cleanTabs(session, true)).catch((error) => {
            for (const tabId of session.tabs.keys()) release(session, tabId);
            (options.onCleanupError ?? console.error)(error);
          }).finally(() => connections.delete(id));
        }, {once: true});
      }
      return {
        type: "extension",
        family: "chrome",
        name: options.name,
        version: options.version,
        capabilities: {browser: [], tab: []},
        apiSupportOverrides: {
          "Tab.ax": false,
          ...(typeof driver.listTabs === "function" ? {"BrowserUser.openTabs": true, "BrowserUser.claimTab": true} : {}),
        },
      };
    }],
    ["nameSession", async (params, signal) => {
      const session = activateTurn(params, signal);
      const rawName = typeof params.name === "string" ? params.name.trim() : "";
      if (!rawName) throw new Error("Session name must be a non-empty string");
      const title = rawName.slice(0, 80);
      const color = params.color === undefined ? "blue" : String(params.color);
      if (!TAB_GROUP_COLORS.has(color)) {
        throw new Error(`Invalid tab group color: ${color}`);
      }
      session.group = { title, color, groupId: session.group?.groupId ?? null };
      let supported = Boolean(driver.groupTabs);
      if (session.tabs.size > 0 && driver.groupTabs) {
        const applied = await applySessionGroup(session, [...session.tabs.keys()]);
        supported = applied.supported;
      }
      return {
        title,
        color,
        groupId: session.group.groupId,
        groupedTabs: session.tabs.size,
        supported,
      };
    }],
    ["createTab", async (params, signal) => {
      const session = activateTurn(params, signal);
      const tab = await driver.createBlankTab();
      if (!Number.isSafeInteger(tab.id) || tab.id < 0 || owners.has(tab.id)) {
        throw new Error("Browser driver returned an invalid or already owned tab");
      }
      if (signal.aborted) {
        await driver.closeTab(tab.id);
        signal.throwIfAborted();
      }
      owners.set(tab.id, session);
      session.tabs.set(tab.id, null);
      if (session.group && driver.groupTabs) {
        await applySessionGroup(session, [tab.id]).catch(() => {});
      }
      return tab;
    }],
    ["getTabs", async (params, signal) => {
      const session = activateTurn(params, signal);
      const entries = await Promise.all([...session.tabs.keys()].map((id) => driver.readTab(id)));
      signal.throwIfAborted();
      return entries.filter((tab) => tab && session.tabs.has(tab.id));
    }],
    ["getUserTabs", async (params, signal) => {
      const session = activateTurn(params, signal);
      if (typeof driver.listTabs !== "function") return [];
      const all = await driver.listTabs();
      signal.throwIfAborted();
      return (Array.isArray(all) ? all : []).filter((tab) => {
        if (!tab || !Number.isSafeInteger(tab.id)) return false;
        const owner = owners.get(tab.id);
        return !owner || owner === session;
      }).map((tab) => ({
        ...tab,
        owned: session.tabs.has(tab.id),
        origin: session.tabs.has(tab.id) && !session.userTabs.has(tab.id) ? "agent" : "user",
      }));
    }],
    ["claimUserTab", async (params, signal) => {
      const session = activateTurn(params, signal);
      const rawId = Number(params.tabId);
      if (!Number.isSafeInteger(rawId) || rawId < 0) {
        throw new Error("Browser tab is unavailable to this session");
      }
      const existingOwner = owners.get(rawId);
      if (existingOwner && existingOwner !== session) {
        throw new Error("Browser tab is unavailable to this session");
      }
      if (session.tabs.has(rawId)) {
        const current = await driver.readTab(rawId);
        signal.throwIfAborted();
        if (!current) throw new Error("Browser tab is unavailable to this session");
        return {
          ...current,
          owned: true,
          origin: session.userTabs.has(rawId) ? "user" : "agent",
        };
      }
      if (typeof driver.claimTab !== "function") {
        throw new Error("Browser tab is unavailable to this session");
      }
      let tab;
      try {
        tab = await driver.claimTab(rawId);
      } catch {
        throw new Error("Browser tab is unavailable to this session");
      }
      if (!tab || !Number.isSafeInteger(tab.id) || tab.id !== rawId) {
        throw new Error("Browser tab is unavailable to this session");
      }
      if (signal.aborted) {
        await driver.releaseTab?.(tab.id).catch(() => {});
        signal.throwIfAborted();
      }
      owners.set(tab.id, session);
      session.tabs.set(tab.id, null);
      session.userTabs.add(tab.id);
      return {...tab, owned: true, origin: "user"};
    }],
    ["getCommittedTabUrl", async (params, signal) => {
      const session = activateTurn(params, signal);
      const tab = await driver.readTab(requireOwnedTab(session, params.tabId));
      signal.throwIfAborted();
      if (!tab || typeof tab.url !== "string") throw new Error("Browser tab URL is unavailable");
      return tab.url;
    }],
    ["markTab", (params, signal) => {
      const session = activateTurn(params, signal);
      const id = requireOwnedTab(session, params.tabId);
      const status = mark(params.status);
      session.tabs.set(id, status);
      void driver.markTab?.(id, status)?.catch?.(() => {});
    }],
    ["finalizeTabs", async (params, signal) => {
      const session = activateTurn(params, signal);
      if (!Array.isArray(params.keep)) throw new Error("finalizeTabs requires a keep array");
      /** @type {Map<number,TabMark>} */
      const marks = new Map();
      for (const entry of params.keep) {
        const id = requireOwnedTab(session, entry?.tabId);
        if (marks.has(id)) throw new Error("finalizeTabs contains a duplicate tab");
        marks.set(id, mark(entry.status));
      }
      for (const id of session.tabs.keys()) {
        const st = marks.get(id) ?? null;
        session.tabs.set(id, st);
        if (st) void driver.markTab?.(id, st)?.catch?.(() => {});
      }
      await endTurn(params, signal);
    }],
    ["turnEnded", endTurn],
  ]);
  if (driver.attach && driver.detach && driver.execute) {
    handlers.set("attach", async (params, signal) => {
      const session = activateTurn(params, signal);
      const id = requireOwnedTab(session, params.tabId);
      validateNetworkPolicy(params.networkPolicy);
      await driver.attach(id);
      if (signal.aborted) {
        await driver.detach(id);
        signal.throwIfAborted();
      }
      session.attached.add(id);
    });
    handlers.set("detach", async (params, signal) => {
      const session = activateTurn(params, signal);
      const id = requireOwnedTab(session, params.tabId);
      await driver.detach(id);
      session.attached.delete(id);
    });
    if (driver.navigate) {
      handlers.set("navigateTab", async (params, signal) => {
        const session = activateTurn(params, signal);
        const id = requireOwnedTab(session, params.tabId);
        validatePageCommand("Page.navigate", { url: params.url });
        await driver.navigate(id, params.url);
        signal.throwIfAborted();
      });
    }
    handlers.set("executeCdp", async (params, signal) => {
      const session = activateTurn(params, signal);
      const id = requireOwnedTab(session, params.target?.tabId);
      if (!session.attached.has(id)) throw new Error("Debugger unattached");
      const childSession = params.target.sessionId;
      if (Object.keys(params.target).some((key) => key !== "tabId" && key !== "sessionId") ||
          (childSession !== undefined && (typeof childSession !== "string" || childSession.length < 1 || childSession.length > 128))) {
        throw new Error("Portable browser targets must identify a tab or child debugger session");
      }
      if ((childSession !== undefined || params.method === "Target.setAutoAttach") && !options.childFrames) {
        throw new Error("Nested browser targets are disabled on this bridge");
      }
      if (params.method === "Target.getTargets" && childSession === undefined) return {targetInfos: []};
      if (params.method === "Page.close" && childSession === undefined) {
        await driver.closeTab(id);
        release(session, id);
        return null;
      }
      validatePageCommand(params.method, params.commandParams);
      return await driver.execute(id, params.method, params.commandParams, childSession);
    });
  }
  if (driver.watchDownloads && driver.unwatchDownloads) {
    handlers.set("watchDownloads", async (params, signal) => {
      const session = activateTurn(params, signal);
      const id = requireOwnedTab(session, params.tabId);
      await driver.watchDownloads(id);
    });
    handlers.set("unwatchDownloads", async (params, signal) => {
      const session = activateTurn(params, signal);
      const id = requireOwnedTab(session, params.tabId);
      await driver.unwatchDownloads(id);
    });
  }
  if (driver.moveCursor) {
    handlers.set("moveCursor", async (params, signal) => {
      const session = activateTurn(params, signal);
      const id = requireOwnedTab(session, params.tabId);
      if (!Number.isFinite(params.x) || !Number.isFinite(params.y)) return null;
      await driver.moveCursor(id, Number(params.x), Number(params.y), params.waitForArrival !== false);
      return null;
    });
  }
  return handlers;
}
