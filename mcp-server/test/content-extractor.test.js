import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { parse } from "acorn";
import { extractContentExpression } from "../src/content-extractor.js";
import { assertReadOnly } from "../src/read-only.js";

function createMockDom({ title = "Test Page", url = "https://example.com/article", body, computedStyles = new WeakMap() }) {
  function matchesSimple(el, selector) {
    const parts = selector.split(",").map((s) => s.trim()).filter(Boolean);
    return parts.some((part) => {
      if (part === 'a[href]') {
        return el.tagName.toUpperCase() === "A" && el.getAttribute("href") !== null;
      }
      if (part === '[role="main"]') {
        return el.getAttribute("role") === "main";
      }
      return el.tagName.toUpperCase() === part.toUpperCase();
    });
  }

  function querySelectorAllFrom(root, selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 1) {
          if (matchesSimple(child, selector)) out.push(child);
          walk(child);
        }
      }
    };
    if (root) walk(root);
    return out;
  }

  function makeText(value) {
    return {
      nodeType: 3,
      nodeValue: value,
      textContent: value,
      parentElement: null,
    };
  }

  function makeElement(tagName, attrs = {}, children = []) {
    const attrMap = new Map(Object.entries(attrs).map(([k, v]) => [k.toLowerCase(), v]));
    const style = attrs.styleObj ? { ...attrs.styleObj } : {};
    const el = {
      nodeType: 1,
      tagName: tagName.toUpperCase(),
      hidden: Boolean(attrs.hidden),
      style,
      className: attrs.class ?? "",
      href: attrs.resolvedHref ?? attrs.href,
      parentElement: null,
      childNodes: [],
      children: [],
      getAttribute(name) {
        const key = String(name).toLowerCase();
        if (key === "hidden" && this.hidden) return "";
        return attrMap.has(key) ? String(attrMap.get(key)) : null;
      },
      querySelectorAll(selector) {
        return querySelectorAllFrom(this, selector);
      },
      get textContent() {
        return this.childNodes.map((c) => c.textContent ?? c.nodeValue ?? "").join("");
      },
    };
    if (typeof attrs.innerText === "string") {
      el.innerText = attrs.innerText;
    }
    for (const child of children) {
      const node = typeof child === "string" ? makeText(child) : child;
      node.parentElement = el;
      el.childNodes.push(node);
      if (node.nodeType === 1) el.children.push(node);
    }
    if (attrs.computedStyle) {
      computedStyles.set(el, attrs.computedStyle);
    }
    return el;
  }

  const rootBody = body(makeElement);
  const document = {
    title,
    URL: url,
    body: rootBody,
    documentElement: rootBody,
    querySelectorAll(selector) {
      return querySelectorAllFrom(rootBody, selector);
    },
  };

  return {
    el: makeElement,
    context: {
      document,
      location: { href: url },
      getComputedStyle(el) {
        return computedStyles.get(el) ?? { display: "block", visibility: "visible" };
      },
    },
  };
}

function runExtractor(domContext, options) {
  const expr = extractContentExpression(options);
  parse(expr, { ecmaVersion: "latest" });
  assertReadOnly(expr);
  return structuredClone(vm.runInNewContext(expr, domContext));
}

test("extractContentExpression produces valid read-only syntax across all formats", () => {
  for (const format of [undefined, "markdown", "tables", "links", "text"]) {
    const expr = extractContentExpression(format ? { format } : {});
    assert.ok(expr.startsWith("(() => {"));
    assert.ok(expr.endsWith("})()"));
    parse(expr, { ecmaVersion: "latest" });
    assertReadOnly(expr);
  }
});

test("extractContentExpression markdown selects primary article, skips boilerplate/hidden nodes, and formats rich elements", () => {
  const longPara = "This is a substantive technical paragraph describing browser automation pipelines and accessibility tree extraction in detail so the article exceeds two hundred characters effortlessly.";
  const dom = createMockDom({
    title: "Architecture Guide",
    url: "https://docs.example.com/guide",
    body: (el) => el("body", {}, [
      el("header", {}, [el("h1", {}, ["Site Header Boilerplate"])]),
      el("nav", {}, [el("a", { href: "/home" }, ["Home"]), el("a", { href: "/about" }, ["About"])]),
      el("aside", {}, [el("p", {}, ["Sidebar promo text"])]),
      el("script", {}, ["window.secret = 1;"]),
      el("style", {}, [".hidden { display: none; }"]),
      el("svg", {}, [el("text", {}, ["Vector label"])]),
      el("main", {}, [
        el("article", {}, [
          el("h1", {}, ["Main Title"]),
          el("h2", {}, ["Overview"]),
          el("p", {}, [
            longPara + " Read ",
            el("a", { href: "https://docs.example.com/api" }, ["API Docs"]),
            " or ",
            el("a", { href: "javascript:void(0)" }, ["Ignore JS"]),
            ".",
          ]),
          el("p", { styleObj: { display: "none" } }, ["Secret display none"]),
          el("p", { computedStyle: { display: "block", visibility: "hidden" } }, ["Secret visibility hidden"]),
          el("p", { hidden: true }, ["Secret hidden attr"]),
          el("p", { "aria-hidden": "true" }, ["Secret aria hidden"]),
          el("ul", {}, [
            el("li", {}, ["First item"]),
            el("li", {}, [
              "Second item",
              el("ul", {}, [el("li", {}, ["Nested child"])]),
            ]),
          ]),
          el("blockquote", {}, [el("p", {}, ["Important note here."])]),
          el("pre", {}, [el("code", { class: "language-js" }, ["const x = 1;\n  return x;"])]),
          el("table", {}, [
            el("thead", {}, [el("tr", {}, [el("th", {}, ["Name"]), el("th", {}, ["Role"])])]),
            el("tbody", {}, [el("tr", {}, [el("td", {}, ["Ada"]), el("td", {}, ["Admin"])])]),
          ]),
        ]),
      ]),
      el("footer", {}, [el("p", {}, ["Copyright 2026"])]),
    ]),
  });

  const result = runExtractor(dom.context, { format: "markdown" });
  assert.equal(result.title, "Architecture Guide");
  assert.equal(result.url, "https://docs.example.com/guide");
  assert.equal(result.format, "markdown");
  assert.equal(result.truncated, false);
  assert.equal(result.text, result.content);
  assert.equal(result.tablesCount, 1);
  assert.ok(result.text.includes("# Main Title"));
  assert.ok(result.text.includes("## Overview"));
  assert.ok(result.text.includes("[API Docs](https://docs.example.com/api)"));
  assert.ok(result.text.includes("Ignore JS"));
  assert.ok(!result.text.includes("javascript:"));
  assert.ok(result.text.includes("- First item\n- Second item\n  - Nested child"));
  assert.ok(result.text.includes("> Important note here."));
  assert.ok(result.text.includes("```js\nconst x = 1;\n  return x;\n```"));
  assert.ok(result.text.includes("| Name | Role |\n| --- | --- |\n| Ada | Admin |"));
  for (const forbidden of [
    "Site Header Boilerplate",
    "Sidebar promo text",
    "window.secret",
    "Vector label",
    "Copyright 2026",
    "Secret display none",
    "Secret visibility hidden",
    "Secret hidden attr",
    "Secret aria hidden",
  ]) {
    assert.ok(!result.text.includes(forbidden), `unexpected text: ${forbidden}`);
  }
});

test("extractContentExpression markdown falls back to highest-density block and clips to maxChars", () => {
  const dom = createMockDom({
    title: "Density Fallback",
    url: "https://example.com/density",
    body: (el) => el("body", {}, [
      el("div", { id: "nav-links" }, [
        el("a", { href: "/1" }, ["Link One Repeated Navigation Menu"]),
        el("a", { href: "/2" }, ["Link Two Repeated Navigation Menu"]),
        el("a", { href: "/3" }, ["Link Three Repeated Navigation Menu"]),
        el("a", { href: "/4" }, ["Link Four Repeated Navigation Menu"]),
      ]),
      el("div", { id: "prose" }, [
        el("p", {}, ["Paragraph one has substantial prose content without being cluttered by navigation anchors and provides real reading value."]),
        el("p", {}, ["Paragraph two continues the discussion with another hundred characters of clean informational text for readers."]),
      ]),
    ]),
  });

  const full = runExtractor(dom.context, { format: "markdown" });
  assert.ok(full.text.includes("Paragraph one"));
  assert.ok(!full.text.includes("Link One Repeated Navigation Menu"));

  const clipped = runExtractor(dom.context, { format: "markdown", maxChars: 80 });
  assert.equal(clipped.truncated, true);
  assert.ok(clipped.text.endsWith("\n...(truncated)"));
  assert.ok(clipped.text.length <= 80);
});

test("extractContentExpression tables extracts visible tables and clips cleanly", () => {
  const dom = createMockDom({
    title: "Data Tables",
    url: "https://example.com/tables",
    body: (el) => el("body", {}, [
      el("table", {}, [
        el("caption", {}, ["Quarterly Revenue"]),
        el("thead", {}, [el("tr", {}, [el("th", {}, ["Quarter"]), el("th", {}, ["Amount"])])]),
        el("tbody", {}, [
          el("tr", {}, [el("td", {}, ["Q1"]), el("td", {}, ["$10M"])]),
          el("tr", {}, [el("td", {}, ["Q2"]), el("td", {}, ["$12M"])]),
        ]),
      ]),
      el("table", { styleObj: { display: "none" } }, [
        el("tr", {}, [el("td", {}, ["Hidden"])]),
      ]),
    ]),
  });

  const res = runExtractor(dom.context, { format: "tables" });
  assert.equal(res.format, "tables");
  assert.equal(res.tablesCount, 1);
  assert.equal(res.truncated, false);
  assert.deepEqual(res.tables, [
    {
      caption: "Quarterly Revenue",
      headers: ["Quarter", "Amount"],
      rows: [["Q1", "$10M"], ["Q2", "$12M"]],
    },
  ]);
  assert.ok(res.text.includes("**Quarterly Revenue**"));
  assert.ok(res.text.includes("| Quarter | Amount |"));
  assert.ok(res.text.includes("| Q2 | $12M |"));
  assert.ok(!res.text.includes("Hidden"));

  const clipped = runExtractor(dom.context, { format: "tables", maxChars: 45 });
  assert.equal(clipped.truncated, true);
  assert.ok(clipped.text.endsWith("\n...(truncated)"));
  assert.ok(clipped.text.length <= 45);
});

test("extractContentExpression links deduplicates visible links and caps safely within maxChars", () => {
  const dom = createMockDom({
    title: "Directory",
    url: "https://example.com/links",
    body: (el) => el("body", {}, [
      el("a", { href: "https://example.com/a" }, ["Alpha"]),
      el("a", { href: "https://example.com/a" }, ["Alpha Duplicate"]),
      el("a", { href: "https://example.com/b" }, ["Beta"]),
      el("a", { href: "https://example.com/c" }, ["Gamma"]),
      el("a", { href: "javascript:alert(1)" }, ["JS Link"]),
      el("a", { href: "" }, ["Empty Href"]),
      el("div", { hidden: true }, [el("a", { href: "https://example.com/hidden" }, ["Hidden Link"])]),
    ]),
  });

  const res = runExtractor(dom.context, { format: "links" });
  assert.equal(res.format, "links");
  assert.equal(res.linksCount, 3);
  assert.equal(res.truncated, false);
  assert.deepEqual(res.links, [
    { text: "Alpha", href: "https://example.com/a" },
    { text: "Beta", href: "https://example.com/b" },
    { text: "Gamma", href: "https://example.com/c" },
  ]);
  assert.deepEqual(res.text.split("\n"), [
    "- [Alpha](https://example.com/a)",
    "- [Beta](https://example.com/b)",
    "- [Gamma](https://example.com/c)",
  ]);

  const capped = runExtractor(dom.context, { format: "links", maxChars: 60 });
  assert.equal(capped.truncated, true);
  assert.ok(capped.text.length <= 60);
  assert.ok(capped.text.endsWith("\n...(truncated)"));
  assert.equal(capped.links.length, 1);
  assert.equal(capped.linksCount, 3);
});

test("extractContentExpression text normalizes document.body.innerText and clips to maxChars", () => {
  const dom = createMockDom({
    title: "Plain Text",
    url: "https://example.com/text",
    body: (el) => el("body", { innerText: "  Line   one  \r\n\r\n\r\n\tLine two with extra words\t  \n" }, []),
  });

  const res = runExtractor(dom.context, { format: "text" });
  assert.equal(res.format, "text");
  assert.equal(res.truncated, false);
  assert.equal(res.text, "Line one\n\nLine two with extra words");
  assert.equal(res.content, "Line one\n\nLine two with extra words");

  const clipped = runExtractor(dom.context, { format: "text", maxChars: 25 });
  assert.equal(clipped.truncated, true);
  assert.ok(clipped.text.length <= 25);
  assert.ok(clipped.text.endsWith("\n...(truncated)"));
});
