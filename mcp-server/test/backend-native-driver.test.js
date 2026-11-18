import assert from "node:assert/strict";
import { endianness } from "node:os";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createNativeTabDriver } from "../src/backend-native-driver.js";

test("CDP timeouts affect only their tab until all late replies arrive", async () => {
  const littleEndian = endianness() === "LE";
  const input = new PassThrough();
  const output = new PassThrough();
  /** @type {Array<{id:number,tabId:number}>} */
  const requests = [];
  output.on("data", (frame) => requests.push(JSON.parse(frame.subarray(4))));
  const driver = createNativeTabDriver(input, output, {timeoutMs: 40});
  /** @param {Record<string,unknown>} message @returns {void} */
  function reply(message) {
    const body = Buffer.from(JSON.stringify(message));
    const header = Buffer.alloc(4);
    if (littleEndian) header.writeUInt32LE(body.length);
    else header.writeUInt32BE(body.length);
    input.write(Buffer.concat([header, body]));
  }
  try {
    const navigation = assert.rejects(driver.execute(1, "Page.navigate", {}), /timed out: Page.navigate/);
    const screenshot = assert.rejects(driver.execute(1, "Page.captureScreenshot", {}), /timed out: Page.captureScreenshot/);
    await Promise.all([navigation, screenshot]);
    const unaffected = driver.execute(2, "Page.getFrameTree", {});
    reply({id: requests[2].id, ok: true, value: "other tab"});
    assert.equal(await unaffected, "other tab");

    reply({id: requests[1].id, ok: true, value: "late screenshot"});
    await assert.rejects(driver.execute(1, "Page.getFrameTree", {}), /still in flight/);
    reply({id: requests[0].id, index: 0, chunk: "{", final: false});
    await assert.rejects(driver.execute(1, "Page.getFrameTree", {}), /still in flight/);
    reply({id: requests[0].id, index: 1, chunk: "}", final: true});
    const recovered = driver.execute(1, "Page.getFrameTree", {});
    assert.deepEqual(requests.map(({tabId}) => tabId), [1, 1, 2, 1]);
    reply({id: requests[3].id, ok: true, value: "recovered tab"});
    assert.equal(await recovered, "recovered tab");
  } finally {
    driver.close();
    input.destroy();
    output.destroy();
  }
});
