import { endianness } from "node:os";
import { FrameReader, encodeFrame } from "./frame-reader.js";

const littleEndian = endianness() === "LE";
const maxMessage = 2 * 1024 * 1024;
const maxChunkChars = 512 * 1024;
const maxUnacknowledged = 128;
/** @typedef {{id:number,title?:string,url?:string,active?:boolean}} BrowserTab */
/** @typedef {Record<string,unknown>} Params */
/** @typedef {(method:string, id:number, params:Params)=>void} EventListener */

/**
 * Speak Chrome native messaging over a dedicated input and output pair.
 * @param {import("node:stream").Readable} input
 * @param {import("node:stream").Writable} output
 * @param {{timeoutMs?:number}} [options]
 * @returns {{createBlankTab:()=>Promise<BrowserTab>,readTab:(id:number)=>Promise<BrowserTab|null>,closeTab:(id:number)=>Promise<void>,releaseTab?:(id:number)=>Promise<void>,markTab?:(id:number,status:string,markOptions?:{focus?:boolean})=>Promise<void>,attach:(id:number)=>Promise<void>,detach:(id:number)=>Promise<void>,execute:(id:number,method:string,params:Params,childSession?:string)=>Promise<unknown>,navigate:(id:number,url:string)=>Promise<void>,watchDownloads:(id:number)=>Promise<void>,unwatchDownloads:(id:number)=>Promise<void>,groupTabs:(tabIds:number[],groupOptions?:{title?:string,color?:string,groupId?:number|null,sessionId?:string,collapsed?:boolean})=>Promise<{groupId:number|null,supported?:boolean}>,ungroupTabs?:(tabIds:number[])=>Promise<{ok?:boolean,ungrouped?:number,supported?:boolean}>,listTabGroups?:()=>Promise<Array<Record<string,unknown>>>,cleanupGroups?:(cleanupOptions?:{ungroupFinished?:boolean,closeDuplicateDeliverables?:boolean,keepTabIds?:number[]})=>Promise<Record<string,unknown>>,onEvent:(listener:EventListener)=>void,closed:Promise<Error>,close:()=>void}}
 */
export function createNativeTabDriver(input, output, options = {}) {
  /** @type {Map<number,{resolve:(result:unknown)=>void,reject:(error:Error)=>void,timer:ReturnType<typeof setTimeout>,parts:string[]}>} */
  const pending = new Map();
  /** @type {Map<number,number>} */
  const expiredCommands = new Map();
  /** @type {Map<number,number>} */
  const expiredCountsByTab = new Map();
  /** @type {EventListener | undefined} */
  let onEvent;
  const closed = Promise.withResolvers();
  let nextId = 0;
  const reader = new FrameReader({
    littleEndian,
    maxFrameBytes: maxMessage,
    maxBufferedBytes: 4 * maxMessage,
    overflowError: "Invalid Chrome native message size",
    lengthError: "Invalid Chrome native message size",
  });
  /** @type {Error | undefined} */
  let failure;

  /** @param {Error} error @returns {void} */
  function fail(error) {
    if (failure) return;
    failure = error;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
    expiredCommands.clear();
    expiredCountsByTab.clear();
    closed.resolve(error);
  }

  input.on("data", (chunk) => {
    if (failure) return;
    try {
      reader.push(chunk);
      let raw;
      while ((raw = reader.nextFrame()) !== null) {
        const reply = JSON.parse(raw.toString("utf8"));
        if (["onCDPEvent", "onCDPDetach", "onTabCreated"].includes(reply?.event) && Number.isSafeInteger(reply.tabId)) {
          onEvent?.(reply.event, reply.tabId, reply.params);
          continue;
        }
        const item = pending.get(reply?.id);
        const expiredTab = expiredCommands.get(reply?.id);
        if (expiredTab !== undefined) {
          if (typeof reply?.ok === "boolean" || reply?.final === true) {
            expiredCommands.delete(reply.id);
            const remaining = expiredCountsByTab.get(expiredTab) - 1;
            if (remaining === 0) expiredCountsByTab.delete(expiredTab);
            else expiredCountsByTab.set(expiredTab, remaining);
          }
          continue;
        }
        if (!item) throw new Error("Invalid Chrome native response ID");
        if (typeof reply.chunk === "string") {
          if (reply.index !== item.parts.length || item.parts.length >= 64 || reply.chunk.length > maxChunkChars ||
              typeof reply.final !== "boolean") throw new Error("Invalid Chrome native chunk");
          item.parts.push(reply.chunk);
          if (!reply.final) continue;
          reply.value = JSON.parse(item.parts.join(""));
          reply.ok = true;
        }
        if (typeof reply.ok !== "boolean") throw new Error("Invalid Chrome native response");
        pending.delete(reply.id);
        clearTimeout(item.timer);
        if (reply.ok) item.resolve(reply.value);
        else item.reject(new Error(typeof reply.error === "string" ? reply.error : "Chrome tab operation failed"));
      }
    } catch (error) {
      fail(error);
    }
  });
  input.once("end", () => fail(new Error("Chrome disconnected from the native host")));
  input.once("close", () => fail(new Error("Chrome native input closed")));
  input.on("error", fail);
  output.on("error", fail);

  /** @param {string} method @param {number} [tabId] @param {Params} [details] @returns {Promise<unknown>} */
  async function request(method, tabId, details) {
    if (failure) throw failure;
    const isolateTimeout = method === "execute" && tabId !== undefined;
    if (isolateTimeout) {
      if (expiredCountsByTab.has(tabId)) {
        throw new Error("A timed-out Chrome command is still in flight for this tab");
      }
      if (pending.size + expiredCommands.size >= maxUnacknowledged) {
        throw new Error("Too many Chrome commands are awaiting acknowledgement");
      }
    }
    const id = ++nextId;
    const packet = encodeFrame({ id, method, tabId, details }, {
      littleEndian,
      maxFrameBytes: maxMessage,
      overflowError: "Invalid Chrome native message size",
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const operation = typeof details?.method === "string" ? details.method : method;
        if (!isolateTimeout) {
          fail(new Error(`Chrome native operation timed out: ${operation}`));
          return;
        }
        pending.delete(id);
        expiredCommands.set(id, tabId);
        expiredCountsByTab.set(tabId, (expiredCountsByTab.get(tabId) ?? 0) + 1);
        reject(new Error(`Chrome native operation timed out: ${operation}. Chrome may still complete it.`));
      }, options.timeoutMs ?? 10000);
      pending.set(id, { resolve, reject, timer, parts: [] });
      output.write(packet, (error) => {
        if (error) fail(error);
      });
    });
  }

  /** @param {unknown} value @param {number} [expectedId] @returns {BrowserTab} */
  function tab(value, expectedId) {
    if (!value || typeof value !== "object" || !Number.isSafeInteger(value.id) ||
        value.id < 0 || (expectedId !== undefined && value.id !== expectedId)) {
      throw new Error("Chrome native driver returned an invalid tab");
    }
    return value;
  }

  return {
    async createBlankTab() { return tab(await request("createBlankTab")); },
    /** @returns {Promise<BrowserTab[]>} */
    async listTabs() {
      const value = await request("listTabs");
      return Array.isArray(value)
        ? value.filter((entry) => entry && Number.isSafeInteger(entry.id) && entry.id >= 0)
        : [];
    },
    /** @param {number} id @returns {Promise<BrowserTab>} */
    async claimTab(id) { return tab(await request("claimTab", id), id); },
    /** @param {number} id @returns {Promise<BrowserTab|null>} */
    async readTab(id) {
      const value = await request("readTab", id);
      return value === null ? null : tab(value, id);
    },
    /** @param {number} id @param {{format?:string,maxChars?:number}} [options] @returns {Promise<unknown>} */
    async readTabContext(id, options = {}) {
      return await request("readTabContext", id, options);
    },
    /** @param {{cursorMode?:string}} [config] @returns {Promise<unknown>} */
    async setConfig(config = {}) {
      return await request("setConfig", undefined, config);
    },
    /** @param {number} id @returns {Promise<void>} */
    async closeTab(id) { await request("closeTab", id); },
    /** @param {number} id @returns {Promise<void>} */
    async releaseTab(id) { await request("releaseTab", id); },
    /** @param {number} id @param {string} status @param {{focus?:boolean}} [markOptions] @returns {Promise<void>} */
    async markTab(id, status, markOptions = {}) {
      await request("markTab", id, {status, ...(markOptions?.focus === true ? {focus: true} : {})});
    },
    /** @param {number} id @param {number} x @param {number} y @param {boolean} [waitForArrival] @returns {Promise<void>} */
    async moveCursor(id, x, y, waitForArrival = true) {
      await request("moveCursor", id, {x, y, waitForArrival});
    },
    /** @param {number} id @returns {Promise<void>} */
    async attach(id) { await request("attach", id); },
    /** @param {number} id @returns {Promise<void>} */
    async detach(id) { await request("detach", id); },
    /** @param {number} id @param {string} method @param {Params} params @param {string} [childSession] @returns {Promise<unknown>} */
    async execute(id, method, params, childSession) { return await request("execute", id, {method, params, childSession}); },
    /** @param {number} id @param {string} url @returns {Promise<void>} */
    async navigate(id, url) { await request("navigate", id, {url}); },
    /** @param {number} id @returns {Promise<void>} */
    async watchDownloads(id) { await request("watchDownloads", id); },
    /** @param {number} id @returns {Promise<void>} */
    async unwatchDownloads(id) { await request("unwatchDownloads", id); },
    /** @param {number[]} tabIds @param {{title?:string,color?:string,groupId?:number|null,sessionId?:string,collapsed?:boolean}} [groupOptions] @returns {Promise<{groupId:number|null,supported?:boolean}>} */
    async groupTabs(tabIds, groupOptions = {}) {
      return await request("groupTabs", undefined, {
        tabIds,
        title: groupOptions.title,
        color: groupOptions.color,
        groupId: groupOptions.groupId ?? null,
        ...(typeof groupOptions.sessionId === "string" ? {sessionId: groupOptions.sessionId} : {}),
        ...(typeof groupOptions.collapsed === "boolean" ? {collapsed: groupOptions.collapsed} : {}),
      });
    },
    /** @param {number[]} tabIds @returns {Promise<{ok?:boolean,ungrouped?:number,supported?:boolean}>} */
    async ungroupTabs(tabIds) {
      return await request("ungroupTabs", undefined, {tabIds});
    },
    /** @returns {Promise<Array<Record<string,unknown>>>} */
    async listTabGroups() {
      const value = await request("listTabGroups");
      return Array.isArray(value) ? value : [];
    },
    /** @param {{ungroupFinished?:boolean,closeDuplicateDeliverables?:boolean,keepTabIds?:number[]}} [cleanupOptions] @returns {Promise<Record<string,unknown>>} */
    async cleanupGroups(cleanupOptions = {}) {
      return await request("cleanupGroups", undefined, cleanupOptions);
    },
    /** @param {EventListener} listener @returns {void} */
    onEvent(listener) { onEvent = listener; },
    closed: closed.promise,
    close() { fail(new Error("Chrome native tab driver closed")); },
  };
}
