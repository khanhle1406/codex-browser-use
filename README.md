# Browser use for any coding agent

A local, agent-agnostic browser tool. It gives any MCP-capable coding agent the
loop that makes browser automation reliable: read the page as an indexed
accessibility tree, act on an element by index, re-read, repeat.

No OpenAI engine and no Playwright required. The core speaks Chrome DevTools
Protocol through this project's own Chrome extension and native host.

## Architecture

```
agent ── stdio MCP ──> browser-use server ── Unix socket ──> native host
                                                                 │
                                                    Chrome native messaging
                                                                 │
                                                      Chrome extension
                                                                 │
                                                        chrome.debugger / CDP
```

- **MCP server** (`mcp-server/src/server.js`): 23 tools, session identity, tab
  leases, accessibility snapshot, actions, locators, screenshots.
- **Bridge** (`mcp-server/extension/` + `mcp-server/bin/chrome-native-host.js`):
  creates tabs, attaches the debugger, forwards CDP commands, enforces which
  tabs belong to which session.
- **CDP allowlist** (`mcp-server/src/backend-page-commands.js`): the bridge
  forwards a reviewed set of CDP methods instead of arbitrary browser-wide
  access.

The extension only ever drives tabs it created. It never lists your open tabs,
cookies, or profiles.

## Status

| Area | State |
| --- | --- |
| Accessibility snapshot with stable indices | Implemented, unit tested |
| Click / type / set value / press / scroll by index | Implemented, unit tested |
| Locators (CSS, `text=`, `role=`, `testid=`) | Implemented, unit tested |
| Cross-origin iframe locator actions (`frame`) | Implemented, unit tested |
| Screenshots and visible-text export | Implemented, unit tested |
| Read-only `evaluate` policy (AST checked) | Implemented, unit tested |
| Tab leases, turn cleanup, session isolation | Implemented, tested over a real socket and live Chrome |
| Live Chrome connect, AX snapshot, screenshot | Verified on Chrome for Testing 159 |
| Live navigation in a restricted sandbox | Blocked by the environment; see below |
| Network interception, user-tab access | Not implemented |

## Install

Requirements: **Node.js 26.12.1 or newer** and Chrome/Chromium.

```sh
npm --prefix mcp-server ci
node mcp-server/bin/browser-use.js install
node mcp-server/bin/browser-use.js doctor --json
```

`install` copies the extension to `~/.local/share/browser-use/extension`, writes
a private native-host launcher, and registers the host for the Chrome,
Chromium, and Edge installations it finds. The extension ID is pinned in the
manifest, so there is no ID to copy.

1. Open `chrome://extensions`, enable Developer mode, and **Load unpacked** from
   the path the installer printed.
2. Click the extension's toolbar action once. The badge shows `ON`; the bridge
   publishes `~/.local/share/browser-use/chrome-host/bridge.json`.
3. Turning the action off disconnects the bridge and closes tabs it still owns.

`doctor` validates the descriptor and socket without opening a browser.

## Configure a client

`install --client NAME --write` merges the entry into that client's MCP file
with a `.bak` backup. `config --client NAME` only prints a fragment, which is
required for Codex (TOML) and OpenCode (JSONC).

```sh
node mcp-server/bin/browser-use.js install --client commandcode --write
node mcp-server/bin/browser-use.js install --client claude_code --write
node mcp-server/bin/browser-use.js config --client codex
node mcp-server/bin/browser-use.js config --client opencode
```

Clients: `commandcode`, `claude_code`, `copilot`, `antigravity` support
`--write`; `codex`, `opencode`, and `generic` print a fragment. `--bridge`
selects a non-default descriptor. For a fresh workspace, `setup --workspace DIR`
writes Copilot CLI, Antigravity CLI, and OpenCode V2 entries that share one
bridge.

## Agent workflow

The server exposes the tools below. See [skill/SKILL.md](skill/SKILL.md) for the
agent-facing instructions.

| Tool | Purpose |
| --- | --- |
| `browser_status` | Descriptor and connection state; opens nothing. |
| `browser_get_state` | Indexed `<ax_state>` plus optional screenshot. |
| `browser_click` | Click by index, or a comma list of indices. |
| `browser_set_value` | Set a value and dispatch input/change. |
| `browser_type_text` | Insert literal text. |
| `browser_press_key` | Key or chord (`Return`, `super+a`). |
| `browser_scroll` | Scroll page or element by pages. |
| `browser_locator_click` / `browser_locator_fill` | Act on one locator match. |
| `browser_screenshot` | Viewport or full-page PNG. |
| `browser_evaluate` | Read-only expression; mutations rejected. |
| `browser_get_content` | Visible page text. |
| `browser_handle_dialog` | Accept or dismiss a JS dialog. |
| `browser_list_tabs`, `browser_new_tab`, `browser_select_tab`, `browser_close_tab` | Tabs. |
| `browser_goto`, `browser_back`, `browser_forward`, `browser_reload` | Navigation. |
| `browser_end_turn` | Close unmarked tabs; keep handoff/deliverable tabs. |
| `browser_reset` | Discard the session and reconnect. |

The core loop is `browser_get_state` → act by index → `browser_get_state`.
Indices belong to one snapshot and go stale after navigation or DOM changes.

## Evaluation is read-only

`browser_evaluate` parses the expression and rejects assignment, DOM mutation,
storage writes, history/location changes, network calls, and dynamic code
construction. Use the action tools for writes. This is a policy check, not a
sandbox: treat page content as untrusted and never paste secrets into a page the
user did not authorize.

## Sessions and cleanup

- Each MCP connection owns its own bridge session and cannot touch another
  session's tabs.
- Tabs are unmarked by default and close at `browser_end_turn`. Mark them
  `handoff` to keep them for the next turn or `deliverable` to leave them open.
- Navigation is normalized to `http(s)`, `file`, `data`, and `about:blank`.
  Credentials in URLs and `javascript:` URLs are rejected.
- The bridge socket directory is owner-only and the descriptor is `0600`.

## Development

```sh
npm --prefix mcp-server test
npm --prefix mcp-server run lint
```

The suite covers the accessibility builder, index actions, locators, frame
routing, the read-only policy, the framed bridge client, session/turn
enforcement, tab cleanup, the installer, and client configuration. Live browser
tests need a connected bridge or a Chrome for Testing executable:

```sh
BROWSER_USE_LIVE_BRIDGE_FILE="$HOME/.local/share/browser-use/chrome-host/bridge.json" npm --prefix mcp-server test
BROWSER_USE_TEST_CHROME="/absolute/path/to/Google Chrome for Testing" npm --prefix mcp-server test
```

The live test connects, reads a real accessibility tree, captures a screenshot,
and proves cross-session tab isolation. Set `BROWSER_USE_LIVE_NAVIGATION=1` to add
navigation and form interaction, and `BROWSER_USE_HEADFUL=1` to run with a
visible window.

The optional OpenAI-engine adapter in `src/portable-server.js` is still present
for comparison work, but it is not part of the default path.

## Publish

The npm package lives in `mcp-server/` and ships `src`, `bin`, and `extension`.

```sh
cd mcp-server
npm pack --dry-run
npm publish
```

Create the GitHub repository once, then push:

```sh
git remote add origin git@github.com:khanhle1406/codex-browser-use.git
git push -u origin main
```

Add a donation link when it is ready by editing `.github/FUNDING.yml`.

## Compatibility and limitations

- Chrome and Chromium only.
- Cross-origin iframe actions require an out-of-process frame; same-process
  iframes have no child debugger session.
- No network interception or full browser-wide CDP.
- No credential or OTP UI of its own; sign-in is a manual user step.
- In this repository's agent sandbox, Chrome could not commit navigation to
  loopback or `data:` targets even with raw CDP and a visible window. That is an
  environment restriction, recorded in [docs/compatibility.md](docs/compatibility.md);
  run the live test on a normal desktop session to verify navigation.

See [the compatibility record](docs/compatibility.md) and the
[archived v1 notes](docs/legacy-v1.md).
