# codex-browser-use Tool Profiles & Inventory

Only read this reference when you need CLI profile flags (`--profile auto | compact | standard | full`) or the complete 36-tool MCP breakdown.

## Tool Profiles

- `--profile auto` selects the optimal profile per host via `browser-use config` / `install`: `"compact"` (`7` core tools) for CLI / non-lazy clients (`codex`, `claude_code`, `commandcode`, `copilot`, `opencode`, `generic`), and `"full"` (`36` tools) for lazy-loading clients (`antigravity`, `cursor`, `windsurf`).
- `--profile compact` (`BROWSER_USE_TOOL_PROFILE=compact`) registers **7 core tools** (`browser_run`, `browser_batch`, `browser_get_state`, `browser_goto`, `browser_list_tabs`, `browser_screenshot`, `browser_end_turn`), cutting fixed tool schema size by **75.4%** (`~1,865` vs `~7,576` est. tokens) for non-lazy CLI clients.
- `--profile standard` registers **14 tools** (`~3,023` est. tokens).
- `--profile full` (default for lazy-loading clients) exposes all **36 tools**:

| Group | Tools |
| --- | --- |
| **1-Shot Script, Batch & Observe** (`10`) | `browser_run`, `browser_batch`, `browser_get_state`, `browser_screenshot`, `browser_get_content`, `browser_dom_snapshot`, `browser_inspect_element`, `browser_console_logs`, `browser_network_logs`, `browser_status` |
| **Index & Coordinate Actions** (`9`) | `browser_click`, `browser_set_value`, `browser_type_text`, `browser_press_key`, `browser_select_option`, `browser_hover`, `browser_drag`, `browser_scroll`, `browser_upload_files` |
| **Locators, Waits & Viewport** (`4`) | `browser_locator_click`, `browser_locator_fill`, `browser_wait_for`, `browser_set_viewport` |
| **Navigate, Tabs & Groups** (`9`) | `browser_goto`, `browser_back`, `browser_forward`, `browser_reload`, `browser_list_tabs`, `browser_new_tab`, `browser_select_tab`, `browser_close_tab`, `browser_name_session` |
| **Evaluate, Dialogs & Lifecycle** (`4`) | `browser_evaluate`, `browser_handle_dialog`, `browser_end_turn`, `browser_reset` |
