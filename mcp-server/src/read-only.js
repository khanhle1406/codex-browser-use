import { parse } from "acorn";

/**
 * Methods that mutate browser state or trigger side effects. Page evaluation is
 * a read-only scope: agents use the dedicated action tools for writes.
 */
const mutatingMethods = new Set([
  "addEventListener", "after", "append", "appendChild", "beforescriptexecute", "before", "blur",
  "checkValidity", "clear", "click", "close", "dispatchEvent", "execCommand", "focus",
  "insertAdjacentElement", "insertAdjacentHTML", "insertAdjacentText", "insertBefore", "open",
  "prepend", "remove", "removeAttribute", "removeAttributeNS", "removeChild", "replaceChild",
  "replaceWith", "reportValidity", "requestFullscreen", "requestPointerLock", "requestSubmit",
  "reset", "scrollBy", "scrollTo", "setAttribute", "setAttributeNS", "setCustomValidity",
  "setRangeText", "setSelectionRange", "showModal", "submit", "toggleAttribute", "write",
  "writeln",
]);

const mutatingObjects = new Set([
  "classList", "dataset", "style",
]);

const mutatingNamespaces = new Map([
  ["localStorage", new Set(["clear", "removeItem", "setItem"])],
  ["sessionStorage", new Set(["clear", "removeItem", "setItem"])],
  ["history", new Set(["back", "forward", "go", "pushState", "replaceState"])],
  ["location", new Set(["assign", "reload", "replace"])],
  ["navigator", new Set(["sendBeacon", "share", "vibrate"])],
  ["clipboard", new Set(["write", "writeText"])],
  ["indexedDB", new Set(["deleteDatabase", "open"])],
  ["caches", new Set(["delete", "open"])],
]);

const forbiddenCalls = new Set(["eval", "fetch", "import", "require"]);

/**
 * Reject an expression that can mutate the page or reach the network.
 * This is a static policy check, not a sandbox.
 * @param {string} source
 * @returns {string} the original source when the expression is read-only
 */
export function assertReadOnly(source) {
  if (typeof source !== "string" || source.trim() === "") {
    throw new Error("Browser evaluate requires a JavaScript expression");
  }
  let ast;
  try {
    ast = parse(`(${source})`, { ecmaVersion: "latest" });
  } catch {
    try {
      ast = parse(source, { ecmaVersion: "latest" });
    } catch (error) {
      throw new Error(`Browser evaluate could not parse the expression: ${error.message}`);
    }
  }
  const violation = findViolation(ast);
  if (violation) throw new Error(`Browser evaluate is read-only: ${violation}`);
  return source;
}

/**
 * @param {unknown} node
 * @returns {string|null}
 */
function findViolation(node) {
  if (!node || typeof node !== "object") return null;
  const record = /** @type {Record<string, unknown>} */ (node);
  const type = record.type;

  if (type === "AssignmentExpression") return "assignment is not allowed";
  if (type === "UpdateExpression") return "increment and decrement are not allowed";
  if (type === "UnaryExpression" && record.operator === "delete") return "delete is not allowed";
  if (type === "ImportExpression") return "dynamic import is not allowed";
  if (type === "NewExpression" && record.callee && /** @type {any} */ (record.callee).name === "Function") {
    return "dynamic code construction is not allowed";
  }

  if (type === "CallExpression") {
    const callee = /** @type {any} */ (record.callee);
    if (callee?.type === "Identifier" && forbiddenCalls.has(callee.name)) {
      return `${callee.name}() is not allowed`;
    }
    if (callee?.type === "MemberExpression" && !callee.computed) {
      const object = callee.object;
      const property = callee.property?.name;
      if (typeof property === "string" && mutatingMethods.has(property)) {
        return `${property}() is not allowed`;
      }
      const namespace = namespaceOf(object);
      if (namespace && typeof property === "string" && mutatingNamespaces.get(namespace)?.has(property)) {
        return `${namespace}.${property}() is not allowed`;
      }
    }
  }

  if (type === "MemberExpression" && !record.computed) {
    const property = /** @type {any} */ (record.property)?.name;
    if (typeof property === "string" && mutatingObjects.has(property)) {
      return `${property} access is not allowed`;
    }
  }

  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        const violation = findViolation(child);
        if (violation) return violation;
      }
    } else if (value && typeof value === "object") {
      const violation = findViolation(value);
      if (violation) return violation;
    }
  }
  return null;
}

/**
 * Resolve a namespace chain such as `window.localStorage` to `localStorage`.
 * @param {any} node
 * @returns {string|null}
 */
function namespaceOf(node) {
  if (!node || typeof node !== "object") return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression" && !node.computed && node.property?.type === "Identifier") {
    return node.property.name;
  }
  if (node.type === "ChainExpression") return namespaceOf(node.expression);
  return null;
}
