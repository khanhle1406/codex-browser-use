import path from "node:path";

const pageCommands = new Set([
  "Accessibility.enable", "Accessibility.getFullAXTree", "Accessibility.getPartialAXTree",
  "DOM.describeNode", "DOM.enable", "DOM.focus", "DOM.getBoxModel", "DOM.getContentQuads", "DOM.getDocument",
  "DOM.getFrameOwner", "DOM.getNodeForLocation", "DOM.querySelector", "DOM.resolveNode",
  "DOM.scrollIntoViewIfNeeded", "DOM.setFileInputFiles",
  "DOMSnapshot.captureSnapshot",
  "Emulation.clearDeviceMetricsOverride", "Emulation.setDeviceMetricsOverride",
  "Emulation.setFocusEmulationEnabled",
  "Input.dispatchKeyEvent", "Input.dispatchMouseEvent", "Input.dispatchTouchEvent",
  "Input.insertText", "Input.synthesizeScrollGesture",
  "Network.disable", "Network.enable", "Network.getResponseBody",
  "Page.addScriptToEvaluateOnNewDocument", "Page.removeScriptToEvaluateOnNewDocument",
  "Page.bringToFront", "Page.captureScreenshot", "Page.createIsolatedWorld", "Page.enable", "Page.getFrameTree",
  "Page.getLayoutMetrics", "Page.getNavigationHistory", "Page.handleJavaScriptDialog",
  "Page.navigate", "Page.navigateToHistoryEntry", "Page.reload",
  "Page.setInterceptFileChooserDialog", "Page.setLifecycleEventsEnabled",
  "Runtime.addBinding", "Runtime.callFunctionOn", "Runtime.enable", "Runtime.evaluate",
  "Runtime.releaseObject", "Runtime.releaseObjectGroup", "Runtime.removeBinding",
  "Target.setAutoAttach",
]);
const clipboardBinding = /^__browserUseClipboard_[a-f0-9]{32}$/u;

/** @param {unknown} method @param {unknown} params @returns {void} */
export function validatePageCommand(method, params) {
  if (!pageCommands.has(method)) throw new Error(`Unsupported portable browser command: ${String(method)}`);
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Invalid portable browser command parameters");
  }
  if (method === "Target.setAutoAttach" &&
      (params.autoAttach !== true || params.flatten !== true || params.waitForDebuggerOnStart !== false ||
        !Array.isArray(params.filter) || params.filter.length !== 1 ||
        params.filter[0]?.type !== "iframe" || params.filter[0]?.exclude !== false)) {
    throw new Error("Portable browser auto-attach is limited to child iframe targets");
  }
  if ((method === "Runtime.addBinding" || method === "Runtime.removeBinding") &&
      (typeof params.name !== "string" || !clipboardBinding.test(params.name))) {
    throw new Error("Portable browser bindings are limited to the engine clipboard");
  }
  if (method === "Page.addScriptToEvaluateOnNewDocument" &&
      (typeof params.source !== "string" || !/\binstallPageClipboardBridge\("__browserUseClipboard_[a-f0-9]{32}"\)/u.test(params.source))) {
    throw new Error("Portable browser document injection is limited to the engine clipboard");
  }
  if (method === "Page.handleJavaScriptDialog" &&
      (typeof params.accept !== "boolean" ||
        (params.promptText !== undefined && typeof params.promptText !== "string"))) {
    throw new Error("Invalid browser dialog response parameters");
  }
  if (method === "Page.setInterceptFileChooserDialog" && typeof params.enabled !== "boolean") {
    throw new Error("Page.setInterceptFileChooserDialog requires a boolean enabled flag");
  }
  if (method === "Network.getResponseBody" &&
      (typeof params.requestId !== "string" || params.requestId.length === 0 || params.requestId.length > 256)) {
    throw new Error("Network.getResponseBody requires a non-empty requestId");
  }
  if (method === "Emulation.setDeviceMetricsOverride") {
    const validSize = (value) => Number.isSafeInteger(value) && value >= 100 && value <= 4096;
    if (!validSize(params.width) || !validSize(params.height) ||
        typeof params.deviceScaleFactor !== "number" || !Number.isFinite(params.deviceScaleFactor) ||
        params.deviceScaleFactor < 0 || params.deviceScaleFactor > 8 ||
        typeof params.mobile !== "boolean") {
      throw new Error("Invalid Emulation.setDeviceMetricsOverride viewport parameters");
    }
  }
  if (method === "DOM.setFileInputFiles") {
    if (!Array.isArray(params.files) || params.files.length === 0 ||
        params.files.some((file) => typeof file !== "string" || file.length === 0 || !path.isAbsolute(file))) {
      throw new Error("DOM.setFileInputFiles requires non-empty absolute file paths");
    }
  }
  if (method === "Page.navigate") {
    if (typeof params.url === "string" && params.url.startsWith("about:blank")) return;
    if (typeof params.url !== "string") throw new Error("Browser navigation requires a URL");
    const url = new URL(params.url);
    if (!["http:", "https:", "file:", "data:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("Browser navigation requires an HTTP(S), file, or data URL without credentials");
    }
  }
}

/** @param {unknown} policy @returns {void} */
export function validateNetworkPolicy(policy) {
  if (policy === undefined) return;
  if (!Array.isArray(policy?.constraints) || !policy.constraints.every(
    (entry) => ["domains", "origins"].includes(entry?.kind) && entry.mode === "denylist" &&
      Array.isArray(entry.patterns) && entry.patterns.length === 0,
  )) {
    throw new Error("The portable browser backend cannot enforce this browser network policy");
  }
}
