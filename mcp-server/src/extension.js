import { fileURLToPath } from "node:url";
import path from "node:path";
import { homedir } from "node:os";
import { defaultBridgeFile } from "./backend-discovery.js";

export { defaultBridgeFile };

export const HOST_NAME = "com.portable_browser_use.bridge";
export const EXTENSION_ID = "ehooacpcolldccnemjebdnmfgmgekghn";
export const EXTENSION_VERSION = "0.7.0";
export const extensionSource = fileURLToPath(new URL("../extension", import.meta.url));

/** @returns {string} */
export function dataRoot() {
  return path.join(homedir(), ".local", "share", "browser-use");
}

/** @returns {string} */
export function installedExtensionDir() {
  return path.join(dataRoot(), "extension");
}

/** @returns {string} */
export function installedRuntimeDir() {
  return path.join(dataRoot(), "runtime");
}

/** @returns {string} */
export function nativeHostLauncher() {
  return path.join(dataRoot(), "chrome-host", "launch.sh");
}
