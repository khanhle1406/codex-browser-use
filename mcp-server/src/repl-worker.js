import repl from "node:repl";
import { PassThrough, Writable } from "node:stream";
import { inspect, format } from "node:util";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parse } from "acorn";

/** @typedef {{type: 'text', text: string} | {type: 'image', data: string, mimeType: string}} ContentItem */
/** @typedef {{nodeRepl: Record<string, any>, runAfterSubmittedCodeHooks?: () => Promise<void>, endTurn?: () => Promise<void>, close?: () => Promise<void>}} RuntimeHost */
/** @type {RuntimeHost | undefined} */
let host;
/** @type {Promise<void> | undefined} */
let initialized;
/** @type {repl.REPLServer | undefined} */
let runtime;
/** @type {((error: Error) => void) | undefined} */
let rejectEvaluation;
/** @type {ContentItem[]} */
let output = [];
let outputBytes = 0;
let outputTruncated = false;
/** @type {Record<string, unknown> | undefined} */
let responseMeta;
/** @type {Record<string, unknown>} */
let requestMeta = {};
/** @type {Map<number, {resolve: (value: unknown) => void, reject: (error: Error) => void}>} */
const elicitations = new Map();
let nextElicitation = 0;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

/** @param {unknown} item @returns {void} */
function emitContentItem(item) {
  if (typeof item === "string") item = { type: "text", text: item };
  if (item?.type === "metadata") {
    if (item.value && typeof item.value === "object") responseMeta = { ...responseMeta, ...item.value };
    return;
  }
  if (!item || typeof item !== "object" || !["text", "image", "audio", "resource", "resource_link"].includes(item.type)) throw new Error("Unsupported browser output content type");
  const bytes = Buffer.byteLength(JSON.stringify(item));
  if (outputBytes + bytes > MAX_OUTPUT_BYTES) {
    if (!outputTruncated) output.push({ type: "text", text: "[Output truncated at 2 MiB; emit a smaller result.]" });
    outputTruncated = true;
    return;
  }
  outputBytes += bytes;
  output.push(item);
}

/** @param {unknown} value @returns {void} */
function write(value) {
  emitContentItem({ type: "text", text: typeof value === "string" ? value : inspect(value, { depth: 8, maxArrayLength: 1000, maxStringLength: 100000 }) });
}

/** @param {unknown} value @returns {void} */
function emitImage(value) {
  if (typeof value === "string") {
    const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(value);
    if (!match) throw new Error("emitImage expects image bytes or a base64 image data URL");
    emitContentItem({ type: "image", mimeType: match[1], data: match[2] });
    return;
  }
  const descriptor = value && typeof value === "object" && "bytes" in value ? value : { bytes: value, mimeType: "image/png" };
  if (!(descriptor.bytes instanceof Uint8Array)) throw new Error("emitImage expects Uint8Array bytes");
  const mimeType = descriptor.mimeType ?? "image/png";
  if (typeof mimeType !== "string" || !mimeType.startsWith("image/")) throw new Error("Invalid image MIME type");
  emitContentItem({ type: "image", mimeType, data: Buffer.from(descriptor.bytes).toString("base64") });
}

/** @param {unknown} request @returns {Promise<unknown>} */
function onElicitation(request) {
  const id = ++nextElicitation;
  return new Promise((resolve, reject) => {
    elicitations.set(id, { resolve, reject });
    process.send?.({ type: "elicitation", id, request });
  });
}

/** Keep redeclaration semantics explicit without modifying strings, nested lexical scopes, or comments. @param {string} code @returns {string} */
function redeclarableCode(code) {
  const tree = parse(code, { ecmaVersion: "latest", sourceType: "script", allowAwaitOutsideFunction: true });
  /** @type {{start: number, end: number, replacement: string}[]} */
  const edits = [];
  for (const statement of tree.body) {
    if (statement.type === "VariableDeclaration" && statement.kind !== "var") edits.push({ start: statement.start, end: statement.start + statement.kind.length, replacement: "var" });
    if (statement.type === "ClassDeclaration" && statement.id) edits.push({ start: statement.start, end: statement.start, replacement: `var ${statement.id.name} = ` });
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) code = code.slice(0, edit.start) + edit.replacement + code.slice(edit.end);
  return code;
}

/** @param {Record<string, any>} options @returns {Promise<void>} */
async function initialize(options) {
  const initialMeta = options.requestMeta ?? {};
  const initialTurn = initialMeta["x-codex-turn-metadata"];
  const turn = typeof initialTurn === "string" ? JSON.parse(initialTurn) : initialTurn ?? {};
  if (!turn || typeof turn !== "object" || Array.isArray(turn)) throw new Error("Browser turn metadata must be an object");
  // A replacement worker never reuses a remotely ended or interrupted session.
  // Preserve policy/model context while issuing identities owned by this worker.
  requestMeta = { ...initialMeta, "x-codex-turn-metadata": JSON.stringify({ ...turn, session_id: randomUUID(), turn_id: randomUUID() }) };
  /** @type {Record<string, any>} */
  let nodeRepl = { write, emitImage };
  if (options.enginePath) {
    const { createRuntimeHost } = await import("./official-runtime.js");
    const env = {...process.env, ...options.env};
    if (env.BROWSER_USE_BRIDGE_FILE) {
      const {readBackend} = await import("./backend-discovery.js");
      env.BROWSER_USE_BACKEND_PATHS = await readBackend(env.BROWSER_USE_BRIDGE_FILE);
    }
    host = await createRuntimeHost({ enginePath: options.enginePath, env, configRoot: options.hostConfigRoot, requestMeta: () => requestMeta, onElicitation, emitContentItem });
    nodeRepl = host.nodeRepl;
    nodeRepl.write = write;
    nodeRepl.emitImage = emitImage;
  }
  globalThis.nodeRepl = nodeRepl;
  // Imported browser-client code uses the process console for displayValue,
  // so capture it too, not only console calls evaluated in the REPL context.
  globalThis.console = { ...console, ...Object.fromEntries(["log", "info", "warn", "error", "debug"].map((level) => [level, (...args) => write(format(...args))])) };
  runtime = repl.start({
    prompt: "",
    input: new PassThrough(),
    output: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
    terminal: false,
    useGlobal: false,
    handleError(error) { rejectEvaluation?.(error); return "ignore"; },
  });
  Object.assign(runtime.context, { nodeRepl, console: globalThis.console, Buffer, Uint8Array, setTimeout, clearTimeout, fetch });
  if (options.enginePath) {
    const client = await import(pathToFileURL(path.join(options.enginePath, "scripts/browser-client.mjs")).href);
    runtime.context.agent = await client.setupBrowserRuntime();
  }
}

/** @param {string} code @returns {Promise<unknown>} */
function evaluate(code) {
  const source = redeclarableCode(code);
  return new Promise((resolve, reject) => {
    rejectEvaluation = reject;
    runtime.eval(`${source}\n`, runtime.context, "browser-session.js", (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  }).finally(() => { rejectEvaluation = undefined; });
}

/** @param {{type: string, id: number, options?: Record<string, any>, params?: Record<string, any>, result?: unknown, error?: string}} message @returns {Promise<void>} */
async function handleMessage(message) {
  if (message.type === "elicitation_result") {
    const pending = elicitations.get(message.id);
    if (pending) {
      elicitations.delete(message.id);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
    }
    return;
  }
  output = [];
  outputBytes = 0;
  outputTruncated = false;
  responseMeta = undefined;
  try {
    initialized ??= initialize(message.options ?? {});
    await initialized;
    if (message.params?.requestMeta) requestMeta = message.params.requestMeta;
    if (message.type === "evaluate") {
      try {
        const value = await evaluate(message.params.code);
        if (value !== undefined) write(value);
      } finally {
        await host?.runAfterSubmittedCodeHooks?.();
      }
    } else if (message.type === "end_turn") {
      await host?.endTurn?.();
      const metadata = requestMeta["x-codex-turn-metadata"];
      const turn = typeof metadata === "string" ? JSON.parse(metadata) : metadata;
      requestMeta["x-codex-turn-metadata"] = JSON.stringify({ ...turn, turn_id: randomUUID() });
    } else if (message.type === "close") {
      await host?.close?.();
      runtime?.close();
    } else throw new Error(`Unknown JavaScript worker request: ${message.type}`);
    process.send?.({ type: "result", id: message.id, result: { content: output, ...(responseMeta ? { _meta: responseMeta } : {}) } });
    if (message.type === "close") process.disconnect();
  } catch (error) {
    emitContentItem({ type: "text", text: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
    process.send?.({ type: "result", id: message.id, result: { content: output, isError: true, ...(responseMeta ? { _meta: responseMeta } : {}) } });
  }
}

process.on("message", (message) => { void handleMessage(message); });
process.on("disconnect", () => { process.exit(0); });
