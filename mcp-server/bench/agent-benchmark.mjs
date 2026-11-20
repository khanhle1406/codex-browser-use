#!/usr/bin/env node
/**
 * Live Chrome agent regression benchmark comparing:
 *   - `codex_native`: Codex CLI with its bundled Chrome plugin (`node_repl:js`)
 *   - `codex_mcp`:    Codex CLI on the exact same model wired to `codex-browser-use` (`--profile compact`)
 *   - `agy_mcp`:      Antigravity CLI wired to `codex-browser-use`
 *
 * Usage:
 *   node bench/agent-benchmark.mjs [--mode same-model|head-to-head|all] [--model gpt-6.1-terra] [--reasoning medium] [--agy-model gemini-3.8-flash-medium] [--out DIR]
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultBridgeFile } from "../src/backend-discovery.js";
import { stableNodePath } from "../src/config.js";
import { discoverEngine } from "../src/engine-discovery.js";
import { AUDIT_ALPHA, AUDIT_BETA, CASES, EXPECTED_TOTAL_SCORE, startBenchServer } from "./agent-bench-server.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SERVER_ENTRY = path.join(REPO_ROOT, "mcp-server", "src", "server.js");
const SKILL_MD = path.join(REPO_ROOT, "skill", "SKILL.md");

function parseCliArgs(argv) {
  const opts = {
    mode: "same-model",
    model: "gpt-6.1-terra",
    reasoning: "medium",
    agyModel: "gemini-3.8-flash-medium",
    outDir: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mode") opts.mode = argv[++i];
    else if (a === "--model") opts.model = argv[++i];
    else if (a === "--reasoning") opts.reasoning = argv[++i];
    else if (a === "--agy-model") opts.agyModel = argv[++i];
    else if (a === "--out") opts.outDir = path.resolve(argv[++i]);
    else if (a === "--help" || a === "-h") {
      console.log("Usage: node bench/agent-benchmark.mjs [--mode same-model|head-to-head|all] [--model gpt-6.1-terra] [--reasoning medium] [--agy-model gemini-3.8-flash-medium] [--out DIR]");
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${a}`);
    }
  }
  if (!["same-model", "head-to-head", "all"].includes(opts.mode)) {
    throw new Error(`Invalid --mode ${opts.mode}; expected same-model, head-to-head, or all`);
  }
  return opts;
}

function buildPrompt(baseUrl, outDir, sessionLabel, toolRoutingNote) {
  return [
    `Use your real Chrome browser automation tool ONLY (do NOT use curl, wget, fetch/HTTP from terminal/Node/Python) to complete all 4 tasks below cleanly and quickly.`,
    toolRoutingNote,
    `Name your Chrome browser session "${sessionLabel}".`,
    ``,
    `Task 1:`,
    `- Open ${baseUrl}/ in Chrome.`,
    `- Across both pages (Page 1 and Page 2, clicking "Next page"), click "View details" on EVERY row TC-01 through TC-08 to read each case's id, numeric score, and secret_code from the modal dialog (and close each modal).`,
    `- Save the sorted array of all 8 objects [{ "id", "score", "secret_code" }] to ${outDir}/cases.json.`,
    ``,
    `Task 2:`,
    `- Navigate to ${baseUrl}/submit.`,
    `- Fill: Team Name = "BenchRunner", Category = "Performance", Total Score = exact sum of all 8 scores, check "Certify accuracy", and enter "Verified all 8 cases: TC-01..TC-08" in Notes.`,
    `- Click "Submit Evaluation" and read the confirmation receipt_id (RCPT-...).`,
    ``,
    `Task 3:`,
    `- Save a visual proof-of-work screenshot showing the confirmation banner to ${outDir}/proof.jpg (or ${outDir}/proof.png).`,
    `- Open ${baseUrl}/audit/alpha and ${baseUrl}/audit/beta in Chrome and read both verification tokens (ALPHA-... and BETA-...).`,
    ``,
    `Task 4:`,
    `- Write ${outDir}/report.json with exact JSON keys:`,
    `  { "cases_count": 8, "total_score": number, "receipt_id": string, "audit_alpha": string, "audit_beta": string, "cases": [{ "id", "score", "secret_code" }] }`,
    `- Clean up your temporary browser tabs / end your browser turn when done, then reply with a brief JSON summary.`,
  ].join("\n");
}

function runProcess(cmd, args, { cwd, timeoutMs, stdoutFile, stderrFile }) {
  return new Promise((resolve) => {
    const startMs = Date.now();
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const outChunks = [];
    const errChunks = [];
    const timedLines = [];
    let outBuf = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      const ts = Date.now();
      outChunks.push(d);
      outBuf += d.toString("utf8");
      const lines = outBuf.split(/\r?\n/);
      outBuf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("{")) timedLines.push({ ts, raw: trimmed });
      }
    });
    child.stderr.on("data", (d) => errChunks.push(d));

    child.on("close", async (code, signal) => {
      clearTimeout(timer);
      const endMs = Date.now();
      const tail = outBuf.trim();
      if (tail.startsWith("{")) timedLines.push({ ts: endMs, raw: tail });
      const stdout = Buffer.concat(outChunks).toString("utf8");
      const stderr = Buffer.concat(errChunks).toString("utf8");
      await writeFile(stdoutFile, stdout, "utf8");
      await writeFile(stderrFile, stderr, "utf8");
      resolve({ startMs, endMs, wallClockMs: endMs - startMs, exitCode: code, signal, timedOut, stdout, stderr, timedLines });
    });
  });
}

function parseTimedJsonLines(timedLines, fallbackText) {
  const out = [];
  if (Array.isArray(timedLines) && timedLines.length > 0) {
    for (const entry of timedLines) {
      try {
        out.push({ ts: entry.ts, ev: JSON.parse(entry.raw) });
      } catch {
        // Ignore partial non-JSON lines.
      }
    }
    return out;
  }
  for (const line of String(fallbackText || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      out.push({ ts: null, ev: JSON.parse(trimmed) });
    } catch {
      // Ignore partial non-JSON lines.
    }
  }
  return out;
}

async function findCodexRollout(threadId) {
  if (!threadId) return null;
  const roots = [process.env.CODEX_HOME, path.join(os.homedir(), ".codex")].filter(Boolean);
  for (const root of roots) {
    const sessionsDir = path.join(root, "sessions");
    try {
      const entries = await readdir(sessionsDir, { recursive: true });
      const match = entries.find((e) => typeof e === "string" && e.endsWith(".jsonl") && e.includes(threadId));
      if (match) return path.join(sessionsDir, match);
    } catch {
      // Ignore missing directory.
    }
  }
  return null;
}

async function parseCodexEvents(proc) {
  const timed = parseTimedJsonLines(proc.timedLines, proc.stdout);
  let threadId = null;
  let totalToolCalls = 0;
  let browserToolCalls = 0;
  let nonBrowserToolCalls = 0;
  let skillReadCalls = 0;
  let toolErrors = 0;
  let browserExecMs = 0;
  const startedAt = new Map();
  const toolBreakdown = {};
  const usageTotals = {
    inputTokens: 0,
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    turns: 0,
  };

  for (const { ts, ev } of timed) {
    if (ev.type === "thread.started" && ev.thread_id) {
      threadId = ev.thread_id;
    }
    if (ev.type === "turn.completed" && ev.usage) {
      usageTotals.turns += 1;
      const inp = Number(ev.usage.input_tokens || 0);
      const cached = Number(ev.usage.cached_input_tokens || 0);
      usageTotals.inputTokens += inp;
      usageTotals.cachedInputTokens += cached;
      usageTotals.uncachedInputTokens += Math.max(0, inp - cached);
      usageTotals.cacheWriteTokens += Number(ev.usage.cache_write_input_tokens || 0);
      usageTotals.outputTokens += Number(ev.usage.output_tokens || 0);
      usageTotals.reasoningTokens += Number(ev.usage.reasoning_output_tokens || 0);
    }
    if (ev.type === "item.started" && ev.item?.id && ts != null) {
      startedAt.set(ev.item.id, ts);
    }
    const item = ev.item;
    if (
      ev.type === "item.completed" &&
      item &&
      (item.type === "mcp_tool_call" || item.type === "command_execution" || item.type === "custom_tool_call" || item.type === "function_call")
    ) {
      totalToolCalls += 1;
      const rawText = JSON.stringify(item);
      const isNodeReplMcp = item.type === "mcp_tool_call" && item.server === "node_repl";
      const isBrowserUseMcp = item.type === "mcp_tool_call" && (item.server === "browser_use" || item.server === "browser-use");
      const isCodexBrowserMeta = Boolean(item.result?._meta?.["codex/browserUse"]);
      const isCodeModeExec = item.type === "custom_tool_call" && item.name === "exec";
      const isSkillCat = item.type === "command_execution" && String(item.command || "").includes("SKILL.md");
      if (isSkillCat) skillReadCalls += 1;

      const toolName = item.type === "mcp_tool_call"
        ? `${item.server || "mcp"}:${item.tool || "call"}`
        : isSkillCat
          ? "command_execution(skill)"
          : (item.name ? `${item.type}:${item.name}` : item.type);
      toolBreakdown[toolName] = (toolBreakdown[toolName] || 0) + 1;

      const isBrowser =
        isBrowserUseMcp ||
        isNodeReplMcp ||
        isCodexBrowserMeta ||
        (isCodeModeExec && (rawText.includes("node_repl") || rawText.includes("browser-client") || rawText.includes("browser_run")));

      const metaMs = Number(item.result?._meta?.["codex/nodeReplExecutionDurationMs"] || 0);
      const elapsedMs = (ts != null && startedAt.has(item.id)) ? Math.max(0, ts - startedAt.get(item.id)) : 0;
      if (isBrowser) {
        browserToolCalls += 1;
        browserExecMs += metaMs > 0 ? metaMs : elapsedMs;
      } else {
        nonBrowserToolCalls += 1;
      }

      if (
        item.error ||
        item.status === "failed" ||
        (item.exit_code !== undefined && item.exit_code !== null && item.exit_code !== 0) ||
        item.result?.isError === true
      ) {
        toolErrors += 1;
      }
    }
  }

  let rolloutCheck = null;
  const rolloutPath = await findCodexRollout(threadId);
  if (rolloutPath) {
    try {
      const rEvents = parseTimedJsonLines(null, await readFile(rolloutPath, "utf8"));
      let customCalls = 0;
      let execCalls = 0;
      for (const { ev: rl } of rEvents) {
        if (rl.type === "response_item" && rl.payload?.type === "custom_tool_call") {
          customCalls += 1;
          if (rl.payload.name === "exec") execCalls += 1;
        }
      }
      rolloutCheck = { rolloutPath, customCalls, execCalls };
    } catch {
      rolloutCheck = { rolloutPath, readError: true };
    }
  }

  return {
    eventCount: timed.length,
    threadId,
    totalToolCalls,
    browserToolCalls,
    nonBrowserToolCalls,
    skillReadCalls,
    schemaReadCalls: 0,
    builtinBrowserCalls: 0,
    browserExecMs: Math.round(browserExecMs),
    modelDurationMs: null,
    toolErrors,
    toolBreakdown,
    usageTotals,
    rolloutCheck,
  };
}

function parseAgyEvents(proc) {
  const timed = parseTimedJsonLines(proc.timedLines, proc.stdout);
  let conversationId = null;
  let totalToolCalls = 0;
  let browserToolCalls = 0;
  let nonBrowserToolCalls = 0;
  let schemaReadCalls = 0;
  let skillReadCalls = 0;
  let builtinBrowserCalls = 0;
  let toolErrors = 0;
  let browserExecMs = 0;
  let modelDurationMs = 0;
  const toolBreakdown = {};
  const usageTotals = {
    inputTokens: 0,
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    apiReportedTotalTokens: 0,
    turns: 0,
  };

  const finalSteps = new Map();
  for (const { ev } of timed) {
    if (ev.event === "init" && ev.conversation_id) conversationId = ev.conversation_id;
    if (ev.event === "step_update" && ev.step_update?.step_index !== undefined) {
      finalSteps.set(ev.step_update.step_index, ev.step_update);
    }
  }

  for (const s of finalSteps.values()) {
    if (!["DONE", "ERROR", "FAILED", "CANCELLED"].includes(s.state)) continue;
    if (s.step_type === "agent_response") {
      usageTotals.turns += 1;
      modelDurationMs += Number(s.duration_seconds || 0) * 1000;
      if (s.usage) {
        const uncached = Number(s.usage.input_tokens || 0);
        const cached = Number(s.usage.cache_read_tokens || 0);
        usageTotals.uncachedInputTokens += uncached;
        usageTotals.cachedInputTokens += cached;
        usageTotals.inputTokens += uncached + cached;
        usageTotals.outputTokens += Number(s.usage.output_tokens || 0);
        usageTotals.thinkingTokens += Number(s.usage.thinking_tokens || 0);
        usageTotals.apiReportedTotalTokens += Number(s.usage.total_tokens || 0);
      }
    } else if (s.step_type === "tool") {
      totalToolCalls += 1;
      const durMs = Number(s.duration_seconds || 0) * 1000;
      const tName = s.tool_name || s.tool_info?.name || "unknown";
      const params = s.tool_info?.parameters || {};
      const outputStr = String(s.tool_info?.output || "");

      if (tName === "call_mcp_tool") {
        const server = params.ServerName || "mcp";
        const tool = params.ToolName || "unknown";
        const label = `mcp:${server}:${tool}`;
        toolBreakdown[label] = (toolBreakdown[label] || 0) + 1;
        if (server === "browser-use") {
          browserToolCalls += 1;
          browserExecMs += durMs;
        } else {
          nonBrowserToolCalls += 1;
        }
      } else if (tName.startsWith("mcp_browser-use_")) {
        toolBreakdown[tName] = (toolBreakdown[tName] || 0) + 1;
        browserToolCalls += 1;
        browserExecMs += durMs;
      } else if (tName === "read_file" || tName === "view_file") {
        const targetPath = String(params.Path || params.AbsolutePath || "");
        let label = tName;
        if (targetPath.includes("/mcp/browser-use/")) {
          schemaReadCalls += 1;
          label = `${tName}(mcp-schema)`;
        } else if (targetPath.includes("SKILL.md")) {
          skillReadCalls += 1;
          label = `${tName}(skill)`;
        }
        toolBreakdown[label] = (toolBreakdown[label] || 0) + 1;
        nonBrowserToolCalls += 1;
      } else if (
        tName.startsWith("browser_") ||
        ["open_browser_url", "execute_browser_javascript", "read_browser_page", "click_browser_pixel", "capture_browser_screenshot"].includes(tName)
      ) {
        toolBreakdown[`builtin:${tName}`] = (toolBreakdown[`builtin:${tName}`] || 0) + 1;
        builtinBrowserCalls += 1;
        nonBrowserToolCalls += 1;
      } else {
        toolBreakdown[tName] = (toolBreakdown[tName] || 0) + 1;
        nonBrowserToolCalls += 1;
      }

      if (s.state === "ERROR" || s.state === "FAILED" || Boolean(s.tool_info?.error) || outputStr.includes('"isError": true') || outputStr.includes('"isError":true')) {
        toolErrors += 1;
      }
    }
  }

  return {
    eventCount: timed.length,
    conversationId,
    totalToolCalls,
    browserToolCalls,
    nonBrowserToolCalls,
    schemaReadCalls,
    skillReadCalls,
    builtinBrowserCalls,
    browserExecMs: Math.round(browserExecMs),
    modelDurationMs: Math.round(modelDurationMs),
    toolErrors,
    toolBreakdown,
    usageTotals,
    rolloutCheck: null,
  };
}

async function gradeRun(outDir, stats) {
  let points = 0;
  const details = {};

  let casesPts = 0;
  try {
    const raw = JSON.parse(await readFile(path.join(outDir, "cases.json"), "utf8"));
    const arr = Array.isArray(raw) ? raw : (Array.isArray(raw?.cases) ? raw.cases : []);
    for (const exp of CASES) {
      const m = arr.find((c) => c?.id === exp.id);
      if (m && Number(m.score) === exp.score && m.secret_code === exp.secret_code) casesPts += 5;
    }
  } catch (e) {
    details.casesError = e.message;
  }
  points += casesPts;
  details.casesPoints = casesPts;

  let submitPts = 0;
  const sub = stats.submissions.at(-1) || null;
  if (sub) {
    if (sub.team === "BenchRunner") submitPts += 6;
    if (sub.category === "Performance") submitPts += 6;
    if (Number(sub.total_score) === EXPECTED_TOTAL_SCORE) submitPts += 6;
    if (sub.certified === true) submitPts += 6;
    if (typeof sub.notes === "string" && sub.notes.includes("TC-01..TC-08")) submitPts += 6;
  }
  points += submitPts;
  details.submitPoints = submitPts;
  details.submissionCount = stats.submissions.length;

  let reportPts = 0;
  try {
    const rep = JSON.parse(await readFile(path.join(outDir, "report.json"), "utf8"));
    if (Number(rep.cases_count) === 8) reportPts += 4;
    if (Number(rep.total_score) === EXPECTED_TOTAL_SCORE) reportPts += 4;
    if (sub && rep.receipt_id === sub.receipt_id) reportPts += 4;
    if (rep.audit_alpha === AUDIT_ALPHA) reportPts += 4;
    if (rep.audit_beta === AUDIT_BETA) reportPts += 4;
  } catch (e) {
    details.reportError = e.message;
  }
  points += reportPts;
  details.reportPoints = reportPts;

  let shotPts = 0;
  for (const name of ["proof.jpg", "proof.png"]) {
    try {
      const p = path.join(outDir, name);
      const info = await stat(p);
      const buf = await readFile(p);
      const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
      const isPng = buf.subarray(0, 4).toString("hex") === "89504e47";
      if (info.size > 2048 && (isJpg || isPng)) {
        shotPts = 10;
        details.screenshotFile = name;
        details.screenshotBytes = info.size;
        break;
      }
    } catch {
      // Check next extension.
    }
  }
  points += shotPts;
  details.screenshotPoints = shotPts;
  details.uniqueCaseModalsFetched = new Set(stats.caseFetches).size;
  details.totalCaseModalFetches = stats.caseFetches.length;
  details.httpEventsCount = stats.httpEvents.length;

  return { score: points, maxScore: 100, details };
}

function summarizeTrack(label, proc, stats, tel, grade) {
  return {
    model: label,
    timing: {
      exitCode: proc.exitCode,
      timedOut: proc.timedOut,
      wallClockMs: proc.wallClockMs,
      ttfaMs: stats.firstHitMs ? stats.firstHitMs - proc.startMs : null,
      browserActiveMs: (stats.firstHitMs && stats.lastHitMs) ? (stats.lastHitMs - stats.firstHitMs) : null,
      browserExecMs: tel.browserExecMs,
      modelDurationMs: tel.modelDurationMs,
      totalToolCalls: tel.totalToolCalls,
      browserToolCalls: tel.browserToolCalls,
      nonBrowserToolCalls: tel.nonBrowserToolCalls,
      schemaReadCalls: tel.schemaReadCalls,
      skillReadCalls: tel.skillReadCalls,
      builtinBrowserCalls: tel.builtinBrowserCalls,
      toolErrors: tel.toolErrors,
      httpEventsCount: stats.httpEvents.length,
      browserOpsPerToolCall: tel.browserToolCalls > 0 ? Number((stats.httpEvents.length / tel.browserToolCalls).toFixed(2)) : null,
      toolBreakdown: tel.toolBreakdown,
      usageTotals: tel.usageTotals,
      rolloutCheck: tel.rolloutCheck,
    },
    grade,
  };
}

async function resolveCodexSkillPath() {
  try {
    const engine = await discoverEngine();
    const p = path.join(engine.path, "skills", "control-chrome", "SKILL.md");
    if (existsSync(p)) return p;
  } catch {
    // Fallback if engine lives under default ~/.codex even when CODEX_HOME overrides it.
  }
  const fallback = await discoverEngine({ env: {} });
  return path.join(fallback.path, "skills", "control-chrome", "SKILL.md");
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  const outRoot = opts.outDir ?? await mkdtemp(path.join(os.tmpdir(), "agent-browser-bench-"));
  await mkdir(outRoot, { recursive: true });

  const srv = await startBenchServer();
  const bridgeFile = path.resolve(process.env.BROWSER_USE_BRIDGE_FILE ?? defaultBridgeFile());
  const codexBin = existsSync("/opt/homebrew/bin/codex") ? "/opt/homebrew/bin/codex" : "codex";
  const agyBin = existsSync(path.join(os.homedir(), ".local/bin/agy")) ? path.join(os.homedir(), ".local/bin/agy") : "agy";
  const summary = { timestamp: new Date().toISOString(), mode: opts.mode, outRoot, baseUrl: srv.baseUrl, tracks: {} };

  try {
    const wantCodexNative = opts.mode === "same-model" || opts.mode === "head-to-head" || opts.mode === "all";
    const wantCodexMcp = opts.mode === "same-model" || opts.mode === "all";
    const wantAgyMcp = opts.mode === "head-to-head" || opts.mode === "all";

    if (wantCodexNative) {
      const skillPath = await resolveCodexSkillPath();
      const dir = path.join(outRoot, "run-codex-native");
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      await fetch(`${srv.baseUrl}/__bench/reset?label=codex-native`, { method: "POST" });
      const prompt = buildPrompt(
        srv.baseUrl,
        dir,
        "Bench Codex Native",
        `Tool routing: Use ONLY Codex's built-in "chrome" plugin (${skillPath}) via mcp__node_repl__js (setupBrowserRuntime -> agent.browsers.get("chrome")). Ignore codex-browser-use and browser-routing skills completely.`,
      );
      const proc = await runProcess(codexBin, [
        "exec", "-m", opts.model, "-c", `model_reasoning_effort=${JSON.stringify(opts.reasoning)}`,
        "--json", "--trust", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check",
        "-C", dir, "-o", path.join(dir, "final-msg.txt"), prompt,
      ], {
        cwd: dir,
        timeoutMs: 240_000,
        stdoutFile: path.join(outRoot, "codex-native-events.jsonl"),
        stderrFile: path.join(outRoot, "codex-native-stderr.log"),
      });
      const stats = await (await fetch(`${srv.baseUrl}/__bench/stats`)).json();
      summary.tracks.codex_native = summarizeTrack(
        `${opts.model} (${opts.reasoning}) + Chrome plugin`,
        proc,
        stats,
        await parseCodexEvents(proc),
        await gradeRun(dir, stats),
      );
      await new Promise((r) => setTimeout(r, 2500));
    }

    if (wantCodexMcp) {
      const dir = path.join(outRoot, "run-codex-mcp");
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      await fetch(`${srv.baseUrl}/__bench/reset?label=codex-mcp`, { method: "POST" });
      const prompt = buildPrompt(
        srv.baseUrl,
        dir,
        "Bench Codex MCP",
        `Tool routing: Use ONLY the "browser_use" MCP server tools (mcp__browser_use__browser_run, mcp__browser_use__browser_batch, mcp__browser_use__browser_get_state, mcp__browser_use__browser_end_turn) following ${SKILL_MD}. Do NOT read control-chrome or call node_repl / setupBrowserRuntime.`,
      );
      const proc = await runProcess(codexBin, [
        "exec", "-m", opts.model,
        "-c", `model_reasoning_effort=${JSON.stringify(opts.reasoning)}`,
        "-c", `mcp_servers.browser_use.command=${JSON.stringify(stableNodePath())}`,
        "-c", `mcp_servers.browser_use.args=${JSON.stringify([SERVER_ENTRY, "--profile", "compact"])}`,
        "-c", "mcp_servers.browser_use.startup_timeout_sec=30",
        "-c", "mcp_servers.browser_use.tool_timeout_sec=180",
        "-c", `mcp_servers.browser_use.env={BROWSER_USE_BRIDGE_FILE=${JSON.stringify(bridgeFile)}}`,
        "--json", "--trust", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check",
        "-C", dir, "-o", path.join(dir, "final-msg.txt"), prompt,
      ], {
        cwd: dir,
        timeoutMs: 240_000,
        stdoutFile: path.join(outRoot, "codex-mcp-events.jsonl"),
        stderrFile: path.join(outRoot, "codex-mcp-stderr.log"),
      });
      const stats = await (await fetch(`${srv.baseUrl}/__bench/stats`)).json();
      summary.tracks.codex_mcp = summarizeTrack(
        `${opts.model} (${opts.reasoning}) + codex-browser-use`,
        proc,
        stats,
        await parseCodexEvents(proc),
        await gradeRun(dir, stats),
      );
      await new Promise((r) => setTimeout(r, 2500));
    }

    if (wantAgyMcp) {
      const dir = path.join(outRoot, "run-agy-mcp");
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      await fetch(`${srv.baseUrl}/__bench/reset?label=agy-mcp`, { method: "POST" });
      const prompt = buildPrompt(
        srv.baseUrl,
        dir,
        "Bench AGY",
        [
          `Tool routing: Use ONLY the "browser-use" MCP server (following ${path.join(os.homedir(), ".gemini/config/skills/codex-browser-use/SKILL.md")}).`,
          `Read MCP tool schemas as needed from ${path.join(os.homedir(), ".gemini/antigravity-cli/mcp/browser-use/")} (such as browser_run.json, browser_batch.json, browser_get_state.json, browser_end_turn.json) and invoke them with call_mcp_tool (ServerName: "browser-use").`,
          `Do NOT use built-in open_browser_url, browser_click_element, browser_input, execute_browser_javascript, or read_browser_page.`,
        ].join(" "),
      );
      const proc = await runProcess(agyBin, [
        "--model", opts.agyModel,
        "--output-format", "stream-json",
        "--dangerously-skip-permissions",
        "--add-dir", dir,
        "--print-timeout", "240s",
        `-p=${prompt}`,
      ], {
        cwd: dir,
        timeoutMs: 250_000,
        stdoutFile: path.join(outRoot, "agy-mcp-events.jsonl"),
        stderrFile: path.join(outRoot, "agy-mcp-stderr.log"),
      });
      const stats = await (await fetch(`${srv.baseUrl}/__bench/stats`)).json();
      summary.tracks.agy_mcp = summarizeTrack(
        `${opts.agyModel} + codex-browser-use`,
        proc,
        stats,
        parseAgyEvents(proc),
        await gradeRun(dir, stats),
      );
    }

    await writeFile(path.join(outRoot, "benchmark-summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await srv.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
