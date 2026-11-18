import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

/** @typedef {{type: 'text', text: string} | {type: 'image', data: string, mimeType: string}} ContentItem */
/** @typedef {{content: ContentItem[], isError?: boolean}} EvaluationResult */
/** @typedef {{enginePath?: string, requestMeta?: Record<string, unknown>, env?: Record<string, string>, hostConfigRoot?: string, onElicitation?: (request: unknown) => Promise<unknown>}} SessionOptions */

/** One isolated, serialized JavaScript runtime per MCP connection. */
export class ReplSession {
  /** @param {SessionOptions} [options] */
  constructor(options = {}) {
    this.options = options;
    /** @type {import('node:child_process').ChildProcess | null} */
    this.child = null;
    /** @type {Map<number, {resolve: (result: EvaluationResult) => void, reject: (error: Error) => void}>} */
    this.pending = new Map();
    /** @type {WeakMap<import('node:child_process').ChildProcess, Error>} */
    this.terminationErrors = new WeakMap();
    this.nextId = 0;
    this.closed = false;
    this.closing = false;
    this.generation = 0;
    /** @type {Promise<void> | undefined} */
    this.closePromise = undefined;
    this.queue = Promise.resolve();
  }

  /** @param {boolean} [allowClosing] @returns {import('node:child_process').ChildProcess} */
  ensureWorker(allowClosing = false) {
    if (this.closed || (this.closing && !allowClosing)) throw new Error("JavaScript session is closed");
    if (this.child) return this.child;
    const child = fork(fileURLToPath(new URL("./repl-worker.js", import.meta.url)), [], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      execArgv: [],
      env: { ...process.env, ...this.options.env },
      serialization: "advanced",
    });
    this.child = child;
    // Diagnostics must never enter the parent's MCP stdout transport.
    child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
    child.on("message", (message) => {
      if (!message || typeof message !== "object") return;
      if (message.type === "elicitation") {
        void this.respondToElicitation(child, message);
        return;
      }
      if (message.type !== "result") return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.resolve(message.result);
    });
    child.on("error", (error) => this.rejectWorker(child, error));
    child.on("exit", (code, signal) => {
      this.rejectWorker(child, this.terminationErrors.get(child) ?? new Error(`JavaScript worker exited (${signal ?? code})`));
    });
    return child;
  }

  /** @param {import('node:child_process').ChildProcess} child @param {{id: number, request: unknown}} message @returns {Promise<void>} */
  async respondToElicitation(child, message) {
    try {
      if (!this.options.onElicitation) throw new Error("This MCP client cannot request browser approval");
      const result = await this.options.onElicitation(message.request);
      if (child.connected) child.send({ type: "elicitation_result", id: message.id, result });
    } catch (error) {
      if (child.connected) child.send({ type: "elicitation_result", id: message.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** @param {import('node:child_process').ChildProcess} child @param {Error} error @returns {void} */
  rejectWorker(child, error) {
    if (this.child !== child) return;
    this.child = null;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  /** @template T @param {() => Promise<T>} operation @returns {Promise<T>} */
  serialized(operation) {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  /** @param {string} code @param {{timeoutMs?: number, requestMeta?: Record<string, unknown>, signal?: AbortSignal}} [options] @returns {Promise<EvaluationResult>} */
  evaluate(code, options = {}) {
    if (this.closing || this.closed) return Promise.reject(new Error("JavaScript session is closed"));
    if (typeof code !== "string" || !code.trim()) return Promise.reject(new Error("JavaScript code must be a non-empty string"));
    const timeoutMs = options.timeoutMs ?? 30000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) return Promise.reject(new Error("timeoutMs must be an integer from 1 through 300000"));
    const generation = this.generation;
    return this.serialized(() => {
      if (generation !== this.generation) throw new Error(this.closing || this.closed ? "JavaScript session is closed" : "JavaScript session was reset before this request started");
      return this.request("evaluate", { code, requestMeta: options.requestMeta }, timeoutMs, options.signal);
    });
  }

  /** @param {string} type @param {Record<string, unknown>} params @param {number} timeoutMs @param {AbortSignal} [signal] @returns {Promise<EvaluationResult>} */
  async request(type, params, timeoutMs, signal) {
    signal?.throwIfAborted();
    const child = this.ensureWorker(type === "close");
    const id = ++this.nextId;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const abort = () => this.terminateWorker(child, new Error("JavaScript execution cancelled; session bindings were reset"));
    try {
      return await new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        timer = setTimeout(() => {
          // Kill before letting the serialized queue proceed: timed-out code
          // must not continue changing browser state beside the next request.
          this.terminateWorker(child, new Error(`JavaScript execution timed out after ${timeoutMs}ms; session bindings were reset`));
        }, timeoutMs);
        signal?.addEventListener("abort", abort, { once: true });
        const workerOptions = { ...this.options };
        delete workerOptions.onElicitation;
        child.send({ type, id, params, options: workerOptions }, (error) => {
          if (error) this.rejectWorker(child, error);
        });
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  /** @param {import("node:child_process").ChildProcess} child @param {Error} error @returns {void} */
  terminateWorker(child, error) {
    this.terminationErrors.set(child, error);
    if (!child.kill("SIGKILL") && (child.exitCode !== null || child.signalCode !== null)) this.rejectWorker(child, error);
  }

  /** End the current browser turn while retaining JavaScript bindings. @returns {Promise<EvaluationResult>} */
  endTurn() {
    return this.serialized(async () => this.child ? this.request("end_turn", {}, 30000) : { content: [] });
  }

  /** Discard bindings and release the current browser session. @returns {Promise<void>} */
  reset() {
    if (this.closing || this.closed) return Promise.reject(new Error("JavaScript session is closed"));
    this.generation += 1;
    if (this.child && this.pending.size > 0) this.terminateWorker(this.child, new Error("JavaScript session reset during execution; worker terminated"));
    return this.serialized(async () => this.stopWorker());
  }

  /** @returns {Promise<void>} */
  async stopWorker() {
    const child = this.child;
    if (!child) return;
    try {
      const result = await this.request("close", {}, 5000);
      if (result.isError) throw new Error(result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n"));
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
      if (this.child === child) this.child = null;
    }
  }

  /** Permanently close this MCP connection's runtime. @returns {Promise<void>} */
  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.generation += 1;
    if (this.child && this.pending.size > 0) this.terminateWorker(this.child, new Error("JavaScript session closed during execution; worker terminated"));
    this.closePromise = this.serialized(async () => {
      try {
        await this.stopWorker();
      } finally {
        this.closed = true;
      }
    });
    return this.closePromise;
  }
}
