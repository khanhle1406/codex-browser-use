import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BridgeBrowser } from "./bridge-browser.js";
import { defaultBridgeFile, readBackend } from "./backend-discovery.js";
import { BrowserScriptSession } from "./script-runner.js";

const bridgeFile = process.env.BROWSER_USE_BRIDGE_FILE ?? defaultBridgeFile();
const stringOrNumber = z.union([z.string(), z.number()]).transform((value) => String(value));
const returnStateEnum = z.enum(["none", "diff", "full", "screenshot", "both"]);
const axModeEnum = z.enum(["full", "compact", "interactive"]);
const tabGroupColorEnum = z.enum(["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]);
const keepEntrySchema = z.object({
  tab_id: stringOrNumber,
  mode: z.enum(["handoff", "deliverable"]).optional(),
});
const keepParamSchema = z.union([
  z.enum(["handoff", "deliverable"]),
  z.array(keepEntrySchema),
]);

/**
 * Normalize inline `keep` parameter + script-tracked kept tabs into unique keep entries.
 * @param {"handoff"|"deliverable"|Array<{tab_id:unknown, mode?:string}>|undefined} keep
 * @param {unknown} fallbackTabId
 * @param {Array<{tab_id:unknown, mode?:string}>} [extraKept]
 */
function resolveKeepEntries(keep, fallbackTabId, extraKept = []) {
  const merged = new Map();
  for (const entry of extraKept) {
    if (entry?.tab_id != null) {
      merged.set(String(entry.tab_id), entry.mode === "deliverable" ? "deliverable" : "handoff");
    }
  }
  if (typeof keep === "string") {
    if (fallbackTabId != null && fallbackTabId !== "") {
      merged.set(String(fallbackTabId), keep);
    }
  } else if (Array.isArray(keep)) {
    for (const entry of keep) {
      if (entry?.tab_id != null) {
        merged.set(String(entry.tab_id), entry.mode === "deliverable" ? "deliverable" : "handoff");
      }
    }
  }
  return [...merged.entries()].map(([tab_id, mode]) => ({ tab_id, mode }));
}

/** @type {Promise<BridgeBrowser>|null} */
let browserPromise = null;

/** @returns {Promise<BridgeBrowser>} */
function defaultGetBrowser() {
  browserPromise ??= BridgeBrowser.connect({ bridgeFile }).catch((error) => {
    browserPromise = null;
    throw error;
  });
  return browserPromise;
}

/** @param {unknown} value */
function text(value) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

/** @param {unknown} handler */
function guarded(handler) {
  return async (args) => {
    try {
      return await handler(args);
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      };
    }
  };
}

/** @param {{axText?:string, screenshotBase64?:string|null, screenshotMimeType?:string|null, notifications?:string[]}} state @param {Record<string, unknown>} [meta] */
function stateResponse(state, meta) {
  const parts = [];
  if (meta && Object.keys(meta).length > 0) parts.push(JSON.stringify(meta));
  if (state.notifications?.length) {
    parts.push(`<notifications>\n${state.notifications.map((n) => `- ${n}`).join("\n")}\n</notifications>`);
  }
  if (state.axText) parts.push(state.axText);
  const content = [{ type: "text", text: parts.join("\n") }];
  if (state.screenshotBase64) {
    content.push({
      type: "image",
      data: state.screenshotBase64,
      mimeType: state.screenshotMimeType || "image/jpeg",
    });
  }
  return { content };
}

/**
 * Attach optional post-action state (diff/full AX tree or screenshot) to reduce tool round-trips.
 * @param {BridgeBrowser} browser
 * @param {unknown} tabId
 * @param {Record<string, unknown>} actionResult
 * @param {string|undefined} returnState
 */
async function withOptionalState(browser, tabId, actionResult, returnState = "none") {
  if (!returnState || returnState === "none") return text(actionResult);
  const targetTabId = actionResult?.tab_id ?? tabId;
  if (returnState === "screenshot") {
    const capture = await browser.screenshot(targetTabId);
    return {
      content: [
        { type: "text", text: JSON.stringify(actionResult) },
        { type: "image", data: capture.data, mimeType: capture.mimeType },
      ],
    };
  }
  const state = await browser.getState(targetTabId, {
    screenshot: returnState === "both",
    diff: returnState === "diff",
    full: returnState === "full" || returnState === "both",
  });
  return stateResponse(state, actionResult);
}

const batchStepSchema = z.object({
  action: z.enum([
    "new_tab", "select_tab", "close_tab", "goto", "back", "forward", "reload",
    "click", "set_value", "type_text", "press_key", "select_option", "hover",
    "drag", "scroll", "locator_click", "locator_fill", "upload_files", "wait",
    "handle_dialog", "set_viewport", "reset_viewport", "name_session",
    "get_state", "get_content", "evaluate", "read_tab",
  ]).describe("Action type to execute"),
  tab_id: stringOrNumber.optional(),
  url: z.string().optional(),
  wait_until: z.enum(["commit", "domcontentloaded", "load", "networkidle"]).optional(),
  element_index: stringOrNumber.optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  click_count: z.number().int().min(1).max(3).optional(),
  mouse_button: z.enum(["left", "right", "middle"]).optional(),
  modifiers: z.union([z.string(), z.array(z.string())]).optional(),
  value: z.union([z.string(), z.array(z.string())]).optional(),
  label: z.union([z.string(), z.array(z.string())]).optional(),
  index: z.union([z.number().int(), z.array(z.number().int())]).optional(),
  text: z.string().optional(),
  key: z.string().optional(),
  direction: z.enum(["up", "down", "left", "right"]).optional(),
  pages: z.number().int().min(1).max(20).optional(),
  selector: z.string().optional(),
  frame: z.string().optional(),
  force: z.boolean().optional(),
  width: z.number().int().min(100).max(4096).optional(),
  height: z.number().int().min(100).max(4096).optional(),
  device_scale_factor: z.number().min(0).max(8).optional(),
  mobile: z.boolean().optional(),
  from_index: stringOrNumber.optional(),
  to_index: stringOrNumber.optional(),
  from_x: z.number().optional(),
  from_y: z.number().optional(),
  to_x: z.number().optional(),
  to_y: z.number().optional(),
  files: z.array(z.string()).optional(),
  state: z.enum(["attached", "detached", "visible", "hidden"]).optional(),
  load_state: z.enum(["domcontentloaded", "load", "networkidle"]).optional(),
  timeout_ms: z.number().int().min(0).max(60_000).optional(),
  accept: z.boolean().optional(),
  prompt_text: z.string().optional(),
  name: z.string().min(1).max(80).optional(),
  color: tabGroupColorEnum.optional(),
  expression: z.string().optional(),
  format: z.enum(["text", "markdown", "tables", "links"]).optional(),
  max_chars: z.number().int().min(200).max(100_000).optional(),
  mode: axModeEnum.optional(),
});

const compactBatchStepSchema = z.object({
  action: batchStepSchema.shape.action,
  tab_id: stringOrNumber.optional(),
  url: z.string().optional(),
  selector: z.string().optional(),
  element_index: stringOrNumber.optional(),
  value: z.union([z.string(), z.array(z.string())]).optional(),
  text: z.string().optional(),
  key: z.string().optional(),
}).passthrough();

const ALL_TOOL_NAMES = [
  "browser_status", "browser_run", "browser_batch", "browser_get_state",
  "browser_click", "browser_set_value", "browser_type_text", "browser_press_key",
  "browser_select_option", "browser_hover", "browser_drag", "browser_scroll",
  "browser_locator_click", "browser_locator_fill", "browser_wait_for",
  "browser_upload_files", "browser_screenshot", "browser_evaluate",
  "browser_get_content", "browser_dom_snapshot", "browser_inspect_element",
  "browser_console_logs", "browser_network_logs", "browser_set_viewport",
  "browser_name_session", "browser_handle_dialog",
  "browser_list_tabs", "browser_new_tab", "browser_select_tab", "browser_close_tab",
  "browser_goto", "browser_back", "browser_forward", "browser_reload",
  "browser_end_turn", "browser_reset",
];

const COMPACT_TOOLS = [
  "browser_run", "browser_batch", "browser_get_state", "browser_goto",
  "browser_list_tabs", "browser_screenshot", "browser_end_turn",
];

const STANDARD_TOOLS = [
  ...COMPACT_TOOLS,
  "browser_status", "browser_get_content", "browser_select_tab",
  "browser_new_tab", "browser_close_tab", "browser_evaluate", "browser_reset",
];

export const TOOL_PROFILES = {
  compact: COMPACT_TOOLS,
  standard: STANDARD_TOOLS,
  full: ALL_TOOL_NAMES,
};

/**
 * Resolve MCP tool surface profile from `--profile` CLI flag or `BROWSER_USE_TOOL_PROFILE`.
 * @param {string[]} [argv]
 * @param {Record<string, string|undefined>} [env]
 * @returns {"compact"|"standard"|"full"}
 */
export function resolveToolProfile(argv = process.argv.slice(2), env = process.env) {
  let profile = env?.BROWSER_USE_TOOL_PROFILE || "full";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--profile") {
      profile = argv[++i] || "";
    } else if (arg.startsWith("--profile=")) {
      profile = arg.slice("--profile=".length);
    }
  }
  if (!Object.hasOwn(TOOL_PROFILES, profile)) {
    throw new Error(`Invalid browser-use profile ${JSON.stringify(profile)}. Choose compact, standard, or full.`);
  }
  return /** @type {"compact"|"standard"|"full"} */ (profile);
}

/**
 * Register the Browser Use MCP surface filtered by profile (`full` = 36 tools, `standard` = 14, `compact` = 7).
 * @param {McpServer} server
 * @param {{getBrowser?:()=>Promise<BridgeBrowser>, resetBrowser?:()=>Promise<void>, profile?:"compact"|"standard"|"full"}} [deps]
 */
export function registerTools(server, deps = {}) {
  const profile = deps.profile ?? "full";
  if (!Object.hasOwn(TOOL_PROFILES, profile)) {
    throw new Error(`Invalid browser-use profile ${JSON.stringify(profile)}. Choose compact, standard, or full.`);
  }
  const activeTools = TOOL_PROFILES[profile];
  const allowedTools = new Set(activeTools);
  const registerTool = (name, description, schema, handler) => {
    if (allowedTools.has(name)) {
      server.tool(name, description, schema, handler);
    }
  };

  const scriptSession = new BrowserScriptSession();
  const getBrowser = deps.getBrowser ?? defaultGetBrowser;
  const resetBrowser = deps.resetBrowser ?? (async () => {
    scriptSession.reset();
    const browser = browserPromise ? await browserPromise.catch(() => null) : null;
    browserPromise = null;
    await browser?.close();
  });

  registerTool(
    "browser_status",
    "Report the Chrome bridge descriptor, connection state, and available tools. Does not open a browser session.",
    {},
    guarded(async () => {
      let bridge;
      try {
        await readBackend(bridgeFile);
        bridge = { state: "ready", file: bridgeFile };
      } catch (error) {
        bridge = { state: "unavailable", file: bridgeFile, reason: error instanceof Error ? error.message : String(error) };
      }
      return text({
        bridge,
        connected: deps.getBrowser ? undefined : browserPromise !== null,
        node: process.version,
        profile,
        tools: activeTools,
      });
    }),
  );

  registerTool(
    "browser_run",
    "Execute an async JavaScript browser script with persistent session bindings (`browser`/`page`, `ariaSnapshot()`, `ax.write()`, `content.export()`, read-only `evaluate`, `viewImage`, `saveFile`, `readFile`, `saveScreenshot`, `dev.responseBody`, `tabs.content`, `markDeliverable`) and optional `end_turn`.",
    {
      code: z.string().min(1).describe("Async JavaScript body with `browser`/`page`, `log`, `sleep`, `viewImage`, `saveFile`, `readFile`, `saveScreenshot` in scope"),
      tab_id: stringOrNumber.optional().describe("Optional initial tab_id"),
      timeout_ms: z.number().int().min(500).max(300_000).optional().describe("Timeout ms (default 45000, max 300000)"),
      return_state: returnStateEnum.optional().describe("Post-script state (default diff if result undefined, else none)"),
      mode: axModeEnum.optional().describe("AX compression mode: full (default), compact, or interactive"),
      end_turn: z.boolean().optional().describe("End turn automatically after script succeeds"),
      keep: keepParamSchema.optional().describe('Keep mode ("handoff" | "deliverable") or [{ tab_id, mode }]'),
      max_lines: z.number().int().min(1).max(10_000).optional().describe("Max AX lines (default 1500)"),
      reset_context: z.boolean().optional().describe("Reset persisted VM variables"),
    },
    async ({ code, tab_id, timeout_ms, return_state, mode, end_turn, keep, max_lines, reset_context }) => {
      let browser = null;
      let run = null;
      try {
        if (reset_context === true) scriptSession.reset();
        browser = await getBrowser();
        run = await scriptSession.run(browser, code, {
          tabId: tab_id,
          timeoutMs: timeout_ms ?? 45_000,
        });

        const shouldEndTurn = end_turn === true || keep !== undefined || (end_turn !== false && (run.keptTabs.length > 0 || run.endTurnRequested));
        const effectiveReturnState = return_state ?? (!shouldEndTurn && run.value === undefined ? "diff" : "none");

        let state = null;
        const images = [...run.images];
        if (effectiveReturnState === "screenshot" && run.activeTabId) {
          const cap = await browser.screenshot(run.activeTabId).catch(() => null);
          if (cap) images.push({ data: cap.data, mimeType: cap.mimeType });
        } else if (effectiveReturnState !== "none" && run.activeTabId) {
          state = await browser.getState(run.activeTabId, {
            screenshot: effectiveReturnState === "both",
            diff: effectiveReturnState === "diff",
            full: effectiveReturnState === "full" || effectiveReturnState === "both",
            maxLines: max_lines ?? 1_500,
            mode: mode ?? "full",
          }).catch(() => null);
          if (state?.screenshotBase64) {
            images.push({ data: state.screenshotBase64, mimeType: state.screenshotMimeType || "image/jpeg" });
          }
        }

        let endTurnResult = null;
        if (shouldEndTurn) {
          const entries = resolveKeepEntries(keep, run.activeTabId, run.keptTabs);
          endTurnResult = await browser.endTurn({ keep: entries });
        }

        const mergedNotifications = [...new Set([...(run.notifications ?? []), ...(state?.notifications ?? [])])];
        const payload = {
          ok: true,
          tab_id: run.activeTabId,
          ...(run.value !== undefined ? { result: run.value } : {}),
          ...(run.logs.length > 0 ? { logs: run.logs } : {}),
          ...(endTurnResult ? { end_turn: endTurnResult } : {}),
        };
        const parts = [JSON.stringify(payload, null, 2)];
        if (mergedNotifications.length > 0) {
          parts.push(`<notifications>\n${mergedNotifications.map((n) => `- ${n}`).join("\n")}\n</notifications>`);
        }
        if (state?.axText) parts.push(state.axText);

        const content = [{ type: "text", text: parts.join("\n") }];
        for (const img of images) {
          content.push({ type: "image", data: img.data, mimeType: img.mimeType || "image/jpeg" });
        }
        return { content };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const fallbackTab = run?.activeTabId ?? tab_id ?? browser?.activeTabId;
        const errState = (browser && fallbackTab != null)
          ? await browser.getState(fallbackTab, { screenshot: false, diff: true, maxLines: max_lines ?? 1_500 }).catch(() => null)
          : null;
        const parts = [msg];
        if (errState?.notifications?.length) {
          parts.push(`<notifications>\n${errState.notifications.map((n) => `- ${n}`).join("\n")}\n</notifications>`);
        }
        if (errState?.axText) parts.push(errState.axText);
        return { isError: true, content: [{ type: "text", text: parts.join("\n") }] };
      }
    },
  );

  registerTool(
    "browser_batch",
    "Execute multiple browser actions sequentially in one tool call with automatic settling and final state/diff.",
    {
      steps: z.array(profile === "compact" ? compactBatchStepSchema : batchStepSchema).min(1).max(50).describe("Ordered action steps"),
      tab_id: stringOrNumber.optional().describe("Optional tab_id"),
      return_state: returnStateEnum.optional().describe("Final state (default diff)"),
      mode: axModeEnum.optional().describe("AX mode: full, compact, or interactive"),
      max_lines: z.number().int().min(1).max(10_000).optional().describe("Max AX lines (default 1500)"),
      stop_on_error: z.boolean().optional().describe("Stop on first error (default true)"),
      end_turn: z.boolean().optional().describe("End turn after all steps succeed"),
      keep: keepParamSchema.optional().describe('Keep mode ("handoff"|"deliverable") or [{ tab_id, mode }]'),
    },
    guarded(async ({ steps, tab_id, return_state, mode, max_lines, stop_on_error, end_turn, keep }) => {
      const browser = await getBrowser();
      const result = await browser.batch(steps, {
        tabId: tab_id,
        returnState: return_state ?? "diff",
        mode: mode ?? "full",
        maxLines: max_lines ?? 1_500,
        stopOnError: stop_on_error !== false,
      });
      let endTurnResult = null;
      if (result.ok && (end_turn === true || keep !== undefined)) {
        const fallbackTab = result.state?.tab_id ?? tab_id ?? browser.activeTabId;
        endTurnResult = await browser.endTurn({ keep: resolveKeepEntries(keep, fallbackTab) });
      }
      const summary = {
        ok: result.ok,
        completed_steps: result.completed_steps.length,
        ...(result.ok ? {} : { failed_step: result.failed_step, error: result.error }),
        ...(endTurnResult ? { end_turn: endTurnResult } : {}),
      };
      if (!result.state) {
        const out = endTurnResult ? { ...result, end_turn: endTurnResult } : result;
        return { ...(result.ok ? {} : { isError: true }), content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
      }
      const response = stateResponse(result.state, summary);
      return result.ok ? response : { isError: true, ...response };
    }),
  );

  registerTool(
    "browser_list_tabs",
    "List all controllable Chrome tabs (both tabs created by this session and existing open user tabs) with tab_id, title, url, active state, owned flag, and origin ('agent' | 'user').",
    {},
    guarded(async () => text(await (await getBrowser()).listTabs())),
  );

  registerTool(
    "browser_new_tab",
    "Open a new tab, optionally navigating to a URL. The new tab becomes the active tab.",
    { url: z.string().optional().describe("URL to open in the new tab") },
    guarded(async ({ url }) => text(await (await getBrowser()).newTab(url))),
  );

  registerTool(
    "browser_select_tab",
    "Select an existing tab by tab_id (automatically claiming already-open user tabs in Chrome into this session) and make it the active tab.",
    { tab_id: stringOrNumber.describe("Tab ID from browser_list_tabs to activate and control") },
    guarded(async ({ tab_id }) => text(await (await getBrowser()).selectTab(tab_id))),
  );

  registerTool(
    "browser_close_tab",
    "Close a tab owned by this browser session.",
    { tab_id: stringOrNumber.describe("Tab ID to close") },
    guarded(async ({ tab_id }) => text(await (await getBrowser()).closeTab(tab_id))),
  );

  registerTool(
    "browser_goto",
    "Navigate a tab to a URL (auto-creating a tab if none exists), wait for load, and return the accessibility tree by default.",
    {
      url: z.string().describe("Destination URL"),
      tab_id: stringOrNumber.optional().describe("Optional tab_id; defaults to the active tab"),
      wait_until: z.enum(["commit", "domcontentloaded", "load", "networkidle"]).optional().describe("Load condition. Defaults to load"),
      return_state: returnStateEnum.optional().describe("State to return after navigation. Defaults to diff"),
    },
    guarded(async ({ url, tab_id, wait_until, return_state }) => {
      const browser = await getBrowser();
      const result = await browser.goto(url, tab_id, { waitUntil: wait_until ?? "load" });
      return withOptionalState(browser, tab_id, result, return_state ?? "diff");
    }),
  );

  registerTool(
    "browser_back",
    "Navigate the active tab back in browsing history.",
    {
      tab_id: stringOrNumber.optional().describe("Optional tab_id"),
      return_state: returnStateEnum.optional().describe("Optional post-action state"),
    },
    guarded(async ({ tab_id, return_state }) => {
      const browser = await getBrowser();
      const result = await browser.history("back", tab_id);
      return withOptionalState(browser, tab_id, result, return_state);
    }),
  );

  registerTool(
    "browser_forward",
    "Navigate the active tab forward in browsing history.",
    {
      tab_id: stringOrNumber.optional().describe("Optional tab_id"),
      return_state: returnStateEnum.optional().describe("Optional post-action state"),
    },
    guarded(async ({ tab_id, return_state }) => {
      const browser = await getBrowser();
      const result = await browser.history("forward", tab_id);
      return withOptionalState(browser, tab_id, result, return_state);
    }),
  );

  registerTool(
    "browser_reload",
    "Reload the active tab and wait for the document to finish loading.",
    {
      tab_id: stringOrNumber.optional().describe("Optional tab_id"),
      return_state: returnStateEnum.optional().describe("Optional post-action state"),
    },
    guarded(async ({ tab_id, return_state }) => {
      const browser = await getBrowser();
      const result = await browser.reload(tab_id);
      return withOptionalState(browser, tab_id, result, return_state);
    }),
  );

  registerTool(
    "browser_get_state",
    "Return the page accessibility tree as <ax_state> (diff-first unless full=true), plus optional screenshot.",
    {
      tab_id: stringOrNumber.optional().describe("Optional tab_id"),
      screenshot: z.boolean().optional().describe("Include viewport screenshot (default false)"),
      full_page: z.boolean().optional().describe("Full-page screenshot when screenshot=true"),
      format: z.enum(["jpeg", "png"]).optional().describe("Screenshot format (default jpeg)"),
      full: z.boolean().optional().describe("Return full AX tree instead of diff"),
      mode: axModeEnum.optional().describe("AX mode: full (default), compact, or interactive"),
      max_lines: z.number().int().min(1).max(10_000).optional().describe("Max accessibility lines (default 2000)"),
    },
    guarded(async ({ tab_id, screenshot, full_page, format, full, mode, max_lines }) => stateResponse(
      await (await getBrowser()).getState(tab_id, {
        screenshot: screenshot === true,
        fullPage: full_page === true,
        format: format ?? "jpeg",
        diff: full !== true,
        full: full === true,
        mode: mode ?? "full",
        maxLines: max_lines ?? 2_000,
      }),
    )),
  );

  registerTool(
    "browser_click",
    "Click elements by element_index (or comma-separated indices) or viewport coordinates (x, y), with Shadow-DOM hit-testing.",
    {
      element_index: stringOrNumber.optional().describe("Element index, or comma-separated indices such as '11, 12, 11'"),
      x: z.number().optional().describe("Viewport X coordinate when clicking without element_index"),
      y: z.number().optional().describe("Viewport Y coordinate when clicking without element_index"),
      click_count: z.number().int().min(1).max(3).optional().describe("Clicks per element. Defaults to 1"),
      mouse_button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button. Defaults to left"),
      modifiers: z.union([z.string(), z.array(z.string())]).optional().describe("Modifier keys held during click"),
      tab_id: stringOrNumber.optional().describe("Optional tab_id"),
      return_state: returnStateEnum.optional().describe("Optional post-action state"),
    },
    guarded(async ({ element_index, x, y, click_count, mouse_button, modifiers, tab_id, return_state }) => {
      const browser = await getBrowser();
      const result = await browser.click(element_index, {
        tabId: tab_id,
        x,
        y,
        clickCount: click_count ?? 1,
        button: mouse_button ?? "left",
        modifiers,
        settle: Boolean(return_state && return_state !== "none"),
      });
      return withOptionalState(browser, tab_id, result, return_state);
    }),
  );

  registerTool(
    "browser_set_value",
    "Semantically set the value of an input, textarea, checkbox/radio ('true'/'false'), select, or contenteditable element by element_index.",
    {
      element_index: stringOrNumber.describe("Element index"),
      value: z.string().describe("Value to assign"),
      tab_id: stringOrNumber.optional().describe("Optional tab_id"),
      return_state: returnStateEnum.optional().describe("Optional post-action state"),
    },
    guarded(async ({ element_index, value, tab_id, return_state }) => {
      const browser = await getBrowser();
      const result = await browser.setValue(element_index, value, { tabId: tab_id });
      return withOptionalState(browser, tab_id, result, return_state);
    }),
  );

  registerTool(
    "browser_type_text",
    "Insert literal text into the focused element, optionally focusing an element_index first.",
    {
      text: z.string().describe("Text to type"),
      element_index: stringOrNumber.optional().describe("Optional element index to focus first"),
      tab_id: stringOrNumber.optional().describe("Optional tab_id"),
      return_state: returnStateEnum.optional().describe("Optional post-action state"),
    },
    guarded(async ({ text: value, element_index, tab_id, return_state }) => {
      const browser = await getBrowser();
      const result = await browser.typeText(value, { tabId: tab_id, elementIndex: element_index });
      return withOptionalState(browser, tab_id, result, return_state);
    }),
  );

  registerTool(
    "browser_press_key",
    "Press a key or chord such as Return, Tab, Escape, or super+a.",
    {
      key: z.string().describe("Key or chord to press"),
      element_index: stringOrNumber.optional().describe("Optional element index to focus first"),
      tab_id: stringOrNumber.optional().describe("Optional tab_id"),
      return_state: returnStateEnum.optional().describe("Optional post-action state"),
    },
    guarded(async ({ key, element_index, tab_id, return_state }) => {
      const browser = await getBrowser();
      const result = await browser.pressKey(key, {
        tabId: tab_id,
        elementIndex: element_index,
        settle: Boolean(return_state && return_state !== "none"),
      });
      return withOptionalState(browser, tab_id, result, return_state);
    }),
  );

  registerTool(
    "browser_select_option",
    "Select one or more options on a <select> element by value, label, or index using element_index or a locator.",
    {
      element_index: stringOrNumber.optional().describe("Element index of the <select>"),
      selector: z.string().optional().describe("Locator expression if not using element_index"),
      frame: z.string().optional().describe("Optional iframe CSS selector chain (>>) "),
      value: z.union([z.string(), z.array(z.string())]).optional().describe("Option value(s)"),
      label: z.union([z.string(), z.array(z.string())]).optional().describe("Option label(s)"),
      index: z.union([z.number().int(), z.array(z.number().int())]).optional().describe("0-based option index/indices"),
      tab_id: stringOrNumber.optional().describe("Optional tab_id"),
      return_state: returnStateEnum.optional().describe("Optional post-action state"),
    },
    guarded(async ({ element_index, selector, frame, value, label, index, tab_id, return_state }) => {
      const browser = await getBrowser();
      const result = await browser.selectOption({ tabId: tab_id, elementIndex: element_index, selector, frame, value, label, index });
      return withOptionalState(browser, tab_id, result, return_state);
    }),
  );

  registerTool(
    "browser_hover",
    "Hover the pointer over an element_index, locator selector, or viewport coordinates (x, y).",
    {
      element_index: stringOrNumber.optional().describe("Element index to hover"),
      selector: z.string().optional().describe("Locator expression to hover"),
      frame: z.string().optional().describe("Optional iframe CSS selector chain (>>)"),
      x: z.number().optional().describe("Viewport X coordinate"),
      y: z.number().optional().describe("Viewport Y coordinate"),
      tab_id: stringOrNumber.optional().describe("Optional tab_id"),
      return_state: returnStateEnum.optional().describe("Optional post-action state"),
    },
    guarded(async ({ element_index, selector, frame, x, y, tab_id, return_state }) => {
      const browser = await getBrowser();
      const result = await browser.hover({ tabId: tab_id, elementIndex: element_index, selector, frame, x, y });
      return withOptionalState(browser, tab_id, result, return_state);
    }),
  );

  registerTool(
    "browser_drag",
    "Drag from a start element/coordinate to a target element/coordinate.",
    {
      from_index: stringOrNumber.optional().describe("Start element_index"),
      to_index: stringOrNumber.optional().describe("End element_index"),
      from_x: z.number().optional().describe("Start X coordinate"),
      from_y: z.number().optional().describe("Start Y coordinate"),
      to_x: z.number().optional().describe("End X coordinate"),
      to_y: z.number().optional().describe("End Y coordinate"),
      steps: z.number().int().min(2).max(30).optional().describe("Intermediate mouse move steps. Defaults to 8"),
      tab_id: stringOrNumber.optional().describe("Optional tab_id"),
      return_state: returnStateEnum.optional().describe("Optional post-action state"),
    },
    guarded(async ({ from_index, to_index, from_x, from_y, to_x, to_y, steps, tab_id, return_state }) => {
      const browser = await getBrowser();
      const result = await browser.drag({
        tabId: tab_id,
        fromIndex: from_index,
        toIndex: to_index,
        fromX: from_x,
        fromY: from_y,
        toX: to_x,
        toY: to_y,
        steps,
      });
      return withOptionalState(browser, tab_id, result, return_state);
    }),
  );

  registerTool(
    "browser_scroll",
    "Scroll the page, or a scrollable element_index / coordinate, by whole pages.",
    {
      direction: z.enum(["up", "down", "left", "right"]).describe("Scroll direction"),
      pages: z.number().int().min(1).max(20).optional().describe("Pages to scroll. Defaults to 1"),
      element_index: stringOrNumber.optional().describe("Optional element to scroll"),
      x: z.number().optional().describe("Optional viewport X coordinate"),
      y: z.number().optional().describe("Optional viewport Y coordinate"),
      tab_id: stringOrNumber.optional().describe("Optional tab_id"),
      return_state: returnStateEnum.optional().describe("Optional post-action state"),
    },
    guarded(async ({ direction, pages, element_index, x, y, tab_id, return_state }) => {
      const browser = await getBrowser();
      const result = await browser.scroll(direction, { tabId: tab_id, elementIndex: element_index, x, y, pages: pages ?? 1 });
      return withOptionalState(browser, tab_id, result, return_state);
    }),
  );

  registerTool(
    "browser_locator_click",
    "Click a single element matched by CSS, text=..., role=..., label=..., placeholder=..., testid=..., or chained >> locators (with built-in actionability auto-wait and open Shadow DOM / iframe piercing).",
    {
      selector: z.string().describe("Locator expression"),
      frame: z.string().optional().describe("CSS selector of an iframe, nested with >>"),
      click_count: z.number().int().min(1).max(3).optional().describe("Number of clicks. Defaults to 1"),
      mouse_button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button. Defaults to left"),
      modifiers: z.union([z.string(), z.array(z.string())]).optional().describe("Modifier keys held during click"),
      force: z.boolean().optional().describe("Bypass visibility/enabled/coverage checks. Defaults to false"),
      timeout_ms: z.number().int().min(0).max(60_000).optional().describe("Auto-wait timeout in ms (0 disables retry). Defaults to 3000"),
      tab_id: stringOrNumber.optional().describe("Optional tab_id"),
      return_state: returnStateEnum.optional().describe("Optional post-action state"),
    },
    guarded(async ({ selector, frame, click_count, mouse_button, modifiers, force, timeout_ms, tab_id, return_state }) => {
      const browser = await getBrowser();
      const result = await browser.locatorClick(selector, {
        tabId: tab_id,
        frame,
        clickCount: click_count ?? 1,
        button: mouse_button ?? "left",
        modifiers,
        force: force === true,
        timeoutMs: timeout_ms,
        settle: Boolean(return_state && return_state !== "none"),
      });
      return withOptionalState(browser, tab_id, result, return_state);
    }),
  );

  registerTool(
    "browser_locator_fill",
    "Fill a single element matched by CSS, text=..., role=..., label=..., placeholder=..., testid=..., or chained >> locators (with built-in auto-wait).",
    {
      selector: z.string().describe("Locator expression"),
      value: z.string().describe("Value to fill"),
      frame: z.string().optional().describe("CSS selector of an iframe, nested with >>"),
      force: z.boolean().optional().describe("Bypass visibility/enabled checks. Defaults to false"),
      timeout_ms: z.number().int().min(0).max(60_000).optional().describe("Auto-wait timeout in ms (0 disables retry). Defaults to 3000"),
      tab_id: stringOrNumber.optional().describe("Optional tab_id"),
      return_state: returnStateEnum.optional().describe("Optional post-action state"),
    },
    guarded(async ({ selector, value, frame, force, timeout_ms, tab_id, return_state }) => {
      const browser = await getBrowser();
      const result = await browser.locatorFill(selector, value, {
        tabId: tab_id,
        frame,
        force: force === true,
        timeoutMs: timeout_ms,
      });
      return withOptionalState(browser, tab_id, result, return_state);
    }),
  );

  registerTool(
    "browser_wait_for",
    "Wait until a selector reaches a state, text appears on the page, URL matches, or load_state completes.",
    {
      selector: z.string().optional().describe("Locator expression to wait for"),
      text: z.string().optional().describe("Visible text substring to wait for"),
      url: z.string().optional().describe("URL or substring to wait for"),
      load_state: z.enum(["domcontentloaded", "load", "networkidle"]).optional().describe("Document load state to wait for"),
      state: z.enum(["attached", "detached", "visible", "hidden"]).optional().describe("Selector state. Defaults to visible"),
      frame: z.string().optional().describe("Optional iframe CSS selector chain"),
      timeout_ms: z.number().int().min(100).max(60_000).optional().describe("Timeout in ms. Defaults to 10000"),
      tab_id: stringOrNumber.optional().describe("Optional tab_id"),
    },
    guarded(async ({ selector, text: expectedText, url, load_state, state, frame, timeout_ms, tab_id }) => text(
      await (await getBrowser()).waitFor({
        tabId: tab_id,
        selector,
        text: expectedText,
        url,
        loadState: load_state,
        state: state ?? "visible",
        frame,
        timeoutMs: timeout_ms ?? 10_000,
      }),
    )),
  );

  registerTool(
    "browser_upload_files",
    "Set absolute local file path(s) on an <input type='file'> element (by element_index or CSS selector) or an active file chooser.",
    {
      files: z.array(z.string()).min(1).describe("Absolute local file paths"),
      element_index: stringOrNumber.optional().describe("Element index of the file input"),
      selector: z.string().optional().describe("CSS selector of the file input"),
      frame: z.string().optional().describe("Optional iframe CSS selector chain"),
      tab_id: stringOrNumber.optional().describe("Optional tab_id"),
      return_state: returnStateEnum.optional().describe("Optional post-action state"),
    },
    guarded(async ({ files, element_index, selector, frame, tab_id, return_state }) => {
      const browser = await getBrowser();
      const result = await browser.uploadFiles(files, { tabId: tab_id, elementIndex: element_index, selector, frame });
      return withOptionalState(browser, tab_id, result, return_state);
    }),
  );

  registerTool(
    "browser_screenshot",
    "Capture a CSS-scaled screenshot (JPEG quality 75, max width 1280px by default).",
    {
      full_page: z.boolean().optional().describe("Capture beyond the viewport"),
      format: z.enum(["jpeg", "png"]).optional().describe("Image format (default jpeg)"),
      quality: z.number().int().min(10).max(100).optional().describe("JPEG quality 10-100 (default 75)"),
      max_width: z.number().int().min(320).max(4096).optional().describe("Cap viewport screenshot CSS width (default 1280)"),
      clip: z.object({
        x: z.number(),
        y: z.number(),
        width: z.number().positive(),
        height: z.number().positive(),
      }).optional().describe("Optional viewport clip rectangle"),
      tab_id: stringOrNumber.optional().describe("Optional tab_id"),
    },
    guarded(async ({ full_page, format, quality, max_width, clip, tab_id }) => {
      const capture = await (await getBrowser()).screenshot(tab_id, {
        fullPage: full_page === true,
        format: format ?? "jpeg",
        quality: quality ?? 75,
        ...(max_width !== undefined ? { maxWidth: max_width } : {}),
        clip,
      });
      return { content: [{ type: "image", data: capture.data, mimeType: capture.mimeType }] };
    }),
  );

  registerTool(
    "browser_evaluate",
    "Evaluate a read-only JavaScript expression in the page and return its value. Assignment, DOM mutation, navigation, and network calls are rejected.",
    {
      expression: z.string().describe("Read-only JavaScript expression"),
      tab_id: stringOrNumber.optional().describe("Optional tab_id"),
    },
    guarded(async ({ expression, tab_id }) => text(await (await getBrowser()).evaluate(expression, { tabId: tab_id }))),
  );

  registerTool(
    "browser_get_content",
    "Return page content as plain text, clean Readability-style markdown, extracted tables, or links.",
    {
      tab_id: stringOrNumber.optional().describe("Optional tab_id"),
      format: z.enum(["text", "markdown", "tables", "links"]).optional().describe("Extraction format (default text)"),
      max_chars: z.number().int().min(200).max(100_000).optional().describe("Character limit (default 16000 for structured formats)"),
    },
    guarded(async ({ tab_id, format, max_chars }) => {
      const opts = (format || max_chars !== undefined)
        ? { ...(format ? { format } : {}), ...(max_chars !== undefined ? { maxChars: max_chars } : {}) }
        : undefined;
      const result = await (await getBrowser()).getContent(tab_id, opts);
      return text(format === "tables" || format === "links" ? result : (result.content ?? result.text));
    }),
  );

  registerTool(
    "browser_dom_snapshot",
    "Return a compact visible DOM tree (default) or clean YAML ARIA snapshot (`format=\"aria\"`) for fast selector discovery or line filtering.",
    {
      format: z.enum(["dom", "aria"]).optional().describe('Snapshot format: "dom" (compact visible DOM) or "aria" (YAML ARIA tree). Defaults to "dom"'),
      mode: axModeEnum.optional().describe("ARIA compression mode when format='aria': full (default), compact, or interactive"),
      max_chars: z.number().int().min(1_000).max(100_000).optional().describe("Character limit for DOM format. Defaults to 24000"),
      max_lines: z.number().int().min(1).max(10_000).optional().describe("Line limit for ARIA format. Defaults to 2000"),
      tab_id: stringOrNumber.optional().describe("Optional tab_id"),
    },
    guarded(async ({ format, mode, max_chars, max_lines, tab_id }) => text(
      await (await getBrowser()).domSnapshot({
        tabId: tab_id,
        format: format ?? "dom",
        mode: mode ?? "full",
        maxChars: max_chars ?? 24_000,
        maxLines: max_lines ?? 2_000,
      }),
    )),
  );

  registerTool(
    "browser_inspect_element",
    "Inspect the element(s) at viewport coordinates (x, y) and return ranked locator candidates.",
    {
      x: z.number().describe("Viewport X coordinate"),
      y: z.number().describe("Viewport Y coordinate"),
      tab_id: stringOrNumber.optional().describe("Optional tab_id"),
    },
    guarded(async ({ x, y, tab_id }) => text(await (await getBrowser()).inspectElement(x, y, { tabId: tab_id }))),
  );

  registerTool(
    "browser_console_logs",
    "Read captured console messages and uncaught page exceptions for the tab.",
    {
      levels: z.array(z.enum(["log", "info", "warn", "error", "debug"])).optional().describe("Filter by log level"),
      filter: z.string().optional().describe("Case-insensitive substring filter"),
      limit: z.number().int().min(1).max(500).optional().describe("Max entries. Defaults to 100"),
      clear: z.boolean().optional().describe("Clear buffer after reading. Defaults to false"),
      tab_id: stringOrNumber.optional().describe("Optional tab_id"),
    },
    guarded(async ({ levels, filter, limit, clear, tab_id }) => text(
      await (await getBrowser()).consoleLogs({ tabId: tab_id, levels, filter, limit: limit ?? 100, clear: clear === true }),
    )),
  );

  registerTool(
    "browser_network_logs",
    "Read captured network requests, HTTP status codes, and failed requests for the tab.",
    {
      filter: z.string().optional().describe("Case-insensitive substring filter matched against URL, method, or error"),
      status_min: z.number().int().min(100).max(599).optional().describe("Minimum HTTP status code"),
      status_max: z.number().int().min(100).max(599).optional().describe("Maximum HTTP status code"),
      failed_only: z.boolean().optional().describe("Include only failed requests or HTTP status >= 400. Defaults to false"),
      resource_types: z.array(z.string()).optional().describe("Filter by resource type such as Document, Fetch, XHR, Script"),
      limit: z.number().int().min(1).max(300).optional().describe("Max entries. Defaults to 100"),
      clear: z.boolean().optional().describe("Clear buffer after reading. Defaults to false"),
      tab_id: stringOrNumber.optional().describe("Optional tab_id"),
    },
    guarded(async ({ filter, status_min, status_max, failed_only, resource_types, limit, clear, tab_id }) => text(
      await (await getBrowser()).networkLogs({
        tabId: tab_id,
        filter,
        statusMin: status_min,
        statusMax: status_max,
        failedOnly: failed_only === true,
        resourceTypes: resource_types,
        limit: limit ?? 100,
        clear: clear === true,
      }),
    )),
  );

  registerTool(
    "browser_set_viewport",
    "Override the tab viewport dimensions and mobile emulation for responsive layout testing, or reset back to normal.",
    {
      width: z.number().int().min(100).max(4096).optional().describe("Viewport width in CSS pixels (required unless reset=true)"),
      height: z.number().int().min(100).max(4096).optional().describe("Viewport height in CSS pixels (required unless reset=true)"),
      device_scale_factor: z.number().min(0).max(8).optional().describe("Device scale factor. Defaults to 1"),
      mobile: z.boolean().optional().describe("Enable mobile viewport metrics. Defaults to false"),
      reset: z.boolean().optional().describe("Clear viewport override and restore default viewport. Defaults to false"),
      tab_id: stringOrNumber.optional().describe("Optional tab_id"),
      return_state: returnStateEnum.optional().describe("Optional post-action state"),
    },
    guarded(async ({ width, height, device_scale_factor, mobile, reset, tab_id, return_state }) => {
      const browser = await getBrowser();
      const result = reset === true
        ? await browser.resetViewport(tab_id)
        : await browser.setViewport({
            tabId: tab_id,
            width,
            height,
            deviceScaleFactor: device_scale_factor ?? 1,
            mobile: mobile === true,
          });
      return withOptionalState(browser, tab_id, result, return_state);
    }),
  );

  registerTool(
    "browser_name_session",
    "Name the current browser automation session and group session-owned tabs inside a labeled Chrome tab group.",
    {
      name: z.string().min(1).max(80).describe("Visible Chrome tab group title"),
      color: tabGroupColorEnum.optional().describe("Chrome tab group color (grey, blue, red, yellow, green, pink, purple, cyan, orange). Defaults to blue"),
    },
    guarded(async ({ name, color }) => text(
      await (await getBrowser()).nameSession(name, { color: color ?? "blue" }),
    )),
  );

  registerTool(
    "browser_handle_dialog",
    "Accept or dismiss the JavaScript dialog currently open in the tab.",
    {
      accept: z.boolean().describe("true accepts, false dismisses"),
      prompt_text: z.string().optional().describe("Text to enter for a prompt dialog"),
      tab_id: stringOrNumber.optional().describe("Optional tab_id"),
      return_state: returnStateEnum.optional().describe("Optional post-action state"),
    },
    guarded(async ({ accept, prompt_text, tab_id, return_state }) => {
      const browser = await getBrowser();
      const result = await browser.handleDialog({ tabId: tab_id, accept, promptText: prompt_text });
      return withOptionalState(browser, tab_id, result, return_state);
    }),
  );

  registerTool(
    "browser_end_turn",
    "End the agent turn. Tabs marked as handoff stay available next turn, deliverable tabs stay open, and unmarked tabs close.",
    {
      keep: z.array(z.object({
        tab_id: stringOrNumber,
        mode: z.enum(["handoff", "deliverable"]).optional(),
      })).optional().describe("Tabs to keep through cleanup"),
    },
    guarded(async ({ keep }) => text(await (await getBrowser()).endTurn({ keep: keep ?? [] }))),
  );

  registerTool(
    "browser_reset",
    "Discard the current browser session and reset persisted `browser_run` variables.",
    {},
    guarded(async () => {
      scriptSession.reset();
      await resetBrowser();
      return text({ ok: true, reset: true });
    }),
  );
}

/**
 * Create a configured McpServer instance (useful for standalone run and unit tests).
 * @param {{getBrowser?:()=>Promise<BridgeBrowser>, resetBrowser?:()=>Promise<void>, profile?:"compact"|"standard"|"full"}} [deps]
 * @returns {McpServer}
 */
export function createStandaloneServer(deps = {}) {
  const profile = deps.profile ?? resolveToolProfile();
  const server = new McpServer(
    { name: "browser-use", version: "4.7.1" },
    {
      instructions: [
        "Browser use through a local Chrome bridge. Can create new session tabs or inspect and claim existing open user tabs in Chrome (via `browser_list_tabs` + `browser_select_tab` or `tab_id`, or `browser.tabs.list()` / `browser.user.openTabs()` + `browser.tabs.read()` / `browser.user.claimTab()` in `browser_run`). Claimed user tabs join the session Chrome Tab Group and are released (kept open & grouped) when a turn ends.",
        "Speed & efficiency (Probe 1 -> Batch Loop All): When facing repetitive UI rows/modals/pages, inspect 1 sample item first, then pack the full loop (clicks, chunked reads, `saveFile()`, pagination) or known deterministic click sequence into ONE `browser_run` call (up to 300000ms) instead of repeating small calls. Includes persistent variables (`const`/`let`/`class`), bound tabs (`browser.tabs.new()` / `browser.tabs.get(id)` / parallel `browser.tabs.content(urls)` returning structured `.links`/`.tables`), `browser.nameSession()`, auto-waiting locators (including async CKEditor sync), `locator.screenshot()` / `saveScreenshot()`, `dev.enableNetwork({ captureBodies: true })` + `dev.responseBody(id)`, `markDeliverable`/`markHandoff`, and `browser.endTurn()`/`browser.end_turn()`.",
        "Diff-first & inspect-first: Start with `ariaSnapshot({ mode: \"compact\" })` or `browser_get_state` / `ax.write()` before guessing selectors; narrow multi-matches with `.first()`/`.nth(i)` and use `reload()` rather than `goto(sameUrl)`. Request `screenshot: true` / `ax.write('screenshot')` / `saveScreenshot(..., { emit: true })` when visual inspection or Proof of Work is needed.",
        "Pass end_turn/keep to browser_run or browser_batch (or call `browser.endTurn()`/`markDeliverable()` inside `browser_run`), `browser_name_session` / `browser.nameSession()` to group tabs visually, and `browser_end_turn` at the end for tabs that must survive cleanup.",
      ].join("\n"),
    },
  );
  registerTools(server, { ...deps, profile });
  return server;
}

export async function main() {
  const server = createStandaloneServer();
  await server.connect(new StdioServerTransport());

  const shutdown = async () => {
    const browser = browserPromise ? await browserPromise.catch(() => null) : null;
    browserPromise = null;
    await browser?.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.once("end", shutdown);
}

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  main().catch((error) => {
    console.error("Fatal browser-use error:", error);
    process.exit(1);
  });
}
