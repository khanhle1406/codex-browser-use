---
trigger: always_on
description: Standalone browser-use MCP server (v4.9.0 / extension v0.7.0): 36 tools in full profile or 7 core tools in compact profile (-75.4% schema tokens), Probe-1-then-Batch 300s browser_run, zero-debugger passive reads, and compact-first AX diffs.
---

# Browser Use Policy

1. **Default Tool & Profiles**: Use the standalone `browser-use` MCP server (`v4.9.0` / extension `v0.7.0`) for browser UI tasks; prefer `curl`, CLI, or API calls when no UI interaction is needed (`--profile auto | compact` for CLI agents, `full` for lazy clients).
2. **Decision Routing**: Passive `browser.tabs.read(id)` / `browser_get_content` for unclaimed user tabs; `browser_batch` (`return_state: "diff"`) for short linear flows; `browser_run` (persistent VM + `page`, up to `300_000` ms) for loops, modals, Shadow DOM, `responseBody()`, and multi-tab work. Do not pre-read `references/*.md` upfront.
3. **Probe 1 → Batch Loop All**: Probe 1 sample item + `locator.ariaSnapshot()`, keep item #0 in memory, pack `i = 1..n` + `saveFile()` into 1 `browser_run` returning `{ count, file, sample }`, and trust auto-reported `saved_files` (`bytes > 0`) without extra `read_file`/`ls` checks.
4. **Inspect & Anti-Error**: Use `ariaSnapshot()` / `tabs.content` (`compact` default) before guessing selectors; use `.first()` / `.filter(...)` on multi-matches; stop blind retries after 2 misses and re-inspect; never `goto(sameUrl)` (use `tab.reload()`).
5. **Focus, Groups & Safety**: Keep agent tabs in background (never pass `focus: true`); reuse open localhost/preview tabs via `browser.user.openTabs()` + `browser.nameSession(label, color)`; pass `ungroup: true` when done. Keep `evaluate()` read-only (only local containers may be mutated); never bypass CAPTCHA/2FA/login prompts (`markHandoff()`).
