import { createHash, generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { readBackend } from "../src/backend-discovery.js";

/** @param {string} value @returns {string} */
function quote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

/**
 * Load a disposable copy of the bridge into Chrome for Testing. The only
 * fixture change is connecting at service worker startup instead of a click.
 * @param {string} root @param {string} executable
 * @param {{headless?:boolean}} [options]
 * @returns {Promise<{descriptor:string,close:()=>Promise<void>}>}
 */
export async function launchChromeForTesting(root, executable, { headless = true } = {}) {
  if (!path.isAbsolute(executable)) throw new Error("Use an absolute Chrome for Testing executable path");
  const extension = path.join(root, "extension");
  const profile = path.join(root, "profile");
  const descriptor = path.join(root, "bridge.json");
  const launcher = path.join(root, "native-host.sh");
  const registry = path.join(profile, "NativeMessagingHosts");
  await mkdir(extension);
  await mkdir(registry, {recursive: true});

  const {publicKey} = generateKeyPairSync("rsa", {modulusLength: 2048});
  const key = publicKey.export({type: "spki", format: "der"});
  const name = "com.portable_browser_use.bridge";
  const id = createHash("sha256").update(key).digest("hex").slice(0, 32)
    .replace(/[0-9a-f]/gu, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)));
  const source = new URL("../extension/", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("manifest.json", source), "utf8"));
  manifest.key = key.toString("base64");
  const worker = await readFile(new URL("background.js", source), "utf8");
  const host = fileURLToPath(new URL("../bin/chrome-native-host.js", import.meta.url));
  await Promise.all([
    writeFile(path.join(extension, "manifest.json"), JSON.stringify(manifest)),
    writeFile(path.join(extension, "background.js"), worker + "\nconnect();\n"),
    writeFile(launcher, `#!/bin/sh\nexec ${[process.execPath, host, descriptor].map(quote).join(" ")}\n`, {mode: 0o700}),
    writeFile(path.join(registry, `${name}.json`), JSON.stringify({
      name, description: "Browser Use integration fixture", path: launcher, type: "stdio",
      allowed_origins: [`chrome-extension://${id}/`],
    })),
  ]);

  const chrome = spawn(executable, [
    ...(headless ? ["--headless=new"] : []), "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-component-update", "--disable-sync",
    `--user-data-dir=${profile}`, `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`, "about:blank",
  ], {stdio: ["ignore", "ignore", "pipe"]});
  const exited = once(chrome, "close");
  void exited.catch(() => undefined);
  let diagnostics = "";
  chrome.stderr.on("data", (chunk) => { diagnostics = (diagnostics + chunk).slice(-8000); });

  /** @returns {Promise<void>} */
  async function close() {
    if (chrome.exitCode === null && chrome.signalCode === null && chrome.pid) {
      chrome.kill("SIGTERM");
      const fallback = setTimeout(() => chrome.kill("SIGKILL"), 2500);
      try { await exited; }
      finally { clearTimeout(fallback); }
    }
  }
  try {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (chrome.exitCode !== null || !chrome.pid) {
        await exited;
        throw new Error("Chrome exited before connecting");
      }
      try {
        await readBackend(descriptor);
        return {descriptor, close};
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await delay(100);
    }
    throw new Error("Chrome did not connect the test extension to the native host");
  } catch (error) {
    await close();
    throw new Error(`${error.message}\n${diagnostics}`, {cause: error});
  }
}
