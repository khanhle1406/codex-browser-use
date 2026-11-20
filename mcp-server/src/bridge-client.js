import { createConnection } from "node:net";
import { endianness } from "node:os";
import { readBackend } from "./backend-discovery.js";
import { FrameReader, encodeFrame } from "./frame-reader.js";

const littleEndian = endianness() === "LE";
const maxFrameBytes = 16 * 1024 * 1024;

/**
 * Framed JSON-RPC client for the project's Chrome bridge.
 * One client owns one bridge connection and therefore one browser session.
 */
export class BridgeClient {
  /**
   * @param {{bridgeFile:string, connectTimeoutMs?:number, requestTimeoutMs?:number}} options
   */
  constructor({ bridgeFile, connectTimeoutMs = 10_000, requestTimeoutMs = 30_000 }) {
    if (typeof bridgeFile !== "string" || bridgeFile.length === 0) {
      throw new Error("A browser bridge descriptor path is required");
    }
    this.bridgeFile = bridgeFile;
    this.connectTimeoutMs = connectTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    /** @type {import("node:net").Socket|null} */
    this.socket = null;
    /** @type {Map<number,{resolve:(value:unknown)=>void, reject:(error:Error)=>void, timer:NodeJS.Timeout}>} */
    this.pending = new Map();
    this.nextId = 1;
    this.reader = new FrameReader({
      littleEndian,
      maxFrameBytes,
      maxBufferedBytes: 2 * (maxFrameBytes + 4),
      overflowError: "Browser bridge input buffer exceeds limit",
      lengthError: "Invalid browser bridge frame length",
    });
    this.closed = false;
    this.connecting = null;
    /** @type {Set<(method:string, params:unknown)=>void>} */
    this.listeners = new Set();
  }

  /** @returns {Promise<BridgeClient>} */
  async connect() {
    if (this.closed) throw new Error("Browser bridge client is closed");
    if (this.socket) return this;
    this.connecting ??= this.#open().finally(() => { this.connecting = null; });
    await this.connecting;
    return this;
  }

  /** @returns {Promise<void>} */
  async #open() {
    const socketPath = await readBackend(this.bridgeFile);
    const socket = createConnection({ path: socketPath });
    this.socket = socket;
    socket.on("data", (chunk) => this.#onData(chunk));
    socket.on("error", (error) => this.#fail(error));
    socket.on("close", () => this.#fail(new Error("Browser bridge connection closed")));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Browser bridge connection timed out after ${this.connectTimeoutMs}ms`));
      }, this.connectTimeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  /** @param {(method:string, params:unknown)=>void} listener @returns {()=>void} */
  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Call one bridge RPC method.
   * @param {string} method
   * @param {Record<string, unknown>} params
   * @param {{timeoutMs?:number}} [options]
   * @returns {Promise<unknown>}
   */
  async request(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new Error("Browser bridge connection is unavailable");
    const id = this.nextId++;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser bridge request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.write(encodeFrame({ jsonrpc: "2.0", id, method, params }, {
          littleEndian,
          maxFrameBytes,
          overflowError: "Browser bridge request exceeds frame limit",
        }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** @param {Buffer} chunk @returns {void} */
  #onData(chunk) {
    try {
      this.reader.push(chunk);
      let body;
      while ((body = this.reader.nextFrame()) !== null) {
        let message;
        try {
          message = JSON.parse(body.toString("utf8"));
        } catch (error) {
          this.#fail(new Error(`Invalid browser bridge response: ${error.message}`));
          return;
        }
        this.#dispatch(message);
      }
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** @param {Record<string, unknown>} message @returns {void} */
  #dispatch(message) {
    if (!Number.isSafeInteger(message.id)) {
      if (typeof message.method === "string") {
        for (const listener of this.listeners) listener(message.method, message.params);
      }
      return;
    }
    const entry = this.pending.get(Number(message.id));
    if (!entry) return;
    this.pending.delete(Number(message.id));
    clearTimeout(entry.timer);
    if (message.error && typeof message.error === "object") {
      entry.reject(new Error(String(message.error.message ?? "Browser bridge request failed")));
    } else {
      entry.resolve(message.result ?? null);
    }
  }

  /** @param {Error} error @returns {void} */
  #fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  /** @returns {Promise<void>} */
  async close() {
    if (this.closed) return;
    this.closed = true;
    const socket = this.socket;
    this.socket = null;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Browser bridge client closed"));
    }
    this.pending.clear();
    if (!socket || socket.destroyed) return;
    await new Promise((resolve) => {
      socket.once("close", resolve);
      socket.end();
      setTimeout(() => socket.destroy(), 1_000).unref();
    });
  }
}
