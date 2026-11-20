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
