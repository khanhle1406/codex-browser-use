import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse, stringify } from "smol-toml";

/** @typedef {{ session_id: string, turn_id: string }} TurnIdentity */
/** @typedef {{ timeoutMs: number, run: (identity?: TurnIdentity) => Promise<unknown> }} RuntimeHook */
/** @typedef {{ action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>, _meta?: Record<string, unknown> }} ElicitationResult */
/**
 * @typedef {object} RuntimeHostOptions
 * @property {string} enginePath Installed official plugin root; proprietary files remain there.
 * @property {string} configRoot Adapter-owned configuration directory.
 * @property {Record<string, string | undefined>} [env] Overrides merged with the current environment.
 * @property {Record<string, unknown> | (() => Record<string, unknown>)} [requestMeta]
 * @property {(request: unknown) => Promise<ElicitationResult>} [onElicitation]
 * @property {(content: unknown) => void} [emitContentItem]
 * @property {(hook: RuntimeHook) => (() => void)} [addAfterSubmittedCodeHook]
 * @property {(hook: RuntimeHook) => (() => void)} [addTurnEndedHandler]
 */

/** @type {object | undefined} */
let connectedHost;

/**
 * Raw local-stream bridge. The installed service owns JSON framing and decoding;
 * its transport expects a connected socket's on/write/end interface unchanged.
 * @param {{connectTimeoutMs?: number}} [options]
 * @returns {{createConnection: (socketPath: string) => Promise<import('node:net').Socket>, close: () => void}}
 */
export function createNativePipe(options = {}) {
  const timeoutMs = options.connectTimeoutMs ?? 10000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("Invalid native pipe connection timeout");
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();
  let closed = false;
  return {
    /** @param {string} socketPath @returns {Promise<import('node:net').Socket>} */
    async createConnection(socketPath) {
      if (closed) throw new Error("Native pipe bridge is closed");
      if (typeof socketPath !== "string" || !path.isAbsolute(socketPath)) throw new Error("Native pipe requires an absolute local socket path");
      const socket = createConnection({ path: socketPath });
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      // Keep errors handled during the handoff to the original transport too.
      // The transport installs its own error listener after the promise resolves.
      socket.on("error", () => sockets.delete(socket));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => socket.destroy(new Error(`Native pipe connection timed out after ${timeoutMs}ms`)), timeoutMs);
        /** @returns {void} */
        const cleanup = () => {
          clearTimeout(timer);
          socket.removeListener("connect", onConnect);
          socket.removeListener("error", onError);
          socket.removeListener("close", onClose);
        };
        /** @returns {void} */
        const onConnect = () => { cleanup(); resolve(socket); };
        /** @param {Error} error @returns {void} */
        const onError = (error) => { cleanup(); reject(error); };
        /** @returns {void} */
        const onClose = () => { cleanup(); reject(new Error("Native pipe closed before connecting")); };
        socket.once("connect", onConnect);
        socket.once("error", onError);
        socket.once("close", onClose);
      });
    },
    close() {
      closed = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
  };
}

/** @param {unknown} error @returns {boolean} */
function missing(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {TurnIdentity} */
function turnIdentity(value) {
  if (!isRecord(value)) throw new Error("Browser lifecycle requires session_id and turn_id");
  const { session_id, turn_id } = value;
  if (typeof session_id !== "string" || typeof turn_id !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(session_id) || !/^[A-Za-z0-9_-]{1,128}$/u.test(turn_id)) {
    throw new Error("Browser lifecycle requires valid session_id and turn_id");
  }
  return { session_id, turn_id };
}

/**
 * Owns only the adapter's TOML files, never the user's Codex configuration.
 * Missing files are empty; malformed or inaccessible files fail closed.
 * @param {string} root
 * @param {{stateNamespace?: string}} [options] Isolates mutable state while sharing read-only policy.
 * @returns {{ read: () => Promise<{config: Record<string, unknown>}>, readRequirements: () => Promise<{requirements: Record<string, unknown>}>, readToml: (name: string) => Promise<Record<string, unknown>>, writeToml: (name: string, value: Record<string, unknown>) => Promise<void> }}
 */
export function createRuntimeConfig(root, options = {}) {
  if (!path.isAbsolute(root)) throw new Error("Browser configRoot must be an absolute path");
  if (options.stateNamespace !== undefined && !/^[A-Za-z0-9_-]{1,128}$/u.test(options.stateNamespace)) {
    throw new Error("Invalid browser state namespace");
  }
  const base = path.resolve(root);
  const stateBase = options.stateNamespace === undefined ? base : path.join(base, "state", options.stateNamespace);
  /** @type {Map<string, Promise<void>>} */
  const writes = new Map();

  /** @param {string} name @returns {string} */
  function resolveName(name) {
    if (!/^(?:config\.toml|requirements\.toml|browser\/config\.toml|browser\/sessions\/[A-Za-z0-9_-]{1,128}\.toml)$/u.test(name)) {
      throw new Error("Unsupported browser configuration path");
    }
    return path.join(name.startsWith("browser/") ? stateBase : base, name);
  }

  /** @param {string} target @param {boolean} create @returns {Promise<void>} */
  async function checkParents(target, create) {
    const parent = path.dirname(target);
    // The selected root and its children cannot redirect state through symlinks.
    // System ancestors such as macOS /tmp -> /private/tmp are outside this root.
    const chain = [base];
    let cursor = base;
    for (const segment of path.relative(base, parent).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, segment);
      chain.push(cursor);
    }
    for (const directory of chain) {
      try {
        const stat = await lstat(directory);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Browser configuration directories must not be symlinks or files");
      } catch (error) {
        if (!missing(error)) throw error;
        if (!create) continue;
        try {
          await mkdir(directory, { mode: 0o700, recursive: directory === base });
        } catch (creationError) {
          if (!(creationError instanceof Error) || !("code" in creationError) || creationError.code !== "EEXIST") throw creationError;
        }
        const created = await lstat(directory);
        if (created.isSymbolicLink() || !created.isDirectory()) throw new Error("Browser configuration directories must not be symlinks or files");
      }
    }
  }

  /** @param {string} name @returns {Promise<Record<string, unknown>>} */
  async function readToml(name) {
    const target = resolveName(name);
    await writes.get(target);
    await checkParents(target, false);
    let handle;
    try {
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      const result = parse(await handle.readFile("utf8"));
      if (!isRecord(result)) throw new Error("Browser configuration must be a TOML table");
      return result;
    } catch (error) {
      if (missing(error)) return {};
      throw error;
    } finally {
      await handle?.close();
    }
  }

  /** @param {string} name @param {Record<string, unknown>} value @returns {Promise<void>} */
  async function writeToml(name, value) {
    if (!name.startsWith("browser/")) throw new Error("The browser engine may only write browser state files");
    const target = resolveName(name);
    if (!isRecord(value)) throw new Error("Browser state must be a TOML table");
    const bytes = stringify(value);
    const prior = writes.get(target) ?? Promise.resolve();
    const write = prior.catch(() => undefined).then(async () => {
      await checkParents(target, true);
      try {
        if ((await lstat(target)).isSymbolicLink()) throw new Error("Browser state files must not be symlinks");
      } catch (error) {
        if (!missing(error)) throw error;
      }
      const temporary = `${target}.${randomUUID()}.tmp`;
      const handle = await open(temporary, "wx", 0o600);
      try {
        try {
          await handle.writeFile(bytes, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await checkParents(target, false);
        await rename(temporary, target);
      } catch (error) {
        await unlink(temporary);
        throw error;
      }
    });
    writes.set(target, write);
    try {
      await write;
    } finally {
      if (writes.get(target) === write) writes.delete(target);
    }
  }

  return {
    read: async () => ({ config: await readToml("config.toml") }),
    readRequirements: async () => ({ requirements: await readToml("requirements.toml") }),
    readToml,
    writeToml,
  };
}

/** @param {RuntimeHook} hook @param {TurnIdentity | undefined} identity @returns {Promise<void>} */
async function invokeHook(hook, identity) {
  if (!Number.isFinite(hook.timeoutMs) || hook.timeoutMs <= 0) throw new Error("Invalid browser hook timeout");
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => hook.run(identity)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Browser lifecycle hook timed out; terminate its worker")), hook.timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Supplies the host contract expected by an unmodified installed browser engine.
 * Each host must live in its own worker; the official service has singleton state.
 * The caller installs nodeRepl on globalThis before importing browser-client.mjs.
 * @param {RuntimeHostOptions} options
 * @returns {{ nodeRepl: Record<string, unknown>, endTurn: (identity?: TurnIdentity) => Promise<void>, runAfterSubmittedCodeHooks: () => Promise<void>, close: () => Promise<void> }}
 */
export function createRuntimeHost(options) {
  if (!path.isAbsolute(options.enginePath)) throw new Error("Browser enginePath must be an absolute plugin root");
  const enginePath = path.join(options.enginePath, "scripts", "browser-service.mjs");
  // The official engine publishes whole state snapshots. Sharing those files
  // between independent workers would overwrite approvals and denials even
  // with atomic writes, so each host owns a separate mutable namespace.
  const config = createRuntimeConfig(options.configRoot, { stateNamespace: randomUUID() });
  const nativePipe = createNativePipe();
  const env = Object.freeze({ ...process.env, ...options.env });
  const identity = { session_id: randomUUID(), turn_id: randomUUID() };
  /** @type {Set<RuntimeHook>} */
  const afterHooks = new Set();
  /** @type {Set<RuntimeHook>} */
  const turnHooks = new Set();
  /** @type {Array<() => void>} */
  const unregister = [];
  /** @type {Promise<{handleRpc: (request: unknown) => Promise<unknown>}> | undefined} */
  let service;
  let closed = false;

  /** @returns {Record<string, unknown>} */
  function metadata() {
    const provided = typeof options.requestMeta === "function" ? options.requestMeta() : options.requestMeta;
    return provided ?? { "x-codex-turn-metadata": identity };
  }

  /** @returns {TurnIdentity} */
  function currentTurn() {
    let value = metadata()["x-codex-turn-metadata"];
    if (typeof value === "string") value = JSON.parse(value);
    return turnIdentity(value);
  }

  /** @param {RuntimeHook} hook @param {Set<RuntimeHook>} set @param {((hook: RuntimeHook) => (() => void)) | undefined} external @returns {() => void} */
  function register(hook, set, external) {
    if (closed) throw new Error("Browser runtime host is closed");
    set.add(hook);
    const removeExternal = external?.(hook);
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      set.delete(hook);
      removeExternal?.();
    };
    unregister.push(remove);
    return remove;
  }

  /** @type {Record<string, unknown>} */
  const nodeRepl = {
    config,
    nativePipe,
    env,
    cwd: process.cwd(),
    homeDir: homedir(),
    tmpDir: tmpdir(),
    get requestMeta() { return metadata(); },
    /** @param {unknown} value @returns {void} */
    setResponseMeta(value) { options.emitContentItem?.({ type: "metadata", value }); },
    /** @param {unknown} value @returns {void} */
    emitContentItem(value) { options.emitContentItem?.(value); },
    /** @param {unknown} value @returns {void} */
    emitImage(value) { options.emitContentItem?.({ type: "image", value }); },
    /** @param {unknown} value @returns {void} */
    write(value) { options.emitContentItem?.({ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }); },
    fetch: globalThis.fetch.bind(globalThis),
    /** @param {unknown} request @returns {Promise<ElicitationResult>} */
    async createElicitation(request) {
      if (!options.onElicitation) throw new Error("This MCP client cannot obtain browser approval; access was not granted");
      const response = await options.onElicitation(request);
      if (!isRecord(response) || !["accept", "decline", "cancel"].includes(response.action)) throw new Error("Invalid browser approval response");
      return response;
    },
    /** @param {RuntimeHook} hook @returns {() => void} */
    addAfterSubmittedCodeHook(hook) { return register(hook, afterHooks, options.addAfterSubmittedCodeHook); },
    /** @param {RuntimeHook} hook @returns {() => void} */
    addTurnEndedHandler(hook) { return register(hook, turnHooks, options.addTurnEndedHandler); },
    /** @param {string} channel @param {unknown} request @returns {Promise<unknown>} */
    async rpc(channel, request) {
      if (closed) throw new Error("Browser runtime host is closed");
      if (channel !== "browser") throw new Error("Unsupported runtime RPC channel");
      if (globalThis.nodeRepl !== nodeRepl) throw new Error("Install this host as globalThis.nodeRepl in its isolated worker");
      if (connectedHost && connectedHost !== nodeRepl) throw new Error("Use one official browser runtime host per worker");
      connectedHost = nodeRepl;
      service ??= import(pathToFileURL(enginePath).href);
      return (await service).handleRpc(request);
    },
  };

  /** @param {TurnIdentity} [value] @returns {Promise<void>} */
  async function endTurn(value) {
    const turn = value ? turnIdentity(value) : currentTurn();
    await Promise.all([...turnHooks].map((hook) => invokeHook(hook, turn)));
  }

  return {
    nodeRepl,
    endTurn,
    async runAfterSubmittedCodeHooks() {
      if (closed) throw new Error("Browser runtime host is closed");
      if (options.addAfterSubmittedCodeHook) return;
      for (const hook of afterHooks) await invokeHook(hook, undefined);
    },
    async close() {
      if (closed) return;
      // The worker must be terminated after close: there is no exported engine shutdown API.
      try {
        await endTurn();
      } finally {
        closed = true;
        nativePipe.close();
        for (const remove of unregister) remove();
        afterHooks.clear();
        turnHooks.clear();
      }
    },
  };
}
