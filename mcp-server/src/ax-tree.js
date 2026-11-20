const TEXT_PRUNABLE_PARENT_ROLES = new Set([
  "button", "link", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
  "option", "heading", "checkbox", "radio", "switch", "treeitem", "label",
  "RadioButton", "ToggleButton",
]);

const STATEFUL_PROPERTIES = new Set([
  "checked", "disabled", "editable", "expanded", "focused", "haspopup",
  "invalid", "modal", "multiselectable", "pressed", "readonly", "required",
  "selected",
]);

/**
 * Collapse internal whitespace and trim surrounding spaces.
 * @param {unknown} value
 * @returns {string}
 */
function normalizeText(value) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/\s+/gu, " ").trim();
}

/**
 * Truncate a string cleanly with an ellipsis when exceeding maxLength.
 * @param {string} text
 * @param {number} maxLength
 * @returns {string}
 */
function truncateText(text, maxLength) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

/**
 * Extract named CDP AX property values into a lookup map.
 * @param {unknown} properties
 * @returns {Map<string, unknown>}
 */
function readPropertyMap(properties) {
  const map = new Map();
  if (!Array.isArray(properties)) return map;
  for (const property of properties) {
    if (typeof property?.name === "string") {
      map.set(property.name, property?.value?.value);
    }
  }
  return map;
}

/**
 * Format compact state tokens for an AX node.
 * @param {Map<string, unknown>} propMap
 * @returns {{states:string, actions:string[]}}
 */
function formatNodeStates(propMap) {
  const parts = [];
  const actions = [];
  for (const [name, raw] of propMap) {
    if (!STATEFUL_PROPERTIES.has(name)) continue;
    if (raw === true) {
      parts.push(name);
      if (name === "expanded") actions.push("Collapse");
    } else if (name === "expanded" && raw === false) {
      parts.push("expanded=false");
      actions.push("Expand");
    } else if (typeof raw === "string" || typeof raw === "number") {
      parts.push(`${name}=${raw}`);
    }
  }
  const level = propMap.get("level");
  if (typeof level === "number" && Number.isFinite(level)) {
    parts.push(`level=${level}`);
  }
  return {
    states: parts.length ? `[${parts.join(" ")}]` : "",
    actions,
  };
}

/**
 * Strip the leading numeric index from a rendered AX line for structural comparison.
 * @param {string} line
 * @returns {string}
 */
function bodyOfLine(line) {
  return line.replace(/^(\s*)\d+\s+/u, "$1");
}

/**
 * Build a compact, indexed accessibility snapshot from CDP AX nodes.
 * Preserves backwards compatibility with the original v3 snapshot format while
 * pruning redundant StaticText children and emitting stable node keys for diffing.
 * @param {Array<Record<string, any>>} nodes
 * @param {{maxLines?:number, maxTextLength?:number, startIndex?:number, baseDepth?:number, frameId?:string|null, sessionId?:string|null}} [options]
 * @returns {{lines:string[], index:Map<string,{backendDOMNodeId:number|null, role:string, name:string, frameId:string|null, sessionId:string|null, actions:string[], dialogControl?:string}>, entries:Array<{idx:number, key:string, line:string, body:string, role:string, name:string, depth:number, frameId:string|null}>, count:number, nextIndex:number, truncated:boolean}}
 */
function buildAxTreeGraph(nodes) {
  const byId = new Map();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node && typeof node.nodeId === "string") byId.set(node.nodeId, node);
  }
  /** @type {Map<string, Array<Record<string, any>>>} */
  const children = new Map();
  /** @type {Array<Record<string, any>>} */
  const roots = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node || typeof node.nodeId !== "string") continue;
    const parent = typeof node.parentId === "string" ? byId.get(node.parentId) : undefined;
    if (parent) {
      const list = children.get(parent.nodeId) ?? [];
      list.push(node);
      children.set(parent.nodeId, list);
    } else {
      roots.push(node);
    }
  }
  return { byId, children, roots };
}

export function buildAxState(nodes, {
  maxLines = 2_000,
  maxTextLength = 240,
  startIndex = 0,
  baseDepth = 0,
  frameId = null,
  sessionId = null,
} = {}) {
  const { byId, children, roots } = buildAxTreeGraph(nodes);

  const lines = [];
  const entries = [];
  const index = new Map();
  let next = startIndex;
  let truncated = false;

  /**
   * @param {Record<string, any>} node
   * @param {number} depth
   * @param {{role:string, name:string}|null} ancestor
   */
  const visit = (node, depth, ancestor) => {
    if (truncated) return;
    const role = node.role?.value ?? "unknown";
    const name = truncateText(normalizeText(node.name?.value), maxTextLength);
    const value = truncateText(normalizeText(node.value?.value), maxTextLength);
    const transparent = node.ignored === true || role === "none" || role === "LineBreak" ||
      role === "InlineTextBox" || role === "generic";

    // Prune StaticText nodes whose text duplicates their interactive/heading ancestor's accessible name.
    if (!transparent && role === "StaticText" && ancestor &&
        TEXT_PRUNABLE_PARENT_ROLES.has(ancestor.role) && ancestor.name &&
        (name === ancestor.name || ancestor.name.includes(name))) {
      return;
    }

    let nextAncestor = ancestor;
    if (!transparent) {
      if (lines.length >= maxLines) {
        truncated = true;
        return;
      }
      const idx = next++;
      const propMap = readPropertyMap(node.properties);
      const { states, actions } = formatNodeStates(propMap);
      const backendDOMNodeId = Number.isSafeInteger(node.backendDOMNodeId) ? node.backendDOMNodeId : null;
      if (backendDOMNodeId !== null) {
        index.set(String(idx), {
          backendDOMNodeId,
          role,
          name,
          frameId,
          sessionId,
          actions,
        });
      }
      let line = `${"  ".repeat(depth)}${idx} ${role}`;
      if (name) line += ` "${name}"`;
      if (value) line += ` (value: "${value}")`;
      if (role === "link") {
        const url = normalizeText(propMap.get("url"));
        if (url && !/^javascript:/iu.test(url)) {
          line += ` (url: "${truncateText(url, 120)}")`;
        }
      }
      const placeholder = normalizeText(propMap.get("placeholder"));
      if (placeholder && placeholder !== name && placeholder !== value) {
        line += ` (placeholder: "${truncateText(placeholder, 80)}")`;
      }
      if (states) line += ` ${states}`;
      const body = bodyOfLine(line);
      const scope = frameId ?? "main";
      const key = backendDOMNodeId !== null
        ? `${scope}:node:${backendDOMNodeId}:${role}`
        : `${scope}:pos:${depth}:${role}:${name}`;
      lines.push(line);
      entries.push({ idx, key, line, body, role, name, depth, frameId });
      nextAncestor = { role, name };
    }

    const childDepth = transparent ? depth : depth + 1;
    const ordered = Array.isArray(node.childIds) && node.childIds.length > 0
      ? node.childIds.map((id) => byId.get(id)).filter(Boolean)
      : children.get(node.nodeId) ?? [];
    for (const child of ordered) visit(child, childDepth, nextAncestor);
  };

  for (const root of roots) visit(root, baseDepth, null);
  return {
    lines,
    index,
    entries,
    count: next - startIndex,
    nextIndex: next,
    truncated,
  };
}

/**
 * Merge main-frame and child-iframe AX node lists into one sequentially indexed tree.
 * @param {Array<{nodes:Array<Record<string, any>>, frameId:string|null, sessionId:string|null, url?:string, depth?:number}>} frames
 * @param {{maxLines?:number, maxTextLength?:number}} [options]
 */
export function mergeFrameAxStates(frames, { maxLines = 2_000, maxTextLength = 240 } = {}) {
  const lines = [];
  const entries = [];
  const index = new Map();
  let nextIndex = 0;
  let truncated = false;

  for (let i = 0; i < frames.length; i++) {
    const remaining = maxLines - lines.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const frame = frames[i];
    const isChild = i > 0;
    const baseDepth = isChild ? Math.max(1, frame.depth ?? 1) : 0;
    const snapshot = buildAxState(frame.nodes, {
      maxLines: isChild ? Math.max(0, remaining - 1) : remaining,
      maxTextLength,
      startIndex: nextIndex,
      baseDepth,
      frameId: frame.frameId ?? null,
      sessionId: frame.sessionId ?? null,
    });
    if (isChild && snapshot.lines.length > 0) {
      const urlHint = frame.url ? ` (${truncateText(normalizeText(frame.url), 100)})` : "";
      lines.push(`${"  ".repeat(Math.max(0, baseDepth - 1))}[iframe ${frame.frameId ?? i}${urlHint}]`);
    }
    lines.push(...snapshot.lines);
    entries.push(...snapshot.entries);
    for (const [k, v] of snapshot.index) index.set(k, v);
    nextIndex = snapshot.nextIndex;
    if (snapshot.truncated) {
      truncated = true;
      break;
    }
  }

  return {
    lines,
    index,
    entries,
    count: nextIndex,
    truncated,
  };
}

/**
 * Compute a compact structural diff between two AX snapshots of the same document.
 * Falls back to full mode when the page changed documentKey or rewrote >65% of nodes.
 * @param {{documentKey?:string, entries:Array<{idx:number, key:string, line:string, body:string}>}|null|undefined} previous
 * @param {{documentKey?:string, lines:string[], entries:Array<{idx:number, key:string, line:string, body:string}>}} current
 * @returns {{mode:"unchanged"|"diff"|"full", lines:string[], added:number, changed:number, removed:number}}
 */
export function buildAxDiff(previous, current) {
  if (!previous || (previous.documentKey && current.documentKey && previous.documentKey !== current.documentKey)) {
    return { mode: "full", lines: current.lines, added: current.entries.length, changed: 0, removed: 0 };
  }

  const prevByKey = new Map();
  for (const entry of previous.entries) prevByKey.set(entry.key, entry);
  const currByKey = new Map();
  for (const entry of current.entries) currByKey.set(entry.key, entry);

  const changed = [];
  const added = [];
  let removed = 0;

  for (const entry of current.entries) {
    const prev = prevByKey.get(entry.key);
    if (!prev) {
      added.push(entry.line.trimStart());
    } else if (prev.body !== entry.body) {
      changed.push(entry.line.trimStart());
    }
  }
  for (const entry of previous.entries) {
    if (!currByKey.has(entry.key)) removed += 1;
  }

  if (added.length === 0 && changed.length === 0 && removed === 0) {
    return {
      mode: "unchanged",
      lines: ["No accessibility changes since last snapshot. Existing element indices remain valid."],
      added: 0,
      changed: 0,
      removed: 0,
    };
  }

  const total = Math.max(1, current.entries.length);
  if (added.length + changed.length > Math.ceil(total * 0.65)) {
    return {
      mode: "full",
      lines: current.lines,
      added: added.length,
      changed: changed.length,
      removed,
    };
  }

  const lines = [
    `[diff summary: +${added.length} added, ~${changed.length} changed, -${removed} removed; element indices updated to current tree]`,
  ];
  if (changed.length > 0) {
    lines.push("[changed]");
    for (const item of changed) lines.push(`  ~ ${item}`);
  }
  if (added.length > 0) {
    lines.push("[added]");
    for (const item of added) lines.push(`  + ${item}`);
  }
  return {
    mode: "diff",
    lines,
    added: added.length,
    changed: changed.length,
    removed,
  };
}

/**
 * Render an open JavaScript dialog as an actionable AX tree so inspection never hangs.
 * @param {{type:string, message?:string, defaultPrompt?:string, url?:string}} dialog
 * @param {{tab_id:string, title?:string, url?:string}} tabMeta
 */
export function buildDialogAxState(dialog, tabMeta) {
  const type = dialog.type || "alert";
  const message = normalizeText(dialog.message || "");
  const index = new Map();
  const lines = [
    `0 alertdialog "JavaScript ${type} dialog"`,
    `  1 StaticText "${truncateText(message, 400)}"`,
  ];
  let nextIdx = 2;

  if (type === "prompt") {
    const idx = nextIdx++;
    const promptVal = normalizeText(dialog.defaultPrompt ?? "");
    index.set(String(idx), {
      backendDOMNodeId: null,
      role: "textbox",
      name: "Prompt input",
      frameId: null,
      sessionId: null,
      actions: [],
      dialogControl: "prompt",
    });
    lines.push(`  ${idx} textbox "Prompt input"${promptVal ? ` (value: "${promptVal}")` : ""}`);
  }

  if (type === "confirm" || type === "prompt" || type === "beforeunload") {
    const okIdx = nextIdx++;
    index.set(String(okIdx), {
      backendDOMNodeId: null,
      role: "button",
      name: "OK",
      frameId: null,
      sessionId: null,
      actions: [],
      dialogControl: "accept",
    });
    lines.push(`  ${okIdx} button "OK"`);
  }

  const dismissIdx = nextIdx++;
  const dismissLabel = type === "alert" ? "OK" : "Cancel";
  index.set(String(dismissIdx), {
    backendDOMNodeId: null,
    role: "button",
    name: dismissLabel,
    frameId: null,
    sessionId: null,
    actions: [],
    dialogControl: type === "alert" ? "accept" : "dismiss",
  });
  lines.push(`  ${dismissIdx} button "${dismissLabel}"`);

  const title = tabMeta.title || "";
  const url = tabMeta.url || dialog.url || "";
  const axText = [
    `Title: ${title}`,
    `URL: ${url}`,
    "<ax_state>",
    ...lines,
    "</ax_state>",
  ].join("\n");

  return {
    tab_id: tabMeta.tab_id,
    title,
    url,
    axText,
    lines,
    entries: lines.map((line, i) => ({
      idx: i,
      key: `dialog:${i}`,
      line,
      body: bodyOfLine(line),
      role: "dialog",
      name: type,
      depth: i === 0 ? 0 : 1,
      frameId: null,
    })),
    index,
    elementCount: lines.length,
    dialog: { type, message },
    screenshotBase64: null,
  };
}

/**
 * Format CDP AX nodes into a compact, Playwright-style YAML ARIA tree
 * ideal for 1-line `.split('\n').filter(...)` queries without index clutter.
 * @param {Array<Record<string, any>>} nodes
 * @param {{maxLines?:number, maxTextLength?:number, baseDepth?:number}} [options]
 * @returns {{text:string, lineCount:number, truncated:boolean}}
 */
export function formatAriaSnapshot(nodes, { maxLines = 2_000, maxTextLength = 240, baseDepth = 0 } = {}) {
  const { byId, children, roots } = buildAxTreeGraph(nodes);
  const lines = [];
  let truncated = false;

  const formatYamlBadges = (propMap) => {
    const badges = [];
    const checked = propMap.get("checked");
    if (checked === true) badges.push("[checked]");
    else if (typeof checked === "string" && checked !== "false") badges.push(`[checked=${checked}]`);
    if (propMap.get("selected") === true) badges.push("[selected]");
    if (propMap.get("focused") === true) badges.push("[active]");
    if (propMap.get("disabled") === true) badges.push("[disabled]");
    if (propMap.get("expanded") === true) badges.push("[expanded]");
    const pressed = propMap.get("pressed");
    if (pressed === true) badges.push("[pressed]");
    else if (typeof pressed === "string" && pressed !== "false") badges.push(`[pressed=${pressed}]`);
    if (propMap.get("required") === true) badges.push("[required]");
    const level = propMap.get("level");
    if (typeof level === "number" && Number.isFinite(level)) badges.push(`[level=${level}]`);
    return badges.length ? ` ${badges.join(" ")}` : "";
  };

  /**
   * @param {Record<string, any>} node
   * @param {number} depth
   * @param {{role:string, name:string}|null} ancestor
   */
  const visit = (node, depth, ancestor) => {
    if (truncated) return;
    const role = node.role?.value ?? "unknown";
    const name = truncateText(normalizeText(node.name?.value), maxTextLength);
    const value = truncateText(normalizeText(node.value?.value), maxTextLength);
    const transparent = node.ignored === true || role === "none" || role === "LineBreak" ||
      role === "InlineTextBox" || role === "RootWebArea" ||
      (role === "generic" && !name && !value);

    if (!transparent && role === "StaticText" && ancestor &&
        TEXT_PRUNABLE_PARENT_ROLES.has(ancestor.role) && ancestor.name &&
        (name === ancestor.name || ancestor.name.includes(name))) {
      return;
    }

    let nextAncestor = ancestor;
    if (!transparent) {
      if (lines.length >= maxLines) {
        truncated = true;
        return;
      }
      const indent = "  ".repeat(baseDepth + depth);
      if (role === "StaticText") {
        if (name) lines.push(`${indent}- text: ${name}`);
      } else {
        const propMap = readPropertyMap(node.properties);
        const badges = formatYamlBadges(propMap);
        let line = `${indent}- ${role}`;
        if (name) line += ` "${name.replaceAll('"', '\\"')}"`;
        line += badges;
        if (value && value !== name) line += `: ${value}`;
        lines.push(line);

        if (role === "link") {
          const url = normalizeText(propMap.get("url"));
          if (url && !/^javascript:/iu.test(url) && lines.length < maxLines) {
            lines.push(`${indent}  - /url: ${truncateText(url, 160)}`);
          }
        }
      }
      nextAncestor = { role, name };
    }

    const childDepth = transparent ? depth : depth + 1;
    const ordered = Array.isArray(node.childIds) && node.childIds.length > 0
      ? node.childIds.map((id) => byId.get(id)).filter(Boolean)
      : children.get(node.nodeId) ?? [];
    for (const child of ordered) visit(child, childDepth, nextAncestor);
  };

  for (const root of roots) visit(root, 0, null);
  return {
    text: lines.join("\n"),
    lineCount: lines.length,
    truncated,
  };
}

/**
 * Merge main-frame and child-iframe ARIA snapshots into one clean indented YAML tree.
 * @param {Array<{nodes:Array<Record<string, any>>, frameId:string|null, url?:string, depth?:number}>} frames
 * @param {{maxLines?:number, maxTextLength?:number}} [options]
 * @returns {{text:string, lineCount:number, truncated:boolean}}
 */
export function mergeFrameAriaSnapshots(frames, { maxLines = 2_000, maxTextLength = 240 } = {}) {
  const lines = [];
  let truncated = false;

  for (let i = 0; i < frames.length; i++) {
    const remaining = maxLines - lines.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const frame = frames[i];
    const isChild = i > 0;
    const baseDepth = isChild ? Math.max(1, frame.depth ?? 1) : 0;
    const snapshot = formatAriaSnapshot(frame.nodes ?? [], {
      maxLines: isChild ? Math.max(0, remaining - 1) : remaining,
      maxTextLength,
      baseDepth,
    });
    if (!snapshot.text) continue;
    const frameLines = snapshot.text.split("\n");
    if (isChild && frameLines.length > 0) {
      const urlHint = frame.url ? ` (${truncateText(normalizeText(frame.url), 100)})` : "";
      lines.push(`${"  ".repeat(Math.max(0, baseDepth - 1))}[iframe ${frame.frameId ?? i}${urlHint}]`);
    }
    lines.push(...frameLines);
    if (snapshot.truncated) {
      truncated = true;
      break;
    }
  }

  return {
    text: lines.join("\n"),
    lineCount: lines.length,
    truncated,
  };
}
