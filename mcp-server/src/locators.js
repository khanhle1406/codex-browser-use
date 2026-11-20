/**
 * Pure JavaScript expression and function builders evaluated inside target pages
 * and frames via CDP Runtime.evaluate / Runtime.callFunctionOn.
 *
 * Clean-room implementation supporting open Shadow DOM piercing, chained locators,
 * same-origin iframe traversal, viewport-clamped hit-testing, semantic value setting,
 * coordinate element inspection, and compact DOM snapshots.
 */

const SHARED_DOM_HELPERS = `
  const INTERACTIVE_SELECTOR = [
    "button", "a[href]", "input", "select", "textarea", "summary",
    '[role="button"]', '[role="checkbox"]', '[role="combobox"]', '[role="link"]',
    '[role="listbox"]', '[role="menuitem"]', '[role="option"]', '[role="radio"]',
    '[role="slider"]', '[role="spinbutton"]', '[role="switch"]', '[role="tab"]',
    '[role="textbox"]', '[tabindex]:not([tabindex="-1"])'
  ].join(",");

  const isVisibleEl = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const win = el.ownerDocument?.defaultView || window;
    const style = win.getComputedStyle(el);
    if (!style || style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const deepElements = (root) => {
    const out = [];
    const stack = [root];
    const seen = new Set();
    while (stack.length > 0) {
      const cur = stack.pop();
      if (!cur || seen.has(cur)) continue;
      seen.add(cur);
      if (cur.nodeType === 1) {
        out.push(cur);
        if (cur.shadowRoot) stack.push(cur.shadowRoot);
      }
      const children = cur.children || (cur.documentElement ? [cur.documentElement] : null);
      if (children) {
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
      } else if (cur.childNodes) {
        for (let i = cur.childNodes.length - 1; i >= 0; i--) {
          if (cur.childNodes[i].nodeType === 1) stack.push(cur.childNodes[i]);
        }
      }
    }
    return out;
  };

  const querySelectorAllDeep = (root, css) => {
    const matches = [];
    const seen = new Set();
    const visitRoot = (scope) => {
      try {
        for (const el of scope.querySelectorAll(css)) {
          if (!seen.has(el)) { seen.add(el); matches.push(el); }
        }
      } catch (err) {
        if (scope === root) throw err;
      }
      for (const el of deepElements(scope)) {
        if (el.shadowRoot && !seen.has(el.shadowRoot)) {
          seen.add(el.shadowRoot);
          visitRoot(el.shadowRoot);
        }
      }
    };
    visitRoot(root);
    return matches;
  };

  const implicitRoleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.trim().toLowerCase().split(/\\s+/)[0];
    const tag = el.tagName.toLowerCase();
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "area" && el.hasAttribute("href")) return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return el.multiple || Number(el.size) > 1 ? "listbox" : "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "option") return "option";
    if (tag === "img") return "img";
    if (tag === "nav") return "navigation";
    if (tag === "main") return "main";
    if (tag === "header") return "banner";
    if (tag === "footer") return "contentinfo";
    if (tag === "aside") return "complementary";
    if (tag === "form") return "form";
    if (tag === "dialog") return "dialog";
    if (tag === "ul" || tag === "ol") return "list";
    if (tag === "li") return "listitem";
    if (tag === "table") return "table";
    if (tag === "tr") return "row";
    if (tag === "th") return "columnheader";
    if (tag === "td") return "cell";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      if (type === "search") return "searchbox";
      if (type === "hidden") return "";
      return "textbox";
    }
    return "";
  };

  const labelTextFor = (el) => {
    const doc = el.ownerDocument || document;
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy.split(/\\s+/).map((id) => doc.getElementById(id)?.innerText || doc.getElementById(id)?.textContent || "").join(" ").replace(/\\s+/g, " ").trim();
      if (text) return text;
    }
    if (el.labels && el.labels.length > 0) {
      const text = Array.from(el.labels).map((l) => l.innerText || l.textContent || "").join(" ").replace(/\\s+/g, " ").trim();
      if (text) return text;
    }
    const parentLabel = el.closest("label");
    if (parentLabel) {
      const text = (parentLabel.innerText || parentLabel.textContent || "").replace(/\\s+/g, " ").trim();
      if (text) return text;
    }
    return "";
  };

  const accessibleNameOf = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    const lbl = labelTextFor(el);
    if (lbl) return lbl;
    const tag = el.tagName.toLowerCase();
    if (tag === "input" && ["button", "submit", "reset"].includes((el.type || "").toLowerCase())) {
      if (el.value) return el.value.trim();
    }
    const text = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
    if (text) return text;
    return (el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || el.value || "").trim();
  };

  const elementFromPointDeep = (doc, x, y) => {
    let hit = doc.elementFromPoint(x, y);
    while (hit && hit.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  };

  const tryFillRichEditor = (el, assigned, inputType = "insertText") => {
    if (!el) return false;
    const win = el.ownerDocument?.defaultView || window;
    try {
      const cke = win?.CKEDITOR?.instances;
      if (cke && typeof cke === "object") {
        const ckeRoot = el.closest?.(".cke");
        for (const inst of Object.values(cke)) {
          if (inst && (inst.element?.$ === el || (el.id && inst.name === el.id) || (el.name && inst.name === el.name) || (ckeRoot && inst.container?.$ === ckeRoot))) {
            inst.setData?.(assigned);
            inst.updateElement?.();
            return true;
          }
        }
      }
    } catch (_e) {}
    try {
      const ck5 = el.ckeditorInstance || el.closest?.(".ck-editor__editable")?.ckeditorInstance;
      if (ck5 && typeof ck5.setData === "function") {
        ck5.setData(assigned);
        return true;
      }
    } catch (_e) {}
    try {
      const tiny = el.id ? win?.tinymce?.get?.(el.id) : null;
      if (tiny && typeof tiny.setContent === "function") {
        tiny.setContent(assigned);
        tiny.save?.();
        return true;
      }
    } catch (_e) {}
    try {
      const quill = el.__quill || el.closest?.(".ql-container")?.__quill;
      if (quill && typeof quill.setText === "function") {
        quill.setText(assigned);
        return true;
      }
    } catch (_e) {}
    if (el.isContentEditable) {
      el.focus?.();
      el.textContent = assigned;
      el.dispatchEvent?.(typeof InputEvent === "function"
        ? new InputEvent("input", { bubbles: true, composed: true, data: assigned, inputType })
        : new Event("input", { bubbles: true, composed: true }));
      el.dispatchEvent?.(new Event("change", { bubbles: true }));
      return true;
    }
    return false;
  };
`;

const SHARED_LOCATOR_RESOLVER = `
  const parseRegexLiteral = (token) => {
    const t = String(token || "").trim();
    if (!t.startsWith("/")) return null;
    const lastSlash = t.lastIndexOf("/");
    if (lastSlash <= 0) return null;
    const flags = t.slice(lastSlash + 1);
    if (!/^[dgimsuvy]*$/.test(flags)) return null;
    return new RegExp(t.slice(1, lastSlash), flags);
  };

  const splitPipeline = (input) => {
    const parts = [];
    let cur = "";
    let quote = null;
    let escaped = false;
    let parenDepth = 0;
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (escaped) {
        cur += ch;
        escaped = false;
        continue;
      }
      if (quote) {
        cur += ch;
        if (ch === "\\\\") escaped = true;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        cur += ch;
        continue;
      }
      if (ch === "(") {
        parenDepth++;
        cur += ch;
        continue;
      }
      if (ch === ")" && parenDepth > 0) {
        parenDepth--;
        cur += ch;
        continue;
      }
      if (parenDepth === 0 && ch === ">" && input[i + 1] === ">") {
        parts.push(cur.trim());
        cur = "";
        i++;
        continue;
      }
      cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts.filter(Boolean);
  };

  const unquote = (s) => {
    const t = s.trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      return t.slice(1, -1);
    }
    return t;
  };

  const querySingle = (scope, step) => {
    if (step.startsWith("text=")) {
      const rawText = step.slice(5).trim();
      const regex = parseRegexLiteral(rawText);
      const exact = !regex && ((rawText.startsWith('"') && rawText.endsWith('"')) || (rawText.startsWith("'") && rawText.endsWith("'")));
      const target = regex ? null : unquote(rawText);
      const matchesText = (val) => regex ? regex.test(val) : (exact ? val === target : val.includes(target));
      const all = deepElements(scope).filter((el) => {
        const val = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
        return matchesText(val);
      });
      return all.filter((el) => !Array.from(el.children || []).some((child) => {
        const val = (child.innerText || child.textContent || "").replace(/\\s+/g, " ").trim();
        return matchesText(val);
      }));
    }
    if (step.startsWith("role=")) {
      const match = /^role=([a-zA-Z0-9_-]+)(?:\\[name=(?:"([^"]*)"|'([^']*)'|(\\/(?:\\\\.|[^/])+\\/[dgimsuvy]*))\\])?(?:\\[exact=(true|false)\\])?$/.exec(step);
      if (!match) throw new Error("Invalid role locator: " + step);
      const role = match[1].toLowerCase();
      const nameRegex = match[4] ? parseRegexLiteral(match[4]) : null;
      const name = nameRegex ? null : (match[2] !== undefined ? match[2] : match[3]);
      const exact = match[5] !== "false";
      return deepElements(scope).filter((el) => {
        if (implicitRoleOf(el) !== role) return false;
        if (nameRegex) return nameRegex.test(accessibleNameOf(el));
        if (name === undefined) return true;
        const actual = accessibleNameOf(el);
        return exact ? actual === name : actual.toLowerCase().includes(name.toLowerCase());
      });
    }
    if (step.startsWith("testid=")) {
      const id = unquote(step.slice(7));
      const escaped = CSS.escape(id);
      return querySelectorAllDeep(scope, '[data-testid="' + escaped + '"],[data-test-id="' + escaped + '"],[data-test="' + escaped + '"]');
    }
    if (step.startsWith("label=")) {
      const wanted = unquote(step.slice(6));
      return deepElements(scope).filter((el) => labelTextFor(el) === wanted || (el.getAttribute("aria-label") || "").trim() === wanted);
    }
    if (step.startsWith("placeholder=")) {
      const wanted = unquote(step.slice(12));
      return querySelectorAllDeep(scope, '[placeholder="' + CSS.escape(wanted) + '"]');
    }
    return querySelectorAllDeep(scope, step.startsWith("css=") ? step.slice(4) : step);
  };

  const resolvePipeline = (rootScope, expr) => {
    const steps = splitPipeline(expr);
    if (steps.length === 0) throw new Error("Empty locator");
    let current = [rootScope];
    let initialized = false;
    for (const step of steps) {
      if (step === "first") {
        current = current.length ? [current[0]] : [];
        initialized = true;
        continue;
      }
      if (step === "last") {
        current = current.length ? [current[current.length - 1]] : [];
        initialized = true;
        continue;
      }
      if (/^nth=(-?\\d+)$/.test(step)) {
        const idx = Number(RegExp.$1);
        const resolved = idx < 0 ? current[current.length + idx] : current[idx];
        current = resolved ? [resolved] : [];
        initialized = true;
        continue;
      }
      if (step === "visible=true" || step === "visible=false") {
        const want = step === "visible=true";
        const base = initialized ? current : deepElements(rootScope);
        current = base.filter((el) => isVisibleEl(el) === want);
        initialized = true;
        continue;
      }
      if (step.startsWith("has-text=")) {
        const rawNeedle = step.slice(9).trim();
        const needleRe = parseRegexLiteral(rawNeedle);
        const needle = needleRe ? null : unquote(rawNeedle);
        const base = initialized ? current : deepElements(rootScope);
        current = base.filter((el) => {
          const txt = el.innerText || el.textContent || "";
          return needleRe ? needleRe.test(txt) : txt.includes(needle);
        });
        initialized = true;
        continue;
      }
      if (step.startsWith("has-not-text=")) {
        const rawNeedle = step.slice(13).trim();
        const needleRe = parseRegexLiteral(rawNeedle);
        const needle = needleRe ? null : unquote(rawNeedle);
        const base = initialized ? current : deepElements(rootScope);
        current = base.filter((el) => {
          const txt = el.innerText || el.textContent || "";
          return !(needleRe ? needleRe.test(txt) : txt.includes(needle));
        });
        initialized = true;
        continue;
      }
      if ((step.startsWith("has=(") || step.startsWith("has-not=(")) && step.endsWith(")")) {
        const negate = step.startsWith("has-not=(");
        const sub = step.slice(negate ? 9 : 5, -1);
        const base = initialized ? current : deepElements(rootScope);
        current = base.filter((el) => {
          const matched = resolvePipeline(el, sub).length > 0;
          return negate ? !matched : matched;
        });
        initialized = true;
        continue;
      }
      if (step.startsWith("and=(") && step.endsWith(")")) {
        const sub = step.slice(5, -1);
        const other = resolvePipeline(rootScope, sub);
        if (!initialized) {
          current = other;
        } else {
          const otherSet = new Set(other);
          current = current.filter((el) => otherSet.has(el));
        }
        initialized = true;
        continue;
      }
      if (step.startsWith("or=(") && step.endsWith(")")) {
        const sub = step.slice(4, -1);
        const extra = resolvePipeline(rootScope, sub);
        if (!initialized) {
          current = extra;
        } else {
          const seen = new Set(current);
          const combined = [...current];
          for (const el of extra) {
            if (!seen.has(el)) { seen.add(el); combined.push(el); }
          }
          if (combined.length > 1) {
            const order = deepElements(rootScope);
            const rank = new Map();
            for (let k = 0; k < order.length; k++) rank.set(order[k], k);
            combined.sort((a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9));
          }
          current = combined;
        }
        initialized = true;
        continue;
      }
      const next = [];
      const seen = new Set();
      const scopes = initialized ? current : [rootScope];
      for (const sc of scopes) {
        for (const found of querySingle(sc, step)) {
          if (!seen.has(found)) { seen.add(found); next.push(found); }
        }
      }
      current = next;
      initialized = true;
    }
    return current;
  };

  const resolveSameOriginTargetRoot = (sameOriginFrames) => {
    let doc = document;
    if (Array.isArray(sameOriginFrames) && sameOriginFrames.length > 0) {
      for (const frameSel of sameOriginFrames) {
        const matchedFrames = resolvePipeline(doc, frameSel);
        if (matchedFrames.length === 0) return { error: "Iframe did not match: " + frameSel, code: "not_found", retryable: true };
        if (matchedFrames.length > 1) return { error: "Iframe matched " + matchedFrames.length + " elements: " + frameSel, code: "multiple", retryable: false };
        const frameEl = matchedFrames[0];
        if (!frameEl.contentDocument) return { error: "Iframe is cross-origin or has no accessible document: " + frameSel, code: "invalid", retryable: false };
        doc = frameEl.contentDocument;
      }
    }
    return { root: doc };
  };
`;

export const LOCATOR_RUNTIME_VERSION = 1;

const SHARED_RUNNER_CORE = `
  const isDisabledEl = (el) => !!(el.matches?.(":disabled") || el.getAttribute?.("aria-disabled") === "true");
  const cursorPt = (el) => {
    if (!el || typeof el.getBoundingClientRect !== "function") return {};
    const r = el.getBoundingClientRect();
    return r && r.width > 0 && r.height > 0
      ? { x: r.left + r.width / 2, y: r.top + r.height / 2, __cursorMove: true }
      : {};
  };
  const fail = (message, code = "error", retryable = false) => ({ error: message, code, retryable });

  const describeCandidate = (el) => {
    const tag = el.tagName.toLowerCase();
    const role = implicitRoleOf(el);
    const ariaName = accessibleNameOf(el);
    const testId = el.getAttribute?.("data-testid") || el.getAttribute?.("data-test-id") || el.getAttribute?.("data-test");
    if (testId) return "testid=" + JSON.stringify(testId);
    if (role && ariaName && ariaName.length <= 50) return "role=" + role + "[name=" + JSON.stringify(ariaName) + "]";
    if (el.id && !/^\\d|:/.test(el.id)) return "css=#" + CSS.escape(el.id);
    const txt = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
    if (txt && txt.length <= 45) return "text=" + JSON.stringify(txt);
    const nameAttr = el.getAttribute?.("name");
    return "css=" + tag + (nameAttr ? "[name=" + JSON.stringify(nameAttr) + "]" : "");
  };

  const suggestLocatorCandidates = (raw, limit = 4) => {
    const rawStr = String(raw || "");
    const stop = new Set(["role", "name", "css", "text", "exact", "true", "false", "first", "last", "button", "link", "textbox", "testid", "label", "placeholder"]);
    const words = rawStr.toLowerCase().split(/[^a-z0-9]+/i).filter((w) => w.length >= 2 && !stop.has(w));
    let candidates = [];
    try {
      candidates = querySelectorAllDeep(document, INTERACTIVE_SELECTOR);
    } catch (_e) {
      return [];
    }
    const scored = [];
    const seen = new Set();
    for (const el of candidates) {
      if (!isVisibleEl(el)) continue;
      const role = implicitRoleOf(el);
      const name = accessibleNameOf(el);
      const hay = (role + " " + name + " " + (el.id || "") + " " + (el.getAttribute?.("data-testid") || "") + " " + (el.getAttribute?.("name") || "")).toLowerCase();
      let score = 0;
      for (const w of words) {
        if (hay.includes(w)) score += 3;
      }
      if (rawStr.toLowerCase().includes("role=" + role)) score += 1;
      if (words.length === 0 || score > 0) {
        const desc = describeCandidate(el);
        if (!seen.has(desc)) {
          seen.add(desc);
          scored.push({ score, desc });
        }
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.desc);
  };

  const runLocatorAction = (raw, opts = {}, __userFn = null) => {
    const mutation = opts.mutation ?? null;
    const nextValue = opts.value ?? null;
    const selectSpec = opts.select ?? null;
    const waitState = opts.state ?? "visible";
    const sameOriginFrames = opts.sameOriginFrames ?? null;
    const crossOriginDirect = Boolean(opts.crossOriginDirect);
    const force = Boolean(opts.force);
    const attrName = opts.attrName ?? null;
    const hasEvalArg = Boolean(opts.hasEvalArg);
    const __evalArg = opts.evalArg;
    const asyncEval = Boolean(opts.asyncEval);
    const waitMs = Math.max(0, Math.round(Number(opts.inPageWaitMs) || 0));

    const runOnce = () => {
      let targetRoot = document;
      try {
        const resolvedFrame = resolveSameOriginTargetRoot(sameOriginFrames);
        if (resolvedFrame.error) return fail(resolvedFrame.error, resolvedFrame.code, resolvedFrame.retryable);
        targetRoot = resolvedFrame.root;
      } catch (error) {
        return fail("Invalid frame locator: " + error.message, "invalid", false);
      }

      let nodes;
      try {
        nodes = resolvePipeline(targetRoot, raw);
      } catch (error) {
        return fail("Invalid locator: " + error.message, "invalid", false);
      }

      if (mutation === "count") return { count: nodes.length };
      if (mutation === "evalAll") {
        if (typeof __userFn !== "function") return fail("Missing evaluation function", "invalid", false);
        const out = hasEvalArg ? __userFn(nodes, __evalArg) : __userFn(nodes);
        if (asyncEval || (out && typeof out.then === "function")) {
          return Promise.resolve(out).then((value) => ({ count: nodes.length, value }));
        }
        return { count: nodes.length, value: out };
      }
      if (mutation === "allTextContents") {
        return { count: nodes.length, values: nodes.map((el) => el.textContent || "") };
      }
      if (mutation === "allInnerTexts") {
        return { count: nodes.length, values: nodes.map((el) => (el.innerText || "").trim()) };
      }
      if (mutation === "isVisible") {
        return { value: nodes.length > 0 && isVisibleEl(nodes[0]) };
      }
      if (mutation === "isEnabled") {
        return { value: nodes.length > 0 && !isDisabledEl(nodes[0]) };
      }
      if (mutation === "isChecked") {
        const el = nodes[0];
        const checked = el
          ? (el instanceof HTMLInputElement ? !!el.checked : el.getAttribute?.("aria-checked") === "true")
          : false;
        return { value: checked };
      }
      if (mutation === "wait") {
        if (waitState === "detached") return { count: nodes.length, satisfied: nodes.length === 0 };
        if (waitState === "attached") return { count: nodes.length, satisfied: nodes.length > 0 };
        const visibleCount = nodes.filter(isVisibleEl).length;
        if (waitState === "visible") return { count: nodes.length, visibleCount, satisfied: visibleCount > 0 };
        if (waitState === "hidden") return { count: nodes.length, visibleCount, satisfied: visibleCount === 0 };
        return fail("Unsupported wait state: " + waitState, "invalid", false);
      }

      if (nodes.length === 0) return fail("Locator did not match any element: " + raw, "not_found", true);
      if (nodes.length > 1) {
        const previews = nodes.slice(0, 3).map((el, i) => {
          const tag = el.tagName.toLowerCase();
          const text = (el.innerText || el.getAttribute("aria-label") || el.id || "").replace(/\\s+/g, " ").trim().slice(0, 40);
          return "#" + i + " <" + tag + (el.id ? "#" + el.id : "") + ">" + (text ? ' "' + text + '"' : "");
        }).join(", ");
        return fail("Locator matched " + nodes.length + " elements; narrow it (e.g. append >> first or >> nth=0): " + raw + " [" + previews + "]", "multiple", false);
      }

      const element = nodes[0];
      if (mutation === "eval") {
        if (typeof __userFn !== "function") return fail("Missing evaluation function", "invalid", false);
        const out = hasEvalArg ? __userFn(element, __evalArg) : __userFn(element);
        if (asyncEval || (out && typeof out.then === "function")) {
          return Promise.resolve(out).then((value) => ({ count: 1, value }));
        }
        return { count: 1, value: out };
      }
      if (mutation === "attr") {
        if (!attrName) return fail("Attribute name is required", "invalid", false);
        return { count: 1, value: element.getAttribute(attrName) };
      }
      if (mutation === "inputValue") {
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) {
          return fail("Locator did not match an input, textarea, or select element: " + raw, "invalid", false);
        }
        return { count: 1, value: element.value ?? "" };
      }
      if (mutation === "text") {
        return { count: 1, text: (element.innerText || element.textContent || "").trim() };
      }
      if (mutation === "textContent") {
        return { count: 1, text: element.textContent };
      }
      if (mutation === "innerText") {
        return { count: 1, text: (element.innerText || "").trim() };
      }
      if (mutation === "focus") {
        if (!force && !isVisibleEl(element)) return fail("Locator matched a hidden element: " + raw, "not_visible", true);
        element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        element.focus();
        return { count: 1, focused: true, ...cursorPt(element) };
      }
      if (mutation === "check" || mutation === "uncheck") {
        if (!force && !isVisibleEl(element)) return fail("Locator matched a hidden element: " + raw, "not_visible", true);
        if (!force && isDisabledEl(element)) return fail("Element is disabled: " + raw, "disabled", true);
        const want = mutation === "check";
        const isChecked = element instanceof HTMLInputElement
          ? !!element.checked
          : element.getAttribute("aria-checked") === "true";
        if (isChecked === want) {
          return { count: 1, changed: false, checked: isChecked, ...cursorPt(element) };
        }
        if (crossOriginDirect) {
          element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
          element.click();
          return { count: 1, changed: true, clicked: true, checked: want, ...cursorPt(element) };
        }
      }
      if (mutation === "click") {
        if (!force && !isVisibleEl(element)) return fail("Locator matched a hidden element: " + raw, "not_visible", true);
        if (!force && isDisabledEl(element)) return fail("Element is disabled: " + raw, "disabled", true);
        element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        element.click();
        return { count: 1, clicked: true, ...cursorPt(element) };
      }
      if (mutation === "hover") {
        if (!force && !isVisibleEl(element)) return fail("Locator matched a hidden element: " + raw, "not_visible", true);
        element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return fail("Locator matched an element with no visible box: " + raw, "not_visible", true);
        return { count: 1, hovered: true, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, __cursorMove: true };
      }
      if (mutation === "fill" || mutation === "clear") {
        if (!force && !isVisibleEl(element)) return fail("Locator matched a hidden element: " + raw, "not_visible", true);
        if (!force && isDisabledEl(element)) return fail("Element is disabled: " + raw, "disabled", true);
        if ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && element.readOnly) {
          return fail("Element is read-only: " + raw, "readonly", false);
        }
        element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        const assigned = mutation === "clear" ? "" : String(nextValue ?? "");
        const inputType = mutation === "clear" ? "deleteContentBackward" : "insertText";
        if (tryFillRichEditor(element, assigned, inputType)) {
          return { count: 1, ...(mutation === "clear" ? { cleared: true } : { filled: true }), ...cursorPt(element) };
        }
        element.focus();
        const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
        if (descriptor?.set) descriptor.set.call(element, assigned); else element.value = assigned;
        element.dispatchEvent(typeof InputEvent === "function"
          ? new InputEvent("input", { bubbles: true, composed: true, data: assigned, inputType })
          : new Event("input", { bubbles: true, composed: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return { count: 1, ...(mutation === "clear" ? { cleared: true } : { filled: true }), ...cursorPt(element) };
      }
      if (mutation === "select") {
        if (!(element instanceof HTMLSelectElement)) return fail("Locator did not match a <select> element: " + raw, "invalid", false);
        if (!force && element.disabled) return fail("Select element is disabled: " + raw, "disabled", true);
        const wanted = Array.isArray(selectSpec) ? selectSpec : [selectSpec];
        const options = Array.from(element.options);
        const selected = [];
        for (const spec of wanted) {
          let opt = null;
          if (typeof spec === "string") {
            opt = options.find((o) => o.value === spec) || options.find((o) => o.label === spec || o.text.trim() === spec);
          } else if (spec && typeof spec === "object") {
            if (spec.index !== undefined) opt = options[spec.index];
            else if (spec.value !== undefined) opt = options.find((o) => o.value === spec.value);
            else if (spec.label !== undefined) opt = options.find((o) => o.label === spec.label || o.text.trim() === spec.label);
          }
          if (!opt) return fail("Select option not found: " + JSON.stringify(spec), "not_found", true);
          if (opt.disabled) return fail("Select option is disabled: " + opt.text, "disabled", true);
          selected.push(opt);
        }
        if (!element.multiple) {
          for (const o of options) o.selected = o === selected[0];
        } else {
          for (const o of options) o.selected = selected.includes(o);
        }
        element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return { count: 1, selected: selected.map((o) => o.value), ...cursorPt(element) };
      }

      if (!force && !isVisibleEl(element)) return fail("Locator matched a hidden element: " + raw, "not_visible", true);
      if (!force && isDisabledEl(element)) return fail("Element is disabled: " + raw, "disabled", true);
      element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return fail("Locator matched an element with no visible box: " + raw, "not_visible", true);

      const doc = element.ownerDocument || document;
      const win = doc.defaultView || window;
      const vv = win.visualViewport;
      const ox = vv?.offsetLeft ?? 0;
      const oy = vv?.offsetTop ?? 0;
      const vw = vv?.width ?? win.innerWidth;
      const vh = vv?.height ?? win.innerHeight;
      const vLeft = Math.max(rect.left, ox);
      const vRight = Math.min(rect.right, ox + vw);
      const vTop = Math.max(rect.top, oy);
      const vBottom = Math.min(rect.bottom, oy + vh);
      if (!force && (vRight <= vLeft || vBottom <= vTop)) {
        return fail("Locator element is outside the viewport: " + raw, "not_visible", true);
      }

      const boxLeft = vRight > vLeft ? vLeft : rect.left;
      const boxRight = vRight > vLeft ? vRight : rect.right;
      const boxTop = vBottom > vTop ? vTop : rect.top;
      const boxBottom = vBottom > vTop ? vBottom : rect.bottom;
      const cx = (boxLeft + boxRight) / 2;
      const cy = (boxTop + boxBottom) / 2;
      const dx = Math.max(1, (boxRight - boxLeft) * 0.25);
      const dy = Math.max(1, (boxBottom - boxTop) * 0.25);

      const control = element instanceof HTMLInputElement || element instanceof HTMLButtonElement ||
        element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement ? element : null;
      const accepted = new Set([element, ...(control?.labels ? Array.from(control.labels) : [])]);
      const matchesTarget = (node) => {
        for (let cur = node; cur; cur = cur.parentNode || cur.host) {
          if (accepted.has(cur)) return true;
          if (cur.assignedSlot && accepted.has(cur.assignedSlot)) return true;
        }
        return false;
      };

      const points = [
        { x: cx, y: cy },
        { x: boxLeft + dx, y: boxTop + dy },
        { x: boxRight - dx, y: boxTop + dy },
        { x: boxLeft + dx, y: boxBottom - dy },
        { x: boxRight - dx, y: boxBottom - dy },
      ];
      let chosen = null;
      let firstHitTag = null;
      for (const pt of points) {
        const hit = elementFromPointDeep(doc, pt.x, pt.y);
        if (firstHitTag === null) firstHitTag = hit?.tagName?.toLowerCase() ?? null;
        if (hit && matchesTarget(hit)) {
          chosen = pt;
          break;
        }
      }
      if (!force && !chosen) {
        return fail("Locator element is covered by <" + (firstHitTag || "unknown") + ">: " + raw, "covered", true);
      }

      const pt = chosen || { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      const sameOriginRect = Array.isArray(sameOriginFrames) && sameOriginFrames.length > 0;
      let offsetX = 0;
      let offsetY = 0;
      if (sameOriginRect) {
        let fWin = element.ownerDocument.defaultView;
        while (fWin && fWin !== window) {
          const frameEl = fWin.frameElement;
          if (!frameEl) break;
          const fr = frameEl.getBoundingClientRect();
          offsetX += fr.left + frameEl.clientLeft;
          offsetY += fr.top + frameEl.clientTop;
          fWin = fWin.parent;
        }
      }
      return {
        count: 1,
        x: offsetX + pt.x,
        y: offsetY + pt.y,
        width: rect.width,
        height: rect.height,
        hitTag: firstHitTag,
        ...(mutation === "check" || mutation === "uncheck"
          ? { changed: true, checked: mutation === "check" }
          : {}),
      };
    };

    if (waitMs <= 0) return runOnce();

    const isDone = (res) => mutation === "wait"
      ? Boolean(res?.satisfied || (res?.error && !res.retryable))
      : Boolean(res && (!res.error || !res.retryable));

    return (async () => {
      const initial = await runOnce();
      if (isDone(initial) || typeof MutationObserver !== "function") return initial;
      return await new Promise((resolve) => {
        let done = false;
        let polling = false;
        const observers = [];
        const finish = (res) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          clearInterval(interval);
          for (const obs of observers) {
            try { obs.disconnect(); } catch (_e) {}
          }
          resolve(res);
        };
        const check = async () => {
          if (done || polling) return;
          polling = true;
          try {
            const next = await runOnce();
            if (isDone(next)) { finish(next); return; }
            observeFrameRoot();
          } catch (error) {
            finish(fail(error?.message || "Locator evaluation failed", "error", false));
          } finally {
            polling = false;
          }
        };
        const observeTarget = (root) => {
          const target = root?.documentElement || root?.body || root;
          if (!target || typeof target !== "object" || observers.some((o) => o.__target === target)) return;
          try {
            const obs = new MutationObserver(() => { void check(); });
            obs.__target = target;
            obs.observe(target, { childList: true, subtree: true, attributes: true, characterData: true });
            observers.push(obs);
          } catch (_e) {}
        };
        const observeFrameRoot = () => {
          observeTarget(document);
          if (Array.isArray(sameOriginFrames) && sameOriginFrames.length > 0) {
            try {
              const rf = resolveSameOriginTargetRoot(sameOriginFrames);
              if (rf?.root && rf.root !== document) observeTarget(rf.root);
            } catch (_e) {}
          }
        };
        observeFrameRoot();
        const interval = setInterval(() => { void check(); }, 100);
        const timer = setTimeout(() => {
          void (async () => {
            try { finish(await runOnce()); }
            catch (error) { finish(fail(error?.message || "Locator evaluation failed", "error", false)); }
          })();
        }, waitMs);
      });
    })();
  };
`;

/**
 * Install or verify the persistent in-page locator runtime (`globalThis.__buRt`).
 * @returns {string}
 */
export function locatorRuntimeInstallExpression() {
  return `(() => {
    if (globalThis.__buRt && globalThis.__buRt.v === ${LOCATOR_RUNTIME_VERSION}) {
      return { installed: true, v: ${LOCATOR_RUNTIME_VERSION} };
    }
    ${SHARED_DOM_HELPERS}
    ${SHARED_LOCATOR_RESOLVER}
    ${SHARED_RUNNER_CORE}
    Object.defineProperty(globalThis, "__buRt", {
      value: {
        v: ${LOCATOR_RUNTIME_VERSION},
        run: runLocatorAction,
        suggestCandidates: suggestLocatorCandidates,
      },
      configurable: true,
      writable: true,
    });
    return { installed: true, v: ${LOCATOR_RUNTIME_VERSION} };
  })()`;
}

/**
 * Build a minimal (~250 byte) expression invoking the already-installed `globalThis.__buRt`.
 * @param {string} selector
 * @param {{mutation?:string|null, value?:string|null, select?:unknown, state?:string, sameOriginFrames?:string[], evalFn?:string|null, evalArg?:unknown, hasEvalArg?:boolean, asyncEval?:boolean, attrName?:string|null, force?:boolean, crossOriginDirect?:boolean, inPageWaitMs?:number}} [options]
 * @returns {string}
 */
export function locatorInvokeExpression(selector, options = {}) {
  const waitMs = Math.max(0, Math.round(Number(options.inPageWaitMs) || 0));
  const isAsync = Boolean(options.asyncEval || waitMs > 0);
  const compactOpts = {};
  if (options.mutation != null) compactOpts.mutation = options.mutation;
  if (options.value != null) compactOpts.value = options.value;
  if (options.select != null) compactOpts.select = options.select;
  if (options.state && options.state !== "visible") compactOpts.state = options.state;
  if (Array.isArray(options.sameOriginFrames) && options.sameOriginFrames.length > 0) compactOpts.sameOriginFrames = options.sameOriginFrames;
  if (options.crossOriginDirect) compactOpts.crossOriginDirect = true;
  if (options.force) compactOpts.force = true;
  if (options.attrName != null) compactOpts.attrName = options.attrName;
  if (options.hasEvalArg) {
    compactOpts.hasEvalArg = true;
    compactOpts.evalArg = options.evalArg ?? null;
  }
  if (options.asyncEval) compactOpts.asyncEval = true;
  if (waitMs > 0) compactOpts.inPageWaitMs = waitMs;

  const args = [JSON.stringify(selector), JSON.stringify(compactOpts)];
  if (options.evalFn) args.push(`(${options.evalFn})`);
  const call = `globalThis.__buRt.run(${args.join(",")})`;
  return isAsync
    ? `(async()=>globalThis.__buRt?.v===${LOCATOR_RUNTIME_VERSION}?await ${call}:{__buRtMissing:true})()`
    : `(()=>globalThis.__buRt?.v===${LOCATOR_RUNTIME_VERSION}?${call}:{__buRtMissing:true})()`;
}

/**
 * Build a standalone Playwright-style locator & action expression executed via Runtime.evaluate.
 * Kept self-contained as fallback for stateless evaluators and direct test callers.
 * @param {string} selector
 * @param {{mutation?:string|null, value?:string|null, select?:unknown, state?:string, sameOriginFrames?:string[], evalFn?:string|null, evalArg?:unknown, hasEvalArg?:boolean, asyncEval?:boolean, attrName?:string|null, force?:boolean, crossOriginDirect?:boolean, inPageWaitMs?:number}} [options]
 * @returns {string}
 */
export function locatorExpression(selector, options = {}) {
  const embeddedEvalFn = options.evalFn ? `(${options.evalFn})` : "null";
  const waitMs = Math.max(0, Math.round(Number(options.inPageWaitMs) || 0));
  const isAsync = Boolean(options.asyncEval || waitMs > 0);
  const wrapperStart = isAsync ? "(async () => {" : "(() => {";
  const evalAwait = isAsync ? "await " : "";
  const optsExpr = JSON.stringify({
    mutation: options.mutation ?? null,
    value: options.value ?? null,
    select: options.select ?? null,
    state: options.state ?? "visible",
    sameOriginFrames: options.sameOriginFrames ?? null,
    crossOriginDirect: Boolean(options.crossOriginDirect),
    force: Boolean(options.force),
    attrName: options.attrName ?? null,
    hasEvalArg: Boolean(options.hasEvalArg),
    evalArg: options.hasEvalArg ? (options.evalArg ?? null) : undefined,
    asyncEval: Boolean(options.asyncEval),
    inPageWaitMs: waitMs,
  });
  return `${wrapperStart}
    const mutation = ${JSON.stringify(options.mutation ?? null)};
    ${SHARED_DOM_HELPERS}
    ${SHARED_LOCATOR_RESOLVER}
    ${SHARED_RUNNER_CORE}
    return ${evalAwait}runLocatorAction(${JSON.stringify(selector)}, ${optsExpr}, ${embeddedEvalFn});
  })()`;
}

/**
 * Build an in-page MutationObserver expression that waits for visible text without polling IPC.
 * @param {string} text
 * @param {{timeoutMs?:number}} [options]
 * @returns {string}
 */
export function waitForTextExpression(text, { timeoutMs = 1_000 } = {}) {
  const waitMs = Math.max(0, Math.round(Number(timeoutMs) || 0));
  return `(async () => {
    const needle = ${JSON.stringify(String(text))};
    const readText = () => (document.body ? document.body.innerText : "");
    if (readText().includes(needle)) return { matched: true };
    const waitMs = ${waitMs};
    if (waitMs <= 0 || typeof MutationObserver !== "function") return { matched: false };
    return await new Promise((resolve) => {
      let done = false;
      let obs = null;
      const finish = (matched) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(interval);
        if (obs) {
          try { obs.disconnect(); } catch (_e) {}
        }
        resolve({ matched });
      };
      const check = () => {
        if (done) return;
        if (readText().includes(needle)) finish(true);
      };
      const target = document.documentElement || document.body || document;
      if (target) {
        try {
          obs = new MutationObserver(check);
          obs.observe(target, { childList: true, subtree: true, characterData: true });
        } catch (_e) {
          obs = null;
        }
      }
      const interval = setInterval(check, 100);
      const timer = setTimeout(() => finish(readText().includes(needle)), waitMs);
    });
  })()`;
}

/**
 * Build a Runtime.evaluate expression (`returnByValue: false`) that resolves a single DOM node
 * across Shadow DOM and same-origin iframes (for `DOM.describeNode` -> `DOM.setFileInputFiles`).
 * @param {string} selector
 * @param {{sameOriginFrames?:string[]}} [options]
 * @returns {string}
 */
export function locatorResolveNodeExpression(selector, { sameOriginFrames = null } = {}) {
  return `(() => {
    const raw = ${JSON.stringify(selector)};
    const sameOriginFrames = ${JSON.stringify(sameOriginFrames)};
    ${SHARED_DOM_HELPERS}
    ${SHARED_LOCATOR_RESOLVER}
    const resolvedFrame = resolveSameOriginTargetRoot(sameOriginFrames);
    if (resolvedFrame.error) throw new Error(resolvedFrame.error);
    const nodes = resolvePipeline(resolvedFrame.root, raw);
    if (nodes.length === 0) throw new Error("Locator did not match any element: " + raw);
    if (nodes.length > 1) throw new Error("Locator matched " + nodes.length + " elements: " + raw);
    return nodes[0];
  })()`;
}

/**
 * Function declaration for Runtime.callFunctionOn to perform Shadow-DOM-aware
 * hit-testing and viewport-clamped coordinate calculation on a resolved DOM node.
 * @returns {string}
 */
export function hitTestFunctionDeclaration() {
  return `function () {
    const el = this instanceof Element ? this : this.parentElement;
    if (!el || !el.isConnected) return { unpositioned: true, reason: "detached" };
    let rect = el.getClientRects()[0] || el.getBoundingClientRect();
    if (this instanceof Text) {
      const range = document.createRange();
      range.selectNode(this);
      rect = range.getClientRects()[0] || range.getBoundingClientRect();
    }
    if (!rect || rect.width <= 0 || rect.height <= 0) return { unpositioned: true, reason: "zero-box" };
    const win = el.ownerDocument?.defaultView || window;
    const vv = win.visualViewport;
    const ox = vv?.offsetLeft ?? 0;
    const oy = vv?.offsetTop ?? 0;
    const vw = vv?.width ?? win.innerWidth;
    const vh = vv?.height ?? win.innerHeight;
    const left = Math.max(rect.left, ox);
    const right = Math.min(rect.right, ox + vw);
    const top = Math.max(rect.top, oy);
    const bottom = Math.min(rect.bottom, oy + vh);
    if (right <= left || bottom <= top) return { offscreen: true, width: rect.width, height: rect.height };

    const control = el instanceof HTMLInputElement || el instanceof HTMLButtonElement ||
      el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement ? el : null;
    const accepted = new Set([el, ...(control?.labels ? Array.from(control.labels) : [])]);
    const interactiveSel = 'button,a[href],input,select,textarea,[role="button"],[role="checkbox"],[role="combobox"],[role="link"],[role="menuitem"],[role="option"],[role="radio"],[role="switch"],[role="tab"],[role="textbox"]';
    const rootInteractive = el.closest(interactiveSel);
    if (rootInteractive) accepted.add(rootInteractive);

    const hitAt = (x, y) => {
      const root = el.getRootNode();
      let node = root instanceof ShadowRoot ? root.elementFromPoint(x, y) : el.ownerDocument.elementFromPoint(x, y);
      while (node?.shadowRoot) {
        const inner = node.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === node) break;
        node = inner;
      }
      return node;
    };

    const matchesTarget = (node) => {
      for (let cur = node; cur; cur = cur.parentNode || cur.host) {
        if (accepted.has(cur)) return true;
        if (cur.assignedSlot) {
          if (accepted.has(cur.assignedSlot)) return true;
        }
      }
      return false;
    };

    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    const dx = Math.max(2, (right - left) * 0.25);
    const dy = Math.max(2, (bottom - top) * 0.25);
    const candidates = [
      { x: cx, y: cy },
      { x: left + dx, y: top + dy },
      { x: right - dx, y: top + dy },
      { x: left + dx, y: bottom - dy },
      { x: right - dx, y: bottom - dy },
    ];
    let firstHitTag = null;
    for (const pt of candidates) {
      const hit = hitAt(pt.x, pt.y);
      if (firstHitTag === null) firstHitTag = hit?.tagName?.toLowerCase() ?? null;
      if (hit && matchesTarget(hit)) {
        return { hitsTarget: true, point: pt, width: rect.width, height: rect.height };
      }
    }
    return { hitsTarget: false, hitTag: firstHitTag, point: { x: cx, y: cy }, width: rect.width, height: rect.height };
  }`;
}

/**
 * Function declaration for Runtime.callFunctionOn to set values semantically across
 * inputs, textareas, checkboxes, radios, native selects, contenteditable elements, and tabs.
 * @returns {string}
 */
export function smartSetValueFunctionDeclaration() {
  return `function (value) {
    const val = String(value);
    const role = this.getAttribute ? this.getAttribute("role") : null;
    if (this.isConnected !== false && typeof this.scrollIntoView === "function") {
      this.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    }
    const ensureEditable = (label, checkReadOnly = false) => {
      if (!this.isConnected) throw new Error(label + " is no longer connected");
      if (this.matches(":disabled") || this.getAttribute("aria-disabled") === "true") {
        throw new Error(label + " is disabled");
      }
      if (checkReadOnly && (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) && this.readOnly) {
        throw new Error(label + " is read-only");
      }
    };
    const resultStatus = (status) => {
      const rect = typeof this.getBoundingClientRect === "function" ? this.getBoundingClientRect() : null;
      return rect && rect.width > 0 && rect.height > 0
        ? { status, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, __cursorMove: true }
        : { status };
    };
    const emit = () => {
      this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      this.dispatchEvent(new Event("change", { bubbles: true }));
    };

    if (this instanceof HTMLInputElement && (this.type === "checkbox" || this.type === "radio")) {
      const kind = this.type === "radio" ? "Radio button" : role === "switch" ? "Switch" : "Checkbox";
      if (!["0", "1", "false", "true"].includes(val)) throw new Error(kind + " value must be 0, 1, false, or true");
      ensureEditable(kind);
      const checked = val === "1" || val === "true";
      const changed = this.checked !== checked || (this.type === "checkbox" && this.indeterminate);
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set;
      this.focus();
      if (setter) setter.call(this, checked); else this.checked = checked;
      if (this.type === "checkbox") this.indeterminate = false;
      if (changed) emit();
      return resultStatus("done");
    }

    if (this instanceof HTMLSelectElement) {
      ensureEditable("Select");
      const options = Array.from(this.options);
      let opt = options.find((o) => o.value === val);
      if (!opt) {
        const byLabel = options.filter((o) => o.label === val || o.text.trim() === val);
        if (byLabel.length !== 1) {
          throw new Error(byLabel.length === 0 ? "Select option not found: " + val : "Select option label is ambiguous: " + val);
        }
        opt = byLabel[0];
      }
      if (opt.disabled) throw new Error("Select option is disabled: " + val);
      this.focus();
      const changed = !opt.selected;
      opt.selected = true;
      if (changed) emit();
      return resultStatus("done");
    }

    if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) {
      if (this instanceof HTMLInputElement && this.type === "file") {
        throw new Error("File inputs require browser_upload_files");
      }
      ensureEditable("Input", true);
      const win = this.ownerDocument?.defaultView || window;
      const cke = win?.CKEDITOR?.instances;
      if (cke && typeof cke === "object") {
        for (const inst of Object.values(cke)) {
          if (inst && (inst.element?.$ === this || (this.id && inst.name === this.id) || (this.name && inst.name === this.name))) {
            inst.setData?.(val);
            inst.updateElement?.();
            return resultStatus("done");
          }
        }
      }
      const tiny = this.id ? win?.tinymce?.get?.(this.id) : null;
      if (tiny && typeof tiny.setContent === "function") {
        tiny.setContent(val);
        tiny.save?.();
        return resultStatus("done");
      }
      this.focus();
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(this), "value");
      if (descriptor?.set) descriptor.set.call(this, val); else this.value = val;
      emit();
      return resultStatus("done");
    }

    if (role === "tab") {
      ensureEditable("Tab");
      return this.getAttribute("aria-selected") === "true" ? resultStatus("done") : resultStatus("needs-click");
    }

    const ck5 = this.ckeditorInstance || this.closest?.(".ck-editor__editable")?.ckeditorInstance;
    if (ck5 && typeof ck5.setData === "function") {
      ensureEditable("Editable element");
      ck5.setData(val);
      return resultStatus("done");
    }
    const quill = this.__quill || this.closest?.(".ql-container")?.__quill;
    if (quill && typeof quill.setText === "function") {
      ensureEditable("Editable element");
      quill.setText(val);
      return resultStatus("done");
    }
    if (this instanceof HTMLElement && this.isContentEditable) {
      ensureEditable("Editable element");
      this.focus();
      this.textContent = val;
      this.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: val, inputType: "insertText" }));
      this.dispatchEvent(new Event("change", { bubbles: true }));
      return resultStatus("done");
    }

    if (typeof this.focus === "function") this.focus();
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(this), "value");
    if (descriptor?.set) descriptor.set.call(this, val); else this.value = val;
    emit();
    return resultStatus("done");
  }`;
}

/**
 * Function declaration for Runtime.callFunctionOn on an HTMLSelectElement.
 * @returns {string}
 */
export function selectOptionFunctionDeclaration() {
  return `function (specList) {
    if (!(this instanceof HTMLSelectElement)) throw new Error("Target element is not a <select>");
    if (this.disabled) throw new Error("Select element is disabled");
    if (typeof this.scrollIntoView === "function") {
      this.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    }
    if (typeof this.focus === "function") this.focus();
    const wanted = Array.isArray(specList) ? specList : [specList];
    const options = Array.from(this.options);
    const chosen = [];
    for (const spec of wanted) {
      let opt = null;
      if (typeof spec === "string") {
        opt = options.find((o) => o.value === spec) || options.find((o) => o.label === spec || o.text.trim() === spec);
      } else if (spec && typeof spec === "object") {
        if (spec.index !== undefined) opt = options[spec.index];
        else if (spec.value !== undefined) opt = options.find((o) => o.value === spec.value);
        else if (spec.label !== undefined) opt = options.find((o) => o.label === spec.label || o.text.trim() === spec.label);
      }
      if (!opt) throw new Error("Select option not found: " + JSON.stringify(spec));
      if (opt.disabled) throw new Error("Select option is disabled: " + opt.text);
      chosen.push(opt);
    }
    if (!this.multiple) {
      for (const o of options) o.selected = o === chosen[0];
    } else {
      for (const o of options) o.selected = chosen.includes(o);
    }
    this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    this.dispatchEvent(new Event("change", { bubbles: true }));
    return chosen.map((o) => o.value);
  }`;
}

/**
 * Inspect DOM elements at viewport coordinate (x, y) and generate ranked locators.
 * @param {number} x
 * @param {number} y
 * @returns {string}
 */
export function inspectElementAtPointExpression(x, y) {
  return `(() => {
    const px = ${Number(x)};
    const py = ${Number(y)};
    ${SHARED_DOM_HELPERS}
    const stack = document.elementsFromPoint(px, py);
    const results = [];
    const seen = new Set();

    const expandShadow = (el) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      const tag = el.tagName.toLowerCase();
      const role = implicitRoleOf(el) || null;
      const ariaName = accessibleNameOf(el) || null;
      const testId = el.getAttribute("data-testid") || el.getAttribute("data-test-id") || el.getAttribute("data-test") || null;
      const rect = el.getBoundingClientRect();
      const candidates = [];
      if (testId) candidates.push("testid=" + testId);
      if (role && ariaName && ariaName.length <= 60) candidates.push("role=" + role + "[name=" + JSON.stringify(ariaName) + "]");
      if (el.id && !/^\\d|:/.test(el.id)) candidates.push("css=#" + CSS.escape(el.id));
      const lbl = labelTextFor(el);
      if (lbl && lbl.length <= 60) candidates.push("label=" + lbl);
      const visibleText = (el.innerText || el.value || "").replace(/\\s+/g, " ").trim();
      if (visibleText && visibleText.length <= 60 && !candidates.some((c) => c.includes(visibleText))) {
        candidates.push("text=" + JSON.stringify(visibleText));
      }
      const cls = Array.from(el.classList || []).filter((c) => c && !/^[0-9]|[:]/.test(c)).slice(0, 2);
      candidates.push("css=" + tag + (cls.length ? "." + cls.map((c) => CSS.escape(c)).join(".") : ""));
      results.push({
        tagName: tag,
        role,
        ariaName: ariaName ? ariaName.slice(0, 120) : null,
        visibleText: visibleText ? visibleText.slice(0, 120) : null,
        testId,
        boundingBox: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        candidates,
      });
      if (el.shadowRoot) {
        for (const inner of el.shadowRoot.elementsFromPoint(px, py)) {
          if (inner !== el && results.length < 5) expandShadow(inner);
        }
      }
    };

    for (const el of stack) {
      if (results.length >= 5) break;
      expandShadow(el);
    }
    return { x: px, y: py, elements: results };
  })()`;
}

/**
 * Extract a compact, noise-stripped visible DOM snapshot with same-origin iframe expansion.
 * @param {number} [maxChars]
 * @returns {string}
 */
export function domSnapshotExpression(maxChars = 24_000) {
  return `(() => {
    const limit = ${Math.max(1_000, Number(maxChars) || 24_000)};
    const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "PATH", "DEFS", "META", "LINK"]);
    const ATTRS = ["id", "name", "role", "type", "href", "placeholder", "aria-label", "data-testid", "value", "disabled", "checked"];
    const out = [];
    let length = 0;
    let truncated = false;

    const pushLine = (line) => {
      if (truncated) return;
      if (length + line.length + 1 > limit) {
        truncated = true;
        out.push("...(truncated)");
        return;
      }
      out.push(line);
      length += line.length + 1;
    };

    const walk = (node, depth, frameDepth) => {
      if (truncated || !node) return;
      if (node.nodeType === 3) {
        const txt = (node.textContent || "").replace(/\\s+/g, " ").trim();
        if (txt) pushLine("  ".repeat(depth) + JSON.stringify(txt.slice(0, 200)));
        return;
      }
      if (node.nodeType !== 1) return;
      if (SKIP_TAGS.has(node.tagName)) return;
      const win = node.ownerDocument?.defaultView || window;
      const style = win.getComputedStyle(node);
      if (style && (style.display === "none" || style.visibility === "hidden")) return;

      const tag = node.tagName.toLowerCase();
      const attrs = [];
      for (const name of ATTRS) {
        let val = name === "value" && "value" in node ? node.value : node.getAttribute(name);
        if (val === null || val === undefined || val === "") continue;
        if (name === "disabled" || name === "checked") val = "true";
        attrs.push(name + "=" + JSON.stringify(String(val).slice(0, 120)));
      }
      const isWrapper = (tag === "div" || tag === "span") && attrs.length === 0;
      const nextDepth = isWrapper ? depth : depth + 1;
      if (!isWrapper) {
        pushLine("  ".repeat(depth) + "<" + tag + (attrs.length ? " " + attrs.join(" ") : "") + ">");
      }
      if (tag === "iframe" && frameDepth < 3 && node.contentDocument?.body) {
        pushLine("  ".repeat(nextDepth) + "<!-- same-origin iframe -->");
        walk(node.contentDocument.body, nextDepth + 1, frameDepth + 1);
        return;
      }
      if (node.shadowRoot) {
        for (const child of node.shadowRoot.childNodes) walk(child, nextDepth, frameDepth);
      }
      for (const child of node.childNodes) walk(child, nextDepth, frameDepth);
    };

    if (document.body) walk(document.body, 0, 0);
    return { title: document.title || "", url: location.href, truncated, snapshot: out.join("\\n") };
  })()`;
}
