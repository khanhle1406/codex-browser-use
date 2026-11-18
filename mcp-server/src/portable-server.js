import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ElicitRequestParamsSchema } from "@modelcontextprotocol/sdk/types.js";
import { discoverEngine } from "./engine-discovery.js";
import { readBackend } from "./backend-discovery.js";
import { ReplSession } from "./repl-session.js";

/** @typedef {import('@modelcontextprotocol/sdk/types.js').CallToolResult} ToolResult */
/** @typedef {{path:string,version:string,clientPath:string,servicePath:string,apiPath:string,manifestPath:string}} Engine */
/** @typedef {{requestId?:string|number,signal?:AbortSignal,_meta?:Record<string,unknown>}} ToolContext */

/** @param {string|undefined} label @param {ToolContext} context @returns {string} */
function sessionKey(label, context) {
  const providerSession = context._meta?.["ai.opencode/sessionID"];
  if (providerSession === undefined) return label ?? "default";
  if (typeof providerSession !== "string" || !providerSession.length || providerSession.length > 256) {
    throw new Error("Invalid OpenCode session metadata");
  }
  return JSON.stringify([providerSession, label ?? "default"]);
}

const instructions = `Use browser_js to execute JavaScript with top-level await. The persistent
agent binding is initialized using the locally installed original browser-client.
Each MCP connection is isolated. An OpenCode session gets its own runtime when its session ID is
present. Subagents sharing a conversation must choose distinct session labels and pass the same
label to all their tools. Use browser_close_session when finished.
Select the requested browser explicitly, e.g. const browser = await agent.browsers.get("chrome").
Read its complete documentation before actions: nodeRepl.write(await browser.documentation()).
Keep browser/tab bindings across calls. Use the documented playwright/cua/dom_cua APIs.
Webpage evaluate is the engine's guarded DOM evaluation, not arbitrary page mutation.
Use browser_end_turn after completing a task so claimed tabs release and unmarked new tabs clean up.
Mark deliverables/handoffs through the original tab API before ending the turn.
Do not replace another agent's claimed tab or bypass approval requests. If approval is unsupported,
report the limitation. Never fabricate a permission grant. This JS runtime executes trusted local
code with the operating-system privileges of the launching CLI; it is not a hostile-code sandbox.`;

/** Convert an exception to a tool error without disguising failure as null.
 * @param {unknown} error @returns {ToolResult} */
function toolError(error) {
  return {isError: true, content: [{type: "text", text: error instanceof Error ? error.message : String(error)}]};
}

/** @param {unknown} value @returns {ToolResult} */
function textResult(value) {
  return {content: [{type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2)}]};
}

/** Adapt the original host's approval shape to standard MCP without fabricating a grant.
 * @param {unknown} request @returns {import('@modelcontextprotocol/sdk/types.js').ElicitRequestParams} */
export function normalizeElicitation(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("Invalid browser permission request");
  const {meta, ...rest} = request;
  if (meta !== undefined && (!meta || typeof meta !== "object" || Array.isArray(meta))) throw new Error("Invalid browser permission metadata");
  if (rest._meta !== undefined && (!rest._meta || typeof rest._meta !== "object" || Array.isArray(rest._meta))) throw new Error("Invalid MCP permission metadata");
  const metadata = {...meta, ...rest._meta};
  if (["browser_auth", "browser_email_otp"].includes(metadata.codex_approval_kind)) {
    throw new Error("This provider adapter does not implement the original secure credential-entry flow. Sign in manually in the selected browser, then retry; no credentials or access were granted.");
  }
  return ElicitRequestParamsSchema.parse({
    ...rest,
    ...(rest.mode !== "url" && rest.requestedSchema === undefined ? {requestedSchema: {type: "object", properties: {}}} : {}),
    _meta: metadata,
  });
}

/** Create a separate runtime for one MCP connection. No browser is selected at startup.
 * @param {{engine?:Engine, env?:NodeJS.ProcessEnv, configRoot?:string, session?:ReplSession}} [options]
 * @returns {Promise<{server:McpServer,session:ReplSession,close:()=>Promise<void>}>} */
export async function createPortableServer(options = {}) {
  const env = options.env ?? process.env;
  const engine = options.engine ?? await discoverEngine({env});
  const server = new McpServer({name: "browser-use", version: "2.0.0"}, {instructions});
  /** @typedef {{session:ReplSession,queue:Promise<void>,generation:number,closing?:boolean,request?:{requestId?:string|number,signal?:AbortSignal}}} SessionRecord */
  /** @type {Map<string,SessionRecord>} */
  const sessions = new Map();
  let closed = false;
  /** @param {string} [label] @returns {SessionRecord} */
  function getSession(label = "default") {
    if (closed) throw new Error("Browser server is closing; new sessions are not accepted.");
    const existing = sessions.get(label);
    if (existing) return existing;
    if (sessions.size >= 16) throw new Error("This connection already has 16 sessions; close an unused session first.");
    /** @type {SessionRecord} */
    const record = {session: undefined, queue: Promise.resolve(), generation: 0};
    record.session = label === "default" && options.session ? options.session : new ReplSession({
      enginePath: engine.path,
      env,
      hostConfigRoot: options.configRoot ?? env.BROWSER_USE_CONFIG_ROOT ?? path.join(homedir(), ".local", "share", "browser-use"),
      requestMeta: {"x-codex-turn-metadata": {session_id: randomUUID(), turn_id: randomUUID()}},
      async onElicitation(params) {
        const capabilities = server.server.getClientCapabilities();
        if (!capabilities?.elicitation) throw new Error("This MCP client cannot display the browser engine's permission request. Use a client with MCP elicitation support; no access was granted.");
        return server.server.elicitInput(normalizeElicitation(params), {relatedRequestId: record.request?.requestId, signal: record.request?.signal});
      },
    });
    sessions.set(label, record);
    return record;
  }
  const session = getSession().session;
  const sessionSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional().describe("Stable label isolating subagents sharing this MCP connection; omitted uses default.");
  /** @param {string|undefined} label @param {(session:ReplSession)=>Promise<ToolResult>} operation @param {ToolContext} extra @returns {Promise<ToolResult>} */
  function run(label, operation, extra) {
    let record;
    try { record = getSession(sessionKey(label, extra)); }
    catch (error) { return Promise.resolve(toolError(error)); }
    const generation = record.generation;
    const result = record.queue.then(async () => {
      if (closed || record.closing || record.generation !== generation) {
        return toolError(new Error("Browser session changed before this request started."));
      }
      if (extra.signal?.aborted) return toolError(new Error("Browser request was cancelled before execution."));
      record.request = extra;
      try { return await operation(record.session); }
      catch (error) { return toolError(error); }
      finally { record.request = undefined; }
    });
    record.queue = result.then(() => undefined, () => undefined);
    return result;
  }
  /** @param {string|undefined} label @param {"reset"|"close"} action @param {ToolContext} context @returns {Promise<ToolResult>} */
  async function interrupt(label, action, context) {
    try {
      const key = sessionKey(label, context);
      if (action === "close" && label === undefined && key === "default") {
        throw new Error("Provide a session label to close a shared connection's browser session.");
      }
      const record = action === "close" ? sessions.get(key) : getSession(key);
      if (!record) return textResult("Browser session closed.");
      if (record.closing) throw new Error("Browser session is closing.");
      record.generation++;
      if (action === "close") {
        record.closing = true;
        try { await record.session.close(); }
        finally { sessions.delete(key); }
        return textResult("Browser session closed.");
      }
      // Start the reset immediately and make later evaluations wait for cleanup.
      const reset = record.session.reset();
      record.queue = Promise.allSettled([record.queue, reset]).then(() => undefined);
      await reset;
      return textResult("Runtime reset. The next browser_js call initializes a new agent binding.");
    } catch (error) {
      return toolError(error);
    }
  }
  server.registerTool("browser_js", {
    description: instructions,
    inputSchema: {
      code: z.string().min(1).max(1_000_000).describe("JavaScript using the persistent agent/browser/tab bindings. Explicitly write text or emit images."),
      timeout_ms: z.number().int().min(100).max(300_000).optional().describe("Execution deadline; expiry terminates and resets this connection's worker."),
      session: sessionSchema,
    },
  }, ({code, timeout_ms, session: label}, extra) => run(label, (runtime) => runtime.evaluate(code, {timeoutMs: timeout_ms, signal: extra.signal}), extra));
  server.registerTool("browser_documentation", {
    description: "Read bootstrap instructions without connecting to or inspecting the user's browser. After selecting a browser, read browser.documentation() through browser_js for supported APIs.",
    inputSchema: {},
    annotations: {readOnlyHint: true},
  }, async () => textResult({instructions, engineVersion: engine.version, enginePath: engine.path}));
  server.registerTool("browser_status", {
    description: "Report the selected engine, bridge descriptor and client approval support without inspecting browser tabs.",
    inputSchema: {}, annotations: {readOnlyHint: true},
  }, async () => {
    const client = server.server.getClientVersion();
    const elicitation = server.server.getClientCapabilities()?.elicitation;
    const descriptor = env.BROWSER_USE_BRIDGE_FILE;
    let bridge = {state: "not configured"};
    if (descriptor) {
      try {
        await readBackend(descriptor);
        bridge = {state: "socket descriptor valid"};
      } catch (error) {
        bridge = {state: "unavailable", reason: error instanceof Error ? error.message : String(error)};
      }
    }
    return textResult({
      engine, runtime: process.version, client,
      approval: elicitation ? "MCP elicitation advertised by client" : "MCP elicitation unavailable",
      bridge, sessionIsolation: "one worker per session label and OpenCode session ID, scoped to this MCP connection",
      browserConnectivity: "not checked", parity: "original engine reused; provider host equivalence must be tested",
    });
  });
  server.registerTool("browser_end_turn", {
    description: "Finish the task: run the original engine's turn cleanup, release claimed user tabs and clean up unmarked new tabs. Starts a fresh turn while preserving JavaScript bindings.",
    inputSchema: {session: sessionSchema},
  }, ({session: label}, extra) => run(label, async (runtime) => {
    const result = await runtime.endTurn();
    return result?.isError ? result : textResult("Turn ended. Obtain fresh tab bindings before using released or closed tabs.");
  }, extra));
  server.registerTool("browser_reset", {
    description: "Run cleanup and reset this connection's JS worker. Browser/tab bindings are discarded. Other connections are unaffected.",
    inputSchema: {session: sessionSchema},
  }, ({session: label}, extra) => interrupt(label, "reset", extra));
  server.registerTool("browser_close_session", {
    description: "End and remove a labeled session or the current OpenCode session, running original engine cleanup.",
    inputSchema: {session: sessionSchema},
  }, ({session: label}, extra) => interrupt(label, "close", extra));
  /** @returns {Promise<void>} */
  async function close() {
    if (closed) return;
    closed = true;
    const results = await Promise.allSettled([...sessions.values()].map((record) => record.session.close()));
    await server.close();
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  }
  server.server.onclose = () => { void close().catch((error) => console.error("Browser cleanup failed:", error.message)); };
  return {server, session, close};
}

/** Start a provider-independent stdio MCP server. @returns {Promise<void>} */
export async function main() {
  const runtime = await createPortableServer();
  await runtime.server.connect(new StdioServerTransport());
  /** @returns {void} */
  const stop = () => { void runtime.close().catch((error) => { console.error(error); process.exitCode = 1; }); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.stdin.once("end", stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("Fatal portable server error:", error);
    process.exitCode = 1;
  });
}
