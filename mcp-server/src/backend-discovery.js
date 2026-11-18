import { lstat, mkdir, open, link, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

/** @returns {string} */
export function defaultBridgeFile() {
  return path.join(homedir(), ".local", "share", "browser-use", "chrome-host", "bridge.json");
}

/** @param {string} file @param {boolean} create @returns {Promise<void>} */
async function privateDirectory(file, create) {
  if (!path.isAbsolute(file)) throw new Error("Browser bridge descriptor must be an absolute path");
  const directory = path.dirname(file);
  if (create) await mkdir(directory, {recursive: true, mode: 0o700});
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new Error("Browser bridge descriptor requires an owner-only directory");
  }
}

/** @param {string} file @param {string} socketPath @returns {Promise<()=>Promise<void>>} */
export async function publishBackend(file, socketPath) {
  await privateDirectory(file, true);
  const temporary = path.join(path.dirname(file), `.bridge-${randomUUID()}`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify({version: 1, socketPath}));
    await link(temporary, file);
  } finally {
    await handle.close();
    await unlink(temporary);
  }
  return async () => { await unlink(file); };
}

/** @param {string} file @returns {Promise<string>} */
export async function readBackend(file) {
  await privateDirectory(file, false);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 4096) {
      throw new Error("Invalid browser bridge descriptor");
    }
    const descriptor = JSON.parse(await handle.readFile("utf8"));
    const socketPath = descriptor?.socketPath;
    if (descriptor?.version !== 1 || typeof socketPath !== "string" || !path.isAbsolute(socketPath) || socketPath.includes(":")) {
      throw new Error("Invalid browser bridge socket path");
    }
    await privateDirectory(socketPath, false);
    const socket = await lstat(socketPath);
    if (!socket.isSocket() || socket.uid !== process.getuid?.()) throw new Error("Browser bridge socket is unavailable");
    return socketPath;
  } finally {
    await handle.close();
  }
}
