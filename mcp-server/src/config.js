import { existsSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const SERVER_PATH = fileURLToPath(new URL("./server.js", import.meta.url));
const HOMEBREW_NODE_LINK = "/opt/homebrew/bin/node";

/**
 * Prefer Homebrew's unversioned symlink over a Cellar path so `brew upgrade node`
 * does not break existing client configs.
 * @returns {string}
 */
export function stableNodePath() {
  if (
    /^\/opt\/homebrew\/Cellar\/node\/[^/]+\/bin\/node$/u.test(process.execPath) &&
    existsSync(HOMEBREW_NODE_LINK)
  ) {
    return HOMEBREW_NODE_LINK;
  }
  return process.execPath;
}

/**
 * Recommend the most token-efficient tool profile for a client host:
 * lazy-loading IDE clients can use `full`, while CLI/non-lazy hosts benefit from `compact`.
 * @param {string} client
 * @returns {"compact"|"full"}
 */
export function recommendedProfileForClient(client) {
  const name = normalizeClient(client);
  return ["antigravity", "cursor", "windsurf"].includes(name) ? "full" : "compact";
}

/**
 * Print a mergeable client fragment; never write a client's configuration.
 * @param {string} client
 * @param {{nodePath?:string, serverPath?:string, bridgeFile?:string, profile?:string}} [options]
 * @returns {Record<string, any>}
 */
export function buildConfig(client, options = {}) {
  const command = options.nodePath ?? stableNodePath();
  const args = [options.serverPath ?? SERVER_PATH];
  const effectiveProfile = options.profile === "auto"
    ? recommendedProfileForClient(client)
    : options.profile;
  if (effectiveProfile && effectiveProfile !== "full") {
    args.push("--profile", effectiveProfile);
  }
  const env = options.bridgeFile ? { BROWSER_USE_BRIDGE_FILE: path.resolve(options.bridgeFile) } : {};
  const name = "browser-use";
  if (client === "opencode" || client === "opencode2") {
    return {
      $schema: "https://opencode.ai/config.json",
      mcp: { servers: { [name]: { type: "local", command: [command, ...args], environment: env, disabled: false } } },
    };
  }
  if (client === "codex") {
    return { mcp_servers: { [name]: { command, args, env, startup_timeout_sec: 30, tool_timeout_sec: 180 } } };
  }
  if (client === "antigravity" || client === "agy") {
    return {
      mcpServers: {
        [name]: {
          command,
          args,
          env,
          tools: {
            browser_run: { eager: true },
            browser_batch: { eager: true },
            browser_get_state: { eager: true },
            browser_end_turn: { eager: true },
          },
        },
      },
    };
  }
  if (client === "copilot" || client === "github-copilot") {
    return { mcpServers: { "browser-use-portable": { command, args, env, type: "local", tools: ["*"] } } };
  }
  if (client === "commandcode" || client === "command-code") {
    return { mcpServers: { [name]: { transport: "stdio", enabled: true, command, args, env } } };
  }
  if (["generic", "claude_code", "claude", "cursor", "windsurf"].includes(client)) {
    return { mcpServers: { [name]: { command, args, env } } };
  }
  throw new Error(`Unknown client ${JSON.stringify(client)}. Choose generic, claude_code, commandcode, copilot, antigravity, cursor, windsurf, opencode, or codex.`);
}

/** @param {Record<string, any>} config @returns {string} */
export function codexToml(config) {
  const server = config.mcp_servers["browser-use"];
  const environment = Object.entries(server.env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join("\n");
  return `[mcp_servers.browser-use]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}\nstartup_timeout_sec = ${server.startup_timeout_sec}\ntool_timeout_sec = ${server.tool_timeout_sec}\n\n[mcp_servers.browser-use.env]\n${environment}\n`;
}

/**
 * Where each client keeps its MCP settings. `null` means the CLI prints a
 * fragment instead of writing, because the file is TOML, JSONC, or shared.
 * @param {string} client
 * @param {string} [home]
 * @returns {{file:string|null, key:"mcpServers"|"mcp.servers"}}
 */
export function clientTarget(client, home = homedir()) {
  switch (normalizeClient(client)) {
    case "commandcode": return { file: path.join(home, ".commandcode", "mcp.json"), key: "mcpServers" };
    case "claude_code": return { file: path.join(home, ".claude.json"), key: "mcpServers" };
    case "copilot": return { file: path.join(home, ".copilot", "mcp-config.json"), key: "mcpServers" };
    case "antigravity": return { file: path.join(home, ".gemini", "config", "mcp_config.json"), key: "mcpServers" };
    case "cursor": return { file: path.join(home, ".cursor", "mcp.json"), key: "mcpServers" };
    case "windsurf": return { file: path.join(home, ".codeium", "windsurf", "mcp_config.json"), key: "mcpServers" };
    default: return { file: null, key: "mcpServers" };
  }
}

/**
 * Where each client keeps its installed `codex-browser-use` skill markdown.
 * @param {string} client
 * @param {string} [home]
 * @returns {string}
 */
export function clientSkillTarget(client, home = homedir()) {
  const dir = "codex-browser-use";
  switch (normalizeClient(client)) {
    case "antigravity": return path.join(home, ".gemini", "config", "skills", dir, "SKILL.md");
    case "claude_code": return path.join(home, ".claude", "skills", dir, "SKILL.md");
    case "codex": return path.join(home, ".codex", "skills", dir, "SKILL.md");
    case "cursor": return path.join(home, ".cursor", "skills", dir, "SKILL.md");
    case "windsurf": return path.join(home, ".codeium", "windsurf", "skills", dir, "SKILL.md");
    default: return path.join(home, ".agents", "skills", dir, "SKILL.md");
  }
}

/**
 * Where each client keeps its always-on browser-use rules file (`file: null` when skills alone apply).
 * @param {string} client
 * @param {string} [home]
 * @returns {{file:string|null, format:"md"|"mdc"|null}}
 */
export function clientRuleTarget(client, home = homedir()) {
  switch (normalizeClient(client)) {
    case "antigravity":
      return { file: path.join(home, ".gemini", "config", "rules", "browser_use.md"), format: "md" };
    case "cursor":
      return { file: path.join(home, ".cursor", "rules", "browser_use.mdc"), format: "mdc" };
    case "windsurf":
      return { file: path.join(home, ".codeium", "windsurf", "rules", "browser_use.md"), format: "md" };
    case "commandcode":
    case "copilot":
    case "opencode":
    case "generic":
      return { file: path.join(home, ".agents", "rules", "browser_use.md"), format: "md" };
    default:
      return { file: null, format: null };
  }
}

/** @param {string} client @returns {string} */
export function normalizeClient(client) {
  if (client === "command-code") return "commandcode";
  if (client === "claude" || client === "claude-code") return "claude_code";
  if (client === "github-copilot") return "copilot";
  if (client === "agy") return "antigravity";
  if (client === "opencode2") return "opencode";
  return client;
}
