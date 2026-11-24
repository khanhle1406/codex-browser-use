import vm from "node:vm";
import { mkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import path from "node:path";
import { URL, URLSearchParams } from "node:url";
import { parse } from "acorn";

const RESERVED_PARAM_NAMES = new Set([
  "browser", "page", "log", "sleep", "viewImage",
  "saveFile", "readFile", "saveScreenshot", "nodeRepl", "console", "__scope",
]);
const MAX_SCRIPT_WRITE_BYTES = 25 * 1024 * 1024;
const MAX_SCRIPT_READ_BYTES = 10 * 1024 * 1024;
const DEFAULT_SCRIPT_READ_BYTES = 2 * 1024 * 1024;
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

/**
 * Determine whether a target string is a selector/locator rather than a numeric
 * accessibility element_index (or comma-separated index chain).
 * @param {unknown} target
 * @returns {boolean}
 */
function isLocatorLike(target) {
  if (typeof target !== "string") return false;
  return !/^\s*\d+(?:\s*,\s*\d+)*\s*$/u.test(target);
}

/** @param {unknown} arg @returns {string} */
function formatLogArg(arg) {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.message;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

/** @param {unknown} value @param {number} maxChars @returns {unknown} */
function boundResult(value, maxChars) {
  if (value === undefined) return undefined;
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return String(value).slice(0, maxChars);
  }
  if (encoded === undefined) return undefined;
  if (encoded.length <= maxChars) return JSON.parse(encoded);
  return `${encoded.slice(0, maxChars)}\n...(truncated)`;
}

/** @param {any} pattern @param {Set<string>} out */
function collectDeclaredIdentifiers(pattern, out) {
  if (!pattern || typeof pattern !== "object") return;
  switch (pattern.type) {
    case "Identifier":
      out.add(pattern.name);
      break;
    case "ObjectPattern":
      for (const prop of pattern.properties ?? []) {
        collectDeclaredIdentifiers(prop?.type === "Property" ? prop.value : prop, out);
      }
      break;
    case "ArrayPattern":
      for (const elem of pattern.elements ?? []) {
        if (elem) collectDeclaredIdentifiers(elem, out);
      }
      break;
    case "RestElement":
      collectDeclaredIdentifiers(pattern.argument, out);
      break;
    case "AssignmentPattern":
      collectDeclaredIdentifiers(pattern.left, out);
      break;
    default:
      break;
  }
}

/**
 * Rewrite top-level `const`/`let`/`class` declarations to `var` so bindings persist
 * across `browser_run` calls and can be redeclared safely across turns.
 * @param {string} code
 * @returns {{transformed:string, declaredNames:string[]}}
 */
export function transformPersistentCode(code) {
  const source = String(code ?? "");
  const tree = parse(source, {
    ecmaVersion: "latest",
    sourceType: "script",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
  });
  const names = new Set();
  /** @type {Array<{start:number, end:number, replacement:string}>} */
  const edits = [];

  for (const stmt of tree.body) {
    if (stmt.type === "VariableDeclaration") {
      if (stmt.kind !== "var") {
        edits.push({ start: stmt.start, end: stmt.start + stmt.kind.length, replacement: "var" });
      }
      for (const decl of stmt.declarations ?? []) collectDeclaredIdentifiers(decl.id, names);
    } else if (stmt.type === "FunctionDeclaration" && stmt.id?.name) {
      names.add(stmt.id.name);
    } else if (stmt.type === "ClassDeclaration" && stmt.id?.name) {
      names.add(stmt.id.name);
      edits.push({ start: stmt.start, end: stmt.start, replacement: `var ${stmt.id.name} = ` });
    }
  }

  let transformed = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    transformed = transformed.slice(0, edit.start) + edit.replacement + transformed.slice(edit.end);
  }
  const declaredNames = [...names].filter((n) => IDENTIFIER_RE.test(n) && !RESERVED_PARAM_NAMES.has(n));
  return { transformed, declaredNames };
}

/** @param {string} role @param {{name?:string|RegExp, exact?:boolean}} [opts] @returns {string} */
function buildRoleStep(role, opts = {}) {
  let step = `role=${String(role)}`;
  if (opts?.name instanceof RegExp) {
    step += `[name=/${opts.name.source}/${opts.name.flags}]`;
  } else if (opts?.name !== undefined) {
    step += `[name=${JSON.stringify(String(opts.name))}][exact=${opts.exact ? "true" : "false"}]`;
  }
  return step;
}

/** @param {string|RegExp} text @param {{exact?:boolean}} [opts] @returns {string} */
function buildTextStep(text, opts = {}) {
  if (text instanceof RegExp) return `text=/${text.source}/${text.flags}`;
  const str = String(text);
  return opts?.exact ? `text=${JSON.stringify(str)}` : `text=${str}`;
}

/** @param {unknown} value @returns {boolean} */
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} obj @param {Set<string>} allowedKeys @returns {boolean} */
function hasOnlyKeys(obj, allowedKeys) {
  if (!isPlainObject(obj)) return false;
  const keys = Object.keys(obj);
  return keys.length > 0 && keys.every((k) => allowedKeys.has(k));
}

const PAGE_EVAL_OPT_KEYS = new Set(["tabId", "tab_id", "timeoutMs", "timeout_ms"]);
const LOCATOR_EVAL_OPT_KEYS = new Set(["tabId", "tab_id", "frame", "timeoutMs", "timeout_ms"]);

/**
 * Persistent VM session for `browser_run`, retaining top-level bindings and active tab
 * state across turns while isolating host globals and enforcing read-only page evaluation.
 */
export class BrowserScriptSession {
  constructor() {
    this.reset();
  }

  reset() {
    this.scope = Object.create(null);
    this.currentTabId = null;
    this.activeRun = null;
    this.context = vm.createContext(
      { URL, URLSearchParams, setTimeout, clearTimeout },
      { codeGeneration: { strings: false, wasm: false } },
    );
  }

  /** @param {import("./bridge-browser.js").BridgeBrowser} browser */
  syncActiveTab(browser) {
    if (this.currentTabId != null) {
      const num = Number(this.currentTabId);
      if (!Number.isSafeInteger(num) || !browser?.ownedTabs?.has(num)) {
        this.currentTabId = browser?.activeTabId != null && browser?.ownedTabs?.has(browser.activeTabId)
          ? String(browser.activeTabId)
          : null;
      }
    }
    if (this.currentTabId === null && browser?.activeTabId != null && browser?.ownedTabs?.has(browser.activeTabId)) {
      this.currentTabId = String(browser.activeTabId);
    }
  }

  #timeoutMessage(run) {
    const during = run?.lastAction ? ` (during ${run.lastAction})` : "";
    return `browser_run timed out after ${run?.timeoutMs ?? 45_000}ms${during}`;
  }

  #requireRun() {
    const run = this.activeRun;
    if (!run || run.aborted || run.deadline - Date.now() <= 0) {
      if (run) run.aborted = true;
      throw new Error(this.#timeoutMessage(run));
    }
    return run;
  }

  #remainingMs() {
    const run = this.activeRun;
    return run ? Math.max(0, run.deadline - Date.now()) : 0;
  }

  #clampTimeout(requested) {
    const rem = this.#remainingMs();
    if (rem <= 0) return 100;
    if (requested === 0) return 0;
    return Math.min(rem, Math.max(100, Number(requested) || rem));
  }

  #resolveTabArg(opts, fixedTabId = null) {
    if (opts && typeof opts === "object") {
      const explicit = opts.tabId ?? opts.tab_id;
      if (explicit !== undefined && explicit !== null && explicit !== "") return explicit;
    }
    if (fixedTabId !== null && fixedTabId !== undefined && fixedTabId !== "") return fixedTabId;
    return this.currentTabId ?? undefined;
  }

  #activeTabId() {
    const browser = this.activeRun?.browser;
    return this.currentTabId ?? (browser?.activeTabId != null ? String(browser.activeTabId) : null);
  }

  #trackPending(run, promise) {
    run.pendingPromises?.add(promise);
    const cleanup = () => run.pendingPromises?.delete(promise);
    promise.then(cleanup, cleanup);
    return promise;
  }

  #guard(fn, label = null, { trackActiveTab = true } = {}) {
    const run = this.#requireRun();
    if (label) run.lastAction = label;
    const promise = (async () => {
      const res = await fn(run.browser);
      if (run.aborted || run !== this.activeRun) {
        throw new Error(this.#timeoutMessage(run));
      }
      if (res && typeof res === "object" && res.tab_id != null) {
        const tid = String(res.tab_id);
        run.touchedTabs.add(tid);
        if (trackActiveTab) this.currentTabId = tid;
      } else if (trackActiveTab && run.browser.activeTabId != null && this.currentTabId === null) {
        this.currentTabId = String(run.browser.activeTabId);
      }
      return res;
    })();
    return this.#trackPending(run, promise);
  }

  #log(...args) {
    const run = this.activeRun;
    if (!run || run.logChars >= run.maxLogChars) return;
    const line = args.map(formatLogArg).join(" ");
    const remaining = run.maxLogChars - run.logChars;
    const clipped = line.length > remaining ? `${line.slice(0, remaining)}...(truncated)` : line;
    run.logs.push(clipped);
    run.logChars += clipped.length;
  }

  #sleep(ms) {
    const run = this.#requireRun();
    const promise = new Promise((resolve, reject) => {
      const waitMs = Math.max(0, Number(ms) || 0);
      const timer = setTimeout(() => {
        run.activeTimers.delete(timer);
        if (run.aborted) reject(new Error(this.#timeoutMessage(run)));
        else resolve();
      }, waitMs);
      run.activeTimers.add(timer);
    });
    return this.#trackPending(run, promise);
  }

  async #viewImage(captureOrOpts, fixedTabId = null) {
    const run = this.#requireRun();
    if (run.images.length >= run.maxImages) {
      throw new Error(`Maximum ${run.maxImages} images per browser_run call exceeded`);
    }
    if (captureOrOpts && typeof captureOrOpts === "object" && typeof captureOrOpts.data === "string") {
      run.images.push({
        data: captureOrOpts.data,
        mimeType: captureOrOpts.mimeType || "image/jpeg",
      });
      return { captured: true, count: run.images.length };
    }
    const opts = (captureOrOpts && typeof captureOrOpts === "object") ? captureOrOpts : {};
    const cap = await this.#guard(
      (b) => b.screenshot(this.#resolveTabArg(opts, fixedTabId), {
        fullPage: opts.fullPage ?? opts.full_page ?? false,
        format: opts.format ?? "jpeg",
        quality: opts.quality ?? 80,
      }),
      "screenshot",
      { trackActiveTab: fixedTabId === null },
    );
    run.images.push({ data: cap.data, mimeType: cap.mimeType });
    return { captured: true, count: run.images.length };
  }

  /** @param {unknown} filePath @param {string} fnName @returns {string} */
  #assertAbsolutePath(filePath, fnName) {
    if (typeof filePath !== "string" || filePath.length === 0 || filePath.includes("\0") || !path.isAbsolute(filePath)) {
      throw new Error(`${fnName} requires a non-empty absolute file path`);
    }
    return filePath;
  }

  /** @param {string} filePath @param {unknown} data */
  async #saveFile(filePath, data) {
    const run = this.#requireRun();
    const target = this.#assertAbsolutePath(filePath, "saveFile");
    const payload = Buffer.isBuffer(data)
      ? data
      : Buffer.from(typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`, "utf8");
    if (payload.byteLength > MAX_SCRIPT_WRITE_BYTES) {
      throw new Error(`saveFile payload exceeds ${MAX_SCRIPT_WRITE_BYTES} bytes limit`);
    }
    await mkdir(path.dirname(target), { recursive: true });
    await fsWriteFile(target, payload);
    run.savedFiles.set(target, { path: target, bytes: payload.byteLength, kind: "file" });
    return { path: target, bytes: payload.byteLength };
  }

  /** @param {string} filePath @param {{encoding?:"utf8"|"base64", maxBytes?:number}} [opts] */
  async #readFile(filePath, opts = {}) {
    this.#requireRun();
    const target = this.#assertAbsolutePath(filePath, "readFile");
    const maxBytes = Math.max(1, Math.min(MAX_SCRIPT_READ_BYTES, Number(opts?.maxBytes ?? DEFAULT_SCRIPT_READ_BYTES)));
    const raw = await fsReadFile(target);
    const sliced = raw.subarray(0, maxBytes);
    return opts?.encoding === "base64" ? sliced.toString("base64") : sliced.toString("utf8");
  }

  /** @param {string} filePath @param {Record<string, any>} [opts] @param {string|null} [fixedTabId] */
  async #saveScreenshot(filePath, opts = {}, fixedTabId = null) {
    const run = this.#requireRun();
    const target = this.#assertAbsolutePath(filePath, "saveScreenshot");
    const ext = path.extname(target).toLowerCase();
    const format = opts.format ?? (ext === ".png" ? "png" : "jpeg");
    const tabId = this.#resolveTabArg(opts, fixedTabId);
    const cap = opts.selector
      ? await this.#guard((b) => b.elementScreenshot(opts.selector, {
        tabId,
        frame: opts.frame,
        force: opts.force === true,
        padding: opts.padding,
        format,
        quality: opts.quality ?? 75,
        scale: opts.scale ?? "css",
        timeoutMs: opts.timeoutMs !== undefined || opts.timeout_ms !== undefined
          ? this.#clampTimeout(opts.timeoutMs ?? opts.timeout_ms)
          : undefined,
      }), `saveScreenshot(${opts.selector})`, { trackActiveTab: fixedTabId === null })
      : await this.#guard((b) => b.screenshot(tabId, {
        fullPage: opts.fullPage ?? opts.full_page ?? false,
        format,
        quality: opts.quality ?? 75,
        ...(opts.maxWidth !== undefined || opts.max_width !== undefined
          ? { maxWidth: opts.maxWidth ?? opts.max_width }
          : {}),
        clip: opts.clip,
        scale: opts.scale ?? "css",
      }), "saveScreenshot", { trackActiveTab: fixedTabId === null });
    const buf = Buffer.from(cap.data, "base64");
    await mkdir(path.dirname(target), { recursive: true });
    await fsWriteFile(target, buf);
    run.savedFiles.set(target, { path: target, bytes: buf.byteLength, kind: "screenshot", mimeType: cap.mimeType });
    if (opts.emit === true) {
      if (run.images.length >= run.maxImages) {
        throw new Error(`Maximum ${run.maxImages} images per browser_run call exceeded`);
      }
      run.images.push({ data: cap.data, mimeType: cap.mimeType });
    }
    return { path: target, bytes: buf.byteLength, mimeType: cap.mimeType, tab_id: cap.tab_id };
  }

  #keepTab(mode = "deliverable", idOrOpts, maybeOpts) {
    const run = this.#requireRun();
    let id = idOrOpts;
    let opts = maybeOpts;
    if (isPlainObject(idOrOpts)) {
      opts = idOrOpts;
      id = idOrOpts.tabId ?? idOrOpts.tab_id;
    }
    const resolved = id !== undefined && id !== null && id !== ""
      ? String(id)
      : this.#activeTabId();
    if (!resolved) {
      throw new Error("No browser tab is active to keep; navigate or open a tab first");
    }
    const normalized = mode === "handoff" ? "handoff" : "deliverable";
    const focus = opts?.focus === true;
    const prev = run.keptTabs.get(resolved);
    const effectiveFocus = focus || (opts?.focus === undefined && prev?.focus === true);
    run.keptTabs.set(resolved, { mode: normalized, ...(effectiveFocus ? { focus: true } : {}) });
    return { tab_id: resolved, mode: normalized, ...(effectiveFocus ? { focus: true } : {}) };
  }

  #requestEndTurn(optsOrMode, fixedTabId = null) {
    const run = this.#requireRun();
    run.endTurnRequested = true;
    if (isPlainObject(optsOrMode) && optsOrMode.ungroup === true) {
      run.ungroupOnEndTurn = true;
    }
    const targetKeep = (optsOrMode && typeof optsOrMode === "object" && !Array.isArray(optsOrMode))
      ? optsOrMode.keep
      : optsOrMode;
    if (typeof targetKeep === "string") {
      this.#keepTab(targetKeep, fixedTabId, isPlainObject(optsOrMode) ? { focus: optsOrMode.focus } : undefined);
    } else if (Array.isArray(targetKeep)) {
      for (const entry of targetKeep) {
        if (entry && typeof entry === "object" && entry.tab_id != null) {
          this.#keepTab(entry.mode ?? "deliverable", entry.tab_id, { focus: entry.focus });
        } else if (typeof entry === "string" || typeof entry === "number") {
          this.#keepTab("deliverable", entry);
        }
      }
    }
    return {
      scheduled: true,
      keep: [...run.keptTabs.entries()].map(([tab_id, cfg]) => ({
        tab_id,
        mode: cfg.mode,
        ...(cfg.focus === true ? { focus: true } : {}),
      })),
    };
  }

  #parseLocatorEvalArgs(fnOrExpr, argOrOpts, maybeOpts, extraLen) {
    if (extraLen >= 3) {
      return { arg: argOrOpts, hasArg: true, opts: isPlainObject(maybeOpts) ? maybeOpts : {} };
    }
    if (extraLen === 2) {
      if (typeof fnOrExpr === "function" && fnOrExpr.length >= 2) {
        return { arg: argOrOpts, hasArg: true, opts: {} };
      }
      if (hasOnlyKeys(argOrOpts, LOCATOR_EVAL_OPT_KEYS)) {
        return { arg: undefined, hasArg: false, opts: argOrOpts };
      }
      return { arg: argOrOpts, hasArg: true, opts: {} };
    }
    return { arg: undefined, hasArg: false, opts: {} };
  }

  #parsePageEvalArgs(exprOrFn, argOrOpts, maybeOpts, extraLen) {
    if (extraLen >= 3) {
      return { arg: argOrOpts, hasArg: true, opts: isPlainObject(maybeOpts) ? maybeOpts : {} };
    }
    if (extraLen === 2) {
      if (typeof exprOrFn === "function" && exprOrFn.length >= 1) {
        return { arg: argOrOpts, hasArg: true, opts: {} };
      }
      if (hasOnlyKeys(argOrOpts, PAGE_EVAL_OPT_KEYS)) {
        return { arg: undefined, hasArg: false, opts: argOrOpts };
      }
      return { arg: argOrOpts, hasArg: true, opts: {} };
    }
    return { arg: undefined, hasArg: false, opts: {} };
  }

  #createLocator(chain, frame = null, boundTabId = null) {
    const selector = chain.filter(Boolean).join(" >> ");
    const tabFor = (opts) => this.#resolveTabArg(opts, boundTabId);
    const guardOpts = { trackActiveTab: boundTabId === null };
    const timeoutOpt = (opts) => (
      opts?.timeoutMs !== undefined || opts?.timeout_ms !== undefined
        ? this.#clampTimeout(opts?.timeoutMs ?? opts?.timeout_ms)
        : undefined
    );

    const self = {
      selector,
      frame,
      tabId: boundTabId,
      locator: (sub, opts) => {
        const loc = this.#createLocator([...chain, String(sub)], frame, boundTabId);
        return isPlainObject(opts) ? loc.filter(opts) : loc;
      },
      getByRole: (role, opts) => this.#createLocator([...chain, buildRoleStep(role, opts)], frame, boundTabId),
      getByText: (text, opts) => this.#createLocator([...chain, buildTextStep(text, opts)], frame, boundTabId),
      getByLabel: (text) => this.#createLocator([...chain, `label=${JSON.stringify(String(text))}`], frame, boundTabId),
      getByPlaceholder: (text) => this.#createLocator([...chain, `placeholder=${JSON.stringify(String(text))}`], frame, boundTabId),
      getByTestId: (id) => this.#createLocator([...chain, `testid=${JSON.stringify(String(id))}`], frame, boundTabId),
      filter: ({ visible, hasText, hasNotText, has, hasNot } = {}) => {
        const steps = [];
        if (visible === true) steps.push("visible=true");
        else if (visible === false) steps.push("visible=false");
        if (hasText instanceof RegExp) steps.push(`has-text=/${hasText.source}/${hasText.flags}`);
        else if (hasText !== undefined) steps.push(`has-text=${JSON.stringify(String(hasText))}`);
        if (hasNotText instanceof RegExp) steps.push(`has-not-text=/${hasNotText.source}/${hasNotText.flags}`);
        else if (hasNotText !== undefined) steps.push(`has-not-text=${JSON.stringify(String(hasNotText))}`);
        if (has) steps.push(`has=(${has?.selector ?? String(has)})`);
        if (hasNot) steps.push(`has-not=(${hasNot?.selector ?? String(hasNot)})`);
        return this.#createLocator([...chain, ...steps], frame, boundTabId);
      },
      and: (other) => this.#createLocator([...chain, `and=(${other?.selector ?? String(other)})`], frame, boundTabId),
      or: (other) => this.#createLocator([...chain, `or=(${other?.selector ?? String(other)})`], frame, boundTabId),
      first: () => this.#createLocator([...chain, "first"], frame, boundTabId),
      last: () => this.#createLocator([...chain, "last"], frame, boundTabId),
      nth: (idx) => this.#createLocator([...chain, `nth=${Number(idx)}`], frame, boundTabId),
      inFrame: (frameSel) => this.#createLocator(chain, frame ? `${frame} >> ${frameSel}` : String(frameSel), boundTabId),
      click: (opts = {}) => this.#guard((b) => b.locatorClick(selector, {
        tabId: tabFor(opts),
        frame: opts?.frame ?? frame ?? undefined,
        clickCount: opts?.clickCount ?? opts?.click_count ?? 1,
        button: opts?.button ?? opts?.mouse_button ?? "left",
        modifiers: opts?.modifiers,
        force: opts?.force === true,
        timeoutMs: timeoutOpt(opts),
        settle: opts?.settle ?? true,
      }), `locator.click(${selector})`, guardOpts),
      dblclick: (opts = {}) => self.click({ ...opts, clickCount: 2 }),
      fill: (value, opts = {}) => this.#guard((b) => b.locatorFill(selector, String(value), {
        tabId: tabFor(opts),
        frame: opts?.frame ?? frame ?? undefined,
        force: opts?.force === true,
        timeoutMs: timeoutOpt(opts),
        settle: opts?.settle ?? true,
      }), `locator.fill(${selector})`, guardOpts),
      clear: (opts = {}) => this.#guard((b) => b.locatorClear(selector, {
        tabId: tabFor(opts),
        frame: opts?.frame ?? frame ?? undefined,
        force: opts?.force === true,
        timeoutMs: timeoutOpt(opts),
        settle: opts?.settle ?? true,
      }), `locator.clear(${selector})`, guardOpts),
      press: (key, opts = {}) => this.#guard((b) => b.locatorPress(selector, String(key), {
        tabId: tabFor(opts),
        frame: opts?.frame ?? frame ?? undefined,
        force: opts?.force === true,
        timeoutMs: timeoutOpt(opts),
        settle: opts?.settle ?? true,
      }), `locator.press(${selector})`, guardOpts),
      type: (text, opts = {}) => this.#guard((b) => b.locatorType(selector, String(text), {
        tabId: tabFor(opts),
        frame: opts?.frame ?? frame ?? undefined,
        force: opts?.force === true,
        timeoutMs: timeoutOpt(opts),
        sequentially: false,
        settle: opts?.settle ?? true,
      }), `locator.type(${selector})`, guardOpts),
      pressSequentially: (text, opts = {}) => this.#guard((b) => b.locatorType(selector, String(text), {
        tabId: tabFor(opts),
        frame: opts?.frame ?? frame ?? undefined,
        force: opts?.force === true,
        timeoutMs: timeoutOpt(opts),
        sequentially: true,
        delayMs: opts?.delay ?? opts?.delayMs ?? 0,
        settle: opts?.settle ?? true,
      }), `locator.pressSequentially(${selector})`, guardOpts),
      check: (opts = {}) => this.#guard((b) => b.locatorCheck(selector, true, {
        tabId: tabFor(opts),
        frame: opts?.frame ?? frame ?? undefined,
        force: opts?.force === true,
        timeoutMs: timeoutOpt(opts),
        settle: opts?.settle ?? true,
      }), `locator.check(${selector})`, guardOpts),
      uncheck: (opts = {}) => this.#guard((b) => b.locatorCheck(selector, false, {
        tabId: tabFor(opts),
        frame: opts?.frame ?? frame ?? undefined,
        force: opts?.force === true,
        timeoutMs: timeoutOpt(opts),
        settle: opts?.settle ?? true,
      }), `locator.uncheck(${selector})`, guardOpts),
      setChecked: (checked, opts = {}) => (checked ? self.check(opts) : self.uncheck(opts)),
      selectOption: (spec, opts = {}) => {
        const payload = (spec && typeof spec === "object" && !Array.isArray(spec))
          ? { ...spec, ...opts }
          : { value: spec, ...opts };
        return this.#guard((b) => b.selectOption({
          tabId: tabFor(payload),
          selector,
          frame: payload.frame ?? frame ?? undefined,
          value: payload.value,
          label: payload.label,
          index: payload.index,
          force: payload.force === true,
          timeoutMs: timeoutOpt(payload),
        }), `locator.selectOption(${selector})`, guardOpts);
      },
      hover: (opts = {}) => this.#guard((b) => b.hover({
        tabId: tabFor(opts),
        selector,
        frame: opts?.frame ?? frame ?? undefined,
        force: opts?.force === true,
        timeoutMs: timeoutOpt(opts),
      }), `locator.hover(${selector})`, guardOpts),
      screenshot: (opts = {}) => {
        const format = opts?.format ?? opts?.type ?? "jpeg";
        if (typeof opts?.path === "string" && opts.path.length > 0) {
          return this.#saveScreenshot(opts.path, {
            ...opts,
            format,
            selector,
            frame: opts?.frame ?? frame ?? undefined,
          }, boundTabId);
        }
        return this.#guard((b) => b.elementScreenshot(selector, {
          tabId: tabFor(opts),
          frame: opts?.frame ?? frame ?? undefined,
          force: opts?.force === true,
          padding: opts?.padding,
          format,
          quality: opts?.quality ?? 75,
          scale: opts?.scale ?? "css",
          timeoutMs: timeoutOpt(opts),
        }), `locator.screenshot(${selector})`, guardOpts);
      },
      saveScreenshot: (filePath, opts = {}) => this.#saveScreenshot(filePath, {
        ...opts,
        selector,
        frame: opts?.frame ?? frame ?? undefined,
      }, boundTabId),
      scrollIntoViewIfNeeded: (opts = {}) => this.#guard((b) => b.locatorScrollIntoView(selector, {
        tabId: tabFor(opts),
        frame: opts?.frame ?? frame ?? undefined,
        timeoutMs: timeoutOpt(opts),
      }), `locator.scrollIntoViewIfNeeded(${selector})`, guardOpts),
      setInputFiles: (files, opts = {}) => this.#guard((b) => b.uploadFiles(files, {
        tabId: tabFor(opts),
        selector,
        frame: opts?.frame ?? frame ?? undefined,
        timeoutMs: timeoutOpt(opts),
      }), `locator.setInputFiles(${selector})`, guardOpts),
      waitFor: (opts = {}) => this.#guard((b) => b.waitFor({
        tabId: tabFor(opts),
        selector,
        frame: opts?.frame ?? frame ?? undefined,
        state: opts?.state ?? "visible",
        timeoutMs: this.#clampTimeout(opts?.timeoutMs ?? opts?.timeout_ms ?? 10_000),
      }), `locator.waitFor(${selector})`, guardOpts),
      count: async (opts = {}) => (await this.#guard((b) => b.locatorCount(selector, {
        tabId: tabFor(opts),
        frame: opts?.frame ?? frame ?? undefined,
      }), `locator.count(${selector})`, guardOpts)).count,
      all: async (opts = {}) => {
        const total = await self.count(opts);
        return Array.from({ length: total }, (_, idx) => self.nth(idx));
      },
      textContent: async (opts = {}) => (await this.#guard((b) => b.locatorText(selector, {
        tabId: tabFor(opts),
        frame: opts?.frame ?? frame ?? undefined,
        mode: "textContent",
        timeoutMs: timeoutOpt(opts),
      }), `locator.textContent(${selector})`, guardOpts)).text,
      innerText: async (opts = {}) => (await this.#guard((b) => b.locatorText(selector, {
        tabId: tabFor(opts),
        frame: opts?.frame ?? frame ?? undefined,
        mode: "innerText",
        timeoutMs: timeoutOpt(opts),
      }), `locator.innerText(${selector})`, guardOpts)).text,
      allTextContents: async (opts = {}) => (await this.#guard((b) => b.locatorAllTexts(selector, {
        tabId: tabFor(opts),
        frame: opts?.frame ?? frame ?? undefined,
        mode: "allTextContents",
      }), `locator.allTextContents(${selector})`, guardOpts)).values,
      allInnerTexts: async (opts = {}) => (await this.#guard((b) => b.locatorAllTexts(selector, {
        tabId: tabFor(opts),
        frame: opts?.frame ?? frame ?? undefined,
        mode: "allInnerTexts",
      }), `locator.allInnerTexts(${selector})`, guardOpts)).values,
      getAttribute: async (name, opts = {}) => (await this.#guard((b) => b.locatorAttribute(selector, name, {
        tabId: tabFor(opts),
        frame: opts?.frame ?? frame ?? undefined,
        timeoutMs: timeoutOpt(opts),
      }), `locator.getAttribute(${selector})`, guardOpts)).value,
      inputValue: async (opts = {}) => (await this.#guard((b) => b.locatorInputValue(selector, {
        tabId: tabFor(opts),
        frame: opts?.frame ?? frame ?? undefined,
        timeoutMs: timeoutOpt(opts),
      }), `locator.inputValue(${selector})`, guardOpts)).value,
      isVisible: async (opts = {}) => (await this.#guard((b) => b.locatorState(selector, "isVisible", {
        tabId: tabFor(opts),
        frame: opts?.frame ?? frame ?? undefined,
      }), `locator.isVisible(${selector})`, guardOpts)).value,
      isEnabled: async (opts = {}) => (await this.#guard((b) => b.locatorState(selector, "isEnabled", {
        tabId: tabFor(opts),
        frame: opts?.frame ?? frame ?? undefined,
      }), `locator.isEnabled(${selector})`, guardOpts)).value,
      isChecked: async (opts = {}) => (await this.#guard((b) => b.locatorState(selector, "isChecked", {
        tabId: tabFor(opts),
        frame: opts?.frame ?? frame ?? undefined,
      }), `locator.isChecked(${selector})`, guardOpts)).value,
      evaluate: async (...args) => {
        const [fnOrExpr, argOrOpts, maybeOpts] = args;
        const parsed = this.#parseLocatorEvalArgs(fnOrExpr, argOrOpts, maybeOpts, args.length);
        return (await this.#guard((b) => b.locatorEvaluate(selector, fnOrExpr, {
          tabId: tabFor(parsed.opts),
          frame: parsed.opts?.frame ?? frame ?? undefined,
          all: false,
          arg: parsed.arg,
          hasArg: parsed.hasArg,
          timeoutMs: timeoutOpt(parsed.opts),
        }), `locator.evaluate(${selector})`, guardOpts)).value;
      },
      evaluateAll: async (...args) => {
        const [fnOrExpr, argOrOpts, maybeOpts] = args;
        const parsed = this.#parseLocatorEvalArgs(fnOrExpr, argOrOpts, maybeOpts, args.length);
        return (await this.#guard((b) => b.locatorEvaluate(selector, fnOrExpr, {
          tabId: tabFor(parsed.opts),
          frame: parsed.opts?.frame ?? frame ?? undefined,
          all: true,
          arg: parsed.arg,
          hasArg: parsed.hasArg,
        }), `locator.evaluateAll(${selector})`, guardOpts)).value;
      },
      ariaSnapshot: async (opts = {}) => (await this.#guard((b) => b.locatorAriaSnapshot(selector, {
        tabId: tabFor(opts),
        frame: opts?.frame ?? frame ?? undefined,
        maxLines: opts?.maxLines ?? opts?.max_lines ?? 2_000,
        mode: opts?.mode ?? "compact",
        timeoutMs: timeoutOpt(opts),
      }), `locator.ariaSnapshot(${selector})`, guardOpts)).text,
    };
    return self;
  }

  #createFrameLocator(frameSelector, boundTabId = null) {
    const sel = String(frameSelector);
    return {
      frameLocator: (sub) => this.#createFrameLocator(`${sel} >> ${String(sub)}`, boundTabId),
      locator: (sub, opts) => {
        const loc = this.#createLocator([String(sub)], sel, boundTabId);
        return isPlainObject(opts) ? loc.filter(opts) : loc;
      },
      getByRole: (role, opts) => this.#createLocator([buildRoleStep(role, opts)], sel, boundTabId),
      getByText: (text, opts) => this.#createLocator([buildTextStep(text, opts)], sel, boundTabId),
      getByLabel: (text) => this.#createLocator([`label=${JSON.stringify(String(text))}`], sel, boundTabId),
      getByPlaceholder: (text) => this.#createLocator([`placeholder=${JSON.stringify(String(text))}`], sel, boundTabId),
      getByTestId: (id) => this.#createLocator([`testid=${JSON.stringify(String(id))}`], sel, boundTabId),
    };
  }

  #createTabHandle(fixedTabId = null) {
    const self = this;
    const isBound = fixedTabId !== null && fixedTabId !== undefined && fixedTabId !== "";
    const boundId = isBound ? String(fixedTabId) : null;
    const resolveTab = (opts) => self.#resolveTabArg(opts, boundId);
    const guardOpts = { trackActiveTab: !isBound };

    const tabApi = {
      get id() {
        return boundId ?? self.#activeTabId();
      },
      get tab_id() {
        return boundId ?? self.#activeTabId();
      },
      get activeTabId() {
        return boundId ?? self.#activeTabId();
      },
      tab: (id) => {
        if (id !== undefined && id !== null && id !== "") {
          self.currentTabId = String(id);
          return self.#createTabHandle(String(id));
        }
        return tabApi;
      },
      url: (opts) => self.#guard((b) => b.url(resolveTab(opts)), "url", guardOpts),
      title: (opts) => self.#guard((b) => b.title(resolveTab(opts)), "title", guardOpts),
      listTabs: () => self.#guard((b) => b.listTabs(), "listTabs", { trackActiveTab: false }),
      newTab: (url) => self.#guard((b) => b.newTab(url), "newTab", { trackActiveTab: true }),
      selectTab: (id) => self.#guard((b) => b.selectTab(id), "selectTab", { trackActiveTab: true }),
      closeTab: async (id) => {
        const target = id ?? boundId;
        const res = await self.#guard((b) => b.closeTab(target), "closeTab", { trackActiveTab: false });
        const closedId = String(res?.tab_id ?? target ?? "");
        if (closedId && self.activeRun) self.activeRun.keptTabs.delete(closedId);
        if (closedId && self.currentTabId === closedId) self.currentTabId = null;
        return res;
      },
      close: () => tabApi.closeTab(boundId),
      goto: (url, opts = {}) => self.#guard((b) => b.goto(url, resolveTab(opts), {
        waitUntil: opts?.waitUntil ?? opts?.wait_until ?? "load",
        timeoutMs: self.#clampTimeout(opts?.timeoutMs ?? opts?.timeout_ms ?? 15_000),
      }), `goto(${url})`, guardOpts),
      back: (opts) => self.#guard((b) => b.history("back", resolveTab(opts)), "back", guardOpts),
      forward: (opts) => self.#guard((b) => b.history("forward", resolveTab(opts)), "forward", guardOpts),
      reload: (opts) => self.#guard((b) => b.reload(resolveTab(opts)), "reload", guardOpts),
      expectNavigation: async (action, opts = {}) => {
        const targetTab = resolveTab(opts);
        return self.#guard((b) => b.expectNavigation(action, {
          tabId: targetTab,
          url: opts?.url,
          waitUntil: opts?.waitUntil ?? opts?.wait_until ?? "load",
          timeoutMs: self.#clampTimeout(opts?.timeoutMs ?? opts?.timeout_ms ?? 15_000),
        }), "expectNavigation", guardOpts);
      },
      getState: (opts = {}) => self.#guard((b) => b.getState(resolveTab(opts), {
        screenshot: opts?.screenshot === true,
        fullPage: opts?.fullPage ?? opts?.full_page ?? false,
        format: opts?.format ?? "jpeg",
        quality: opts?.quality ?? 75,
        diff: opts?.full !== true && opts?.disableDiffing !== true,
        full: opts?.full === true || opts?.disableDiffing === true,
        mode: opts?.mode ?? "full",
        maxLines: opts?.maxLines ?? opts?.max_lines ?? 2_000,
      }), "getState", guardOpts),
      state: (opts = {}) => tabApi.getState(opts),
      ariaSnapshot: async (opts = {}) => {
        if (opts && typeof opts === "object" && opts.selector) {
          return tabApi.locator(String(opts.selector)).ariaSnapshot(opts);
        }
        return (await self.#guard((b) => b.ariaSnapshot({
          tabId: resolveTab(opts),
          maxLines: opts?.maxLines ?? opts?.max_lines ?? 2_000,
          mode: opts?.mode ?? "compact",
        }), "ariaSnapshot", guardOpts)).text;
      },
      screenshot: (opts = {}) => {
        const format = opts?.format ?? opts?.type ?? "jpeg";
        if (typeof opts?.path === "string" && opts.path.length > 0) {
          return self.#saveScreenshot(opts.path, { ...opts, format }, boundId);
        }
        return self.#guard((b) => b.screenshot(resolveTab(opts), {
          fullPage: opts?.fullPage ?? opts?.full_page ?? false,
          format,
          quality: opts?.quality ?? 75,
          ...(opts?.maxWidth !== undefined || opts?.max_width !== undefined
            ? { maxWidth: opts?.maxWidth ?? opts?.max_width }
            : {}),
          clip: opts?.clip,
          scale: opts?.scale ?? "css",
        }), "screenshot", guardOpts);
      },
      elementScreenshot: (selector, opts = {}) => self.#guard((b) => b.elementScreenshot(selector, {
        tabId: resolveTab(opts),
        frame: opts?.frame,
        force: opts?.force === true,
        padding: opts?.padding,
        format: opts?.format ?? "jpeg",
        quality: opts?.quality ?? 75,
        scale: opts?.scale ?? "css",
        timeoutMs: opts?.timeoutMs !== undefined || opts?.timeout_ms !== undefined
          ? self.#clampTimeout(opts.timeoutMs ?? opts.timeout_ms)
          : undefined,
      }), `elementScreenshot(${selector})`, guardOpts),
      saveScreenshot: (filePath, opts = {}) => self.#saveScreenshot(filePath, opts, boundId),
      getContent: async (opts) => {
        const format = typeof opts === "string" ? opts : opts?.format;
        const maxChars = typeof opts === "object" && opts ? (opts.maxChars ?? opts.max_chars) : undefined;
        const passOpts = (format || maxChars !== undefined)
          ? { ...(format ? { format } : {}), ...(maxChars !== undefined ? { maxChars } : {}) }
          : undefined;
        const res = await self.#guard((b) => b.getContent(resolveTab(opts), passOpts), "getContent", guardOpts);
        if (format === "tables" || format === "links") return res;
        return res?.content ?? res?.text ?? "";
      },
      webmcp: {
        listTools: (opts) => self.#guard((b) => b.webmcpListTools(resolveTab(opts)), "webmcp.listTools", guardOpts),
        invokeTool: (name, args, opts) => self.#guard((b) => b.webmcpInvokeTool(name, args, { tabId: resolveTab(opts) }), "webmcp.invokeTool", guardOpts),
      },
      assets: {
        list: (opts = {}) => self.#guard((b) => b.listPageAssets(resolveTab(opts), opts), "assets.list", guardOpts),
      },
      domSnapshot: (opts = {}) => self.#guard((b) => b.domSnapshot({
        tabId: resolveTab(opts),
        maxChars: opts?.maxChars ?? opts?.max_chars ?? 24_000,
        maxLines: opts?.maxLines ?? opts?.max_lines ?? 2_000,
        format: opts?.format ?? "dom",
      }), "domSnapshot", guardOpts),
      inspectElement: (x, y, opts) => self.#guard((b) => b.inspectElement(x, y, { tabId: resolveTab(opts) }), "inspectElement", guardOpts),
      consoleLogs: (opts = {}) => self.#guard((b) => b.consoleLogs({
        tabId: resolveTab(opts),
        levels: opts?.levels,
        filter: opts?.filter,
        limit: opts?.limit ?? 100,
        clear: opts?.clear === true,
      }), "consoleLogs", guardOpts),
      networkLogs: (opts = {}) => self.#guard((b) => b.networkLogs({
        tabId: resolveTab(opts),
        filter: opts?.filter,
        statusMin: opts?.statusMin ?? opts?.status_min,
        statusMax: opts?.statusMax ?? opts?.status_max,
        failedOnly: opts?.failedOnly ?? opts?.failed_only ?? false,
        resourceTypes: opts?.resourceTypes ?? opts?.resource_types,
        limit: opts?.limit ?? 100,
        clear: opts?.clear === true,
      }), "networkLogs", guardOpts),
      setViewport: (optsOrWidth = {}, maybeHeight, maybeOpts = {}) => {
        const opts = typeof optsOrWidth === "number"
          ? { ...(isPlainObject(maybeOpts) ? maybeOpts : {}), width: optsOrWidth, height: maybeHeight }
          : (optsOrWidth || {});
        return self.#guard((b) => b.setViewport({
          tabId: resolveTab(opts),
          width: opts.width,
          height: opts.height,
          deviceScaleFactor: opts.deviceScaleFactor ?? opts.device_scale_factor ?? 1,
          mobile: opts.mobile === true,
        }), "setViewport", guardOpts);
      },
      setViewportSize: (...args) => tabApi.setViewport(...args),
      resetViewport: (opts = {}) => self.#guard((b) => b.resetViewport(resolveTab(opts)), "resetViewport", guardOpts),
      keyboard: {
        press: (key, opts) => tabApi.press(key, opts),
        type: (text, opts) => tabApi.type(text, opts),
        insertText: (text, opts) => tabApi.type(text, opts),
      },
      mouse: {
        move: (x, y, opts) => tabApi.hover({ x, y }, opts),
        click: (x, y, opts) => tabApi.click({ x, y }, opts),
        wheel: (dx, dy, opts = {}) => tabApi.scroll((Number(dy) || 0) >= 0 ? "down" : "up", {
          ...opts,
          pages: Math.max(1, Math.round(Math.abs(Number(dy) || 500) / 500)),
        }),
      },
      on: (eventName, handler) => {
        if (eventName !== "console" && eventName !== "pageerror") {
          throw new Error(`Unsupported page event listener: ${String(eventName)} (supported: console, pageerror)`);
        }
        if (typeof handler !== "function") return tabApi;
        const run = self.#requireRun();
        const unsub = run.browser.addEventListener((ev) => {
          if (boundId != null && String(ev.tabId) !== String(boundId)) return;
          if (boundId == null) {
            const cur = self.#activeTabId();
            if (cur != null && String(ev.tabId) !== String(cur)) return;
          }
          if (eventName === "console" && ev.kind === "console") {
            handler({
              type: () => ev.entry?.level ?? "log",
              text: () => ev.entry?.message ?? "",
              ...ev.entry,
            });
          } else if (eventName === "pageerror" && ev.kind === "pageerror") {
            handler(ev.error ?? new Error(ev.entry?.message || "Page error"));
          }
        });
        run.eventCleanups.set(handler, unsub);
        const activeId = boundId ?? self.#activeTabId();
        if (activeId != null && run.browser.attached.has(Number(activeId))) {
          void run.browser.enableRuntime(activeId).catch(() => {});
        }
        return tabApi;
      },
      off: (_eventName, handler) => {
        const run = self.activeRun;
        const unsub = run?.eventCleanups?.get(handler);
        if (typeof unsub === "function") {
          unsub();
          run.eventCleanups.delete(handler);
        }
        return tabApi;
      },
      evaluate: async (...args) => {
        const [exprOrFn, argOrOpts, maybeOpts] = args;
        const parsed = self.#parsePageEvalArgs(exprOrFn, argOrOpts, maybeOpts, args.length);
        const expr = typeof exprOrFn === "function"
          ? (parsed.hasArg ? exprOrFn.toString() : `(${exprOrFn.toString()})()`)
          : String(exprOrFn);
        const res = await self.#guard((b) => b.evaluate(expr, {
          tabId: resolveTab(parsed.opts),
          arg: parsed.arg,
          hasArg: parsed.hasArg,
        }), "evaluate", guardOpts);
        return res?.value;
      },
      locator: (sel, opts) => {
        const loc = self.#createLocator([String(sel)], null, boundId);
        return isPlainObject(opts) ? loc.filter(opts) : loc;
      },
      frameLocator: (sel) => self.#createFrameLocator(sel, boundId),
      getByRole: (role, opts) => self.#createLocator([buildRoleStep(role, opts)], null, boundId),
      getByText: (text, opts) => self.#createLocator([buildTextStep(text, opts)], null, boundId),
      getByLabel: (text) => self.#createLocator([`label=${JSON.stringify(String(text))}`], null, boundId),
      getByPlaceholder: (text) => self.#createLocator([`placeholder=${JSON.stringify(String(text))}`], null, boundId),
      getByTestId: (id) => self.#createLocator([`testid=${JSON.stringify(String(id))}`], null, boundId),
      click: (target, opts = {}) => {
        const tabId = resolveTab(opts);
        if (target && typeof target === "object" && !Array.isArray(target) &&
            Number.isFinite(target.x) && Number.isFinite(target.y)) {
          return self.#guard((b) => b.click(undefined, {
            tabId,
            x: target.x,
            y: target.y,
            clickCount: opts?.clickCount ?? opts?.click_count ?? target.clickCount ?? 1,
            button: opts?.button ?? opts?.mouse_button ?? "left",
            modifiers: opts?.modifiers,
            settle: opts?.settle ?? true,
          }), "click(point)", guardOpts);
        }
        if (isLocatorLike(target)) {
          return self.#guard((b) => b.locatorClick(target, {
            tabId,
            frame: opts?.frame,
            clickCount: opts?.clickCount ?? opts?.click_count ?? 1,
            button: opts?.button ?? opts?.mouse_button ?? "left",
            modifiers: opts?.modifiers,
            force: opts?.force === true,
            timeoutMs: opts?.timeoutMs ?? opts?.timeout_ms,
            settle: opts?.settle ?? true,
          }), `click(${target})`, guardOpts);
        }
        return self.#guard((b) => b.click(target, {
          tabId,
          clickCount: opts?.clickCount ?? opts?.click_count ?? 1,
          button: opts?.button ?? opts?.mouse_button ?? "left",
          modifiers: opts?.modifiers,
          settle: opts?.settle ?? true,
        }), `click(${target})`, guardOpts);
      },
      locatorClick: (selector, opts = {}) => self.#guard((b) => b.locatorClick(selector, {
        tabId: resolveTab(opts),
        frame: opts?.frame,
        clickCount: opts?.clickCount ?? opts?.click_count ?? 1,
        button: opts?.button ?? opts?.mouse_button ?? "left",
        modifiers: opts?.modifiers,
        force: opts?.force === true,
        timeoutMs: opts?.timeoutMs ?? opts?.timeout_ms,
        settle: opts?.settle ?? true,
      }), `locatorClick(${selector})`, guardOpts),
      fill: (target, value, opts = {}) => {
        const tabId = resolveTab(opts);
        if (isLocatorLike(target)) {
          return self.#guard((b) => b.locatorFill(target, String(value), {
            tabId,
            frame: opts?.frame,
            force: opts?.force === true,
            timeoutMs: opts?.timeoutMs ?? opts?.timeout_ms,
            settle: opts?.settle ?? true,
          }), `fill(${target})`, guardOpts);
        }
        return self.#guard((b) => b.setValue(target, String(value), {
          tabId,
          settle: opts?.settle ?? true,
        }), `setValue(${target})`, guardOpts);
      },
      locatorFill: (selector, value, opts = {}) => self.#guard((b) => b.locatorFill(selector, String(value), {
        tabId: resolveTab(opts),
        frame: opts?.frame,
        force: opts?.force === true,
        timeoutMs: opts?.timeoutMs ?? opts?.timeout_ms,
        settle: opts?.settle ?? true,
      }), `locatorFill(${selector})`, guardOpts),
      setValue: (index, value, opts = {}) => self.#guard((b) => b.setValue(index, String(value), {
        tabId: resolveTab(opts),
        settle: opts?.settle ?? true,
      }), `setValue(${index})`, guardOpts),
      type: (text, opts = {}) => self.#guard((b) => b.typeText(String(text), {
        tabId: resolveTab(opts),
        elementIndex: opts?.elementIndex ?? opts?.element_index,
        settle: opts?.settle ?? true,
      }), "typeText", guardOpts),
      typeText: (text, opts = {}) => tabApi.type(text, opts),
      press: (key, opts = {}) => self.#guard((b) => b.pressKey(String(key), {
        tabId: resolveTab(opts),
        elementIndex: opts?.elementIndex ?? opts?.element_index,
        settle: opts?.settle ?? true,
      }), `pressKey(${key})`, guardOpts),
      pressKey: (key, opts = {}) => tabApi.press(key, opts),
      hover: (target, opts = {}) => {
        const tabId = resolveTab(opts);
        if (target && typeof target === "object" && !Array.isArray(target) &&
            Number.isFinite(target.x) && Number.isFinite(target.y)) {
          return self.#guard((b) => b.hover({ tabId, x: target.x, y: target.y }), "hover(point)", guardOpts);
        }
        if (isLocatorLike(target)) {
          return self.#guard((b) => b.hover({
            tabId,
            selector: target,
            frame: opts?.frame,
            force: opts?.force === true,
            timeoutMs: opts?.timeoutMs ?? opts?.timeout_ms,
          }), `hover(${target})`, guardOpts);
        }
        return self.#guard((b) => b.hover({ tabId, elementIndex: target }), `hover(${target})`, guardOpts);
      },
      drag: (opts) => self.#guard((b) => b.drag({ tabId: resolveTab(opts), ...opts }), "drag", guardOpts),
      scroll: (dirOrOpts, optsOrPages = {}) => {
        if (isPlainObject(dirOrOpts)) {
          const opts = dirOrOpts;
          return self.#guard((b) => b.scroll(opts.direction ?? "down", {
            tabId: resolveTab(opts),
            elementIndex: opts.elementIndex ?? opts.element_index,
            pages: opts.pages ?? 1,
            x: opts.x,
            y: opts.y,
          }), `scroll(${opts.direction ?? "down"})`, guardOpts);
        }
        const opts = typeof optsOrPages === "number" ? { pages: optsOrPages } : (optsOrPages || {});
        return self.#guard((b) => b.scroll(dirOrOpts, {
          tabId: resolveTab(opts),
          elementIndex: opts?.elementIndex ?? opts?.element_index,
          pages: opts?.pages ?? 1,
          x: opts?.x,
          y: opts?.y,
        }), `scroll(${dirOrOpts})`, guardOpts);
      },
      selectOption: (targetOrOpts, valOrOpts) => {
        if (targetOrOpts && typeof targetOrOpts === "object" && !Array.isArray(targetOrOpts)) {
          return self.#guard((b) => b.selectOption({ tabId: resolveTab(targetOrOpts), ...targetOrOpts }), "selectOption", guardOpts);
        }
        const extra = (valOrOpts && typeof valOrOpts === "object" && !Array.isArray(valOrOpts))
          ? valOrOpts
          : { value: valOrOpts };
        const targetFields = isLocatorLike(targetOrOpts)
          ? { selector: targetOrOpts }
          : { elementIndex: targetOrOpts };
        return self.#guard((b) => b.selectOption({ tabId: resolveTab(extra), ...targetFields, ...extra }), "selectOption", guardOpts);
      },
      uploadFiles: (files, opts = {}) => self.#guard((b) => b.uploadFiles(files, {
        tabId: resolveTab(opts),
        elementIndex: opts?.elementIndex ?? opts?.element_index,
        selector: opts?.selector,
        frame: opts?.frame,
        timeoutMs: opts?.timeoutMs ?? opts?.timeout_ms,
      }), "uploadFiles", guardOpts),
      innerText: (selector, opts = {}) => {
        if (selector === undefined || selector === null || isPlainObject(selector)) {
          return tabApi.locator("css=body").innerText(isPlainObject(selector) ? selector : opts);
        }
        return tabApi.locator(selector).innerText(opts);
      },
      textContent: (selector, opts = {}) => {
        if (selector === undefined || selector === null || isPlainObject(selector)) {
          return tabApi.locator("css=body").textContent(isPlainObject(selector) ? selector : opts);
        }
        return tabApi.locator(selector).textContent(opts);
      },
      inputValue: (selector, opts = {}) => tabApi.locator(selector).inputValue(opts),
      getAttribute: (selector, name, opts = {}) => tabApi.locator(selector).getAttribute(name, opts),
      isVisible: (selector, opts = {}) => tabApi.locator(selector).isVisible(opts),
      isEnabled: (selector, opts = {}) => tabApi.locator(selector).isEnabled(opts),
      isChecked: (selector, opts = {}) => tabApi.locator(selector).isChecked(opts),
      check: (selector, opts = {}) => tabApi.locator(selector).check(opts),
      uncheck: (selector, opts = {}) => tabApi.locator(selector).uncheck(opts),
      waitFor: (optsOrMs) => {
        if (typeof optsOrMs === "number") return self.#sleep(optsOrMs);
        if (typeof optsOrMs === "string") {
          return self.#guard((b) => b.waitFor({
            tabId: resolveTab(),
            selector: optsOrMs,
            timeoutMs: self.#clampTimeout(10_000),
          }), `waitFor(${optsOrMs})`, guardOpts);
        }
        const opts = (optsOrMs && typeof optsOrMs === "object") ? optsOrMs : {};
        return self.#guard((b) => b.waitFor({
          tabId: resolveTab(opts),
          selector: opts.selector,
          text: opts.text,
          url: opts.url,
          loadState: opts.loadState ?? opts.load_state,
          state: opts.state,
          frame: opts.frame,
          timeoutMs: self.#clampTimeout(opts.timeoutMs ?? opts.timeout_ms ?? 10_000),
        }), "waitFor", guardOpts);
      },
      wait: (optsOrMs) => tabApi.waitFor(optsOrMs),
      waitForEvent: async (eventName, opts = {}) => {
        const res = await self.#guard((b) => b.waitForEvent(eventName, {
          tabId: resolveTab(opts),
          timeoutMs: self.#clampTimeout(opts?.timeoutMs ?? opts?.timeout_ms ?? 30_000),
        }), `waitForEvent(${eventName})`, guardOpts);
        if (eventName === "popup" && res?.tab_id) {
          const handle = self.#createTabHandle(res.tab_id);
          handle.openerTabId = res.opener_tab_id;
          handle.opener_tab_id = res.opener_tab_id;
          handle.initialUrl = res.url;
          handle.initialTitle = res.title;
          return handle;
        }
        return res;
      },
      waitForLoadState: (stateOrOpts = "load", maybeOpts = {}) => {
        const opts = typeof stateOrOpts === "string"
          ? { ...maybeOpts, loadState: stateOrOpts }
          : (stateOrOpts || {});
        return tabApi.waitFor({
          ...opts,
          loadState: opts.loadState ?? opts.state ?? "load",
        });
      },
      waitForURL: (url, opts = {}) => tabApi.waitFor({ ...opts, url }),
      waitForTimeout: (ms) => self.#sleep(ms),
      handleDialog: (opts = {}) => self.#guard((b) => b.handleDialog({
        tabId: resolveTab(opts),
        accept: opts?.accept !== false,
        promptText: opts?.promptText ?? opts?.prompt_text,
      }), "handleDialog", guardOpts),
      getJsDialog: (opts = {}) => self.#guard((b) => b.getJsDialog(resolveTab(opts)), "getJsDialog", guardOpts),
      keepTab: (mode, idOrOpts, maybeOpts) => self.#keepTab(mode, idOrOpts ?? boundId, maybeOpts),
      markDeliverable: (idOrOpts, maybeOpts) => {
        if (isPlainObject(idOrOpts)) {
          return self.#keepTab("deliverable", idOrOpts.tabId ?? idOrOpts.tab_id ?? boundId, idOrOpts);
        }
        return self.#keepTab("deliverable", idOrOpts ?? boundId, maybeOpts);
      },
      markHandoff: (idOrOpts, maybeOpts) => {
        if (isPlainObject(idOrOpts)) {
          return self.#keepTab("handoff", idOrOpts.tabId ?? idOrOpts.tab_id ?? boundId, idOrOpts);
        }
        return self.#keepTab("handoff", idOrOpts ?? boundId, maybeOpts);
      },
      endTurn: (opts) => self.#requestEndTurn(opts, boundId),
      end_turn: (opts) => self.#requestEndTurn(opts, boundId),
      dev: {
        logs: async (opts = {}) => (await tabApi.consoleLogs(opts)).logs,
        network: async (opts = {}) => (await tabApi.networkLogs(opts)).requests,
        enableNetwork: (opts = {}) => self.#guard((b) => b.enableNetwork({
          tabId: resolveTab(opts),
          captureBodies: opts?.captureBodies !== false,
        }), "dev.enableNetwork", guardOpts),
        responseBody: (requestId, opts = {}) => self.#guard((b) => b.networkResponseBody(requestId, {
          tabId: resolveTab(opts),
          maxChars: opts?.maxChars ?? opts?.max_chars ?? 64_000,
        }), `dev.responseBody(${requestId})`, guardOpts),
      },
      ax: {
        getState: (opts = {}) => tabApi.getState(opts),
        get: async (modeOrOpts = {}, maybeOpts = {}) => {
          if (modeOrOpts === "screenshot") {
            return await tabApi.screenshot(maybeOpts);
          }
          if (modeOrOpts === "both") {
            const full = maybeOpts?.disableDiffing === true || maybeOpts?.full === true;
            const st = await tabApi.getState({ ...maybeOpts, screenshot: true, full, diff: !full });
            return {
              state: st.axText,
              screenshot: st.screenshotBase64
                ? { data: st.screenshotBase64, mimeType: st.screenshotMimeType || "image/jpeg" }
                : undefined,
            };
          }
          const opts = typeof modeOrOpts === "string" ? maybeOpts : (modeOrOpts || {});
          const full = opts.full === true || opts.disableDiffing === true;
          const st = await tabApi.getState({ ...opts, screenshot: false, full, diff: !full });
          return st.axText;
        },
        write: async (modeOrOpts = {}, maybeOpts = {}) => {
          if (modeOrOpts === "screenshot") {
            await self.#viewImage(maybeOpts, boundId);
            return;
          }
          if (modeOrOpts === "both") {
            const full = maybeOpts?.disableDiffing === true || maybeOpts?.full === true;
            const st = await tabApi.getState({ ...maybeOpts, screenshot: false, full, diff: !full });
            self.#log(st.axText);
            await self.#viewImage(maybeOpts, boundId);
            return st.axText;
          }
          const opts = typeof modeOrOpts === "string" ? maybeOpts : (modeOrOpts || {});
          const full = opts.full === true || opts.disableDiffing === true;
          const st = await tabApi.getState({ ...opts, screenshot: false, full, diff: !full });
          self.#log(st.axText);
          if (opts.screenshot === true) {
            await self.#viewImage(opts, boundId);
          }
          return st.axText;
        },
        click: (target, opts = {}) => {
          if (Array.isArray(target)) {
            return tabApi.click({ x: target[0], y: target[1] }, opts);
          }
          return tabApi.click(target, opts);
        },
        setValue: (idx, val, opts = {}) => tabApi.setValue(idx, val, opts),
        paste: (idxOrText, maybeText, opts = {}) => {
          if (typeof maybeText === "string") {
            return self.#guard((b) => b.pasteText(idxOrText, maybeText, {
              tabId: resolveTab(opts),
              settle: opts?.settle === true,
            }), "ax.paste", guardOpts);
          }
          const extra = isPlainObject(maybeText) ? maybeText : {};
          return self.#guard((b) => b.pasteText(undefined, String(idxOrText), {
            tabId: resolveTab(extra),
            settle: extra?.settle === true,
          }), "ax.paste", guardOpts);
        },
        selectText: (idx, text, opts = {}) => self.#guard((b) => b.selectText(idx, text, {
          tabId: resolveTab(opts),
          settle: opts?.settle === true,
        }), `ax.selectText(${idx})`, guardOpts),
        pressKey: (idxOrKey, maybeKey, opts = {}) => {
          if (typeof maybeKey === "string") {
            return tabApi.press(maybeKey, {
              ...opts,
              ...(idxOrKey !== null && idxOrKey !== undefined ? { elementIndex: idxOrKey } : {}),
            });
          }
          const extra = isPlainObject(maybeKey) ? maybeKey : {};
          return tabApi.press(String(idxOrKey), extra);
        },
        typeText: (idxOrText, maybeText, opts = {}) => {
          if (typeof maybeText === "string") {
            return tabApi.type(maybeText, {
              ...opts,
              ...(idxOrText !== null && idxOrText !== undefined ? { elementIndex: idxOrText } : {}),
            });
          }
          const extra = isPlainObject(maybeText) ? maybeText : {};
          return tabApi.type(String(idxOrText), extra);
        },
        scroll: (targetOrDir, dirOrOpts = "down", pagesOrOpts) => {
          if (typeof targetOrDir === "string") {
            const opts = typeof dirOrOpts === "number"
              ? { pages: dirOrOpts }
              : (isPlainObject(dirOrOpts) ? dirOrOpts : {});
            return tabApi.scroll(targetOrDir, opts);
          }
          const pages = typeof pagesOrOpts === "number" ? pagesOrOpts : (pagesOrOpts?.pages ?? 1);
          if (Array.isArray(targetOrDir)) {
            return tabApi.scroll(String(dirOrOpts), { x: targetOrDir[0], y: targetOrDir[1], pages });
          }
          return tabApi.scroll(String(dirOrOpts), { elementIndex: targetOrDir, pages });
        },
        drag: (fromOrOpts, to, opts = {}) => {
          if (isPlainObject(fromOrOpts)) return tabApi.drag(fromOrOpts);
          const payload = { ...opts };
          if (Array.isArray(fromOrOpts)) {
            payload.fromX = fromOrOpts[0];
            payload.fromY = fromOrOpts[1];
          } else {
            payload.fromIndex = fromOrOpts;
          }
          if (Array.isArray(to)) {
            payload.toX = to[0];
            payload.toY = to[1];
          } else {
            payload.toIndex = to;
          }
          return tabApi.drag(payload);
        },
        performSecondaryAction: (idx, action, opts = {}) => self.#guard((b) => b.performSecondaryAction(idx, action, {
          tabId: resolveTab(opts),
          settle: opts?.settle ?? true,
        }), `ax.performSecondaryAction(${idx}, ${action})`, guardOpts),
        ariaSnapshot: (opts = {}) => tabApi.ariaSnapshot(opts),
      },
    };
    tabApi.content = Object.assign(
      (opts) => tabApi.getContent(opts),
      {
        export: (opts = {}) => tabApi.getContent({ ...opts, format: opts?.format ?? "markdown" }),
        tables: (opts = {}) => tabApi.getContent({ ...opts, format: "tables" }),
        links: (opts = {}) => tabApi.getContent({ ...opts, format: "links" }),
      },
    );
    tabApi.playwright = tabApi;
    return tabApi;
  }

  #createApi() {
    const self = this;
    const api = this.#createTabHandle(null);
    api.tabs = {
      new: async (url) => {
        const info = await self.#guard((b) => b.newTab(url), "tabs.new", { trackActiveTab: true });
        return self.#createTabHandle(info.tab_id);
      },
      get: async (id) => {
        const raw = isPlainObject(id) ? (id.tab_id ?? id.id) : id;
        const wanted = String(raw);
        const list = await self.#guard((b) => b.listTabs(), "tabs.get", { trackActiveTab: false });
        const match = list.find((t) => String(t.tab_id) === wanted);
        if (!match) {
          throw new Error(`Browser tab ${wanted} is unavailable to this session`);
        }
        if (match.owned === false) {
          await self.#guard((b) => b.claimTab(wanted), "tabs.claim", { trackActiveTab: false });
        }
        return self.#createTabHandle(wanted);
      },
      read: async (tabOrId, opts = {}) => {
        const raw = isPlainObject(tabOrId) ? (tabOrId.tab_id ?? tabOrId.id ?? tabOrId.providerTabId) : tabOrId;
        return await self.#guard((b) => b.readTabContext(raw, opts), "tabs.read", { trackActiveTab: false });
      },
      claim: async (tabOrId) => {
        const raw = isPlainObject(tabOrId) ? (tabOrId.tab_id ?? tabOrId.id) : tabOrId;
        const info = await self.#guard((b) => b.claimTab(raw), "tabs.claim", { trackActiveTab: true });
        return self.#createTabHandle(info.tab_id);
      },
      list: async () => {
        const list = await self.#guard((b) => b.listTabs(), "tabs.list", { trackActiveTab: false });
        return list.map((t) => ({ id: t.tab_id, ...t }));
      },
      selected: async () => {
        const list = await self.#guard((b) => b.listTabs(), "tabs.selected", { trackActiveTab: false });
        const target = list.find((t) => t.active) || list.find((t) => t.owned !== false) || list[0];
        if (!target) return undefined;
        if (target.owned === false) {
          await self.#guard((b) => b.claimTab(target.tab_id), "tabs.claim", { trackActiveTab: true });
        }
        return self.#createTabHandle(target.tab_id);
      },
      content: (urls, opts = {}) => self.#guard((b) => b.extractUrlsContent(urls, {
        format: opts?.format ?? "markdown",
        maxChars: opts?.maxChars ?? opts?.max_chars ?? 16_000,
        concurrency: opts?.concurrency ?? 3,
        waitUntil: opts?.waitUntil ?? opts?.wait_until ?? "domcontentloaded",
        timeoutMs: self.#clampTimeout(opts?.timeoutMs ?? opts?.timeout_ms ?? 15_000),
      }), "tabs.content", { trackActiveTab: false }),
    };
    api.user = {
      openTabs: async () => {
        const list = await self.#guard((b) => b.listTabs({ includeUserTabs: "force" }), "user.openTabs", { trackActiveTab: false });
        return list.map((t) => ({ id: t.tab_id, providerTabId: t.tab_id, ...t }));
      },
      claimTab: async (tabOrId) => {
        const raw = isPlainObject(tabOrId) ? (tabOrId.tab_id ?? tabOrId.id ?? tabOrId.providerTabId) : tabOrId;
        const info = await self.#guard((b) => b.claimTab(raw), "user.claimTab", { trackActiveTab: true });
        return self.#createTabHandle(info.tab_id);
      },
      getTabContext: async (tabOrId, opts = {}) => {
        const raw = isPlainObject(tabOrId) ? (tabOrId.tab_id ?? tabOrId.id ?? tabOrId.providerTabId) : tabOrId;
        return await self.#guard((b) => b.readTabContext(raw, opts), "user.getTabContext", { trackActiveTab: false });
      },
    };
    api.viewport = {
      set: (opts) => api.setViewport(opts),
      reset: (opts) => api.resetViewport(opts),
    };
    api.nameSession = (name, colorOrOpts) => {
      const opts = typeof colorOrOpts === "string" ? { color: colorOrOpts } : (colorOrOpts || {});
      return self.#guard((b) => b.nameSession(name, opts), "nameSession", { trackActiveTab: false });
    };
    api.groups = {
      list: () => self.#guard((b) => b.listTabGroups(), "groups.list", { trackActiveTab: false }),
      ungroup: (tabIds) => self.#guard((b) => b.ungroupTabs(tabIds), "groups.ungroup", { trackActiveTab: false }),
      cleanup: (opts = {}) => self.#guard((b) => b.cleanupGroups(opts), "groups.cleanup", { trackActiveTab: false }),
    };
    return api;
  }

  /**
   * Execute an async multi-step browser script with `browser`/`page`, bound `Tab` handles,
   * fluent auto-waiting Locators, `ariaSnapshot()`, `log`, `sleep`, `viewImage`,
   * `saveFile`, `readFile`, `saveScreenshot`, `nodeRepl`, and persisted top-level variables.
   * @param {import("./bridge-browser.js").BridgeBrowser} browser
   * @param {string} code
   * @param {{tabId?:unknown, timeoutMs?:number, maxLogChars?:number, maxResultChars?:number, maxImages?:number}} [options]
   */
  async run(browser, code, options = {}) {
    const timeoutMs = Math.max(500, Math.min(300_000, Number(options.timeoutMs) || 45_000));
    const maxLogChars = options.maxLogChars ?? 16_000;
    const maxResultChars = options.maxResultChars ?? 32_000;
    const maxImages = options.maxImages ?? 4;

    if (options.tabId !== undefined && options.tabId !== null && options.tabId !== "") {
      this.currentTabId = String(options.tabId);
    } else {
      this.syncActiveTab(browser);
    }

    const run = {
      browser,
      deadline: Date.now() + timeoutMs,
      timeoutMs,
      aborted: false,
      lastAction: null,
      touchedTabs: new Set(this.currentTabId ? [this.currentTabId] : []),
      keptTabs: new Map(),
      savedFiles: new Map(),
      eventCleanups: new Map(),
      pendingPromises: new Set(),
      endTurnRequested: false,
      ungroupOnEndTurn: false,
      logs: [],
      logChars: 0,
      images: [],
      activeTimers: new Set(),
      maxLogChars,
      maxImages,
    };
    this.activeRun = run;

    const api = this.#createApi();
    const log = (...args) => this.#log(...args);
    const sleep = (ms) => this.#sleep(ms);
    const viewImage = (captureOrOpts) => this.#viewImage(captureOrOpts);
    const saveFile = (filePath, data) => this.#saveFile(filePath, data);
    const readFile = (filePath, opts) => this.#readFile(filePath, opts);
    const saveScreenshot = (filePath, opts) => this.#saveScreenshot(filePath, opts);
    const nodeRepl = { write: log, emitImage: viewImage };
    const consoleFacade = {
      log,
      info: log,
      warn: (...args) => log("[warn]", ...args),
      error: (...args) => log("[error]", ...args),
    };

    const { transformed, declaredNames } = transformPersistentCode(code);
    const existingKeys = Object.keys(this.scope).filter((k) => IDENTIFIER_RE.test(k) && !RESERVED_PARAM_NAMES.has(k));
    const preloadLines = existingKeys.map((k) => `var ${k} = __scope[${JSON.stringify(k)}];`).join("\n");
    const allSavedKeys = [...new Set([...existingKeys, ...declaredNames])];
    const saveLines = allSavedKeys
      .map((k) => `try { __scope[${JSON.stringify(k)}] = ${k}; } catch { /* uninitialized */ }`)
      .join("\n");

    const wrapped = `(async function __browserRun(browser, page, log, sleep, viewImage, saveFile, readFile, saveScreenshot, nodeRepl, console, __scope) {\n${preloadLines}\ntry {\n${transformed}\n} finally {\n${saveLines}\n}\n})`;
    const script = new vm.Script(wrapped, { filename: "browser-run.js" });
    const runner = script.runInContext(this.context, { timeout: Math.min(timeoutMs, 5_000) });

    let deadlineTimer;
    const timeoutPromise = new Promise((_, reject) => {
      deadlineTimer = setTimeout(() => {
        run.aborted = true;
        reject(new Error(this.#timeoutMessage(run)));
      }, timeoutMs);
    });

    const runnerPromise = runner(
      api,
      api,
      log,
      sleep,
      viewImage,
      saveFile,
      readFile,
      saveScreenshot,
      nodeRepl,
      consoleFacade,
      this.scope,
    );

    try {
      const rawValue = await Promise.race([
        runnerPromise,
        timeoutPromise,
      ]);
      const notifications = [];
      const drainIds = new Set([...run.touchedTabs]);
      const finalActive = this.#activeTabId();
      if (finalActive != null) drainIds.add(String(finalActive));
      for (const tid of drainIds) {
        const num = Number(tid);
        if (Number.isSafeInteger(num)) {
          notifications.push(...browser.drainNotifications(num));
        }
      }
      return {
        value: boundResult(rawValue, maxResultChars),
        logs: run.logs,
        images: run.images,
        savedFiles: [...run.savedFiles.values()],
        notifications,
        activeTabId: finalActive,
        keptTabs: [...run.keptTabs.entries()].map(([tab_id, cfg]) => ({
          tab_id,
          mode: cfg.mode,
          ...(cfg.focus === true ? { focus: true } : {}),
        })),
        endTurnRequested: run.endTurnRequested,
        ungroupOnEndTurn: run.ungroupOnEndTurn,
      };
    } finally {
      run.aborted = true;
      clearTimeout(deadlineTimer);
      runnerPromise.catch(() => {});
      for (const pending of run.pendingPromises) pending.catch(() => {});
      run.pendingPromises.clear();
      for (const timer of run.activeTimers) clearTimeout(timer);
      run.activeTimers.clear();
      for (const unsub of run.eventCleanups.values()) {
        try { unsub(); } catch { /* Ignore cleanup failure */ }
      }
      run.eventCleanups.clear();
      if (this.activeRun === run) this.activeRun = null;
    }
  }
}

/**
 * Convenience stateless/session-aware helper for running a browser script.
 * @param {import("./bridge-browser.js").BridgeBrowser} browser
 * @param {string} code
 * @param {{session?:BrowserScriptSession, tabId?:unknown, timeoutMs?:number, maxLogChars?:number, maxResultChars?:number, maxImages?:number}} [options]
 */
export async function runBrowserScript(browser, code, options = {}) {
  const session = options.session ?? new BrowserScriptSession();
  return session.run(browser, code, options);
}
