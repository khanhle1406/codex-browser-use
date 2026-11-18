import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BridgeBrowser } from "./bridge-browser.js";
import { defaultBridgeFile, readBackend } from "./backend-discovery.js";

const bridgeFile = process.env.BROWSER_USE_BRIDGE_FILE ?? defaultBridgeFile();
const stringOrNumber = z.union([z.string(), z.number()]).transform((value) => String(value));

/** @type {Promise<BridgeBrowser>|null} */
let browserPromise = null;

/** @returns {Promise<BridgeBrowser>} */
function getBrowser() {
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

/** @param {{axText?:string, screenshotBase64?:string|null}} state */
function stateResponse(state) {
  const content = [{ type: "text", text: state.axText ?? "" }];
  if (state.screenshotBase64) {
    content.push({ type: "image", data: state.screenshotBase64, mimeType: "image/png" });
  }
  return { content };
}

export function registerTools(server) {
  server.tool(
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
        connected: browserPromise !== null,
        node: process.version,
        tools: ["browser_get_state", "browser_click", "browser_set_value", "browser_type_text",
          "browser_press_key", "browser_scroll", "browser_locator_click", "browser_locator_fill",
          "browser_screenshot", "browser_evaluate", "browser_get_content", "browser_handle_dialog"],
      });
    }),
  );

  server.tool(
    "browser_list_tabs",
    "List tabs owned by this browser session with tab_id, title, url, and active state.",
    {},
    guarded(async () => text(await (await getBrowser()).listTabs())),
  );

  server.tool(
    "browser_new_tab",
    "Open a new tab, optionally navigating to a URL. The new tab becomes the active tab.",
    { url: z.string().optional().describe("URL to open in the new tab") },
    guarded(async ({ url }) => text(await (await getBrowser()).newTab(url))),
  );

  server.tool(
    "browser_select_tab",
    "Make an existing session tab the active tab.",
    { tab_id: stringOrNumber.describe("Tab ID to activate") },
    guarded(async ({ tab_id }) => text(await (await getBrowser()).selectTab(tab_id))),
  );

  server.tool(
    "browser_close_tab",
    "Close a tab owned by this browser session.",
    { tab_id: stringOrNumber.describe("Tab ID to close") },
    guarded(async ({ tab_id }) => text(await (await getBrowser()).closeTab(tab_id))),
  );

  server.tool(
    "browser_goto",
    "Navigate a tab to a URL and wait for the document to finish loading.",
    {
      url: z.string().describe("Destination URL"),
      tab_id: stringOrNumber.optional().describe("Optional tab_id; defaults to the active tab"),
    },
    guarded(async ({ url, tab_id }) => text(await (await getBrowser()).goto(url, tab_id))),
  );

  server.tool(
    "browser_back",
    "Navigate the active tab back in browsing history.",
    { tab_id: stringOrNumber.optional().describe("Optional tab_id") },
    guarded(async ({ tab_id }) => text(await (await getBrowser()).history("back", tab_id))),
  );

  server.tool(
    "browser_forward",
    "Navigate the active tab forward in browsing history.",
    { tab_id: stringOrNumber.optional().describe("Optional tab_id") },
    guarded(async ({ tab_id }) => text(await (await getBrowser()).history("forward", tab_id))),
  );

  server.tool(
    "browser_reload",
    "Reload the active tab and wait for the document to finish loading.",
    { tab_id: stringOrNumber.optional().describe("Optional tab_id") },
    guarded(async ({ tab_id }) => text(await (await getBrowser()).reload(tab_id))),
  );

  server.tool(
    "browser_get_state",
    "Return the page accessibility tree as <ax_state> with numbered element indices, plus a screenshot. Call this before clicking or typing by element index.",
    {
      tab_id: stringOrNumber.optional().describe("Optional tab_id"),
      screenshot: z.boolean().optional().describe("Include a viewport screenshot. Defaults to true"),
      max_lines: z.number().int().min(1).max(10_000).optional().describe("Maximum accessibility lines. Defaults to 2000"),
    },
    guarded(async ({ tab_id, screenshot, max_lines }) => stateResponse(
      await (await getBrowser()).getState(tab_id, { screenshot: screenshot !== false, maxLines: max_lines ?? 2_000 }),
    )),
  );

  server.tool(
    "browser_click",
    "Click elements by their element_index from browser_get_state. Multiple indices can be chained with commas to click several elements in order.",
    {
      element_index: stringOrNumber.describe("Element index, or comma-separated indices such as '11, 12, 11'"),
      click_count: z.number().int().min(1).max(3).optional().describe("Clicks per element. Defaults to 1"),
      mouse_button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button. Defaults to left"),
      tab_id: stringOrNumber.optional().describe("Optional tab_id"),
    },
    guarded(async ({ element_index, click_count, mouse_button, tab_id }) => text(
      await (await getBrowser()).click(element_index, { tabId: tab_id, clickCount: click_count ?? 1, button: mouse_button ?? "left" }),
    )),
  );

  server.tool(
    "browser_set_value",
    "Set the value of an editable element by element_index and dispatch input/change events.",
    {
      element_index: stringOrNumber.describe("Element index"),
      value: z.string().describe("Value to assign"),
      tab_id: stringOrNumber.optional().describe("Optional tab_id"),
    },
    guarded(async ({ element_index, value, tab_id }) => text(
      await (await getBrowser()).setValue(element_index, value, { tabId: tab_id }),
    )),
  );

  server.tool(
    "browser_type_text",
    "Insert literal text into the focused element, optionally focusing an element_index first.",
    {
      text: z.string().describe("Text to type"),
      element_index: stringOrNumber.optional().describe("Optional element index to focus first"),
      tab_id: stringOrNumber.optional().describe("Optional tab_id"),
    },
    guarded(async ({ text: value, element_index, tab_id }) => text(
      await (await getBrowser()).typeText(value, { tabId: tab_id, elementIndex: element_index }),
    )),
  );

  server.tool(
    "browser_press_key",
    "Press a key or chord such as Return, Tab, Escape, or super+a.",
    {
      key: z.string().describe("Key or chord to press"),
      element_index: stringOrNumber.optional().describe("Optional element index to focus first"),
      tab_id: stringOrNumber.optional().describe("Optional tab_id"),
    },
    guarded(async ({ key, element_index, tab_id }) => text(
      await (await getBrowser()).pressKey(key, { tabId: tab_id, elementIndex: element_index }),
    )),
  );

  server.tool(
    "browser_scroll",
    "Scroll the page, or a scrollable element_index, by whole pages.",
    {
      direction: z.enum(["up", "down", "left", "right"]).describe("Scroll direction"),
      pages: z.number().int().min(1).max(20).optional().describe("Pages to scroll. Defaults to 1"),
      element_index: stringOrNumber.optional().describe("Optional element to scroll"),
      tab_id: stringOrNumber.optional().describe("Optional tab_id"),
    },
    guarded(async ({ direction, pages, element_index, tab_id }) => text(
      await (await getBrowser()).scroll(direction, { tabId: tab_id, elementIndex: element_index, pages: pages ?? 1 }),
    )),
  );

  server.tool(
    "browser_screenshot",
    "Capture a PNG screenshot of the active tab viewport.",
    {
      full_page: z.boolean().optional().describe("Capture beyond the viewport. Defaults to false"),
      tab_id: stringOrNumber.optional().describe("Optional tab_id"),
    },
    guarded(async ({ full_page, tab_id }) => {
      const capture = await (await getBrowser()).screenshot(tab_id, { fullPage: full_page === true });
      return { content: [{ type: "image", data: capture.data, mimeType: capture.mimeType }] };
    }),
  );

  server.tool(
    "browser_evaluate",
    "Evaluate a read-only JavaScript expression in the page and return its value. Assignment, DOM mutation, navigation, and network calls are rejected.",
    {
      expression: z.string().describe("Read-only JavaScript expression"),
      tab_id: stringOrNumber.optional().describe("Optional tab_id"),
    },
    guarded(async ({ expression, tab_id }) => text(await (await getBrowser()).evaluate(expression, { tabId: tab_id }))),
  );

  server.tool(
    "browser_locator_click",
    "Click a single element matched by a CSS selector, text=..., role=<role>[name=\"...\"], or testid=... locator. Set frame to the CSS selector of an iframe to act inside it; nest frames with >>.",
    {
      selector: z.string().describe("Locator expression"),
      frame: z.string().optional().describe("CSS selector of an iframe, nested with >>"),
      tab_id: stringOrNumber.optional().describe("Optional tab_id"),
    },
    guarded(async ({ selector, frame, tab_id }) => text(
      await (await getBrowser()).locatorClick(selector, { tabId: tab_id, frame }),
    )),
  );

  server.tool(
    "browser_locator_fill",
    "Fill a single element matched by a CSS selector, text=..., role=<role>[name=\"...\"], or testid=... locator. Set frame to the CSS selector of an iframe to act inside it; nest frames with >>.",
    {
      selector: z.string().describe("Locator expression"),
      value: z.string().describe("Value to fill"),
      frame: z.string().optional().describe("CSS selector of an iframe, nested with >>"),
      tab_id: stringOrNumber.optional().describe("Optional tab_id"),
    },
    guarded(async ({ selector, value, frame, tab_id }) => text(
      await (await getBrowser()).locatorFill(selector, value, { tabId: tab_id, frame }),
    )),
  );

  server.tool(
    "browser_get_content",
    "Return the visible text content of the page.",
    { tab_id: stringOrNumber.optional().describe("Optional tab_id") },
    guarded(async ({ tab_id }) => {
      const result = await (await getBrowser()).getContent(tab_id);
      return text(result.text);
    }),
  );

  server.tool(
    "browser_handle_dialog",
    "Accept or dismiss the JavaScript dialog currently open in the tab.",
    {
      accept: z.boolean().describe("true accepts, false dismisses"),
      prompt_text: z.string().optional().describe("Text to enter for a prompt dialog"),
      tab_id: stringOrNumber.optional().describe("Optional tab_id"),
    },
    guarded(async ({ accept, prompt_text, tab_id }) => text(
      await (await getBrowser()).handleDialog({ tabId: tab_id, accept, promptText: prompt_text }),
    )),
  );

  server.tool(
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

  server.tool(
    "browser_reset",
    "Discard the current browser session and start a fresh one on the next call.",
    {},
    guarded(async () => {
      const browser = browserPromise ? await browserPromise.catch(() => null) : null;
      browserPromise = null;
      await browser?.close();
      return text({ ok: true, reset: true });
    }),
  );
}

export async function main() {
  const server = new McpServer(
    { name: "browser-use", version: "3.0.0" },
    {
      instructions: [
        "Browser use through a local Chrome bridge. Browser actions operate only on tabs this session creates.",
        "Call browser_get_state before clicking or typing by element_index: indices come from the current accessibility tree and go stale after navigation or DOM changes.",
        "Prefer element_index actions. Use browser_locator_click/browser_locator_fill when no index is available, and browser_evaluate only for read-only inspection.",
        "At the end of a task call browser_end_turn with keep entries for tabs that must survive.",
      ].join("\n"),
    },
  );

  registerTools(server);
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
