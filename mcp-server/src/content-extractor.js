const VALID_FORMATS = new Set(["markdown", "tables", "links", "text"]);

/**
 * Build a self-contained read-only IIFE expression for CDP `Runtime.evaluate`
 * that extracts clean structured content from the current page.
 * @param {{format?:"markdown"|"tables"|"links"|"text", maxChars?:number}} [options]
 * @returns {string}
 */
export function extractContentExpression({ format = "markdown", maxChars = 16_000 } = {}) {
  const targetFormat = VALID_FORMATS.has(format) ? format : "markdown";
  const limit = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0
    ? Math.floor(Number(maxChars))
    : 16_000;

  return `(() => {
  const FORMAT = ${JSON.stringify(targetFormat)};
  const MAX_CHARS = ${limit};
  const BOILERPLATE_TAGS = new Set([
    "NAV", "HEADER", "FOOTER", "ASIDE", "SCRIPT", "STYLE", "NOSCRIPT", "SVG", "TEMPLATE",
  ]);
  const BLOCK_TAGS = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DETAILS", "DIALOG", "DIV",
    "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2",
    "H3", "H4", "H5", "H6", "HEADER", "HGROUP", "HR", "LI", "MAIN", "NAV", "OL",
    "P", "PRE", "SECTION", "TABLE", "UL",
  ]);

  const normalizeSpace = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();

  const normalizeMultilineText = (value) => String(value ?? "")
    .replace(/\\r\\n?/g, "\\n")
    .split("\\n")
    .map((line) => line.replace(/[ \\t]+/g, " ").trim())
    .join("\\n")
    .replace(/\\n{3,}/g, "\\n\\n")
    .trim();

  const clipText = (raw, limitChars) => {
    const text = String(raw ?? "").trim();
    if (text.length <= limitChars) return { text, truncated: false };
    const suffix = "\\n...(truncated)";
    const budget = Math.max(0, limitChars - suffix.length);
    const clipped = budget > 0
      ? text.slice(0, budget).trimEnd() + suffix
      : suffix.slice(0, limitChars);
    return { text: clipped, truncated: true };
  };

  const tagOf = (el) => String(el && el.tagName ? el.tagName : "").toUpperCase();

  const isOwnHidden = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (el.hidden === true) return true;
    if (typeof el.getAttribute === "function") {
      if (el.getAttribute("hidden") !== null) return true;
      if (el.getAttribute("aria-hidden") === "true") return true;
    }
    if (el.style) {
      if (el.style.display === "none" || el.style.visibility === "hidden") return true;
    }
    if (typeof getComputedStyle === "function") {
      try {
        const cs = getComputedStyle(el);
        if (cs && (cs.display === "none" || cs.visibility === "hidden")) return true;
      } catch (_err) {
        // Ignore detached or cross-realm elements.
      }
    }
    return false;
  };

  const isElementVisible = (el) => {
    for (let curr = el; curr && curr.nodeType === 1; curr = curr.parentElement) {
      if (isOwnHidden(curr)) return false;
    }
    return true;
  };

  const isInsideBoilerplate = (el) => {
    for (let curr = el; curr && curr.nodeType === 1; curr = curr.parentElement) {
      if (BOILERPLATE_TAGS.has(tagOf(curr))) return true;
    }
    return false;
  };

  const queryAll = (root, selector) => {
    if (!root) return [];
    if (typeof root.querySelectorAll === "function") {
      try {
        return Array.from(root.querySelectorAll(selector));
      } catch (_err) {
        return [];
      }
    }
    return [];
  };

  const collectElementsByTags = (root, tags) => {
    const wanted = new Set(tags.map((t) => t.toUpperCase()));
    const out = [];
    const walk = (node) => {
      if (!node || node.nodeType !== 1) return;
      if (wanted.has(tagOf(node))) out.push(node);
      const children = node.children || node.childNodes || [];
      for (let i = 0; i < children.length; i++) {
        if (children[i] && children[i].nodeType === 1) walk(children[i]);
      }
    };
    walk(root);
    return out;
  };

  const extractVisibleText = (node, { skipBoilerplate = true } = {}) => {
    if (!node) return "";
    if (node.nodeType === 3) return String(node.nodeValue ?? node.textContent ?? "");
    if (node.nodeType !== 1) return "";
    const tag = tagOf(node);
    if (isOwnHidden(node)) return "";
    if (skipBoilerplate && BOILERPLATE_TAGS.has(tag)) return "";
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE") return "";
    if (tag === "BR") return "\\n";
    const children = node.childNodes || [];
    if (!children.length) return String(node.textContent ?? "");
    const parts = [];
    for (let i = 0; i < children.length; i++) {
      parts.push(extractVisibleText(children[i], { skipBoilerplate }));
    }
    const joined = parts.join("");
    return BLOCK_TAGS.has(tag) ? "\\n" + joined + "\\n" : joined;
  };

  const measureTextAndLinks = (root) => {
    let totalLen = 0;
    let linkLen = 0;
    let blockCount = 0;
    const walk = (node, insideLink) => {
      if (!node) return;
      if (node.nodeType === 3) {
        const len = normalizeSpace(node.nodeValue ?? node.textContent ?? "").length;
        totalLen += len;
        if (insideLink) linkLen += len;
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = tagOf(node);
      if (isOwnHidden(node) || BOILERPLATE_TAGS.has(tag)) return;
      if (tag === "P" || tag === "PRE" || tag === "TABLE" || tag === "BLOCKQUOTE" || /^H[1-6]$/.test(tag)) {
        blockCount += 1;
      }
      const nextInsideLink = insideLink || tag === "A";
      const children = node.childNodes || [];
      for (let i = 0; i < children.length; i++) {
        walk(children[i], nextInsideLink);
      }
    };
    walk(root, false);
    return { totalLen, linkLen, blockCount };
  };

  const extractTableData = (tableEl) => {
    let caption = "";
    const captions = collectElementsByTags(tableEl, ["CAPTION"]);
    if (captions.length > 0 && isElementVisible(captions[0])) {
      caption = normalizeSpace(extractVisibleText(captions[0], { skipBoilerplate: false }));
    }

    const rowEls = collectElementsByTags(tableEl, ["TR"]).filter((tr) => isElementVisible(tr));
    let headers = [];
    const rows = [];

    for (let i = 0; i < rowEls.length; i++) {
      const tr = rowEls[i];
      const cells = [];
      const childEls = tr.children || tr.childNodes || [];
      let thCount = 0;
      let cellCount = 0;
      for (let c = 0; c < childEls.length; c++) {
        const cell = childEls[c];
        if (!cell || cell.nodeType !== 1) continue;
        const cTag = tagOf(cell);
        if (cTag !== "TH" && cTag !== "TD") continue;
        if (isOwnHidden(cell)) continue;
        cellCount += 1;
        if (cTag === "TH") thCount += 1;
        cells.push(normalizeSpace(extractVisibleText(cell, { skipBoilerplate: false })));
      }
      if (cellCount === 0) continue;
      const inThead = tr.parentElement && tagOf(tr.parentElement) === "THEAD";
      if (headers.length === 0 && rows.length === 0 && (inThead || thCount === cellCount)) {
        headers = cells;
      } else {
        rows.push(cells);
      }
    }

    return { caption, headers, rows };
  };

  const escapeTableCell = (cell) => String(cell ?? "").replace(/\\|/g, "\\\\|").replace(/\\n/g, " ").trim();

  const renderTableMarkdown = (tableData) => {
    const { caption, headers, rows } = tableData;
    const activeHeaders = headers.length > 0 ? headers : (rows.length > 0 ? rows[0] : []);
    const dataRows = headers.length > 0 ? rows : rows.slice(1);
    let colCount = activeHeaders.length;
    for (let i = 0; i < dataRows.length; i++) {
      if (dataRows[i].length > colCount) colCount = dataRows[i].length;
    }
    if (colCount === 0) return "";
    const padRow = (r) => {
      const out = [];
      for (let i = 0; i < colCount; i++) out.push(escapeTableCell(r[i] ?? ""));
      return "| " + out.join(" | ") + " |";
    };
    const lines = [];
    if (caption) lines.push("**" + caption + "**", "");
    lines.push(padRow(activeHeaders));
    lines.push("| " + Array.from({ length: colCount }, () => "---").join(" | ") + " |");
    for (let i = 0; i < dataRows.length; i++) {
      lines.push(padRow(dataRows[i]));
    }
    return lines.join("\\n");
  };

  const getAttr = (el, name) => (el && typeof el.getAttribute === "function" ? el.getAttribute(name) : null);

  const resolveLinkHref = (aEl) => {
    const rawAttr = String(getAttr(aEl, "href") ?? "").trim();
    const propHref = typeof aEl.href === "string" ? aEl.href.trim() : "";
    const candidate = rawAttr || propHref;
    if (!candidate || /^javascript:/i.test(candidate)) return "";
    if (/^javascript:/i.test(rawAttr)) return "";
    if (propHref && !/^javascript:/i.test(propHref) && !rawAttr.startsWith("#")) return propHref;
    return candidate;
  };

  const extractLinksList = (root) => {
    const anchors = queryAll(root, "a[href]").length > 0
      ? queryAll(root, "a[href]")
      : collectElementsByTags(root, ["A"]).filter((a) => getAttr(a, "href") !== null || Boolean(a.href));
    const seen = new Set();
    const links = [];
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      if (!isElementVisible(a)) continue;
      const href = resolveLinkHref(a);
      if (!href || seen.has(href)) continue;
      let text = normalizeSpace(extractVisibleText(a, { skipBoilerplate: false }));
      if (!text) text = normalizeSpace(getAttr(a, "aria-label") || getAttr(a, "title") || "");
      if (!text) {
        const imgs = collectElementsByTags(a, ["IMG"]);
        for (let k = 0; k < imgs.length; k++) {
          const alt = normalizeSpace(getAttr(imgs[k], "alt") || "");
          if (alt) {
            text = alt;
            break;
          }
        }
      }
      if (!text) continue;
      seen.add(href);
      links.push({ text, href });
    }
    return links;
  };

  const countVisibleTables = (root) => {
    const tables = queryAll(root, "table").length > 0
      ? queryAll(root, "table")
      : collectElementsByTags(root, ["TABLE"]);
    return tables.filter((t) => isElementVisible(t));
  };

  const pickPrimaryContainer = (body) => {
    if (!body) return document.documentElement;
    const semanticCandidates = [];
    const primaryMatches = queryAll(document, 'article, main, [role="main"]');
    const fallbackMatches = primaryMatches.length > 0
      ? primaryMatches
      : collectElementsByTags(body, ["ARTICLE", "MAIN", "DIV", "SECTION"]).filter((el) => {
        const t = tagOf(el);
        return t === "ARTICLE" || t === "MAIN" || getAttr(el, "role") === "main";
      });
    for (let i = 0; i < fallbackMatches.length; i++) {
      const el = fallbackMatches[i];
      if (!isElementVisible(el) || isInsideBoilerplate(el)) continue;
      const stats = measureTextAndLinks(el);
      if (stats.totalLen >= 200) {
        semanticCandidates.push({ el, score: stats.totalLen });
      }
    }
    if (semanticCandidates.length > 0) {
      semanticCandidates.sort((a, b) => b.score - a.score);
      return semanticCandidates[0].el;
    }

    const densityBlocks = collectElementsByTags(body, ["SECTION", "DIV", "ARTICLE", "MAIN"]);
    let bestEl = null;
    let bestScore = 0;
    for (let i = 0; i < densityBlocks.length; i++) {
      const el = densityBlocks[i];
      if (!isElementVisible(el) || isInsideBoilerplate(el)) continue;
      const stats = measureTextAndLinks(el);
      if (stats.totalLen < 120 || (stats.blockCount < 2 && stats.totalLen < 200)) continue;
      const linkDensity = stats.linkLen / Math.max(1, stats.totalLen);
      const nonLinkLen = Math.max(0, stats.totalLen - stats.linkLen);
      const score = nonLinkLen * (1 - Math.min(0.9, linkDensity)) + stats.blockCount * 20;
      if (score > bestScore) {
        bestScore = score;
        bestEl = el;
      }
    }
    return bestEl || body;
  };

  const renderMarkdownNode = (node) => {
    if (!node) return "";
    if (node.nodeType === 3) {
      return String(node.nodeValue ?? node.textContent ?? "").replace(/[ \\t\\r\\n]+/g, " ");
    }
    if (node.nodeType !== 1) return "";
    const tag = tagOf(node);
    if (isOwnHidden(node) || BOILERPLATE_TAGS.has(tag)) return "";

    if (tag === "BR") return "\\n";
    if (tag === "HR") return "\\n\\n---\\n\\n";

    if (tag === "PRE") {
      const rawPre = String(node.textContent ?? "").replace(/\\r\\n?/g, "\\n").replace(/^\\n+|\\n+$/g, "");
      if (!rawPre) return "";
      const codeChildren = collectElementsByTags(node, ["CODE"]);
      let lang = "";
      if (codeChildren.length > 0) {
        const cls = String(getAttr(codeChildren[0], "class") || codeChildren[0].className || "");
        const m = cls.match(/language-([a-zA-Z0-9_-]+)/);
        if (m) lang = m[1];
      }
      return "\\n\\n\`\`\`" + lang + "\\n" + rawPre + "\\n\`\`\`\\n\\n";
    }

    if (tag === "CODE") {
      const codeText = normalizeSpace(node.textContent ?? "");
      return codeText ? "\`" + codeText + "\`" : "";
    }

    if (tag === "TABLE") {
      const md = renderTableMarkdown(extractTableData(node));
      return md ? "\\n\\n" + md + "\\n\\n" : "";
    }

    const renderChildren = () => {
      const children = node.childNodes || [];
      if (!children.length) return String(node.textContent ?? "").replace(/[ \\t\\r\\n]+/g, " ");
      let acc = "";
      for (let i = 0; i < children.length; i++) {
        acc += renderMarkdownNode(children[i]);
      }
      return acc;
    };

    if (/^H[1-6]$/.test(tag)) {
      const level = Number(tag.slice(1));
      const text = normalizeSpace(renderChildren());
      return text ? "\\n\\n" + "#".repeat(level) + " " + text + "\\n\\n" : "";
    }

    if (tag === "A") {
      const href = resolveLinkHref(node);
      const inner = normalizeSpace(renderChildren());
      if (!inner) return "";
      if (!href) return inner;
      return "[" + inner + "](" + href + ")";
    }

    if (tag === "BLOCKQUOTE") {
      const inner = normalizeMarkdownOutput(renderChildren());
      if (!inner) return "";
      const quoted = inner
        .split("\\n")
        .map((line) => (line ? "> " + line : ">"))
        .join("\\n");
      return "\\n\\n" + quoted + "\\n\\n";
    }

    if (tag === "UL" || tag === "OL") {
      const items = [];
      const children = node.children || node.childNodes || [];
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (!child || child.nodeType !== 1 || tagOf(child) !== "LI") continue;
        if (isOwnHidden(child)) continue;
        const itemMd = renderListItem(child, 0);
        if (itemMd) items.push(itemMd);
      }
      return items.length ? "\\n\\n" + items.join("\\n") + "\\n\\n" : "";
    }

    if (tag === "LI") {
      return renderListItem(node, 0);
    }

    if (tag === "P") {
      const inner = renderChildren().replace(/^[ \\t]+|[ \\t]+$/g, "");
      return inner.trim() ? "\\n\\n" + inner.trim() + "\\n\\n" : "";
    }

    const inner = renderChildren();
    if (BLOCK_TAGS.has(tag)) {
      return inner.trim() ? "\\n\\n" + inner.trim() + "\\n\\n" : "";
    }
    return inner;
  };

  const renderListItem = (liNode, depth) => {
    const inlineParts = [];
    const nestedLists = [];
    const children = liNode.childNodes || [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child && child.nodeType === 1 && (tagOf(child) === "UL" || tagOf(child) === "OL")) {
        nestedLists.push(child);
      } else {
        inlineParts.push(renderMarkdownNode(child));
      }
    }
    const text = normalizeSpace(inlineParts.join(""));
    const lines = [];
    const indent = "  ".repeat(depth);
    if (text) lines.push(indent + "- " + text);
    for (let i = 0; i < nestedLists.length; i++) {
      const list = nestedLists[i];
      if (isOwnHidden(list)) continue;
      const listChildren = list.children || list.childNodes || [];
      for (let k = 0; k < listChildren.length; k++) {
        const sub = listChildren[k];
        if (sub && sub.nodeType === 1 && tagOf(sub) === "LI" && !isOwnHidden(sub)) {
          const subMd = renderListItem(sub, depth + 1);
          if (subMd) lines.push(subMd);
        }
      }
    }
    return lines.join("\\n");
  };

  const normalizeMarkdownOutput = (raw) => {
    const parts = String(raw ?? "").split(/(\`\`\`[\\s\\S]*?\`\`\`)/g);
    const out = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i % 2 === 1) {
        out.push("\\n\\n" + part + "\\n\\n");
      } else {
        const cleaned = part
          .replace(/\\r\\n?/g, "\\n")
          .split("\\n")
          .map((line) => {
            const rtrimmed = line.trimEnd();
            if (rtrimmed.trim() === "") return "";
            const listMatch = rtrimmed.match(/^( +)(- .*)$/);
            if (listMatch) return listMatch[1] + listMatch[2].replace(/[ \\t]+/g, " ");
            return rtrimmed.replace(/[ \\t]+/g, " ").replace(/^ +/, "");
          })
          .join("\\n");
        out.push(cleaned);
      }
    }
    return out.join("").replace(/\\n{3,}/g, "\\n\\n").trim();
  };

  const title = normalizeSpace(document && document.title);
  const url = String(
    (typeof location !== "undefined" && location && location.href) ||
    (document && document.URL) ||
    ""
  );
  const body = (document && (document.body || document.documentElement)) || null;
  const visibleTables = body ? countVisibleTables(body) : [];
  const allLinks = body ? extractLinksList(body) : [];
  const tablesCount = visibleTables.length;
  const linksCount = allLinks.length;

  if (FORMAT === "tables") {
    const tables = visibleTables.map((t) => extractTableData(t));
    const rendered = tables
      .map((t) => renderTableMarkdown(t))
      .filter(Boolean)
      .join("\\n\\n");
    const clipped = clipText(rendered, MAX_CHARS);
    return {
      title,
      url,
      format: FORMAT,
      text: clipped.text,
      content: clipped.text,
      truncated: clipped.truncated,
      tablesCount,
      linksCount,
      tables,
    };
  }

  if (FORMAT === "links") {
    const suffix = "\\n...(truncated)";
    const lines = [];
    const keptLinks = [];
    let usedChars = 0;
    let truncated = false;
    for (let i = 0; i < allLinks.length; i++) {
      const item = allLinks[i];
      const line = "- [" + item.text + "](" + item.href + ")";
      const addition = (lines.length > 0 ? 1 : 0) + line.length;
      if (usedChars + addition > MAX_CHARS) {
        truncated = true;
        break;
      }
      lines.push(line);
      keptLinks.push(item);
      usedChars += addition;
    }
    let text = lines.join("\\n");
    if (truncated) {
      while (lines.length > 0 && (lines.join("\\n").length + suffix.length) > MAX_CHARS) {
        lines.pop();
        keptLinks.pop();
      }
      text = lines.length > 0
        ? lines.join("\\n") + suffix
        : suffix.slice(0, MAX_CHARS);
    }
    return {
      title,
      url,
      format: FORMAT,
      text,
      content: text,
      truncated,
      tablesCount,
      linksCount,
      links: keptLinks,
    };
  }

  if (FORMAT === "text") {
    const raw = body && typeof body.innerText === "string"
      ? body.innerText
      : extractVisibleText(body, { skipBoilerplate: false });
    const normalized = normalizeMultilineText(raw);
    const clipped = clipText(normalized, MAX_CHARS);
    return {
      title,
      url,
      format: FORMAT,
      text: clipped.text,
      content: clipped.text,
      truncated: clipped.truncated,
      tablesCount,
      linksCount,
    };
  }

  const container = pickPrimaryContainer(body);
  const rawMd = container ? renderMarkdownNode(container) : "";
  const normalizedMd = normalizeMarkdownOutput(rawMd);
  const clipped = clipText(normalizedMd, MAX_CHARS);
  return {
    title,
    url,
    format: "markdown",
    text: clipped.text,
    content: clipped.text,
    truncated: clipped.truncated,
    tablesCount,
    linksCount,
  };
})()`;
}
