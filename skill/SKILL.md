---
name: codex-browser-use
description: Fast, token-efficient Chrome automation through a local stdio MCP bridge (36 tools in `full` profile; 7 core tools in `compact` profile via `--profile compact` / `BROWSER_USE_TOOL_PROFILE`). Run persistent multi-step and multi-tab workflows in 1 call with `browser_run`, group session tabs with `browser.nameSession()` / `browser_name_session`, auto-waiting fluent locators with rich-text smart fill, parallel `browser.tabs.new()` & auto-claimed popup handles, zero-debugger passive user tab reads (`browser.tabs.read()`), batch flows with `browser_batch`, diff-first & `mode` compression (`full`/`compact`/`interactive`), structured `page.content` exports, `page.webmcp`, `page.assets.list()`, viewport emulation, and CSS-scaled screenshots (`max_width` 1280px). Works with any MCP-capable coding agent.
---

# Browser Use

Use this skill for real Chrome browser tasks: navigating pages, filling forms, driving multiple tabs concurrently, responsive mobile/desktop UI auditing, clicking inside Shadow DOM or iframes, uploading/downloading files, inspecting DOM/console/network state, and capturing screenshots. Prefer a dedicated API, CLI, or `curl` for non-UI data retrieval.

The bridge can create new session tabs, read open user tabs passively with zero Chrome debugger attach (via `browser.tabs.read(id)` / `browser.user.getTabContext(id)` or passive `browser_get_content` using `chrome.scripting.executeScript`), or inspect and claim existing open user tabs in Chrome (via `browser_list_tabs` + `browser_select_tab` / `tab_id`, or `browser.tabs.list()` / `browser.user.openTabs()` + `browser.user.claimTab()` in `browser_run`). Claimed user tabs are released (never auto-closed) when a turn ends, and tabs currently owned by another active agent session remain isolated.

## Speed & Token-Efficiency Rules

1. **Zero wasted bootstrap calls**: Do NOT call `browser_new_tab` before `browser_goto` — `browser_goto`, `browser_batch`, and `browser_run` automatically create a tab if none exists and return `<ax_state>` when needed.
2. **Start with `ariaSnapshot()` / `<ax_state>` — never guess CSS selectors**: On complex apps (e.g. ChatGPT, dashboards, forms), inspect with `await page.ariaSnapshot({ mode: "compact" })` (includes child `[iframe ...]` trees and is filterable with `.split('\n').filter(...)`) or `ax.write()` / `browser_get_state` first. Pass `mode: "full" | "compact" | "interactive"` on `browser_get_state`, `ariaSnapshot()`, and `browser_run` to collapse repetitive rows/items and prune static boilerplate. Then combine AX indices (`ax.click(idx)`, `ax.setValue(idx, val)`, `ax.performSecondaryAction(idx, "Expand")`) with fluent auto-waiting locators (`page.getByRole(...)`, `page.getByText(...)`); `not_found` timeouts automatically include closest-locator fallback hints.
3. **Use persistent `browser_run` for Codex-speed workflows**: Top-level `const`/`let`/`class` bindings, bound `Tab` handles (`browser.tabs.new()`), saved tab-pinned `Locator` handles, and active tabs persist across `browser_run` calls (`reset_context: true` to clear). Locator calls reuse a persistent in-page runtime cache (`globalThis.__buRt` v1, ~29 KB → ~150-300 B per call), cached content script readiness, and a non-blocking virtual cursor (`BROWSER_USE_CURSOR_MODE=fast|smooth|off`, default `fast` = 0 ms blocking). Write 1-shot workflows using:
   - **Auto-waiting Locators & Rich-Text Smart Fill** (default 3000ms retry + Shadow-DOM hit-testing; override with `{ timeoutMs, force: true }`): `.click()`, `.dblclick()`, `.fill()` (includes rich-text smart fill for CKEditor 4/5, TinyMCE, Quill, and `contenteditable`), `.clear()`, `.press()`, `.pressSequentially()`, `.check()`, `.uncheck()`, `.setChecked()`, `.selectOption()`, `.hover()`, `.setInputFiles()`, `.getAttribute()`, `.inputValue()`, `.isVisible()`, `.isEnabled()`, `.isChecked()`, `.textContent()`, `.innerText()`, `.allTextContents()`, `.allInnerTexts()`, `.all()`, `.filter({ visible, hasText, hasNotText, has, hasNot })`, `.and()`, `.or()`, `frameLocator()`.
   - **Bound Multi-Tab Handles, Auto-Claimed Popups & Passive User Tab Reads**: `const tabA = await browser.tabs.new(); const tabB = await browser.tabs.new(); await Promise.all([tabA.goto(...), tabB.goto(...)]);` — locators created on `tabA` stay pinned to `tabA`, and `target="_blank"` popup/child tabs are auto-claimed (`const [popup] = await Promise.all([page.waitForEvent("popup"), link.click()])`). To read a user tab passively without attaching Chrome debugger, call `await browser.tabs.read(id)` / `await browser.user.getTabContext(id)` (or passive `browser_get_content`). To control an existing tab, call `const open = await browser.tabs.list()` (or `await browser.user.openTabs()`), **filter by `url`/`title` first**, and claim only the matching tab (`await browser.tabs.get(match.tab_id)` or `await browser.user.claimTab(match)` / `browser_select_tab({ tab_id })`) — never loop `tabs.get()` over unrelated user tabs! Remember to call `browser_end_turn` (or `end_turn: true`) when finished so debugger sessions detach cleanly.
   - **Diff-First `ax.write` & `ax.get`**: `await tab.ax.write()` (compact diff by default), `ax.write("state", { disableDiffing: true })`, `ax.write("screenshot")`, `ax.write("both")`, `ax.get(...)`, `ax.pressKey(idxOrNull, key)`, `ax.performSecondaryAction(idx, action)`.
   - **Structured Content, WebMCP & Assets**: `page.content.export({ format: "markdown" | "tables" | "links" | "text" })`, `page.content.tables()`, `page.content.links()` (or `browser_get_content` with `format`), `page.webmcp.listTools()` / `page.webmcp.invokeTool(name, args)`, and `page.assets.list()`.
   - **Read-Only `evaluate(fn, arg)`**: Supports JSON-serializable `arg` in `page.evaluate(fn, arg)`, `locator.evaluate(fn, arg)`, and `locator.evaluateAll(fn, arg)`, plus read-only reads on `classList`/`dataset`/`style`.
   - **Dev, Viewport, Session Grouping & Events**: `browser.nameSession("Checkout", "green")` (groups session tabs in Chrome), `tab.setViewport({ width: 390, height: 844, mobile: true })`, `tab.resetViewport()`, `tab.dev.logs()`, `tab.dev.network()`, `tab.expectNavigation(fn)`, `tab.waitForEvent("filechooser" | "download" | "popup")`, `tab.getJsDialog()`.
4. **Batch linear sequences with `browser_batch`**: Whenever you already know the exact linear sequence (e.g., `goto` → `locator_fill` → `locator_click` → `wait`, or `get_state`, `get_content`, `read_tab`, `evaluate`, `set_viewport` → `reset_viewport`), pack it into `browser_batch` (with optional `end_turn: true, keep: "deliverable"`).
5. **Diff-first, token-saving extraction & no speculative screenshots**: `browser_get_state` and `ax.write()` default to structural diffing without screenshots, and support `mode: "compact" | "interactive"`. Use `browser_get_content` (`format: "markdown" | "tables" | "links" | "text"`) for structured text/table extraction instead of full DOM dumps. Request `screenshot: true`, `ax.write("screenshot")`, `viewImage()`, or `browser_screenshot` (JPEG quality 75, `max_width` default 1280px) only when visual layout, images, or responsive breakpoints actually matter.
6. **Stop on the first authoritative signal**: Once an expected confirmation banner, selected state, URL change, or target output appears, stop exploring and report the result.
7. **Re-derive indices on DOM changes**: Numeric `element_index` values belong to the snapshot that produced them. After navigation or major DOM rewrites, read the returned `<ax_state>` or `ax.write()` before reusing an index.

## Core Workflows

### 0. One-Shot Dynamic Script & Multi-Tab Locators (`browser_run`)
```js
const tab = await browser.tabs.new();
await tab.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await tab.goto("https://example.com/form");
// Filter clean YAML ARIA snapshot with 1 line instead of dumping full DOM
log((await tab.ariaSnapshot()).split("\n").filter((l) => /Status|checkbox|radio|Continue/.test(l)).join("\n"));

await tab.getByRole("row", { name: /I certify/i }).filter({ hasNotText: "Archived" }).getByRole("checkbox").check();
await tab.getByRole("combobox").selectOption({ label: "Optimization" });
const options = await tab.getByRole("radio").evaluateAll((els, tag) => els.map((e) => ({ id: e.id, tag })), "tier");
await tab.ax.write("screenshot");
await tab.resetViewport();
await tab.markDeliverable();
return { url: await tab.url(), options, networkErrors: await tab.dev.network({ failedOnly: true }) };
```

### 1. Downloads & File Choosers (`waitForEvent`)
```js
const chooserPromise = page.waitForEvent("filechooser");
await page.getByRole("button", { name: "Upload CSV" }).click();
const chooser = await chooserPromise;
await chooser.setFiles(["/abs/path/data.csv"]);

const dlPromise = page.waitForEvent("download");
await page.getByRole("button", { name: "Export" }).click();
const download = await dlPromise;
const savedPath = await download.path();
```

### 2. Fast Batch Navigation & Form Flow (1 tool call)
```json
{
  "name": "browser_batch",
  "arguments": {
    "steps": [
      { "action": "goto", "url": "http://localhost:3000/login" },
      { "action": "locator_fill", "selector": "label=Email", "value": "ada@example.com" },
      { "action": "locator_fill", "selector": "label=Password", "value": "secret" },
      { "action": "locator_click", "selector": "role=button[name=\"Sign in\"]" },
      { "action": "wait", "text": "Dashboard" }
    ],
    "return_state": "diff"
  }
}
```
If any step fails, `browser_batch` stops immediately, reports `failed_step` + `error`, and includes the current `<ax_state>` so recovery takes 1 turn.

### 3. Inspect -> Act by Index
```text
browser_goto { url: "https://example.com" }           -> returns <ax_state> with 7 textbox "Email", 8 button "Save"
browser_batch { steps: [
  { action: "set_value", element_index: "7", value: "me@example.com" },
  { action: "click", element_index: "8" }
] }
```
`browser_set_value` works semantically across `<input>`, `<textarea>`, `<input type="checkbox"|"radio">` (`"true"` / `"false"`), `<select>` (by value or unique label), `[contenteditable]`, and `[role="tab"]`.

### 4. Locators (Shadow DOM + Combinators + Same/Cross-Origin Iframes)
Use locators in `browser_locator_click`, `browser_locator_fill`, `browser_select_option`, `browser_hover`, `browser_wait_for`, or inside `browser_batch` / `browser_run`:
- `css=.checkout button[type=submit]` or bare CSS selector
- `text=Sign in` (substring) or `text="Sign in"` (exact trimmed match)
- `role=button[name="Save"]` (resolves `aria-label`, `aria-labelledby`, `<label>`, `placeholder`, text, `value`)
- `label=Email`, `placeholder=Search...`, `testid=email-field` (`data-testid` / `data-test-id` / `data-test`)
- **Chaining, filters & combinators with `>>`**:
  - `css=.product-card >> has-text=Pro >> has=(css=.badge) >> role=button[name="Select"]`
  - `role=listitem >> visible=true >> has-not-text=Disabled >> nth=0` (or `first`, `last`)
  - `and=(...)` and `or=(...)` (via `.and()` / `.or()` in `browser_run`)
- **Iframes**: Pass `frame: "iframe#checkout"` (nest with `iframe#outer >> iframe#inner`) or `tab.frameLocator("iframe#checkout")` in `browser_run`. Works transparently for both same-origin iframes and cross-origin out-of-process iframes (OOPIFs).

### 5. Tool Profiles & Complete Tool Surface (36 Tools)

- **Profiles (`--profile compact|standard|full` or `BROWSER_USE_TOOL_PROFILE`)**:
  - `compact`: Registers 7 core tools (`browser_run`, `browser_batch`, `browser_get_state`, `browser_goto`, `browser_list_tabs`, `browser_screenshot`, `browser_end_turn`), reducing fixed tool schema size by ~78% (~7.4K tokens → ~1.5K tokens) for non-lazy CLI clients (e.g. Command Code).
  - `standard`: Balanced subset; `full` (36 tools): Default for clients with lazy loading (e.g. Antigravity).
  - Configure via `browser-use config --client <name> --profile compact` or `browser-use install ... --profile compact`.

| Group | Tools |
| --- | --- |
| **1-Shot Script, Batch & Observe** | `browser_run` (persistent async VM script + `globalThis.__buRt` v1 cache + bound `Tab` handles + `browser.tabs.read()` + `page.content` / `page.webmcp` / `page.assets.list()` + `browser.nameSession()` + auto-wait locators + `ariaSnapshot({ mode })` + `<notifications>` + inline `end_turn`), `browser_batch` (linear step pipelines + `get_state`, `get_content`, `read_tab`, `evaluate`, viewport/name_session steps + optional `end_turn`), `browser_get_state` (`mode: "full" \| "compact" \| "interactive"`), `browser_screenshot` (CSS-scaled JPEG quality 75, `max_width` default 1280px), `browser_get_content` (`format: "markdown" \| "tables" \| "links" \| "text"`, passive mode supported), `browser_dom_snapshot` (`format="dom"\|"aria"`), `browser_inspect_element`, `browser_console_logs`, `browser_network_logs`, `browser_status` |
| **Index & Coordinate Actions** | `browser_click` (supports `element_index`, comma chains, `(x, y)`, `modifiers`), `browser_set_value`, `browser_type_text`, `browser_press_key`, `browser_select_option`, `browser_hover`, `browser_drag`, `browser_scroll`, `browser_upload_files` |
| **Locators, Waits & Viewport** | `browser_locator_click` (auto-wait, `force`, `timeout_ms`), `browser_locator_fill` (auto-wait, `force`, `timeout_ms`), `browser_wait_for` (`selector`, `text`, `url`, `load_state`, `state`), `browser_set_viewport` (`width`, `height`, `device_scale_factor`, `mobile`, `reset`) |
| **Navigate, Tabs & Session UX** | `browser_goto` (`wait_until`, default `return_state: "diff"`), `browser_back`, `browser_forward`, `browser_reload`, `browser_list_tabs`, `browser_new_tab`, `browser_select_tab`, `browser_close_tab`, `browser_name_session` (Chrome tab group label + color) |
| **Evaluate, Dialogs & Lifecycle** | `browser_evaluate` (read-only AST-checked JS), `browser_handle_dialog`, `browser_end_turn`, `browser_reset` |

### 6. Specialized Operations
- **File uploads & downloads**: Use `page.waitForEvent("filechooser")` / `page.waitForEvent("download")` in `browser_run`, `locator.setInputFiles(...)`, or `browser_upload_files` with absolute local paths.
- **Responsive auditing**: Call `browser_set_viewport` (or `tab.setViewport` / `tab.resetViewport`) with `width`/`height`/`mobile: true`, inspect visually with `ax.write("screenshot")`, then reset before finishing.
- **JavaScript dialogs**: `browser_get_state` renders open `alert`/`confirm`/`prompt`/`beforeunload` dialogs cleanly without hanging; act via `browser_handle_dialog`, AX indices, or `tab.getJsDialog()` inside `browser_run`.
- **Debugging failed clicks or API errors**: Call `browser_network_logs` (`failed_only: true`) for failed HTTP/fetch requests, `browser_console_logs` for JS errors, `browser_inspect_element` at `(x, y)` for ranked locators, or `browser_dom_snapshot` for compact DOM structure.
- **Read-only inspection**: `evaluate` allows read-only reads on `classList`/`dataset`/`style` while rejecting assignments, DOM/style/classList/storage/history mutations, and network calls; use action tools for writes.

## Turn Cleanup & Boundaries
- Unmarked tabs close automatically at `browser_end_turn`.
- Pass `keep: [{ tab_id, mode: "handoff" }]` when a later turn needs the live tab (login, user step), or `mode: "deliverable"` to leave the completed tab open for the user.
- Never bypass CAPTCHA, sign-in, or permission walls — mark the tab `handoff` and ask the user to complete authentication manually.
