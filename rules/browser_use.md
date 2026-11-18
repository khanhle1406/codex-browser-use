---
trigger: always_on
description: Use the configured portable browser-use MCP runtime for requested browser UI work while preserving user browser choice and permissions.
---

For browser UI tasks, use `browser_documentation` and `browser_js` from this project's MCP server. The original browser engine supplies the documented API; do not use the legacy nineteen-action gateway as a parity substitute.

Honor the user's explicit browser choice. Prefer applicable connectors/APIs for non-UI operations unless the user requests browser interaction. Follow the configured client's approvals and site permissions; do not replace a denied operation with another browser or bypass mechanism.

Each subagent sharing one MCP connection must use its own stable `session` label, separate tab leases, and `browser_end_turn`/`browser_close_session` cleanup. Do not claim or close another session's tabs. Report unsupported approval flows and actual tool failures.
