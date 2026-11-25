import { lstat, mkdir, open, link, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import net from "node:net";
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
  if (!info.isDirectory()) {
    throw new Error("Browser bridge descriptor requires an owner-only directory");
  }
  if (process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) {
    throw new Error("Browser bridge descriptor requires an owner-only directory");
  }
}

/** @param {string} socketPath @returns {Promise<boolean>} */
export function isSocketAlive(socketPath) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({path: socketPath});
    const finish = (alive) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(alive);
    };
    const timer = setTimeout(() => finish(false), 300);
    timer.unref?.();
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** @param {string} file @returns {Promise<boolean>} */
async function isDescriptorLive(file) {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (!info.isFile() || (process.platform !== "win32" && info.uid !== process.getuid?.())) {
    throw new Error("Refusing to replace non-regular or foreign browser bridge descriptor");
  }
  try {
    const existingSocket = await readBackend(file);
    return await isSocketAlive(existingSocket);
  } catch {
    return false;
  }
}

/** @param {string} file @param {string} socketPath @returns {Promise<()=>Promise<void>>} */
export async function publishBackend(file, socketPath) {
  await privateDirectory(file, true);
  const temporary = path.join(path.dirname(file), `.bridge-${randomUUID()}`);
  const handle = await open(temporary, "wx", 0o600);
  let publishedIno;
  let renamed = false;
  try {
    await handle.writeFile(JSON.stringify({version: 1, socketPath}));
    publishedIno = (await handle.stat()).ino;
    try {
      await link(temporary, file);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let live = await isDescriptorLive(file);
      for (let attempt = 0; attempt < 4 && live; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        live = await isDescriptorLive(file);
      }
      if (live) {
        throw new Error("Another live browser bridge host is already active");
      }
      await rename(temporary, file);
      renamed = true;
    }
  } finally {
    await handle.close();
    if (!renamed) await unlink(temporary).catch(() => {});
  }
  return async () => {
    try {
      const current = await lstat(file);
      if (current.ino === publishedIno) await unlink(file);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  };
}

/** @param {string} file @returns {Promise<string>} */
export async function readBackend(file) {
  await privateDirectory(file, false);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    const invalidOwner = process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0);
    if (!info.isFile() || invalidOwner || info.size > 4096) {
      throw new Error("Invalid browser bridge descriptor");
    }
    const descriptor = JSON.parse(await handle.readFile("utf8"));
    const socketPath = descriptor?.socketPath;
    const hasInvalidColon = process.platform !== "win32" && typeof socketPath === "string" && socketPath.includes(":");
    if (descriptor?.version !== 1 || typeof socketPath !== "string" || !path.isAbsolute(socketPath) || hasInvalidColon) {
      throw new Error("Invalid browser bridge socket path");
    }
    if (process.platform !== "win32") {
      await privateDirectory(socketPath, false);
      const socket = await lstat(socketPath);
      if (!socket.isSocket() || socket.uid !== process.getuid?.()) throw new Error("Browser bridge socket is unavailable");
    }
    return socketPath;
  } finally {
    await handle.close();
  }
}
