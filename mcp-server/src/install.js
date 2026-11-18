import { cp, copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  EXTENSION_ID,
  EXTENSION_VERSION,
  HOST_NAME,
  defaultBridgeFile,
  extensionSource,
  installedExtensionDir,
  nativeHostLauncher,
} from "./extension.js";
import { buildConfig, clientTarget, normalizeClient } from "./config.js";

const nativeHostEntry = fileURLToPath(new URL("../bin/chrome-native-host.js", import.meta.url));

/** @param {string} value */
function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** @param {string} file @param {string|Buffer} content @param {number} mode */
async function writeAtomic(file, content, mode) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.tmp-${randomUUID()}`);
  await writeFile(temporary, content, { mode });
  try {
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

/** @param {string} file @returns {Promise<string|null>} */
async function backupOnce(file) {
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile()) return null;
  const backup = `${file}.bak`;
  try {
    await stat(backup);
    return backup;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await copyFile(file, backup);
  return backup;
}

/**
 * Copy the bundled extension to a stable path and report its pinned ID.
 * @param {{source?:string, destination?:string}} [options]
 */
export async function installExtension({ source = extensionSource, destination = installedExtensionDir() } = {}) {
  const manifest = JSON.parse(await readFile(path.join(source, "manifest.json"), "utf8"));
  if (manifest.version !== EXTENSION_VERSION) {
    throw new Error(`Bundled extension is ${manifest.version}, expected ${EXTENSION_VERSION}`);
  }
  let changed = false;
  try {
    const existing = JSON.parse(await readFile(path.join(destination, "manifest.json"), "utf8"));
    changed = existing.version !== manifest.version;
  } catch {
    changed = true;
  }
  if (changed) {
    const temporary = `${destination}.tmp-${randomUUID()}`;
    await cp(source, temporary, { recursive: true });
    const backup = await backupDirectory(destination);
    await rename(temporary, destination);
    return { path: destination, id: EXTENSION_ID, version: manifest.version, changed: true, backup };
  }
  return { path: destination, id: EXTENSION_ID, version: manifest.version, changed: false, backup: null };
}

/** @param {string} destination @returns {Promise<string|null>} */
async function backupDirectory(destination) {
  try {
    await stat(destination);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const backup = `${destination}.bak`;
  await unlink(backup).catch(() => {});
  await rename(destination, backup);
  return backup;
}

/** @returns {string[]} */
export function nativeMessagingDirs() {
  const home = homedir();
  if (process.platform === "darwin") {
    const support = path.join(home, "Library", "Application Support");
    return [
      path.join(support, "Google", "Chrome", "NativeMessagingHosts"),
      path.join(support, "Chromium", "NativeMessagingHosts"),
      path.join(support, "Microsoft Edge", "NativeMessagingHosts"),
      path.join(support, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"),
    ];
  }
  if (process.platform === "linux") {
    return [
      path.join(home, ".config", "google-chrome", "NativeMessagingHosts"),
      path.join(home, ".config", "chromium", "NativeMessagingHosts"),
      path.join(home, ".config", "microsoft-edge", "NativeMessagingHosts"),
      path.join(home, ".config", "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"),
    ];
  }
  throw new Error("Native host installation supports macOS and Linux; on Windows, register the host with the Chrome registry key manually");
}

/**
 * Write the launcher and native messaging manifests for every installed browser.
 * @param {{extensionId?:string, bridgeFile?:string}} [options]
 */
export async function installNativeHost({ extensionId = EXTENSION_ID, bridgeFile = defaultBridgeFile() } = {}) {
  const launcher = nativeHostLauncher();
  const script = `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(nativeHostEntry)} ${shellQuote(path.resolve(bridgeFile))}\n`;
  await writeAtomic(launcher, script, 0o700);
  const manifest = {
    name: HOST_NAME,
    description: "Browser Use bridge native host",
    path: launcher,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
  const written = [];
  let chromeWritten = false;
  for (const directory of nativeMessagingDirs()) {
    const browserRoot = path.dirname(directory);
    let exists = true;
    try {
      await stat(browserRoot);
    } catch {
      exists = false;
    }
    const isChrome = directory.includes(`${path.sep}Google${path.sep}Chrome${path.sep}`);
    if (!exists && !isChrome) continue;
    const file = path.join(directory, `${HOST_NAME}.json`);
    const backup = await backupOnce(file);
    await writeAtomic(file, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
    written.push({ file, backup });
    if (isChrome) chromeWritten = true;
  }
  if (!chromeWritten) throw new Error("Could not locate a Chrome native messaging directory");
  return { launcher, manifests: written };
}

/**
 * Merge the browser-use entry into a client's MCP configuration.
 * @param {{client:string, bridgeFile?:string, write?:boolean, home?:string}} options
 */
export async function configureClient({ client, bridgeFile = defaultBridgeFile(), write = false, home = homedir() }) {
  const name = normalizeClient(client);
  const target = clientTarget(name, home);
  const config = buildConfig(name, { bridgeFile });
  if (!write || target.file === null) {
    return { written: false, file: target.file, config };
  }
  let existing = {};
  try {
    existing = JSON.parse(await readFile(target.file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`${target.file} is not valid JSON: ${error.message}`);
  }
  const merged = target.key === "mcp.servers"
    ? { ...existing, mcp: { ...existing.mcp, servers: { ...existing.mcp?.servers, ...config.mcp.servers } } }
    : { ...existing, mcpServers: { ...existing.mcpServers, ...config.mcpServers } };
  const backup = await backupOnce(target.file);
  await writeAtomic(target.file, `${JSON.stringify(merged, null, 2)}\n`, 0o600);
  return { written: true, file: target.file, backup, config };
}
