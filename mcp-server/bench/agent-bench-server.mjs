import http from "node:http";

/** Deterministic 8-case fixture across 2 paginated pages with modals, form, Shadow DOM, and audit channels. */
export const CASES = [
  { id: "TC-01", title: "Throughput Stability Check", status: "Passed", score: 410, secret_code: "SEC-01-K9M2" },
  { id: "TC-02", title: "Concurrent Session Isolation", status: "Passed", score: 385, secret_code: "SEC-02-P4X7" },
  { id: "TC-03", title: "Shadow DOM Event Dispatch", status: "Passed", score: 520, secret_code: "SEC-03-R8L1" },
  { id: "TC-04", title: "Cross-Origin Frame Routing", status: "Passed", score: 295, secret_code: "SEC-04-T6N3" },
  { id: "TC-05", title: "Modal Chunk Extraction", status: "Passed", score: 460, secret_code: "SEC-05-V2B9" },
  { id: "TC-06", title: "Rich-Text Asynchronous Sync", status: "Passed", score: 390, secret_code: "SEC-06-Z5H4" },
  { id: "TC-07", title: "Tab Group Retention Audit", status: "Passed", score: 515, secret_code: "SEC-07-J3D6" },
  { id: "TC-08", title: "End-Turn Leak Prevention", status: "Passed", score: 445, secret_code: "SEC-08-W4Q8" },
].map((item, idx) => ({
  ...item,
  payload: Array.from({ length: 24 }, (_, k) => `[${item.id}::SEG-${String(k + 1).padStart(2, "0")}] ABCDEFGHJKLMNPQRSTUVWXYZ0123456789`).join(" | ") + ` :: INDEX=${idx + 1}`,
}));

export const EXPECTED_TOTAL_SCORE = 3420;
export const AUDIT_ALPHA = "ALPHA-9482-OK";
export const AUDIT_BETA = "BETA-7315-OK";

function homeHtml() {
  const summaryRows = CASES.map(({ id, title, status }) => ({ id, title, status }));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Benchmark Cases Portal</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 920px; margin: 32px auto; padding: 0 20px; color: #111827; }
    header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #e5e7eb; padding-bottom: 12px; margin-bottom: 20px; }
    nav a { margin-left: 16px; color: #2563eb; text-decoration: none; font-weight: 600; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
    th, td { border: 1px solid #d1d5db; padding: 10px 12px; text-align: left; }
    th { background: #f3f4f6; }
    .pager { display: flex; align-items: center; gap: 12px; }
    .backdrop { position: fixed; inset: 0; background: rgba(17,24,39,0.5); display: flex; align-items: center; justify-content: center; }
    .dialog { background: #fff; padding: 20px; border-radius: 8px; max-width: 640px; width: 90%; box-shadow: 0 10px 25px rgba(0,0,0,0.2); }
    pre { background: #f9fafb; border: 1px solid #e5e7eb; padding: 8px; max-height: 160px; overflow: auto; white-space: pre-wrap; word-break: break-all; }
    button { padding: 6px 12px; cursor: pointer; }
  </style>
</head>
<body>
  <header>
    <h1>Evaluation Test Cases</h1>
    <nav>
      <a href="/">Cases</a>
      <a href="/submit">Submit Report</a>
      <a href="/audit/alpha">Audit Alpha</a>
      <a href="/audit/beta">Audit Beta</a>
    </nav>
  </header>
  <main>
    <p>Inspect every test case across both pages using <strong>View details</strong> to collect <code>score</code> and <code>secret_code</code>.</p>
    <table aria-label="Test cases table">
      <thead>
        <tr><th>Case ID</th><th>Title</th><th>Status</th><th>Action</th></tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>
    <div class="pager">
      <button type="button" id="prevBtn">Previous page</button>
      <span id="pageInfo">Page 1 of 2</span>
      <button type="button" id="nextBtn">Next page</button>
    </div>
  </main>
  <div id="modalRoot"></div>
  <script>
    const ALL_ROWS = ${JSON.stringify(summaryRows)};
    const PAGE_SIZE = 4;
    let currentPage = 0;

    function renderTable() {
      const tbody = document.getElementById("rows");
      const start = currentPage * PAGE_SIZE;
      const slice = ALL_ROWS.slice(start, start + PAGE_SIZE);
      tbody.innerHTML = slice.map((r) => \`
        <tr data-case-id="\${r.id}">
          <td>\${r.id}</td>
          <td>\${r.title}</td>
          <td>\${r.status}</td>
          <td><button type="button" class="view-btn" data-id="\${r.id}">View details</button></td>
        </tr>
      \`).join("");
      const totalPages = Math.ceil(ALL_ROWS.length / PAGE_SIZE);
      document.getElementById("pageInfo").textContent = \`Page \${currentPage + 1} of \${totalPages}\`;
      document.getElementById("prevBtn").disabled = currentPage === 0;
      document.getElementById("nextBtn").disabled = currentPage >= totalPages - 1;
      for (const btn of tbody.querySelectorAll(".view-btn")) {
        btn.addEventListener("click", () => openCaseModal(btn.getAttribute("data-id")));
      }
    }

    async function openCaseModal(id) {
      const resp = await fetch("/api/case/" + encodeURIComponent(id), { cache: "no-store" });
      const data = await resp.json();
      const root = document.getElementById("modalRoot");
      root.innerHTML = \`
        <div class="backdrop">
          <div class="dialog" role="dialog" aria-modal="true" aria-label="Case Details \${data.id}">
            <h2>Case Details: \${data.id}</h2>
            <h6>Case ID</h6><pre><code>\${data.id}</code></pre>
            <h6>Score</h6><pre><code>\${data.score}</code></pre>
            <h6>Secret Code</h6><pre><code>\${data.secret_code}</code></pre>
            <h6>Payload</h6><pre><code>\${data.payload}</code></pre>
            <button type="button" id="closeModalBtn">Close</button>
          </div>
        </div>
      \`;
      document.getElementById("closeModalBtn").addEventListener("click", () => { root.innerHTML = ""; });
    }

    document.getElementById("prevBtn").addEventListener("click", () => {
      if (currentPage > 0) { currentPage--; renderTable(); }
    });
    document.getElementById("nextBtn").addEventListener("click", () => {
      if ((currentPage + 1) * PAGE_SIZE < ALL_ROWS.length) { currentPage++; renderTable(); }
    });
    renderTable();
  </script>
</body>
</html>`;
}

function submitHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Submit Evaluation Report</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 720px; margin: 32px auto; padding: 0 20px; color: #111827; }
    .field { margin-bottom: 16px; }
    label { display: block; font-weight: 600; margin-bottom: 6px; }
    input[type="text"], input[type="number"], select { width: 100%; padding: 8px 10px; box-sizing: border-box; font-size: 15px; }
    #notes { min-height: 70px; border: 1px solid #9ca3af; border-radius: 4px; padding: 8px 10px; background: #fff; }
    .check-row { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
    .check-row label { margin: 0; }
    #receipt { margin-top: 20px; padding: 14px 16px; border-radius: 6px; border: 2px solid #16a34a; background: #ecfdf5; color: #065f46; display: none; }
    #errorBox { margin-top: 16px; padding: 12px; border: 1px solid #dc2626; background: #fef2f2; color: #991b1b; display: none; }
  </style>
</head>
<body>
  <h1>Submit Evaluation Report</h1>
  <form id="evalForm">
    <div class="field">
      <label for="team">Team Name</label>
      <input id="team" name="team" type="text" placeholder="Enter team name" />
    </div>
    <div class="field">
      <label for="category">Category</label>
      <select id="category" name="category">
        <option value="General">General</option>
        <option value="Performance">Performance</option>
        <option value="Security">Security</option>
      </select>
    </div>
    <div class="field">
      <label for="totalScore">Total Score</label>
      <input id="totalScore" name="totalScore" type="number" placeholder="0" />
    </div>
    <div class="check-row">
      <input id="certify" name="certify" type="checkbox" />
      <label for="certify">Certify accuracy</label>
    </div>
    <div class="field">
      <label for="notes">Notes</label>
      <div id="notes" contenteditable="true" role="textbox" aria-label="Notes" tabindex="0"></div>
    </div>
    <submit-bar id="submitBar"></submit-bar>
  </form>
  <div id="errorBox" role="alert"></div>
  <div id="receipt" role="status">Submission accepted: <strong id="receiptId"></strong></div>
  <script>
    class SubmitBar extends HTMLElement {
      connectedCallback() {
        const root = this.attachShadow({ mode: "open" });
        root.innerHTML = \`
          <style>
            button { background: #2563eb; color: #fff; border: 0; border-radius: 6px; padding: 10px 18px; font-size: 15px; font-weight: 600; cursor: pointer; }
            button:hover { background: #1d4ed8; }
          </style>
          <button type="button" id="submitBtn">Submit Evaluation</button>
        \`;
        root.getElementById("submitBtn").addEventListener("click", handleSubmit);
      }
    }
    customElements.define("submit-bar", SubmitBar);

    async function handleSubmit() {
      const errorBox = document.getElementById("errorBox");
      const receipt = document.getElementById("receipt");
      errorBox.style.display = "none";
      const payload = {
        team: document.getElementById("team").value.trim(),
        category: document.getElementById("category").value,
        total_score: Number(document.getElementById("totalScore").value),
        certified: document.getElementById("certify").checked,
        notes: (document.getElementById("notes").innerText || document.getElementById("notes").textContent || "").trim(),
      };
      if (!payload.team || !payload.certified || !Number.isFinite(payload.total_score) || !payload.notes) {
        errorBox.textContent = "All fields and accuracy certification are required.";
        errorBox.style.display = "block";
        return;
      }
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        errorBox.textContent = data.error || "Submission failed";
        errorBox.style.display = "block";
        return;
      }
      document.getElementById("receiptId").textContent = data.receipt_id;
      receipt.style.display = "block";
    }
  </script>
</body>
</html>`;
}

function auditHtml(name, token) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Audit ${name}</title></head>
<body style="font-family: sans-serif; max-width: 640px; margin: 40px auto;">
  <h1>Audit Channel: ${name}</h1>
  <p>Verification token for channel ${name}: <strong id="auditToken">${token}</strong></p>
  <p>All automated browser actions must preserve session hygiene and tab isolation.</p>
</body>
</html>`;
}

/**
 * Start a deterministic HTTP server for end-to-end Chrome agent benchmarking.
 * @returns {Promise<{baseUrl:string, close:()=>Promise<void>}>}
 */
export function startBenchServer() {
  const state = {
    label: "idle",
    submissions: [],
    httpEvents: [],
    caseFetches: [],
    firstHitMs: null,
    lastHitMs: null,
    seq: 0,
  };

  function recordHit(req) {
    if (req.url.startsWith("/__bench/") || req.url === "/favicon.ico") return;
    const now = Date.now();
    if (state.firstHitMs === null) state.firstHitMs = now;
    state.lastHitMs = now;
    state.httpEvents.push({ ts: now, method: req.method, url: req.url });
  }

  const server = http.createServer(async (req, res) => {
    const parsed = new URL(req.url, "http://127.0.0.1");
    recordHit(req);

    if (req.method === "POST" && parsed.pathname === "/__bench/reset") {
      state.label = parsed.searchParams.get("label") || "run";
      state.submissions = [];
      state.httpEvents = [];
      state.caseFetches = [];
      state.firstHitMs = null;
      state.lastHitMs = null;
      state.seq = 0;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, label: state.label }));
      return;
    }

    if (req.method === "GET" && parsed.pathname === "/__bench/stats") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state));
      return;
    }

    if (req.method === "GET" && parsed.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(homeHtml());
      return;
    }

    if (req.method === "GET" && parsed.pathname === "/submit") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(submitHtml());
      return;
    }

    if (req.method === "GET" && parsed.pathname === "/audit/alpha") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(auditHtml("Alpha", AUDIT_ALPHA));
      return;
    }

    if (req.method === "GET" && parsed.pathname === "/audit/beta") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(auditHtml("Beta", AUDIT_BETA));
      return;
    }

    if (req.method === "GET" && parsed.pathname.startsWith("/api/case/")) {
      const id = decodeURIComponent(parsed.pathname.slice("/api/case/".length));
      const found = CASES.find((c) => c.id === id);
      if (!found) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }
      state.caseFetches.push(id);
      await new Promise((r) => setTimeout(r, 30));
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(found));
      return;
    }

    if (req.method === "POST" && parsed.pathname === "/api/submit") {
      const chunks = [];
      for await (const ch of req) chunks.push(ch);
      const raw = Buffer.concat(chunks).toString("utf8");
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        return;
      }
      state.seq += 1;
      const receipt_id = `RCPT-${state.label.toUpperCase()}-${String(state.seq).padStart(3, "0")}`;
      const record = { ...data, receipt_id, ts: Date.now() };
      state.submissions.push(record);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, receipt_id }));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
