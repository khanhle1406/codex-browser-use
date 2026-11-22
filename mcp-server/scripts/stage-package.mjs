import { cp, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mcpRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(mcpRoot, "..");

const TARGETS = ["skill", "rules", "README.md", "LICENSE"];

/**
 * Filter out macOS metadata, backup files, and temporary files during staging.
 * @param {string} src
 * @returns {boolean}
 */
function shouldCopy(src) {
  const name = path.basename(src);
  return name !== ".DS_Store" && !name.endsWith(".bak") && !name.startsWith(".tmp-");
}

/**
 * Copy root skill, rules, README, and LICENSE into `mcp-server/` for npm packaging.
 * Skips any missing source cleanly when run outside the monorepo.
 */
async function pack() {
  await clean();
  for (const rel of TARGETS) {
    const src = path.join(repoRoot, rel);
    const dst = path.join(mcpRoot, rel);
    let info;
    try {
      info = await stat(src);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    await cp(src, dst, {
      recursive: info.isDirectory(),
      force: true,
      filter: shouldCopy,
    });
  }
}

/**
 * Remove staged copies from `mcp-server/` after `npm pack` or `npm publish`.
 */
async function clean() {
  for (const rel of TARGETS) {
    await rm(path.join(mcpRoot, rel), { recursive: true, force: true });
  }
}

const mode = process.argv[2];
if (mode === "pack") {
  await pack();
} else if (mode === "clean") {
  await clean();
} else {
  console.error("Usage: node scripts/stage-package.mjs <pack|clean>");
  process.exitCode = 1;
}
