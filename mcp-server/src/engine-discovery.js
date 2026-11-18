import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** @typedef {{path: string, version: string, clientPath: string, servicePath: string, apiPath: string, manifestPath: string}} BrowserEngine */

/** @param {string} [version] @returns {void} */
export function assertRuntime(version = process.versions.node) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Unsupported Node.js version: ${version}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (major < 26 || (major === 26 && (minor < 12 || (minor === 12 && patch < 1)))) {
    throw new Error("Browser Use requires Node.js 26.12.1 or newer for the persistent REPL error handler.");
  }
}

/**
 * Validate a locally installed engine without importing it or opening a browser.
 * @param {string} enginePath
 * @returns {Promise<BrowserEngine>}
 */
export async function validateEngine(enginePath) {
  if (!path.isAbsolute(enginePath)) throw new Error("Engine path must be absolute");
  const root = await realpath(enginePath);
  const files = {
    clientPath: path.join(root, "scripts/browser-client.mjs"),
    servicePath: path.join(root, "scripts/browser-service.mjs"),
    apiPath: path.join(root, "docs/api.json"),
    manifestPath: path.join(root, ".codex-plugin/plugin.json"),
  };
  for (const file of Object.values(files)) {
    await access(file);
    if (!(await stat(file)).isFile()) throw new Error(`Engine component is not a file: ${file}`);
  }
  const manifest = JSON.parse(await readFile(files.manifestPath, "utf8"));
  if (!["chrome", "browser"].includes(manifest.name) || typeof manifest.version !== "string" || !manifest.version.trim()) {
    throw new Error("Expected an installed OpenAI chrome/browser plugin manifest with a version");
  }
  const api = JSON.parse(await readFile(files.apiPath, "utf8"));
  if (!api.interfaces?.Agent || !api.interfaces?.Browser || !api.interfaces?.Tab) {
    throw new Error("Engine API manifest is missing Agent, Browser, or Tab interfaces");
  }
  return { path: root, version: manifest.version, ...files };
}

/**
 * Select a numeric release, never staging directories or an unrelated plugin.
 * Explicit selections fail closed instead of silently using another engine.
 * @param {{enginePath?: string, env?: NodeJS.ProcessEnv, homeDir?: string}} [options]
 * @returns {Promise<BrowserEngine>}
 */
export async function discoverEngine(options = {}) {
  assertRuntime();
  const env = options.env ?? process.env;
  const explicit = options.enginePath ?? env.BROWSER_USE_ENGINE_PATH;
  if (explicit !== undefined) {
    if (!explicit.trim()) throw new Error("BROWSER_USE_ENGINE_PATH cannot be empty");
    return validateEngine(explicit);
  }
  const home = options.homeDir ?? os.homedir();
  const homes = [...new Set([env.CODEX_HOME, path.join(home, ".codex")].filter(Boolean))];
  /** @type {{root: string, version: string, rank: number}[]} */
  const candidates = [];
  for (const [rank, codexHome] of homes.entries()) {
    const root = path.join(codexHome, "plugins/cache/openai-bundled/chrome");
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && /^\d+(?:\.\d+)+$/.test(entry.name)) {
        candidates.push({ root: path.join(root, entry.name), version: entry.name, rank });
      }
    }
  }
  candidates.sort((a, b) => b.version.localeCompare(a.version, "en", { numeric: true }) || a.rank - b.rank);
  /** @type {string[]} */
  const invalid = [];
  for (const candidate of candidates) {
    try {
      return await validateEngine(candidate.root);
    } catch (error) {
      invalid.push(`${candidate.root}: ${error.message}`);
    }
  }
  throw new Error(`No complete installed OpenAI Chrome engine found. Install the official Chrome plugin, then retry or set BROWSER_USE_ENGINE_PATH to its absolute directory.${invalid.length ? ` Invalid releases: ${invalid.join("; ")}` : ""}`);
}
