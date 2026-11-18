# Original Chrome transport: peer authorization

Investigated on 2026-11-18, read-only. No installed executable, signature,
extension, native-host configuration, or browser tab was modified.

## Finding

The installed macOS extension host authorizes the **connecting process's code
identity before reading protocol messages**. A plain Node MCP worker is not an
accepted peer. Correct socket framing and an unchanged browser-service are
therefore insufficient to make this direct transport portable across providers.

This is established by static disassembly of the shipped host, rather than only
by nearby strings. It explains the observed connect → write → immediate close
without a `getInfo` response, although this investigation did not instrument the
live process to observe which rejection branch executed.

## Artifact and reproducible evidence

- Installed plugin: `~/.codex/plugins/cache/openai-bundled/chrome/26.1103.31037`.
- Binary relative path: `extension-host/macos/arm64/ChatGPT for Chrome`.
- Format: Mach-O arm64, with Rust function symbols retained.
- SHA-256: `4dc178cd279269ce3ef114b6eea23e624a2499107e2a79db874dd2f2dfb201fe`.
- Inspection: `/usr/bin/nm`, `/usr/bin/otool -tvV`, `/usr/bin/otool -l`,
  `/usr/bin/codesign -dv --verbose=4`, and a read-only decoder of the constant
  table. REA MCP was unavailable to this worker; these observations have no new
  REA Evidence ID and must not be presented as a REA decompilation result.

Addresses below are unslid virtual addresses for this exact binary hash.

| Address | Observation |
| --- | --- |
| `0x100005870` | Calls `UnixSocketServer::accept`. |
| `0x100005894` | Immediately calls `PeerAuthorizer::authorize_unix_stream`. |
| `0x1000058a8` | Tests the returned authorization boolean. |
| `0x1000058b0` | False result calls `UnixSocketTransport::shutdown`, then closes the accepted file descriptor. |
| `0x1000058c8` | Only an accepted peer proceeds to split the transport and register a message writer/reader. |
| `0x100029ea8` | Authorizer entry. Calls `getsockopt` with a 32-byte peer audit-token buffer. |
| `0x100029f50` | Calls `code_identity_for_peer_at_depth` with depth 0. |
| `0x100029fe8` | Starts comparing the peer's team and signing identifier with the constant table. |
| `0x10002a080` | If required, retrieves the immediate parent's code identity with depth 1. |
| `0x10002a0e8` / `0x10002a150` | Require table matches for both the peer and parent before accepting this path. |
| `0x10003ad44` | `extension_host_copy_code_identity_for_audit_token_at_depth`: depth 0 uses the audit token; parent traversal uses `audit_token_to_pid` and `proc_pidinfo`. |
| `0x10003af64` / `0x10003af8c` | Calls `SecCodeCopyGuestWithAttributes` and `SecCodeCopySigningInformation`. |
| `0x10003afd8` | Rejects code-signing flags with bit 1 set (ad-hoc signing). |

The constant table occupies `0x1000b0e10` through `0x1000b1068`: 15 entries,
40 bytes each, containing team-string pointer/length, identifier-string
pointer/length, and a boolean. The Mach-O segment mapping places these addresses
at file offset `address - 0x100000000` in this artifact.

| Signing team | Signing identifiers | Boolean |
| --- | --- | --- |
| `2DC432GLL2` | `com.openai.codex`, `.nightly`, `.alpha`, `.beta`, `.runtime` | 1 |
| `2DC432GLL2` | `com.openai.codex.cli`, `codex`, `node`, `node_repl`, `extension-host` | 0 |
| `EQHXZ8M8AV` | `com.google.Chrome` | 1 |
| `UBF8T346G9` | `com.microsoft.edgemac` | 1 |
| `KL8N8XSYF4` | `com.brave.Browser` | 1 |
| `A2P9LX4JPN` | `com.operasoftware.Opera` | 1 |
| `4XF3XNRN6Y` | `com.vivaldi.Vivaldi` | 1 |

The direct-accept branch additionally requires the OpenAI team and boolean 1.
Other matches require a matching parent. In particular, a signed ancestor alone
does not authorize an arbitrary Node child.

The adapter's `/opt/homebrew/bin/node` resolves to Node 26.13.0_2 and reports
`Signature=adhoc`, `TeamIdentifier=not set`, and signing identifier
`node-555549448374945e75b330739a4a1fe77dbc25c3`. These are incompatible with the
observed authorization path. Renaming a process cannot supply a signing team.

## Supported integration search and remaining work

The same binary contains an app-server WebSocket proxy, origin checks, a token
parameter, and `CODEX_APP_SERVER_PROXY_HOST` / `CODEX_APP_SERVER_PROXY_PORT`
strings. These establish another component's presence, not a documented generic
browser endpoint. The inspected installed troubleshooting documents do not
describe authorizing arbitrary provider workers through it. Its protocol,
credential ownership, and suitability for third-party agents remain unverified;
it is not a working fallback in this adapter.

A portable implementation needs its own explicitly installed browser transport
with its own consent and session ownership, or a supported integration offered
by the original host. It must not patch the original allowlist, replace its
signature checks, or pretend to have a trusted OpenAI signing identity.

This finding covers this installed **macOS** artifact only. Other operating
systems, plugin builds, protected credential UI, Guardian behavior, and complete
browser-action parity have not been established by this investigation.
