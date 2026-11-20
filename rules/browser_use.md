---
trigger: always_on
description: Use the standalone browser-use MCP server (v4.5: 36 tools, Chrome tab group session naming, 1-shot multi-tab browser_run, auto-wait locators, batch-first, diff-first AX tree) for browser UI tasks while preserving user permissions and tab isolation.
---

# Browser Use Policy

1. **Default tool**: Use the standalone `browser-use` MCP server (`src/server.js`, 36 tools) for browser UI tasks: navigation, multi-tab workflows, Chrome tab group naming (`browser_name_session` / `browser.nameSession()`), form interaction, DOM/AX/console/network inspection, viewport emulation, uploads/downloads, and screenshots. Prefer API/CLI/`curl` tools when browser UI interaction is unnecessary.
2. **1-shot scripting, batch & diff-first execution**:
   - Start with `ariaSnapshot()` (with child iframe trees) or diff-first `ax.write()` / `getState()` before guessing CSS selectors; pair AX indices (`ax.click`, `ax.setValue`, `ax.performSecondaryAction`) with auto-waiting fluent locators (`getByRole`, `getByText`, `.filter()`, `.getAttribute()`, `.check()`, `.evaluateAll()`).
   - Prefer `browser_run` (persistent context across calls, `reset_context: true` to clear, first-class bound `browser.tabs.new()` handles with tab-pinned locators, `evaluate(fn, arg)`, `setViewport()`/`resetViewport()`, `waitForEvent("filechooser"|"download")`, `tab.dev.logs()`/`network()`, and inline `markDeliverable()`/`markHandoff()`/`keep`).
   - Prefer `browser_batch` for known linear step sequences (fill + click + wait or `set_viewport`/`reset_viewport`, optionally with `end_turn: true, keep: "deliverable"`) instead of sequential single-action round-trips.
   - `browser_goto` auto-creates a tab when none exists and returns `<ax_state>` directly.
   - Use diff-first `browser_get_state` (`screenshot: false` by default) and `ax.write()`, requesting screenshots (`screenshot: true` or `ax.write("screenshot")`) only when visual inspection is required.
3. **Read-only evaluate**: Use `browser_evaluate` and `evaluate(fn, arg)` strictly for read-only page inspection (including read-only `classList`/`dataset`/`style` reads); perform mutations via action and locator tools.
4. **Session tabs & existing user tabs**:
   - Use `browser_list_tabs` (or `browser.tabs.list()` / `browser.user.openTabs()` in `browser_run`) to find an already-open Chrome tab when the user asks to inspect or control an existing tab, then claim/activate it with `browser_select_tab` (or `browser.tabs.get(tab_id)` / `browser.user.claimTab(tab)`). Claimed user tabs are automatically released (never closed) when the turn ends.
   - Respect authentication, CAPTCHA, and site permission boundaries. When user sign-in or approval is needed, mark the tab `handoff` in `browser_end_turn` and ask the user directly.
5. **Turn cleanup**: End browser workflows with `browser_end_turn` (or inline `end_turn`/`keep` with `handoff` or `deliverable` when a tab must remain open).
