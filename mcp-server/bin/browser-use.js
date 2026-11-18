#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { lstat, mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { discoverEngine } from "../src/engine-discovery.js";
import { defaultBridgeFile, readBackend } from "../src/backend-discovery.js";
import { buildConfig, codexToml, normalizeClient } from "../src/config.js";
import { EXTENSION_ID } from "../src/extension.js";
import { configureClient, installExtension, installNativeHost } from "../src/install.js";

export { buildConfig };

/**
 * Create provider-local configs for a new workspace using one shared bridge.
 * @param {string} workspace @param {string} bridgeFile
 * @returns {Promise<string[]>}
 */
export async function setupWorkspace(workspace, bridgeFile) {
  const root = path.resolve(workspace);
  const destinations = [
    ["copilot", path.join(root, ".mcp.json")],
    ["antigravity", path.join(root, ".agents", "mcp_config.json")],
    ["opencode", path.join(root, "opencode.jsonc")],
  ];
  const existingOpenCode = ["opencode.json", ".opencode/opencode.json", ".opencode/opencode.jsonc"];
  for (const target of [...destinations.map(([, file]) => file), ...existingOpenCode.map((file) => path.join(root, file))]) {
    try {
      await lstat(target);
      throw new Error(`Workspace already has a provider config at ${target}. Use config --client to merge the Browser Use entry.`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const agents = path.join(root, ".agents");
  await mkdir(agents, { recursive: true });
  if (!(await lstat(agents)).isDirectory()) throw new Error("The workspace .agents path must be a directory");
  /** @type {string[]} */
  const written = [];
  try {
    for (const [client, file] of destinations) {
      const config = buildConfig(client, { bridgeFile });
      await writeFile(file, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      written.push(file);
    }
  } catch (error) {
    const cleanup = await Promise.allSettled(written.map((file) => unlink(file)));
    const failures = cleanup.filter((result) => result.status === "rejected");
    if (failures.length) throw new AggregateError([error, ...failures.map((failure) => failure.reason)], "Workspace config setup and rollback failed");
    throw error;
  }
  return written;
}

/**
 * @param {string[]} argv
 * @returns {{command:string, client?:string, enginePath?:string, bridgeFile?:string, workspace?:string, extensionId?:string, write:boolean, json:boolean, help:boolean}}
 */
function parseArgs(argv) {
  const options = { command: argv[0] ?? "help", json: false, help: false, write: false };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (["--client", "--engine", "--bridge", "--workspace", "--extension-id"].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--client") options.client = value;
      else if (arg === "--engine") options.enginePath = value;
      else if (arg === "--bridge") options.bridgeFile = value;
      else if (arg === "--extension-id") options.extensionId = value;
      else options.workspace = value;
    } else if (arg === "--write") options.write = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

/** @param {string[]} [argv] @returns {Promise<number>} */
export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help || ["help", "--help", "-h"].includes(options.command)) {
    process.stdout.write([
      "Usage:",
      "  browser-use install [--client NAME] [--write] [--bridge FILE] [--extension-id ID] [--json]",
      "  browser-use doctor [--bridge FILE] [--engine PATH] [--json]",
      "  browser-use config --client NAME [--bridge FILE]",
      "  browser-use setup --workspace DIR [--bridge FILE] [--json]",
      "",
      "Clients: generic, claude_code, commandcode, copilot, antigravity, opencode, codex",
      "",
    ].join("\n"));
    return 0;
  }
  if (!["install", "doctor", "config", "setup"].includes(options.command)) throw new Error(`Unknown command: ${options.command}`);
  if (options.workspace !== undefined && (options.command !== "setup" || options.client !== undefined)) {
    throw new Error("--workspace is only available with setup and without --client");
  }
  const bridgeFile = path.resolve(options.bridgeFile ?? defaultBridgeFile());

  if (options.command === "install") {
    const extension = await installExtension();
    const nativeHost = await installNativeHost({ extensionId: options.extensionId ?? EXTENSION_ID, bridgeFile });
    const client = options.client
      ? await configureClient({ client: options.client, bridgeFile, write: options.write })
      : null;
    const report = {
      ok: true,
      extension: { ...extension, loadUnpackedPath: extension.path },
      nativeHost,
      bridgeFile,
      client,
      next: [
        `Open chrome://extensions, enable Developer mode, and Load unpacked from ${extension.path}.`,
        "Click the Portable Browser Bridge toolbar action once; the badge shows ON.",
        client?.written
          ? `Restart ${normalizeClient(options.client)} so it reads the new MCP entry.`
          : "Merge the printed client fragment into the client's MCP settings, then restart it.",
      ],
    };
    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(`Extension ${extension.version} at ${extension.path} (id ${extension.id})\n`);
      process.stdout.write(`Native host launcher: ${nativeHost.launcher}\n`);
      for (const manifest of nativeHost.manifests) process.stdout.write(`Native host manifest: ${manifest.file}\n`);
      if (client) {
        if (client.written) process.stdout.write(`Updated ${client.file}\n`);
        else {
          process.stdout.write(client.config ? `${JSON.stringify(client.config, null, 2)}\n` : "");
          process.stdout.write("Merge this fragment into the client's MCP settings.\n");
        }
      }
      for (const line of report.next) process.stdout.write(`- ${line}\n`);
    }
    return 0;
  }

  if (options.command === "doctor") {
    try {
      const engine = options.enginePath ? await discoverEngine({ enginePath: options.enginePath }) : undefined;
      const bridge = { descriptor: bridgeFile, socketPath: await readBackend(bridgeFile) };
      const report = { ready: true, node: process.version, ...(engine ? { engine } : {}), bridge,
        scope: "The bridge socket descriptor passed validation. Browser actions and provider permissions are not checked." };
      process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${report.scope}\n`);
      return 0;
    } catch (error) {
      if (!options.json) throw error;
      process.stdout.write(`${JSON.stringify({ ready: false, node: process.version, error: error.message }, null, 2)}\n`);
      return 1;
    }
  }

  if (options.workspace !== undefined) {
    const written = await setupWorkspace(options.workspace, bridgeFile);
    process.stdout.write(options.json ? JSON.stringify(written, null, 2) + "\n" : written.join("\n") + "\n");
    return 0;
  }

  const client = normalizeClient(options.client ?? "generic");
  const config = buildConfig(client, { bridgeFile });
  process.stdout.write(client === "codex" && !options.json ? codexToml(config) : `${JSON.stringify(config, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`browser-use: ${error.message}\n`);
    process.exitCode = 1;
  });
}
