#!/usr/bin/env node
import { listenBackend } from "../src/backend-transport.js";
import { createTabHandlers } from "../src/backend-tabs.js";
import { createNativeTabDriver } from "../src/backend-native-driver.js";
import { publishBackend } from "../src/backend-discovery.js";

/** @param {string} descriptor @returns {Promise<void>} */
async function main(descriptor) {
  if (!descriptor) throw new Error("A browser bridge descriptor path is required");
  const driver = createNativeTabDriver(process.stdin, process.stdout);
  process.once("SIGTERM", driver.close);
  process.once("SIGINT", driver.close);
  const backend = await listenBackend(createTabHandlers(driver, {name: "Portable Chrome", version: "0.1.0",
    childFrames: process.env.BROWSER_USE_ENABLE_CHILD_FRAMES !== "0"}));
  try {
    const unpublish = await publishBackend(descriptor, backend.socketPath);
    try { await driver.closed; }
    finally { await unpublish(); }
  } finally {
    driver.close();
    process.stdin.destroy();
    await backend.close();
  }
}

main(process.argv[2]).catch((error) => {
  process.stderr.write(`Portable Chrome native host: ${error.message}\n`);
  process.exitCode = 1;
});
