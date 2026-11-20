import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { configureClient, installExtension, installSkill } from "../src/install.js";
import { EXTENSION_ID, EXTENSION_VERSION, extensionSource } from "../src/extension.js";

async function extensionFixture(root, version = EXTENSION_VERSION) {
  const source = path.join(root, "source");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "manifest.json"), JSON.stringify({ manifest_version: 3, version }));
  await writeFile(path.join(source, "background.js"), "// fixture\n");
  return source;
}

test("installExtension copies once and replaces with a backup on version change", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "browser-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await extensionFixture(root);
  const destination = path.join(root, "installed");

  const first = await installExtension({ source, destination });
  assert.equal(first.changed, true);
  assert.equal(first.id, EXTENSION_ID);
  assert.equal(first.version, EXTENSION_VERSION);
  assert.equal(JSON.parse(await readFile(path.join(destination, "manifest.json"), "utf8")).version, EXTENSION_VERSION);

  const second = await installExtension({ source, destination });
  assert.equal(second.changed, false);
  assert.equal(second.backup, null);

  await writeFile(path.join(destination, "manifest.json"), JSON.stringify({ manifest_version: 3, version: "0.0.1" }));
  const third = await installExtension({ source, destination });
  assert.equal(third.changed, true);
  assert.equal(third.backup, `${destination}.bak`);
  assert.equal(JSON.parse(await readFile(path.join(third.backup, "manifest.json"), "utf8")).version, "0.0.1");
});

test("installExtension rejects a bundle whose version is not the expected release", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "browser-install-bad-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await extensionFixture(root, "9.9.9");
  await assert.rejects(
    () => installExtension({ source, destination: path.join(root, "installed") }),
    /Bundled extension is 9\.9\.9, expected/,
  );
});

test("configureClient merges one entry, preserves unrelated settings, and backs up", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "browser-client-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, ".commandcode", "mcp.json");
  await mkdir(path.dirname(file), { recursive: true });
  const original = { theme: "dark", mcpServers: { other: { command: "other" } } };
  await writeFile(file, JSON.stringify(original));

  const result = await configureClient({ client: "commandcode", bridgeFile: "/bridge.json", write: true, home });
  assert.equal(result.written, true);
  assert.equal(result.backup, `${file}.bak`);
  const merged = JSON.parse(await readFile(file, "utf8"));
  assert.equal(merged.theme, "dark");
  assert.deepEqual(merged.mcpServers.other, { command: "other" });
  assert.equal(merged.mcpServers["browser-use"].transport, "stdio");
  assert.deepEqual(merged.mcpServers["browser-use"].env, { BROWSER_USE_BRIDGE_FILE: "/bridge.json" });
  assert.deepEqual(JSON.parse(await readFile(`${file}.bak`, "utf8")), original);
});

test("configureClient prints instead of writing when write is false or the client is print-only", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "browser-client-print-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const preview = await configureClient({ client: "commandcode", bridgeFile: "/bridge.json", write: false, home });
  assert.equal(preview.written, false);
  assert.equal(preview.config.mcpServers["browser-use"].transport, "stdio");
  const opencode = await configureClient({ client: "opencode", bridgeFile: "/bridge.json", write: true, home });
  assert.equal(opencode.written, false);
  assert.equal(opencode.config.mcp.servers["browser-use"].type, "local");
  await assert.rejects(
    () => configureClient({ client: "invented", bridgeFile: "/bridge.json", write: true, home }),
    /Unknown client/,
  );
});

test("installSkill writes SKILL.md into each client directory with backup on overwrite", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "browser-skill-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const agy = await installSkill({ client: "antigravity", home });
  assert.equal(agy.written, true);
  assert.equal(agy.file, path.join(home, ".gemini", "config", "skills", "codex-browser-use", "SKILL.md"));
  assert.equal(agy.backup, null);
  assert.match(await readFile(agy.file, "utf8"), /browser_batch/);

  await writeFile(agy.file, "old skill\n");
  const updated = await installSkill({ client: "agy", home });
  assert.equal(updated.backup, `${agy.file}.bak`);
  assert.equal(await readFile(updated.backup, "utf8"), "old skill\n");

  const cursor = await installSkill({ client: "cursor", home });
  assert.equal(cursor.file, path.join(home, ".cursor", "skills", "codex-browser-use", "SKILL.md"));
  const windsurf = await installSkill({ client: "windsurf", home });
  assert.equal(windsurf.file, path.join(home, ".codeium", "windsurf", "skills", "codex-browser-use", "SKILL.md"));
});

test("bundled extension manifest bundles 16/32/48/128 PNG icons matching EXTENSION_VERSION", async () => {
  const manifest = JSON.parse(await readFile(path.join(extensionSource, "manifest.json"), "utf8"));
  assert.equal(manifest.version, EXTENSION_VERSION);
  for (const size of ["16", "32", "48", "128"]) {
    assert.equal(manifest.icons?.[size], `icons/icon-${size}.png`);
    assert.equal(manifest.action?.default_icon?.[size], `icons/icon-${size}.png`);
    const bytes = await readFile(path.join(extensionSource, manifest.icons[size]));
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  }
});
