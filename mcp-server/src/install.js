import { cp, copyFile, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
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
  installedRuntimeDir,
  nativeHostLauncher,
} from "./extension.js";
import { buildConfig, clientRuleTarget, clientSkillTarget, clientTarget, isEphemeralPackagePath, normalizeClient, stableNodePath } from "./config.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const nativeHostEntry = fileURLToPath(new URL("../bin/chrome-native-host.js", import.meta.url));
const repoSkillSource = fileURLToPath(new URL("../../skill/SKILL.md", import.meta.url));
const localSkillSource = fileURLToPath(new URL("../skill/SKILL.md", import.meta.url));
const repoRuleSource = fileURLToPath(new URL("../../rules/browser_use.md", import.meta.url));
const localRuleSource = fileURLToPath(new URL("../rules/browser_use.md", import.meta.url));

/** @returns {Promise<string>} */
async function resolveDefaultSkillSource() {
  for (const candidate of [repoSkillSource, localSkillSource]) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // Try next location.
    }
  }
  throw new Error("Bundled Browser Use skill (skill/SKILL.md) was not found");
}

/** @returns {Promise<string>} */
async function resolveDefaultRuleSource() {
  for (const candidate of [repoRuleSource, localRuleSource]) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // Try next location.
    }
  }
  throw new Error("Bundled Browser Use policy rule (rules/browser_use.md) was not found");
}

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
 * Verifies critical bundle files in addition to version and rolls back on rename failure.
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
    if (!changed) {
      for (const critical of ["background.js", "content-script.js"]) {
        const srcStat = await stat(path.join(source, critical)).catch(() => null);
        if (!srcStat?.isFile()) continue;
        const dstStat = await stat(path.join(destination, critical));
        if (!dstStat.isFile() || dstStat.size !== srcStat.size) {
          changed = true;
          break;
        }
      }
    }
  } catch {
    changed = true;
  }
  if (changed) {
    const temporary = `${destination}.tmp-${randomUUID()}`;
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    let backup = null;
    try {
      await cp(source, temporary, { recursive: true });
      backup = await backupDirectory(destination);
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => {});
      if (backup) {
        await rename(backup, destination).catch(() => {});
      }
      throw error;
    }
    return { path: destination, id: EXTENSION_ID, version: manifest.version, changed: true, backup };
  }
  return { path: destination, id: EXTENSION_ID, version: manifest.version, changed: false, backup: null };
}

/**
 * Resolve runtime `node_modules` directory (package-local or hoisted parent for `_npx`)
 * and copy only runtime dependencies + transitive packages into `destNodeModules`.
 * @param {string} sourceRoot
 * @param {string} destNodeModules
 */
async function copyRuntimeDependencies(sourceRoot, destNodeModules) {
  const pkg = JSON.parse(await readFile(path.join(sourceRoot, "package.json"), "utf8"));
  const roots = Object.keys(pkg.dependencies ?? {});
  if (roots.length === 0) return;

  const searchBases = [path.join(sourceRoot, "node_modules")];
  let cur = path.dirname(sourceRoot);
  for (let i = 0; i < 4; i++) {
    const candidate = path.basename(cur) === "node_modules" ? cur : path.join(cur, "node_modules");
    if (!searchBases.includes(candidate)) searchBases.push(candidate);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  /** @param {string} pkgName @param {string} fromDir @returns {Promise<string|null>} */
  async function findPackageDir(pkgName, fromDir) {
    const candidates = fromDir ? [path.join(fromDir, "node_modules", pkgName), ...searchBases.map((b) => path.join(b, pkgName))] : searchBases.map((b) => path.join(b, pkgName));
    for (const dir of candidates) {
      try {
        const info = await stat(path.join(dir, "package.json"));
        if (info.isFile()) return dir;
      } catch {
        // Try next candidate.
      }
    }
    return null;
  }

  const visited = new Set();
  const queue = roots.map((name) => ({ name, fromDir: sourceRoot }));
  await mkdir(destNodeModules, { recursive: true, mode: 0o755 });
  while (queue.length > 0) {
    const { name, fromDir } = queue.shift();
    if (visited.has(name)) continue;
    const found = await findPackageDir(name, fromDir);
    if (!found) continue;
    visited.add(name);
    const destPkg = path.join(destNodeModules, ...name.split("/"));
    await mkdir(path.dirname(destPkg), { recursive: true, mode: 0o755 });
    await cp(found, destPkg, {
      recursive: true,
      dereference: true,
      filter: (src) => path.basename(src) !== ".bin",
    });
    try {
      const depPkg = JSON.parse(await readFile(path.join(found, "package.json"), "utf8"));
      for (const depName of [...Object.keys(depPkg.dependencies ?? {}), ...Object.keys(depPkg.optionalDependencies ?? {})]) {
        if (!visited.has(depName)) queue.push({ name: depName, fromDir: found });
      }
    } catch {
      // Ignore malformed dependency package.json.
    }
  }
}

/**
 * Stage a persistent self-contained MCP + native host runtime so ephemeral `npx` caches
 * can be pruned without breaking installed browser native messaging or MCP configs.
 * @param {{sourceRoot?:string, destination?:string}} [options]
 * @returns {Promise<{staged:boolean, dir:string, serverPath:string, nativeHostEntry:string}>}
 */
export async function stageRuntime({ sourceRoot = packageRoot, destination = installedRuntimeDir() } = {}) {
  const temporary = `${destination}.tmp-${randomUUID()}`;
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  let backup = null;
  try {
    await mkdir(temporary, { recursive: true, mode: 0o755 });
    await cp(path.join(sourceRoot, "package.json"), path.join(temporary, "package.json"));
    await cp(path.join(sourceRoot, "bin"), path.join(temporary, "bin"), { recursive: true, dereference: true });
    await cp(path.join(sourceRoot, "src"), path.join(temporary, "src"), { recursive: true, dereference: true });
    await cp(path.join(sourceRoot, "extension"), path.join(temporary, "extension"), { recursive: true, dereference: true });
    await copyRuntimeDependencies(sourceRoot, path.join(temporary, "node_modules"));
    backup = await backupDirectory(destination);
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    if (backup) await rename(backup, destination).catch(() => {});
    throw error;
  }
  return {
    staged: true,
    dir: destination,
    serverPath: path.join(destination, "src", "server.js"),
    nativeHostEntry: path.join(destination, "bin", "chrome-native-host.js"),
  };
}

/**
 * Resolve permanent entrypoints for `install`, auto-staging when running from `_npx` or temp dirs.
 * @param {{stageIfEphemeral?:boolean, destination?:string}} [options]
 * @returns {Promise<{staged:boolean, serverPath:string, nativeHostEntry:string}>}
 */
export async function resolveRuntimePaths({ stageIfEphemeral = true, destination = installedRuntimeDir() } = {}) {
  const directServer = fileURLToPath(new URL("./server.js", import.meta.url));
  if (stageIfEphemeral && isEphemeralPackagePath(nativeHostEntry)) {
    const staged = await stageRuntime({ sourceRoot: packageRoot, destination });
    return { staged: true, serverPath: staged.serverPath, nativeHostEntry: staged.nativeHostEntry };
  }
  return { staged: false, serverPath: directServer, nativeHostEntry };
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
  await rm(backup, { recursive: true, force: true });
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
      path.join(support, "Google", "Chrome Beta", "NativeMessagingHosts"),
      path.join(support, "Google", "Chrome Canary", "NativeMessagingHosts"),
      path.join(support, "Google", "Chrome Dev", "NativeMessagingHosts"),
      path.join(support, "Google", "Chrome for Testing", "NativeMessagingHosts"),
      path.join(support, "Chromium", "NativeMessagingHosts"),
      path.join(support, "Arc", "User Data", "NativeMessagingHosts"),
      path.join(support, "Microsoft Edge", "NativeMessagingHosts"),
      path.join(support, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"),
      path.join(support, "Vivaldi", "NativeMessagingHosts"),
      path.join(support, "com.operasoftware.Opera", "NativeMessagingHosts"),
    ];
  }
  if (process.platform === "linux") {
    return [
      path.join(home, ".config", "google-chrome", "NativeMessagingHosts"),
      path.join(home, ".config", "google-chrome-beta", "NativeMessagingHosts"),
      path.join(home, ".config", "google-chrome-unstable", "NativeMessagingHosts"),
      path.join(home, ".config", "chromium", "NativeMessagingHosts"),
      path.join(home, ".config", "microsoft-edge", "NativeMessagingHosts"),
      path.join(home, ".config", "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"),
      path.join(home, ".config", "vivaldi", "NativeMessagingHosts"),
      path.join(home, ".config", "opera", "NativeMessagingHosts"),
    ];
  }
  throw new Error("Native host installation supports macOS and Linux; on Windows, register the host with the Chrome registry key manually");
}

/**
 * Write the launcher and native messaging manifests for every installed browser.
 * @param {{extensionId?:string, bridgeFile?:string, nativeHostPath?:string}} [options]
 */
export async function installNativeHost({ extensionId = EXTENSION_ID, bridgeFile = defaultBridgeFile(), nativeHostPath } = {}) {
  const launcher = nativeHostLauncher();
  const entry = nativeHostPath ?? nativeHostEntry;
  const preferredNode = stableNodePath();
  const script = [
    "#!/bin/sh",
    `NODE=${shellQuote(preferredNode)}`,
    'if [ ! -x "$NODE" ]; then',
    '  for c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" "$HOME/.local/share/fnm/aliases/default/bin/node"; do',
    '    if [ -x "$c" ]; then NODE="$c"; break; fi',
    "  done",
    "fi",
    'if [ ! -x "$NODE" ]; then NODE="$(command -v node 2>/dev/null || echo node)"; fi',
    `exec "$NODE" ${shellQuote(entry)} ${shellQuote(path.resolve(bridgeFile))}`,
    "",
  ].join("\n");
  await writeAtomic(launcher, script, 0o700);
  const manifest = {
    name: HOST_NAME,
    description: "Browser Use bridge native host",
    path: launcher,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
  const written = [];
  for (const directory of nativeMessagingDirs()) {
    const browserRoot = path.dirname(directory);
    let exists = true;
    try {
      await stat(browserRoot);
    } catch {
      exists = false;
    }
    const isDefaultChrome = directory.includes(`${path.sep}Google${path.sep}Chrome${path.sep}`) ||
      directory.includes(`${path.sep}google-chrome${path.sep}`);
    if (!exists && !isDefaultChrome) continue;
    const file = path.join(directory, `${HOST_NAME}.json`);
    const backup = await backupOnce(file);
    await writeAtomic(file, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
    written.push({ file, backup });
  }
  if (written.length === 0) throw new Error("Could not locate a Chrome native messaging directory");
  return { launcher, entry, manifests: written };
}

/**
 * Strip JS/JSONC `//` line comments, block comments, and trailing commas outside string literals.
 * @param {string} raw
 * @returns {string}
 */
export function stripJsonComments(raw) {
  let out = "";
  let inStr = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (lineComment) {
      if (ch === "\n") {
        lineComment = false;
        out += ch;
      }
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (inStr) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      lineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      blockComment = true;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out.replace(/,\s*([}\]])/gu, "$1");
}

/**
 * Merge the browser-use entry into a client's MCP configuration.
 * @param {{client:string, bridgeFile?:string, serverPath?:string, profile?:string, write?:boolean, home?:string}} options
 */
export async function configureClient({ client, bridgeFile = defaultBridgeFile(), serverPath, profile, write = false, home = homedir() }) {
  const name = normalizeClient(client);
  const target = clientTarget(name, home);
  const config = buildConfig(name, { bridgeFile, serverPath, profile });
  if (!write || target.file === null) {
    return { written: false, file: target.file, config };
  }
  let existing = {};
  try {
    const raw = await readFile(target.file, "utf8");
    existing = raw.trim() ? JSON.parse(stripJsonComments(raw)) : {};
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`${target.file} is not valid JSON: ${error.message}`);
  }
  const mergeEntries = (prevServers = {}, nextServers = {}) => {
    const out = { ...prevServers };
    for (const [key, entry] of Object.entries(nextServers)) {
      const prevEntry = prevServers[key];
      if (prevEntry && typeof prevEntry === "object" && entry && typeof entry === "object") {
        const mergedEnv = (prevEntry.env || entry.env) ? { ...(prevEntry.env ?? {}), ...(entry.env ?? {}) } : undefined;
        out[key] = { ...entry, ...(mergedEnv ? { env: mergedEnv } : {}) };
      } else {
        out[key] = entry;
      }
    }
    return out;
  };
  const merged = target.key === "mcp.servers"
    ? { ...existing, mcp: { ...existing.mcp, servers: mergeEntries(existing.mcp?.servers, config.mcp.servers) } }
    : { ...existing, mcpServers: mergeEntries(existing.mcpServers, config.mcpServers) };
  const backup = await backupOnce(target.file);
  await writeAtomic(target.file, `${JSON.stringify(merged, null, 2)}\n`, 0o600);
  return { written: true, file: target.file, backup, config };
}

const IGNORED_SKILL_FILES = new Set(["SKILL.md", ".DS_Store"]);

/**
 * Resolve source SKILL.md + directory even if caller passes either a file or a directory.
 * @param {string|undefined} source
 * @returns {Promise<{skillFile:string, skillDir:string}>}
 */
async function resolveSkillPaths(source) {
  if (!source) {
    const skillFile = await resolveDefaultSkillSource();
    return { skillFile, skillDir: path.dirname(skillFile) };
  }
  const resolved = path.resolve(source);
  const info = await stat(resolved);
  if (info.isDirectory()) {
    return { skillFile: path.join(resolved, "SKILL.md"), skillDir: resolved };
  }
  return { skillFile: resolved, skillDir: path.dirname(resolved) };
}

/**
 * Recursively copy companion files inside a skill bundle (`references/`, etc.).
 * @param {string} srcDir
 * @param {string} dstDir
 * @param {string} [prefix]
 * @returns {Promise<string[]>}
 */
async function copyCompanionSkillFiles(srcDir, dstDir, prefix = "") {
  const entries = await readdir(srcDir, { withFileTypes: true });
  const copied = [];
  for (const entry of entries) {
    if (IGNORED_SKILL_FILES.has(entry.name) && prefix === "") continue;
    if (entry.name === ".DS_Store" || entry.name.endsWith(".bak") || entry.name.startsWith(".tmp-")) continue;
    const rel = prefix ? path.posix.join(prefix, entry.name) : entry.name;
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copied.push(...await copyCompanionSkillFiles(srcPath, dstPath, rel));
    } else if (entry.isFile()) {
      await writeAtomic(dstPath, await readFile(srcPath), 0o644);
      copied.push(rel);
    }
  }
  return copied;
}

/**
 * Install the Browser Use skill bundle (`SKILL.md` + companion `references/` files)
 * into a client's standard skills directory.
 * @param {{client?:string, home?:string, source?:string}} [options]
 * @returns {Promise<{written:boolean, client:string, file:string, dir:string, files:string[], backup:string|null}>}
 */
export async function installSkill({ client = "generic", home = homedir(), source } = {}) {
  const name = normalizeClient(client);
  const target = clientSkillTarget(name, home);
  const targetDir = path.dirname(target);
  const { skillFile, skillDir } = await resolveSkillPaths(source);
  const content = await readFile(skillFile, "utf8");
  const backup = await backupOnce(target);
  await writeAtomic(target, content, 0o644);
  const companions = await copyCompanionSkillFiles(skillDir, targetDir);
  return {
    written: true,
    client: name,
    file: target,
    dir: targetDir,
    files: ["SKILL.md", ...companions.sort()],
    backup,
  };
}

/**
 * Install the always-on Browser Use policy rules file for clients that use standalone rule files.
 * @param {{client?:string, home?:string, source?:string}} [options]
 * @returns {Promise<{written:boolean, client:string, file:string|null, backup:string|null, skipped?:boolean}>}
 */
export async function installRules({ client = "generic", home = homedir(), source } = {}) {
  const name = normalizeClient(client);
  const target = clientRuleTarget(name, home);
  if (!target.file) {
    return { written: false, client: name, file: null, backup: null, skipped: true };
  }
  const src = source ? path.resolve(source) : await resolveDefaultRuleSource();
  let content = await readFile(src, "utf8");
  if (target.format === "mdc") {
    const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/u, "");
    content = `---\ndescription: Browser Use MCP automation policy\nalwaysApply: true\n---\n\n${body}`;
  }
  const backup = await backupOnce(target.file);
  await writeAtomic(target.file, content, 0o644);
  return { written: true, client: name, file: target.file, backup };
}
