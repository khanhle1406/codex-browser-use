import { createServer } from "node:net";
import { mkdtemp, rmdir } from "node:fs/promises";
import { endianness, tmpdir } from "node:os";
import path from "node:path";

const littleEndian = endianness() === "LE";
const maxFrameBytes = 16 * 1024 * 1024;

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
  let buffered = Buffer.alloc(0);
  let busy = false;

  /** @param {object} response @returns {void} */
  function reply(response) {
    if (socket.destroyed) return;
    const body = Buffer.from(JSON.stringify({jsonrpc: "2.0", ...response}));
    if (body.length > maxFrameBytes) throw new Error("Browser backend response exceeds frame limit");
    if (socket.writableLength + body.length + 4 > 2 * (maxFrameBytes + 4)) {
      throw new Error("Browser backend output queue exceeds limit");
    }
    const header = Buffer.alloc(4);
    if (littleEndian) header.writeUInt32LE(body.length);
    else header.writeUInt32BE(body.length);
    socket.write(Buffer.concat([header, body]));
  }

  /** @param {Buffer} body @returns {Promise<void>} */
  async function dispatch(body) {
    const request = JSON.parse(body.toString("utf8"));
    if (!isRecord(request) || request.jsonrpc !== "2.0" || !Number.isSafeInteger(request.id) ||
        typeof request.method !== "string" || !isRecord(request.params)) {
      throw new Error("Invalid browser backend request");
    }
    const handler = handlers.get(request.method);
    if (!handler) {
      reply({id: request.id, error: {code: -32601, message: `No handler registered for method: ${request.method}`}});
      return;
    }
    try {
      const result = await handler(request.params, lifetime.signal, notify);
      reply({id: request.id, result: result ?? null});
    } catch (error) {
      reply({id: request.id, error: {code: -32000, message: error instanceof Error ? error.message : String(error)}});
    }
  }

  /** @type {Notify} */
  function notify(method, params) {
    try { reply({method, params}); }
    catch (error) { socket.destroy(error); }
  }

  /** @returns {Promise<void>} */
  async function drain() {
    busy = true;
    try {
      while (!socket.destroyed && buffered.length >= 4) {
        const length = littleEndian ? buffered.readUInt32LE() : buffered.readUInt32BE();
        if (length < 1 || length > maxFrameBytes) throw new Error("Invalid browser backend frame length");
        if (buffered.length < length + 4) break;
        const body = buffered.subarray(4, length + 4);
        buffered = buffered.subarray(length + 4);
        await dispatch(body);
      }
    } catch (error) {
      socket.destroy(error);
    } finally {
      busy = false;
    }
  }

  socket.on("data", (chunk) => {
    if (buffered.length + chunk.length > 2 * (maxFrameBytes + 4)) {
      socket.destroy(new Error("Browser backend input queue exceeds limit"));
      return;
    }
    buffered = Buffer.concat([buffered, chunk]);
    if (!busy) void drain();
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
    await rmdir(directory);
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
      }).then(() => rmdir(directory));
      return closing;
    },
  };
}
