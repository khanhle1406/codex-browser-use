<div align="center">

<img src="docs/assets/logo.png" alt="codex-browser-use logo" width="96" />

# codex-browser-use

### Give any coding agent your real Chrome browser.

**Codex's Browser Use feature is so good — so I cloned it and built a faster, open-source version for every coding agent.**

[![License: MIT](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-26.12.1%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](#quick-start)
[![MCP tools](https://img.shields.io/badge/MCP-36%20tools-5B8DEF?style=flat-square)](#why-its-better)
[![Extension](https://img.shields.io/badge/Extension-v0.5.2-34D399?style=flat-square)](#quick-start)
[![GitHub stars](https://img.shields.io/github/stars/khanhle1406/codex-browser-use?style=flat-square)](https://github.com/khanhle1406/codex-browser-use/stargazers)

[Quick start](#quick-start) · [What you can do](#what-you-can-do) · [How it works](#how-it-works) · [Why it's better](#why-its-better) · [FAQ](#faq) · [Docs](#documentation)

<code>node mcp-server/bin/browser-use.js install --client antigravity --write --skill</code>

<br />

<img src="docs/assets/banner.png" alt="codex-browser-use — Local Chrome MCP Bridge" width="100%" />

</div>

---

OpenAI Codex's built-in Browser Use feature is one of the best developer experiences for web automation. Instead of fighting flaky headless browsers or wasting thousands of tokens on huge HTML dumps, it drives your real Chrome window using clean, numbered page outlines and fast JavaScript workflows. The only problem is that it stays locked inside one proprietary tool.

So I rebuilt that workflow cleanly from scratch as a standalone MIT MCP server — and made it faster. Your coding agent connects straight to your local Chrome, reads pages as lightweight accessibility trees, runs multi-step scripts in a single turn, and groups its own tabs neatly without ever touching your personal browsing.

There is no Playwright download, no proprietary runtime binary, and no cloud proxy. One install command wires everything up for **Antigravity, Claude Code, Codex, Cursor, Windsurf, Copilot CLI, Command Code, and OpenCode**.

## Quick start

**You need:** Node.js **26.12.1 or newer**, npm, and Chrome (or Chromium, Edge, or Brave).

### 1. Install

Run these commands from the repository root:

```sh
npm --prefix mcp-server ci
node mcp-server/bin/browser-use.js install --client antigravity --write --skill
node mcp-server/bin/browser-use.js doctor --json
```

`install` copies the Chrome extension (`v0.5.2`) to your home directory, registers Chrome's local bridge, adds the MCP entry to your agent (with a `.bak` backup), and installs the matching workflow skill.

<details>
<summary><strong>Using Claude Code, Codex, Cursor, Windsurf, Copilot, Command Code, or OpenCode?</strong></summary>

Swap `--client antigravity` with your editor (`claude_code`, `cursor`, `windsurf`, `copilot`, or `commandcode`):

```sh
node mcp-server/bin/browser-use.js install --client cursor --write --skill
```

For Codex or OpenCode (TOML / JSONC configs), print the exact config snippet and install the skill:

```sh
node mcp-server/bin/browser-use.js config --client codex
node mcp-server/bin/browser-use.js config --client opencode
node mcp-server/bin/browser-use.js install --client codex --skill
```

</details>

### 2. Connect Chrome

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick `~/.local/share/browser-use/extension`.
2. Click the **Portable Browser Bridge** icon on Chrome's toolbar once so the green badge shows `ON`.
3. Restart your coding agent so it picks up all **36 tools**.

### 3. Ask your agent

Once connected, just ask in plain English:

```text
Open http://127.0.0.1:3000 in a Chrome tab group named "App QA".
Test the signup form on both desktop and mobile viewports, check for console
or failed network requests, and leave the finished tab open for me to review.
```

## What you can do

| Use case | How it helps |
| --- | --- |
| **Test your app end-to-end** | Fill forms, click buttons, switch mobile/desktop viewports, and catch JS console errors or failed API requests right after editing code. |
| **Research across multiple tabs** | Open several tabs in parallel inside a single turn, extract structured data with read-only JavaScript, and summarize pages cleanly. |
| **Handle modern web UIs** | Works inside Shadow DOM components and embedded third-party iframes (like checkout widgets), plus real file uploads and downloads. |
| **Keep Chrome organized** | Label each agent's work into a color-coded Chrome Tab Group (`Checkout QA`, `Docs Audit`) while scratch tabs auto-clean when done. |
| **Hand off logins & CAPTCHAs safely** | Never tries to bypass security checks — the agent pauses on login/2FA screens and leaves the live tab open for you to sign in manually. |

## How it works

### 1. Everything runs locally on your machine

<img src="docs/assets/how-it-works-architecture.png" alt="4-layer local architecture: AI Agent to MCP Server to Local Bridge to Chrome Tab" width="100%" />

[Open full-size figure](docs/assets/how-it-works-architecture.png).

Your agent talks to a local MCP server, which sends fast commands over a local Unix socket and Chrome Native Messaging straight into a lightweight Chrome extension. Nothing passes through an external browser cloud or Playwright wrapper — every click and page read stays on your laptop.

### 2. Fast actions, tiny token usage

<img src="docs/assets/how-it-works-workflow.png" alt="Workflow: run multi-step scripts in one call, read diff-first accessibility trees, and act without polling" width="100%" />

[Open full-size figure](docs/assets/how-it-works-workflow.png).

- **Multi-step scripts in one call**: Instead of burning an LLM turn per click, `browser_run` (or `browser_batch`) runs full multi-step flows and parallel tabs in a single tool call while remembering variables across turns.
- **Diff-first `<ax_state>`**: Instead of re-sending huge HTML pages or Retina screenshots every step, the server strips noisy decorative nodes and only sends what actually changed (`+` added, `~` modified, `-` removed). Screenshots are optional and scaled down to crisp 1x JPEG when needed.
- **Zero-polling waiting**: Page loads wake directly on Chrome events, and element waits observe live DOM mutations inside the page instead of hammering Chrome with timer loops.

<details>
<summary><strong>Example: what a 1-shot <code>browser_run</code> workflow looks like</strong></summary>

```json
{
  "name": "browser_run",
  "arguments": {
    "return_state": "none",
    "end_turn": true,
    "code": "await browser.nameSession('Docs Audit', 'cyan');\nconst [docsTab, pricingTab] = await Promise.all([\n  browser.tabs.new('https://example.com/docs'),\n  browser.tabs.new('https://example.com/pricing')\n]);\nconst outline = await docsTab.ariaSnapshot();\nconst plans = await pricingTab.locator('css=.plan-card').evaluateAll((els) => els.map((e) => e.dataset.tier));\nawait pricingTab.markDeliverable();\nreturn { outlineLines: outline.split('\\n').length, plans };"
  }
}
```

Or use `browser_batch` for linear steps (`goto`, `set_viewport`, `locator_fill`, `locator_click`, `wait`) in one call.

</details>

### 3. Your personal tabs stay untouched

<img src="docs/assets/how-it-works-isolation.png" alt="Chrome Tab Groups isolating Personal Tabs from Agent A and Agent B sessions" width="100%" />

[Open full-size figure](docs/assets/how-it-works-isolation.png).

The Chrome extension keeps a strict list of tabs it created for each agent session. Pre-existing personal tabs, cookies, and windows are off-limits to agents. When multiple agents run at the same time, each gets its own isolated tabs (and optional named Chrome Tab Group), and scratch tabs close automatically when a turn ends unless kept as a `handoff` (for user login) or `deliverable` (final result).

## Why it's better

| Feature | Playwright / Screenshot MCPs | Codex Built-in Browser Use | `codex-browser-use` |
| --- | :---: | :---: | :---: |
| Works with any coding agent | ✅ | ❌ Codex only | ✅ Any MCP client |
| Zero Playwright / closed binaries | ❌ | ❌ | ✅ Pure MIT JS + MV3 |
| 1-call scripting + parallel tabs | ❌ Turn-by-turn | ✅ | ✅ + `browser.tabs.new` |
| Diff-first `<ax_state>` + YAML ARIA | ❌ Raw DOM / PNG spam | ✅ | ✅ Structural diffs |
| Named Chrome Tab Groups | ❌ | ❌ | ✅ Color-coded groups |
| Concurrent socket & DOM-observer speed | ❌ Sequential / timer polls | Partial | ✅ Up to 6.8x faster |

Even better, v4.5.1 removes the hidden bottlenecks that slow local browser bridges down: **6.83x faster** parallel multi-tab workflows, **2.9x–3.1x faster** full page + iframe + Retina screenshot reads, and **zero** wasted polling requests while pages load.

<details>
<summary><strong>See full benchmark numbers &amp; reproduce locally</strong></summary>

Measured on Node `v26.13.0` with [perf-benchmark.mjs](mcp-server/bench/perf-benchmark.mjs) using real Unix sockets, Native Messaging streams running `extension/background.js`, and a DOM VM with live `MutationObserver` (holding simulated CDP latencies constant before vs. after optimization):

| Scenario | Before | After | Speedup |
| --- | --- | --- | --- |
| **4 Parallel Tabs** (`goto` + `getState`) | `606.79 ms` | **`88.86 ms`** | **6.83x faster** (`-85.4%`) |
| **`getState` + 4 Child Iframes + Screenshot** | `267.63 ms` / `226.38 ms` | **`90.88 ms`** / **`72.59 ms`** | **2.94x** cold / **3.12x** warm |
| **`goto(..., waitUntil: "load")`** (+ assets) | `130.54 ms` (`10` polls) | **`113.58 ms`** (**`0`** polls) | **`-100%` polling RPCs** |
| **Wait for DOM Elements & Text** (`90ms` delay) | `406.74 ms` (`8` RPCs) | **`289.37 ms`** (`3` RPCs) | **1.41x faster** / `-62.5%` calls |
| **`setValue` Sequential** (`10` fields) | `399.85 ms` (`40` CDPs) | **`187.89 ms`** (`20` CDPs) | **2.13x faster** (`50%` fewer CDPs) |
| **Cross-Origin Iframe Clicks** (`10` clicks) | `494.31 ms` (`51` CDPs) | **`151.28 ms`** (`15` CDPs) | **3.27x faster** (`-70.6%` CDPs) |
| **Extension 2,000 Events & 40 Large Replies** | `34.18 ms` / `120` msgs | **`26.57 ms`** / **`40` msgs** | `-22.3%` CPU / **`-66.7%` wire msgs** |
| **Fragmented 1 MB Frames (`40 MB` IPC)** | `263.01 ms` (`152.1 MB/s`) | **`132.20 ms`** (**`302.6 MB/s`**) | **~2.0x throughput** |

Run it yourself:

```sh
npm --prefix mcp-server run bench
```

</details>

<details>
<summary><strong>View all 36 MCP tools</strong></summary>

| Group | Tools |
| --- | --- |
| **1-Shot, Batch & Status** (`3`) | `browser_run`, `browser_batch`, `browser_status` |
| **Read & Debug** (`8`) | `browser_get_state`, `browser_screenshot`, `browser_get_content`, `browser_dom_snapshot`, `browser_inspect_element`, `browser_console_logs`, `browser_network_logs`, `browser_evaluate` |
| **Actions** (`9`) | `browser_click`, `browser_set_value`, `browser_type_text`, `browser_press_key`, `browser_select_option`, `browser_hover`, `browser_drag`, `browser_scroll`, `browser_upload_files` |
| **Locators, Waits & Viewport** (`4`) | `browser_locator_click`, `browser_locator_fill`, `browser_wait_for`, `browser_set_viewport` |
| **Navigation, Tabs & Groups** (`9`) | `browser_goto`, `browser_back`, `browser_forward`, `browser_reload`, `browser_list_tabs`, `browser_new_tab`, `browser_select_tab`, `browser_close_tab`, `browser_name_session` |
| **Dialogs & Turn Lifecycle** (`3`) | `browser_handle_dialog`, `browser_end_turn`, `browser_reset` |

</details>

## FAQ

<details>
<summary><strong>Which coding agents work with this?</strong></summary>

Any tool that speaks local MCP stdio: Antigravity, Claude Code, Codex CLI, Cursor, Windsurf, GitHub Copilot CLI, Command Code, OpenCode, or custom agent harnesses.

</details>

<details>
<summary><strong>Can the agent see my personal Chrome tabs or passwords?</strong></summary>

No. The extension only attaches to blank tabs it created for that MCP session. Your existing tabs, bookmarks, and unrelated windows cannot be read or closed. Read-only JavaScript inspection (`browser_evaluate`) is also AST-checked to block DOM writes, navigation, storage writes, and network calls.

</details>

<details>
<summary><strong>Why not just use Playwright MCP?</strong></summary>

Playwright spawns separate heavy browser binaries, lacks your everyday Chrome environment, and typically sends verbose DOM snapshots or full PNGs per action. `codex-browser-use` connects straight to your running Chrome over CDP with diff-first `<ax_state>`, named Tab Groups, and 1-shot script execution — zero extra browsers to install.

</details>

<details>
<summary><strong>What happens on login screens, 2FA, or CAPTCHAs?</strong></summary>

Agents are instructed never to bypass login walls or CAPTCHAs. Instead, the agent marks the tab `handoff`, tells you it is waiting, and lets you log in or solve the prompt directly in Chrome before continuing.

</details>

<details>
<summary><strong>How do I verify my setup or update the extension?</strong></summary>

Pull the latest code, re-run `node mcp-server/bin/browser-use.js install --client <your-client> --skill`, click **Reload** on **Portable Browser Bridge** in `chrome://extensions`, and run `node mcp-server/bin/browser-use.js doctor --json`.

</details>

## Documentation

Run tests, lint, and health checks anytime:

```sh
npm --prefix mcp-server test
npm --prefix mcp-server run lint
npm --prefix mcp-server run bench
node mcp-server/bin/browser-use.js doctor --json
```

- [Agent Skill Instructions](skill/SKILL.md) — workflow guidance installed into your coding agent
- [Browser Policy Rule](rules/browser_use.md) — always-on safety & tool selection rule template
- [Compatibility & Engine Modes](docs/compatibility.md) — standalone vs. optional comparison mode details
- [Transport & IPC Notes](docs/transport-investigation.md) — Unix socket and Native Messaging internals
- [Legacy v1 Notes](docs/legacy-v1.md) — archived v1 architecture reference
- [MIT License](LICENSE)
