# Compatibility and verification record

This project ships two runtimes over the same Chrome bridge:

- **Standalone core (default).** `mcp-server/src/server.js` speaks CDP directly
  through the project extension and native host. It does not use the OpenAI
  engine or Playwright. It exposes 23 tools: accessibility snapshot, index
  actions, locators, screenshots, content export, dialogs, tabs, navigation, and
  a read-only evaluator.
- **Portable official-engine adapter (optional).** `mcp-server/src/portable-server.js`
  reuses an installed OpenAI Chrome plugin's `browser-client.mjs` in a
  persistent JavaScript worker and exposes six `browser_*` tools. It is kept
  for comparison work and is not part of the default path.

The reference OpenAI artifacts inspected on this machine are Chrome plugin
`26.1103.31037`, extension `1.26.1102.11740`, and Codex CLI `0.169.0`. The saved
REA analysis `ev_8914d8cfeba33344791fe228ff8902ee96c997f436a16a07a944faf8b752c887`
is partial semantic evidence, not a proof of whole-product equivalence.

## Standalone core: verified

- **Accessibility snapshot.** `buildAxState` follows CDP `childIds` order,
  skips ignored and transparent nodes, keeps role, name, value, and state flags,
  and assigns stable per-snapshot indices. Unit tested.
- **Index actions.** Click resolves a box model and dispatches mouse events at
  the box center with a focus/`click()` fallback. Set-value dispatches
  `input` and `change`. Key chords map modifiers and virtual key codes. Scroll
  uses wheel events at the viewport or element center. Unit tested.
- **Locators.** CSS, `text=`, `role=<role>[name="..."]`, and `testid=` resolve
  to exactly one element; ambiguous matches fail with the match count. Unit
  tested.
- **Frame locators.** `frame` on the locator tools enables iframe-only
  auto-attach, resolves the iframe through `DOM.describeNode`, waits for the
  child debugger session, and runs the locator inside that session. Nested
  frames use `>>`. Unit tested against a scripted frame session.
- **Installer.** Verified in a temporary HOME: extension copy to a stable path,
  private launcher, native-host manifests for Chrome/Chromium/Edge, and a
  client-config merge with a `.bak` backup.
- **Read-only evaluation.** `assertReadOnly` parses the expression and rejects
  assignment, update, `delete`, DOM mutation methods, storage and history
  writes, navigation, network calls, and dynamic code construction. Unit
  tested. This is a policy check, not a sandbox.
- **Bridge protocol.** Framed JSON-RPC over a real Unix socket: descriptor
  validation, `getInfo` handshake, session/tab ownership, turn cleanup, and
  `navigateTab` scheme validation. Integration tested against a real socket with
  a fake CDP driver.
- **Live Chrome.** Chrome for Testing `159.0.8154.6` launches, the extension
  connects to the native host, and the live test passes `newTab`,
  `Accessibility.getFullAXTree`, `Page.captureScreenshot`, and cross-session tab
  isolation. `Page.enable` and `Runtime.evaluate` also return results through
  the bridge.

## Standalone core: not verified

- **Navigation in this agent sandbox.** On this host, `Page.navigate` and
  `chrome.tabs.update` did not commit to a loopback or `data:` target, in both
  headless and headful Chrome-for-Testing profiles. A control test using raw CDP
  against the same Chrome and loopback server also hung, so the failure is in
  the environment rather than the bridge. `about:blank#fragment` committed in
  6 ms with raw CDP. The default path tries `chrome.tabs.update` and then falls
  back to `Page.navigate`.
- **Same-process iframes.** Frame actions need an out-of-process frame with a
  child debugger session; a same-process iframe fails with an explicit error.
- **Network interception, request blocking, browser-wide CDP, and user-tab
  access.** Not implemented.
- **Approval and credential UI.** No approval flow of its own; sign-in is a
  manual user step. The portable adapter refuses `browser_auth` and
  `browser_email_otp` approval kinds rather than fabricating a grant.

## Portable official-engine adapter: known blocker

On this macOS build the official native host authenticates the connecting
process before reading requests. A standalone Node worker fails that identity
check, and the live test stops at browser selection with
`Browser is not available: chrome`. The disassembly and the refusal to patch the
allowlist or signature checks are recorded in the
[transport investigation](transport-investigation.md).

## Provider quirks observed previously

- Copilot CLI `1.0.105` disables a server named `browser-use`; the generated
  Copilot entry is named `browser-use-portable`.
- Antigravity CLI `1.5.10` cancels browser origin approval in print mode.
- OpenCode `2.2.7` hit an upstream cold-location registry issue; a later binary
  connected to MCP.
- These probes predate the standalone core and were run against the portable
  adapter. Re-check them against the standalone tools before relying on them.

## Provider configuration

All providers launch the same stdio server; only the client shape differs.
`browser-use config --client NAME` prints a mergeable fragment and never writes
the client's file.

| Client | Generated shape |
| --- | --- |
| Command Code | `mcpServers.browser-use` with `transport: "stdio"`, `enabled`, command, args, env |
| Claude Code / generic | `mcpServers.browser-use` with command, args, env |
| GitHub Copilot CLI | `mcpServers.browser-use-portable` with local type and tools |
| Antigravity CLI | `mcpServers.browser-use` with eager `browser_get_state` and `browser_end_turn` |
| OpenCode V2 | `mcp.servers.browser-use` with a local command array |
| Codex CLI | TOML `mcp_servers.browser-use` |

`doctor --json` validates the bridge descriptor and socket. `--engine` adds
validation of a portable-runtime engine when one is used. Neither runs a browser
action.

## What is not claimed

- No 100% whole-product parity with any specific agent's built-in browser is
  claimed.
- Browser-use efficiency still depends on the agent model, tool instructions,
  and task. The same tool surface does not prove identical task success rates.
- The old custom extension and native gateway in `chrome-extension/`,
  `native-host/`, and `chrome-configs/` are legacy artifacts and must not be
  installed alongside the portable extension.
