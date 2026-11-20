import assert from "node:assert/strict";
import test from "node:test";
import { buildAxDiff, buildAxState, buildDialogAxState, formatAriaSnapshot, mergeFrameAriaSnapshots, mergeFrameAxStates } from "../src/ax-tree.js";

test("buildAxState prunes redundant StaticText under semantic controls and formats rich properties", () => {
  const nodes = [
    { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "App" }, backendDOMNodeId: 1, childIds: ["2", "4", "6", "7"] },
    {
      nodeId: "2",
      parentId: "1",
      role: { value: "button" },
      name: { value: "Submit" },
      backendDOMNodeId: 20,
      properties: [{ name: "expanded", value: { value: false } }],
      childIds: ["3"],
    },
    { nodeId: "3", parentId: "2", role: { value: "StaticText" }, name: { value: "Submit" }, backendDOMNodeId: 21 },
    {
      nodeId: "4",
      parentId: "1",
      role: { value: "link" },
      name: { value: "Docs" },
      backendDOMNodeId: 30,
      properties: [{ name: "url", value: { value: "https://example.com/docs" } }],
      childIds: ["5"],
    },
    { nodeId: "5", parentId: "4", role: { value: "StaticText" }, name: { value: "Docs" }, backendDOMNodeId: 31 },
    {
      nodeId: "6",
      parentId: "1",
      role: { value: "heading" },
      name: { value: "Overview" },
      backendDOMNodeId: 40,
      properties: [{ name: "level", value: { value: 2 } }],
    },
    {
      nodeId: "7",
      parentId: "1",
      role: { value: "StaticText" },
      name: { value: "Independent body text" },
      backendDOMNodeId: 50,
    },
  ];
  const snapshot = buildAxState(nodes);
  assert.deepEqual(snapshot.lines, [
    '0 RootWebArea "App"',
    '  1 button "Submit" [expanded=false]',
    '  2 link "Docs" (url: "https://example.com/docs")',
    '  3 heading "Overview" [level=2]',
    '  4 StaticText "Independent body text"',
  ]);
  assert.deepEqual(snapshot.index.get("1").actions, ["Expand"]);
});

test("mergeFrameAxStates combines main and child iframe trees with sequential indices", () => {
  const merged = mergeFrameAxStates([
    {
      frameId: null,
      sessionId: null,
      nodes: [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Parent" }, backendDOMNodeId: 1, childIds: ["2"] },
        { nodeId: "2", parentId: "1", role: { value: "button" }, name: { value: "Open" }, backendDOMNodeId: 10 },
      ],
    },
    {
      frameId: "frame-child",
      sessionId: "session-9",
      url: "https://pay.example/form",
      depth: 1,
      nodes: [
        { nodeId: "10", role: { value: "RootWebArea" }, name: { value: "Payment" }, backendDOMNodeId: 100, childIds: ["11"] },
        { nodeId: "11", parentId: "10", role: { value: "textbox" }, name: { value: "Card" }, backendDOMNodeId: 101 },
      ],
    },
  ]);

  assert.equal(merged.count, 4);
  assert.ok(merged.lines.some((line) => line.includes("[iframe frame-child (https://pay.example/form)]")));
  assert.equal(merged.index.get("1").sessionId, null);
  assert.equal(merged.index.get("3").frameId, "frame-child");
  assert.equal(merged.index.get("3").sessionId, "session-9");
  assert.equal(merged.index.get("3").backendDOMNodeId, 101);
});

test("buildAxDiff reports unchanged, compact diffs, and full fallback on document change or rewrite", () => {
  const baseNodes = [
    { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Form" }, backendDOMNodeId: 1, childIds: ["2", "3", "4", "5"] },
    { nodeId: "2", parentId: "1", role: { value: "textbox" }, name: { value: "Email" }, value: { value: "" }, backendDOMNodeId: 10 },
    { nodeId: "3", parentId: "1", role: { value: "button" }, name: { value: "Save" }, backendDOMNodeId: 11 },
    { nodeId: "4", parentId: "1", role: { value: "StaticText" }, name: { value: "Hint A" }, backendDOMNodeId: 12 },
    { nodeId: "5", parentId: "1", role: { value: "StaticText" }, name: { value: "Hint B" }, backendDOMNodeId: 13 },
  ];
  const first = buildAxState(baseNodes);
  const unchanged = buildAxDiff({ documentKey: "doc-1", entries: first.entries }, { documentKey: "doc-1", ...first });
  assert.equal(unchanged.mode, "unchanged");
  assert.match(unchanged.lines[0], /No accessibility changes/);

  const updatedNodes = [
    ...baseNodes.slice(0, 1),
    { nodeId: "2", parentId: "1", role: { value: "textbox" }, name: { value: "Email" }, value: { value: "a@b.c" }, backendDOMNodeId: 10 },
    ...baseNodes.slice(2, 5),
    { nodeId: "6", parentId: "1", role: { value: "StaticText" }, name: { value: "Saved" }, backendDOMNodeId: 14 },
  ];
  updatedNodes[0] = { ...updatedNodes[0], childIds: ["2", "3", "4", "5", "6"] };
  const second = buildAxState(updatedNodes);
  const diff = buildAxDiff({ documentKey: "doc-1", entries: first.entries }, { documentKey: "doc-1", ...second });
  assert.equal(diff.mode, "diff");
  assert.equal(diff.changed, 1);
  assert.equal(diff.added, 1);
  assert.ok(diff.lines.some((line) => line.includes('~ 1 textbox "Email" (value: "a@b.c")')));
  assert.ok(diff.lines.some((line) => line.includes('+ 5 StaticText "Saved"')));

  const navigated = buildAxDiff({ documentKey: "doc-1", entries: first.entries }, { documentKey: "doc-2", ...second });
  assert.equal(navigated.mode, "full");
});

test("buildDialogAxState emits synthetic prompt, accept, and dismiss indices", () => {
  const state = buildDialogAxState(
    { type: "prompt", message: "Enter your name", defaultPrompt: "Ada", url: "https://example.com" },
    { tab_id: "1", title: "Example", url: "https://example.com" },
  );
  assert.match(state.axText, /alertdialog "JavaScript prompt dialog"/);
  assert.equal(state.index.get("2").dialogControl, "prompt");
  assert.equal(state.index.get("3").dialogControl, "accept");
  assert.equal(state.index.get("4").dialogControl, "dismiss");
});

test("formatAriaSnapshot renders clean filterable YAML ARIA lines without indices", () => {
  const nodes = [
    { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Form" }, childIds: ["2", "3", "4", "6"] },
    { nodeId: "2", parentId: "1", role: { value: "heading" }, name: { value: "Submission" }, properties: [{ name: "level", value: { value: 2 } }] },
    { nodeId: "3", parentId: "1", role: { value: "checkbox" }, name: { value: "Agree" }, properties: [{ name: "checked", value: { value: true } }] },
    {
      nodeId: "4",
      parentId: "1",
      role: { value: "link" },
      name: { value: "Docs" },
      properties: [{ name: "url", value: { value: "https://example.com/docs" } }],
      childIds: ["5"],
    },
    { nodeId: "5", parentId: "4", role: { value: "StaticText" }, name: { value: "Docs" } },
    { nodeId: "6", parentId: "1", role: { value: "StaticText" }, name: { value: "Ready" } },
  ];
  const yaml = formatAriaSnapshot(nodes);
  assert.equal(yaml.truncated, false);
  assert.deepEqual(yaml.text.split("\n"), [
    '- heading "Submission" [level=2]',
    '- checkbox "Agree" [checked]',
    '- link "Docs"',
    "  - /url: https://example.com/docs",
    "- text: Ready",
  ]);
});

test("mergeFrameAriaSnapshots includes child iframes with indentation and skips empty frames", () => {
  const merged = mergeFrameAriaSnapshots([
    {
      frameId: null,
      nodes: [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Main" }, childIds: ["2"] },
        { nodeId: "2", parentId: "1", role: { value: "button" }, name: { value: "Continue" } },
      ],
    },
    {
      frameId: "empty-frame",
      url: "about:blank",
      depth: 1,
      nodes: [],
    },
    {
      frameId: "frame-pay",
      url: "https://pay.example/checkout",
      depth: 1,
      nodes: [
        { nodeId: "10", role: { value: "RootWebArea" }, name: { value: "Card" }, childIds: ["11"] },
        { nodeId: "11", parentId: "10", role: { value: "textbox" }, name: { value: "Card Number" } },
      ],
    },
  ]);

  assert.equal(merged.truncated, false);
  assert.deepEqual(merged.text.split("\n"), [
    '- button "Continue"',
    "[iframe frame-pay (https://pay.example/checkout)]",
    '  - textbox "Card Number"',
  ]);
});

test("buildAxState interactive mode prunes non-interactive boilerplate while keeping controls, stateful nodes, and active landmarks", () => {
  const nodes = [
    { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Portal" }, backendDOMNodeId: 1, childIds: ["2", "3", "4", "6", "8", "10", "14"] },
    { nodeId: "2", parentId: "1", role: { value: "heading" }, name: { value: "Account" }, backendDOMNodeId: 2, properties: [{ name: "level", value: { value: 1 } }] },
    { nodeId: "3", parentId: "1", role: { value: "StaticText" }, name: { value: "Legal footer notice" }, backendDOMNodeId: 3 },
    { nodeId: "4", parentId: "1", role: { value: "paragraph" }, backendDOMNodeId: 4, childIds: ["5", "16"] },
    { nodeId: "5", parentId: "4", role: { value: "StaticText" }, name: { value: "Read the" }, backendDOMNodeId: 5 },
    { nodeId: "16", parentId: "4", role: { value: "link" }, name: { value: "Guide" }, backendDOMNodeId: 16, properties: [{ name: "url", value: { value: "https://example.com/guide" } }] },
    { nodeId: "6", parentId: "1", role: { value: "navigation" }, name: { value: "Empty Nav" }, backendDOMNodeId: 6, childIds: ["7"] },
    { nodeId: "7", parentId: "6", role: { value: "StaticText" }, name: { value: "No actions" }, backendDOMNodeId: 7 },
    { nodeId: "8", parentId: "1", role: { value: "form" }, name: { value: "Login" }, backendDOMNodeId: 8, childIds: ["9", "11"] },
    { nodeId: "9", parentId: "8", role: { value: "textbox" }, name: { value: "User" }, backendDOMNodeId: 9 },
    { nodeId: "11", parentId: "8", role: { value: "button" }, name: { value: "Sign in" }, backendDOMNodeId: 11 },
    { nodeId: "10", parentId: "1", role: { value: "region" }, name: { value: "Status" }, backendDOMNodeId: 10, childIds: ["12"] },
    { nodeId: "12", parentId: "10", role: { value: "generic" }, name: { value: "Active row" }, backendDOMNodeId: 12, properties: [{ name: "selected", value: { value: true } }] },
    { nodeId: "14", parentId: "1", role: { value: "StaticText" }, name: { value: "Focused note" }, backendDOMNodeId: 14, properties: [{ name: "focused", value: { value: true } }] },
  ];

  const snapshot = buildAxState(nodes, { mode: "interactive" });
  assert.deepEqual(snapshot.lines, [
    '0 RootWebArea "Portal"',
    '  1 heading "Account" [level=1]',
    '  2 link "Guide" (url: "https://example.com/guide")',
    '  3 form "Login"',
    '    4 textbox "User"',
    '    5 button "Sign in"',
    '  6 region "Status"',
    '    7 generic "Active row" [selected]',
    '  8 StaticText "Focused note" [focused]',
  ]);
  assert.equal(snapshot.count, 9);
  assert.equal(snapshot.index.size, 9);
  assert.equal(snapshot.index.get("2").backendDOMNodeId, 16);
  assert.equal(snapshot.index.get("5").backendDOMNodeId, 11);
  assert.equal(snapshot.index.get("7").backendDOMNodeId, 12);
  assert.equal(snapshot.index.get("8").backendDOMNodeId, 14);
});

test("buildAxState compact mode collapses >5 consecutive listitem/row siblings without indexing placeholder", () => {
  const listItems = Array.from({ length: 8 }, (_, i) => ({
    nodeId: `li-${i}`,
    parentId: "list",
    role: { value: "listitem" },
    name: { value: `Item ${i + 1}` },
    backendDOMNodeId: 100 + i,
  }));
  const rowItems = Array.from({ length: 6 }, (_, i) => ({
    nodeId: `row-${i}`,
    parentId: "table",
    role: { value: "row" },
    name: { value: `Row ${i + 1}` },
    backendDOMNodeId: 200 + i,
    childIds: [`cell-${i}`],
  }));
  const cellItems = rowItems.map((row, i) => ({
    nodeId: `cell-${i}`,
    parentId: row.nodeId,
    role: { value: "cell" },
    name: { value: `Cell ${i + 1}` },
    backendDOMNodeId: 300 + i,
  }));
  const shortItems = Array.from({ length: 5 }, (_, i) => ({
    nodeId: `opt-${i}`,
    parentId: "listbox",
    role: { value: "option" },
    name: { value: `Opt ${i + 1}` },
    backendDOMNodeId: 400 + i,
  }));

  const nodes = [
    { nodeId: "root", role: { value: "RootWebArea" }, name: { value: "Catalog" }, backendDOMNodeId: 1, childIds: ["list", "table", "listbox"] },
    { nodeId: "list", parentId: "root", role: { value: "list" }, backendDOMNodeId: 2, childIds: listItems.map((n) => n.nodeId) },
    ...listItems,
    { nodeId: "table", parentId: "root", role: { value: "table" }, backendDOMNodeId: 3, childIds: rowItems.map((n) => n.nodeId) },
    ...rowItems,
    ...cellItems,
    { nodeId: "listbox", parentId: "root", role: { value: "listbox" }, backendDOMNodeId: 4, childIds: shortItems.map((n) => n.nodeId) },
    ...shortItems,
  ];

  // Full mode keeps everything unchanged
  const full = buildAxState(nodes);
  assert.ok(!full.lines.some((l) => l.includes("omitted")));
  assert.equal(full.count, 1 + 1 + 8 + 1 + 6 + 6 + 1 + 5);

  // Compact mode collapses runs > 5 (8 listitems -> 3 + placeholder + 1; 6 rows -> 3 + placeholder + 1; 5 options -> all 5)
  const compact = buildAxState(nodes, { mode: "compact" });
  assert.ok(compact.lines.includes("    ... (+4 similar listitem items omitted)"));
  assert.ok(compact.lines.includes("    ... (+2 similar row items omitted)"));
  assert.ok(!compact.lines.some((l) => l.includes("option items omitted")));
  assert.ok(compact.lines.some((l) => l.includes('listitem "Item 1"')));
  assert.ok(compact.lines.some((l) => l.includes('listitem "Item 3"')));
  assert.ok(!compact.lines.some((l) => l.includes('listitem "Item 4"')));
  assert.ok(!compact.lines.some((l) => l.includes('listitem "Item 7"')));
  assert.ok(compact.lines.some((l) => l.includes('listitem "Item 8"')));
  assert.ok(!compact.lines.some((l) => l.includes('Cell 4')));
  assert.ok(compact.lines.some((l) => l.includes('Cell 6')));
  // Placeholder lines are not indexed
  assert.equal(compact.index.size, compact.count);
  for (let i = 0; i < compact.count; i++) {
    assert.ok(compact.index.has(String(i)), `missing index ${i}`);
  }

  // Explicit collapseRepeated: false disables collapsing even in compact mode
  const uncollapsed = buildAxState(nodes, { mode: "compact", collapseRepeated: false });
  assert.equal(uncollapsed.count, full.count);
  assert.ok(!uncollapsed.lines.some((l) => l.includes("omitted")));

  // Explicit collapseRepeated: true enables collapsing in full mode
  const fullCollapsed = buildAxState(nodes, { mode: "full", collapseRepeated: true });
  assert.equal(fullCollapsed.count, compact.count);
});

test("formatAriaSnapshot and mergeFrameAriaSnapshots support compact and interactive modes", () => {
  const items = Array.from({ length: 7 }, (_, i) => ({
    nodeId: `li-${i}`,
    parentId: "list",
    role: { value: "listitem" },
    name: { value: `Row ${i + 1}` },
  }));
  const nodes = [
    { nodeId: "root", role: { value: "RootWebArea" }, name: { value: "Page" }, childIds: ["h", "p", "list", "btn"] },
    { nodeId: "h", parentId: "root", role: { value: "heading" }, name: { value: "Title" }, properties: [{ name: "level", value: { value: 2 } }] },
    { nodeId: "p", parentId: "root", role: { value: "StaticText" }, name: { value: "Boilerplate intro" } },
    { nodeId: "list", parentId: "root", role: { value: "list" }, childIds: items.map((x) => x.nodeId) },
    ...items,
    { nodeId: "btn", parentId: "root", role: { value: "button" }, name: { value: "Next" } },
  ];

  const interactive = formatAriaSnapshot(nodes, { mode: "interactive" });
  assert.deepEqual(interactive.text.split("\n"), [
    '- heading "Title" [level=2]',
    '- button "Next"',
  ]);

  const compact = formatAriaSnapshot(nodes, { mode: "compact" });
  assert.deepEqual(compact.text.split("\n"), [
    '- heading "Title" [level=2]',
    "- text: Boilerplate intro",
    "- list",
    '  - listitem "Row 1"',
    '  - listitem "Row 2"',
    '  - listitem "Row 3"',
    "  ... (+3 similar listitem items omitted)",
    '  - listitem "Row 7"',
    '- button "Next"',
  ]);

  const mergedInteractive = mergeFrameAriaSnapshots([
    { frameId: null, nodes },
    {
      frameId: "text-only-frame",
      url: "https://ads.example",
      depth: 1,
      nodes: [
        { nodeId: "a1", role: { value: "RootWebArea" }, childIds: ["a2"] },
        { nodeId: "a2", parentId: "a1", role: { value: "StaticText" }, name: { value: "Ad copy" } },
      ],
    },
    {
      frameId: "action-frame",
      url: "https://app.example/widget",
      depth: 1,
      nodes: [
        { nodeId: "b1", role: { value: "RootWebArea" }, childIds: ["b2", "b3"] },
        { nodeId: "b2", parentId: "b1", role: { value: "StaticText" }, name: { value: "Widget hint" } },
        { nodeId: "b3", parentId: "b1", role: { value: "checkbox" }, name: { value: "Enable" } },
      ],
    },
  ], { mode: "interactive" });

  assert.deepEqual(mergedInteractive.text.split("\n"), [
    '- heading "Title" [level=2]',
    '- button "Next"',
    "[iframe action-frame (https://app.example/widget)]",
    '  - checkbox "Enable"',
  ]);

  const mergedAxCompact = mergeFrameAxStates([
    { frameId: null, sessionId: null, nodes: nodes.map((n, idx) => ({ ...n, backendDOMNodeId: idx + 10 })) },
  ], { mode: "compact" });
  assert.ok(mergedAxCompact.lines.some((l) => l.includes("... (+3 similar listitem items omitted)")));
});

test("formatAriaSnapshot supports scoped subtree extraction by rootBackendDOMNodeId", () => {
  const nodes = [
    { nodeId: "root", role: { value: "RootWebArea" }, name: { value: "Portal" }, backendDOMNodeId: 1, childIds: ["main", "backdrop"] },
    { nodeId: "main", parentId: "root", role: { value: "main" }, backendDOMNodeId: 2, childIds: ["unrelatedBtn"] },
    { nodeId: "unrelatedBtn", parentId: "main", role: { value: "button" }, name: { value: "Outside" }, backendDOMNodeId: 3 },
    { nodeId: "backdrop", parentId: "root", role: { value: "generic" }, backendDOMNodeId: 40, childIds: ["dlg"] },
    { nodeId: "dlg", parentId: "backdrop", role: { value: "dialog" }, name: { value: "Case Details" }, backendDOMNodeId: 50, childIds: ["h", "close"] },
    { nodeId: "h", parentId: "dlg", role: { value: "heading" }, name: { value: "TC-01" }, backendDOMNodeId: 51, properties: [{ name: "level", value: { value: 2 } }] },
    { nodeId: "close", parentId: "dlg", role: { value: "button" }, name: { value: "Close" }, backendDOMNodeId: 52 },
  ];

  const scoped = formatAriaSnapshot(nodes, { mode: "compact", rootBackendDOMNodeId: 40 });
  assert.equal(scoped.matched, true);
  assert.deepEqual(scoped.text.split("\n"), [
    '- dialog "Case Details"',
    '  - heading "TC-01" [level=2]',
    '  - button "Close"',
  ]);

  const missing = formatAriaSnapshot(nodes, { mode: "compact", rootBackendDOMNodeId: 999 });
  assert.equal(missing.matched, false);
  assert.equal(missing.lineCount, 0);
  assert.equal(missing.text, "");
});
