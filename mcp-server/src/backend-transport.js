import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { endianness, tmpdir } from "node:os";
import path from "node:path";
import { FrameReader, encodeFrame } from "./frame-reader.js";

const littleEndian = endianness() === "LE";
const maxFrameBytes = 16 * 1024 * 1024;
const maxInFlightRequests = 32;
const barrierMethods = new Set(["turnEnded", "finalizeTabs"]);

/** @typedef {Record<string, unknown>} RpcParams */
/** @typedef {(method:string,params:RpcParams)=>void} Notify */
/** @typedef {(params: RpcParams, signal: AbortSignal, notify:Notify) => unknown | Promise<unknown>} RpcHandler */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {import("node:net").Socket} socket @param {ReadonlyMap<string,RpcHandler>} handlers @returns {void} */
function serveConnection(socket, handlers) {
  const lifetime = new AbortController();
  const reader = new FrameReader({
    littleEndian,
    maxFrameBytes,
    maxBufferedBytes: 2 * (maxFrameBytes + 4),
    overflowError: "Browser backend input queue exceeds limit",
    lengthError: "Invalid browser backend frame length",
  });
  /** @type {Set<Promise<void>>} */
  const inFlight = new Set();
  let draining = false;
  let barrierActive = false;

  /** @param {object} response @returns {void} */
  function reply(response) {
    if (socket.destroyed) return;
    const packet = encodeFrame({ jsonrpc: "2.0", ...response }, {
      littleEndian,
      maxFrameBytes,
      overflowError: "Browser backend response exceeds frame limit",
    });
    if (socket.writableLength + packet.length > 2 * (maxFrameBytes + 4)) {
      throw new Error("Browser backend output queue exceeds limit");
    }
    socket.write(packet);
  }

  /** @type {Notify} */
  function notify(method, params) {
    try { reply({ method, params }); }
    catch (error) { socket.destroy(error); }
  }

  /** @param {{id:number,method:string,params:RpcParams}} request @returns {Promise<void>} */
  async function dispatchRequest(request) {
    const handler = handlers.get(request.method);
    if (!handler) {
      // Yield one microtask so an immediately-preceding async handler isn't overtaken on the same tick.
      await Promise.resolve();
      reply({ id: request.id, error: { code: -32601, message: `No handler registered for method: ${request.method}` } });
      return;
    }
    try {
      const result = await handler(request.params, lifetime.signal, notify);
      reply({ id: request.id, result: result ?? null });
    } catch (error) {
      reply({ id: request.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
    }
  }

  /** @returns {Promise<void>} */
  async function drain() {
    if (draining || barrierActive || socket.destroyed) return;
    draining = true;
    try {
      while (!socket.destroyed && !barrierActive && inFlight.size < maxInFlightRequests) {
        const body = reader.nextFrame();
        if (!body) break;
        const request = JSON.parse(body.toString("utf8"));
        if (!isRecord(request) || request.jsonrpc !== "2.0" || !Number.isSafeInteger(request.id) ||
            typeof request.method !== "string" || !isRecord(request.params)) {
          throw new Error("Invalid browser backend request");
        }
        if (barrierMethods.has(request.method)) {
          barrierActive = true;
          try {
            if (inFlight.size > 0) await Promise.allSettled([...inFlight]);
            await dispatchRequest(request);
          } finally {
            barrierActive = false;
          }
          continue;
        }
        const task = dispatchRequest(request)
          .catch((error) => { socket.destroy(error); })
          .finally(() => {
            inFlight.delete(task);
            if (!draining && !socket.destroyed && !barrierActive) void drain();
          });
        inFlight.add(task);
      }
    } catch (error) {
      socket.destroy(error);
    } finally {
      draining = false;
    }
  }

  socket.on("data", (chunk) => {
    try {
      reader.push(chunk);
    } catch (error) {
      socket.destroy(error);
      return;
    }
    if (!draining && !barrierActive) void drain();
  });
  socket.on("error", (error) => lifetime.abort(error));
  socket.on("close", () => lifetime.abort());
}

/**
 * Serve the engine's framed requests from a new owner-only Unix socket directory.
 * Handlers are supplied by the project's backend and determine browser permissions.
 * @param {ReadonlyMap<string,RpcHandler>} handlers
 * @returns {Promise<{socketPath:string,close:()=>Promise<void>}>}
 */
export async function listenBackend(handlers) {
  const directory = await mkdtemp(path.join(tmpdir(), "browser-backend-"));
  const socketPath = path.join(directory, "rpc.sock");
  /** @type {Set<import("node:net").Socket>} */
  const connections = new Set();
  const server = createServer((socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    serveConnection(socket, handlers);
  });
  server.maxConnections = 32;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  /** @type {Promise<void> | undefined} */
  let closing;
  return {
    socketPath,
    close() {
      closing ??= new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        for (const socket of connections) socket.destroy();
      }).then(() => rm(directory, { recursive: true, force: true }));
      return closing;
    },
  };
}
