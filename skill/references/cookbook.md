# codex-browser-use Cookbook (v4.7.0)

Copy-paste patterns for `browser_run` and `browser_batch`. All local file paths passed to `saveFile`, `readFile`, and `saveScreenshot` must be **absolute paths**; parent directories are created automatically.

---

## Recipe 1: Multi-Page Pagination + `saveFile` (Zero-Bloat Output)

Collect rows across pages, write the full dataset to disk, and return only `{ count, file, sample }` so chat context stays tiny.

```js
await browser.nameSession("Catalog Scrape", "blue");
const tab = await browser.tabs.new("https://example.com/catalog");

const rows = [];
for (let pageNum = 1; pageNum <= 5; pageNum++) {
  const tableRows = await tab.locator("css=table tbody tr").evaluateAll((trs) =>
    trs.map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.innerText.trim()))
  );
  rows.push(...tableRows.map((cells) => ({ page: pageNum, cells })));

  const nextBtn = tab.getByRole("button", { name: "Next" }).first();
  if (!(await nextBtn.isVisible()) || !(await nextBtn.isEnabled())) break;
  await nextBtn.click();
  await tab.waitFor({ text: "Page " + (pageNum + 1) });
}

const saved = await saveFile("/abs/path/artifacts/catalog-rows.json", rows);
return { count: rows.length, file: saved.path, bytes: saved.bytes, sample: rows.slice(0, 3) };
```

---

## Recipe 2: Passive Scan → Selective `claimTab`

Never attach the Chrome debugger or loop `tabs.get()` across unrelated personal tabs. Scan open tabs, read passively first, and claim only the matching tab if interaction is required.

```js
const open = await browser.user.openTabs();
const match = open.find((t) => /localhost:3000|staging\.example\.com/.test(t.url));
if (!match) return { found: false, openCount: open.length };

// Zero-debugger passive read (no yellow debugger bar)
const preview = await browser.tabs.read(match.tab_id);
log("Passive preview title: " + preview.title);

// Only claim if you actually need to click/type or inspect live CDP events
const tab = await browser.user.claimTab(match);
const snap = await tab.ariaSnapshot({ mode: "compact" });
log(snap.split("\n").slice(0, 30).join("\n"));

await tab.markDeliverable(); // Claimed user tabs are always released, never closed
return { claimedTabId: tab.tab_id, url: await tab.url() };
```

---

## Recipe 3: Rich-Text CMS Forms, `ax.paste` & `ax.selectText`

`locator.fill()` handles CKEditor 4/5, TinyMCE, Quill, and `[contenteditable]`, while `tab.ax.paste` and `tab.ax.selectText` work directly on AX indices for complex editors or inline replacements.

```js
const tab = await browser.tabs.new("https://example.com/cms/edit");
const draft = await readFile("/abs/path/draft-notes.txt");

// Disambiguate strict-mode multi-matches with .filter() / .first()
await tab.getByRole("textbox", { name: "Title" }).first().fill("Q4 Release Notes");

// Inspect compact AX tree to find editor index
const axText = await tab.ariaSnapshot({ mode: "compact" });
log(axText.split("\n").filter((l) => /textbox|editor|Publish|Save/i.test(l)).join("\n"));

// Paste large text cleanly without character-by-character typing delay
const bodyEditor = tab.locator("css=.ProseMirror, [contenteditable='true']").first();
await bodyEditor.click();
await tab.ax.paste(null, draft);

// Select and replace a target phrase inside an indexed field
await tab.ax.selectText(12, "DRAFT");
await tab.ax.paste(12, "FINAL");

await tab.getByRole("button", { name: /Publish/i }).filter({ hasNotText: "Schedule" }).click();
await tab.saveScreenshot("/abs/path/artifacts/cms-published.png", { emit: true });
await tab.markDeliverable();
```

---

## Recipe 4: Uploads & Long Archive Downloads (300s Cap)

Set `timeout_ms: 300000` on `browser_run` for large exports or slow CI/staging downloads.

```js
const tab = await browser.tabs.new("https://example.com/reports");

// 1. Upload local file via native file chooser event
const chooserPromise = tab.waitForEvent("filechooser");
await tab.getByRole("button", { name: "Import CSV" }).click();
const chooser = await chooserPromise;
await chooser.setFiles(["/abs/path/input/metrics.csv"]);

// 2. Trigger export and wait for download completion
const dlPromise = tab.waitForEvent("download", { timeoutMs: 240_000 });
await tab.getByRole("button", { name: "Download Full Archive" }).click();
const download = await dlPromise;
const downloadedPath = await download.path();

return { downloadedPath, suggestedFilename: download.suggestedFilename?.() };
```

---

## Recipe 5: Network Response Body Capture (`dev.responseBody`)

Enable body capture before triggering an action so you can inspect JSON payloads or error responses directly without scraping the UI.

```js
const tab = await browser.tabs.new();
await tab.dev.enableNetwork({ captureBodies: true });
await tab.goto("https://example.com/dashboard");

await tab.getByRole("button", { name: "Run Audit" }).click();
await tab.waitFor({ text: "Audit Complete" });

const requests = await tab.dev.network({ limit: 50 });
const apiReq = requests.find((r) => r.url.includes("/api/audit") && r.status === 200);
if (!apiReq) return { error: "Audit API call not found", failed: await tab.dev.network({ failedOnly: true }) };

const bodyResult = await tab.dev.responseBody(apiReq.requestId, { maxChars: 20_000 });
await saveFile("/abs/path/artifacts/audit-response.json", bodyResult.body);
return { status: apiReq.status, length: bodyResult.length, truncated: bodyResult.truncated };
```

---

## Recipe 6: Parallel `browser.tabs.content()` & Dual-Tab Popups

Use `browser.tabs.content(urls, opts)` when you only need clean extracted content from up to 10 URLs; use `browser.tabs.new()` + `waitForEvent("popup")` when interacting across tabs.

```js
// Pattern A: Parallel multi-URL read (auto-opens and auto-closes up to 10 temp tabs)
const pages = await browser.tabs.content(
  [
    "https://example.com/docs/install",
    "https://example.com/docs/api",
    "https://example.com/changelog",
  ],
  { format: "markdown", maxChars: 12_000, concurrency: 3, timeoutMs: 30_000 }
);
await saveFile("/abs/path/artifacts/docs-bundle.json", pages);

// Pattern B: Dual interactive tabs + auto-claimed target="_blank" popup
await browser.nameSession("Checkout QA", "green");
const [cartTab, helpTab] = await Promise.all([
  browser.tabs.new("https://example.com/cart"),
  browser.tabs.new("https://example.com/help"),
]);
const [popup] = await Promise.all([
  cartTab.waitForEvent("popup"),
  cartTab.getByRole("link", { name: /Terms/i }).click(),
]);
return {
  extractedCount: pages.filter((p) => p.ok).length,
  popupUrl: await popup.url(),
  helpTitle: await helpTab.evaluate(() => document.title),
};
```

---

## Recipe 7: Responsive QA, `elementScreenshot` & `nodeRepl` Alias

Capture tight element-level Proof of Work alongside mobile/desktop viewport checks without blowing up token limits.

```js
const tab = await browser.tabs.new("https://example.com/pricing");
await tab.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

const card = tab.locator("css=.pricing-tier").filter({ hasText: "Pro" }).first();
await card.scrollIntoViewIfNeeded?.();

// Tightly clipped element screenshot saved to disk + emitted to turn
await card.saveScreenshot("/abs/path/artifacts/pricing-pro-mobile.png", {
  padding: 12,
  format: "png",
  emit: true,
});

// Codex-style nodeRepl alias works directly
nodeRepl.write("Captured mobile Pro tier card");

await tab.resetViewport();
await tab.saveScreenshot("/abs/path/artifacts/pricing-desktop.jpg", {
  fullPage: false,
  format: "jpeg",
  quality: 80,
  emit: true,
});
await tab.markDeliverable();
```

---

## Recipe 8: Troubleshooting Table (Real-World Failure Fixes)

| Symptom / Error | Root Cause | Exact Fix |
| --- | --- | --- |
| `strict mode violation: resolved to N elements` | Ambiguous locator matched multiple nodes | Narrow with `.first()`, `.nth(i)`, or `.filter({ hasText, hasNotText, has })`. |
| `role=button[name="Save"]` with `{ exact: true }` times out | Button accessible name includes badge count or icon text (e.g. `"Save 3"`) | Inspect exact name via `ariaSnapshot({ mode: "compact" })` and drop `exact: true` or match `/Save/i`. |
| Unsaved form or React state vanished mid-flow | `goto(sameUrl)` triggered a full reload | Replace `goto(currentUrl)` with `await tab.reload()` or `browser_reload`. |
| Click succeeds in script or misses 2 times in a row | Element is inside an iframe/OOPIF, covered by an overlay, or index went stale | Stop blind retries after 2 misses: check `tab.frameLocator(...)`, `browser_inspect_element(x, y)`, or `locator.screenshot()`. |
| `evaluate` rejected with mutation/network error | `evaluate(fn, arg)` enforces read-only AST checks | Use `evaluate` only for reading DOM/computed styles/`dataset`/`classList`; perform writes with `.click()`, `.fill()`, or `ax.paste()`. |
| `saveFile` / `readFile` / `saveScreenshot` rejected | Relative path passed | Always pass an absolute path (e.g. `"/Users/.../out.json"`). |
| Login / 2FA / CAPTCHA / permission dialog blocks script | Security boundary reached | Call `await tab.markHandoff()`, stop automation, and ask the user to sign in manually. |
