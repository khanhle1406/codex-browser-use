import { endianness } from "node:os";

const littleEndian = endianness() === "LE";
const maxMessage = 1024 * 1024;
const maxUnacknowledged = 128;
/** @typedef {{id:number,title?:string,url?:string,active?:boolean}} BrowserTab */
/** @typedef {Record<string,unknown>} Params */
/** @typedef {(method:string, id:number, params:Params)=>void} EventListener */

/**
 * Speak Chrome native messaging over a dedicated input and output pair.
 * @param {import("node:stream").Readable} input
 * @param {import("node:stream").Writable} output
 * @param {{timeoutMs?:number}} [options]
 * @returns {{createBlankTab:()=>Promise<BrowserTab>,readTab:(id:number)=>Promise<BrowserTab|null>,closeTab:(id:number)=>Promise<void>,releaseTab:(id:number)=>Promise<void>,attach:(id:number)=>Promise<void>,detach:(id:number)=>Promise<void>,execute:(id:number,method:string,params:Params,childSession?:string)=>Promise<unknown>,onEvent:(listener:EventListener)=>void,closed:Promise<Error>,close:()=>void}}
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
  let buffer = Buffer.alloc(0);
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
    buffer = Buffer.concat([buffer, chunk]);
    try {
      while (buffer.length >= 4) {
        const length = littleEndian ? buffer.readUInt32LE() : buffer.readUInt32BE();
        if (length < 1 || length > maxMessage) throw new Error("Invalid Chrome native message size");
        if (buffer.length < length + 4) return;
        const reply = JSON.parse(buffer.subarray(4, length + 4));
        buffer = buffer.subarray(length + 4);
        if (["onCDPEvent", "onCDPDetach"].includes(reply?.event) && Number.isSafeInteger(reply.tabId)) {
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
          if (reply.index !== item.parts.length || item.parts.length >= 64 || reply.chunk.length > 128 * 1024 ||
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
    const body = Buffer.from(JSON.stringify({id, method, tabId, details}));
    const header = Buffer.alloc(4);
    if (littleEndian) header.writeUInt32LE(body.length);
    else header.writeUInt32BE(body.length);
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
      pending.set(id, {resolve, reject, timer, parts: []});
      output.write(Buffer.concat([header, body]), (error) => {
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
    /** @param {number} id @returns {Promise<BrowserTab|null>} */
    async readTab(id) {
      const value = await request("readTab", id);
      return value === null ? null : tab(value, id);
    },
    /** @param {number} id @returns {Promise<void>} */
    async closeTab(id) { await request("closeTab", id); },
    /** @param {number} id @returns {Promise<void>} */
    async releaseTab(id) { await request("releaseTab", id); },
    /** @param {number} id @returns {Promise<void>} */
    async attach(id) { await request("attach", id); },
    /** @param {number} id @returns {Promise<void>} */
    async detach(id) { await request("detach", id); },
    /** @param {number} id @param {string} method @param {Params} params @param {string} [childSession] @returns {Promise<unknown>} */
    async execute(id, method, params, childSession) { return await request("execute", id, {method, params, childSession}); },
    /** @param {number} id @param {string} url @returns {Promise<void>} */
    async navigate(id, url) { await request("navigate", id, {url}); },
    /** @param {EventListener} listener @returns {void} */
    onEvent(listener) { onEvent = listener; },
    closed: closed.promise,
    close() { fail(new Error("Chrome native tab driver closed")); },
  };
}
