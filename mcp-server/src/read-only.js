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

const mutatingNamespaces = new Map([
  ["localStorage", new Set(["clear", "removeItem", "setItem"])],
  ["sessionStorage", new Set(["clear", "removeItem", "setItem"])],
  ["history", new Set(["back", "forward", "go", "pushState", "replaceState"])],
  ["location", new Set(["assign", "reload", "replace"])],
  ["navigator", new Set(["sendBeacon", "share", "vibrate"])],
  ["clipboard", new Set(["write", "writeText"])],
  ["indexedDB", new Set(["deleteDatabase", "open"])],
  ["caches", new Set(["delete", "open"])],
  ["classList", new Set(["add", "remove", "toggle", "replace"])],
  ["style", new Set(["setProperty", "removeProperty"])],
  ["Object", new Set(["assign", "defineProperty", "defineProperties", "setPrototypeOf"])],
  ["Reflect", new Set(["set", "deleteProperty", "defineProperty", "setPrototypeOf"])],
]);

const forbiddenCalls = new Set(["eval", "fetch", "import", "require"]);

const FORBIDDEN_ASSIGN_PROPS = new Set(["__proto__", "prototype", "constructor"]);

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
  const nonPlainReassigned = collectNonPlainReassignments(ast);
  const violation = findViolation(ast, [], nonPlainReassigned);
  if (violation) throw new Error(`Browser evaluate is read-only: ${violation}`);
  return source;
}

const SCOPE_CREATORS = new Set([
  "Program", "BlockStatement", "FunctionDeclaration", "FunctionExpression",
  "ArrowFunctionExpression", "ForStatement", "ForInStatement", "ForOfStatement",
  "CatchClause", "SwitchStatement",
]);

/** @param {any} init @returns {boolean} */
function isPlainContainerInit(init) {
  if (!init || typeof init !== "object") return false;
  if (init.type === "ObjectExpression" || init.type === "ArrayExpression") return true;
  if (
    init.type === "CallExpression" &&
    !init.optional &&
    init.callee?.type === "MemberExpression" &&
    !init.callee.computed &&
    init.callee.object?.type === "Identifier" &&
    init.callee.object.name === "Object" &&
    init.callee.property?.type === "Identifier" &&
    init.callee.property.name === "create" &&
    Array.isArray(init.arguments) &&
    init.arguments.length === 1 &&
    init.arguments[0]?.type === "Literal" &&
    init.arguments[0].value === null
  ) {
    return true;
  }
  return false;
}

/** @param {any} root @returns {Set<string>} */
function collectNonPlainReassignments(root) {
  const out = new Set();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "AssignmentExpression") {
      if (node.left?.type === "Identifier") {
        if (!(node.operator === "=" && isPlainContainerInit(node.right))) {
          out.add(node.left.name);
        }
      } else if (node.left?.type === "ObjectPattern" || node.left?.type === "ArrayPattern") {
        collectPatternIdentifiers(node.left, out);
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) visit(child);
      } else if (value && typeof value === "object") {
        visit(value);
      }
    }
  };
  visit(root);
  return out;
}

/** @param {any} pattern @param {Set<string>} out */
function collectPatternIdentifiers(pattern, out) {
  if (!pattern || typeof pattern !== "object") return;
  switch (pattern.type) {
    case "Identifier":
      out.add(pattern.name);
      break;
    case "ObjectPattern":
      for (const prop of pattern.properties ?? []) {
        collectPatternIdentifiers(prop?.type === "Property" ? prop.value : prop, out);
      }
      break;
    case "ArrayPattern":
      for (const elem of pattern.elements ?? []) {
        if (elem) collectPatternIdentifiers(elem, out);
      }
      break;
    case "RestElement":
      collectPatternIdentifiers(pattern.argument, out);
      break;
    case "AssignmentPattern":
      collectPatternIdentifiers(pattern.left, out);
      break;
    default:
      break;
  }
}

/** @param {any} node @param {Set<string>} out */
function collectHoistedVars(node, out) {
  if (!node || typeof node !== "object") return;
  if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)) return;
  if (node.type === "VariableDeclaration" && node.kind === "var") {
    for (const decl of node.declarations ?? []) collectPatternIdentifiers(decl.id, out);
    return;
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) collectHoistedVars(child, out);
    } else if (value && typeof value === "object") {
      collectHoistedVars(value, out);
    }
  }
}

/** @param {any} statements @param {{locals:Set<string>, plainContainers:Set<string>}} scope @param {Set<string>} nonPlainReassigned */
function collectDirectDeclarations(statements, scope, nonPlainReassigned) {
  for (const stmt of Array.isArray(statements) ? statements : []) {
    if (!stmt || typeof stmt !== "object") continue;
    if (stmt.type === "VariableDeclaration") {
      for (const decl of stmt.declarations ?? []) {
        collectPatternIdentifiers(decl.id, scope.locals);
        if (decl.id?.type === "Identifier" && isPlainContainerInit(decl.init) && !nonPlainReassigned.has(decl.id.name)) {
          scope.plainContainers.add(decl.id.name);
        }
      }
    } else if ((stmt.type === "FunctionDeclaration" || stmt.type === "ClassDeclaration") && stmt.id?.name) {
      scope.locals.add(stmt.id.name);
    }
  }
}

/** @param {any} node @param {Set<string>} nonPlainReassigned @returns {{locals:Set<string>, plainContainers:Set<string>}} */
function createScopeForNode(node, nonPlainReassigned) {
  const scope = { locals: new Set(), plainContainers: new Set() };
  const type = node.type;
  if (type === "Program" || type === "BlockStatement") {
    collectDirectDeclarations(node.body, scope, nonPlainReassigned);
    if (type === "Program") {
      for (const stmt of node.body ?? []) collectHoistedVars(stmt, scope.locals);
    }
  } else if (type === "FunctionDeclaration" || type === "FunctionExpression" || type === "ArrowFunctionExpression") {
    if (node.id?.name) scope.locals.add(node.id.name);
    for (const param of node.params ?? []) collectPatternIdentifiers(param, scope.locals);
    if (node.body?.type === "BlockStatement") {
      collectDirectDeclarations(node.body.body, scope, nonPlainReassigned);
      for (const stmt of node.body.body ?? []) collectHoistedVars(stmt, scope.locals);
    }
  } else if (type === "ForStatement") {
    if (node.init?.type === "VariableDeclaration") {
      collectDirectDeclarations([node.init], scope, nonPlainReassigned);
    }
  } else if (type === "ForInStatement" || type === "ForOfStatement") {
    if (node.left?.type === "VariableDeclaration") {
      for (const decl of node.left.declarations ?? []) collectPatternIdentifiers(decl.id, scope.locals);
    }
  } else if (type === "CatchClause" && node.param) {
    collectPatternIdentifiers(node.param, scope.locals);
  } else if (type === "SwitchStatement") {
    for (const c of node.cases ?? []) collectDirectDeclarations(c.consequent, scope, nonPlainReassigned);
  }
  return scope;
}

/** @param {string} name @param {Array<{locals:Set<string>, plainContainers:Set<string>}>} scopes @returns {boolean} */
function isLocalIdentifier(name, scopes) {
  for (let i = scopes.length - 1; i >= 0; i--) {
    if (scopes[i].locals.has(name)) return true;
  }
  return false;
}

/** @param {string} name @param {Array<{locals:Set<string>, plainContainers:Set<string>}>} scopes @returns {boolean} */
function isLocalPlainContainer(name, scopes) {
  for (let i = scopes.length - 1; i >= 0; i--) {
    if (scopes[i].plainContainers.has(name)) return true;
    if (scopes[i].locals.has(name)) return false;
  }
  return false;
}

/** @param {any} node @param {Array<{locals:Set<string>, plainContainers:Set<string>}>} scopes @returns {boolean} */
function isSafePlainMemberTarget(node, scopes) {
  if (node?.type !== "MemberExpression" || node.object?.type !== "Identifier") return false;
  if (!isLocalPlainContainer(node.object.name, scopes)) return false;
  if (!node.computed) return !FORBIDDEN_ASSIGN_PROPS.has(node.property?.name);
  if (node.property?.type === "Literal") {
    return !FORBIDDEN_ASSIGN_PROPS.has(String(node.property.value));
  }
  if (node.property?.type === "TemplateLiteral" && node.property.expressions?.length === 0) {
    return !FORBIDDEN_ASSIGN_PROPS.has(String(node.property.quasis?.[0]?.value?.cooked ?? ""));
  }
  return true;
}

/**
 * @param {unknown} node
 * @param {Array<{locals:Set<string>, plainContainers:Set<string>}>} scopes
 * @param {Set<string>} nonPlainReassigned
 * @returns {string|null}
 */
function findViolation(node, scopes = [], nonPlainReassigned = new Set()) {
  if (!node || typeof node !== "object") return null;
  const record = /** @type {Record<string, unknown>} */ (node);
  const type = record.type;

  const activeScopes = SCOPE_CREATORS.has(String(type))
    ? [...scopes, createScopeForNode(record, nonPlainReassigned)]
    : scopes;

  if (type === "AssignmentExpression") {
    const left = /** @type {any} */ (record.left);
    if (left?.type === "Identifier" && isLocalIdentifier(left.name, activeScopes)) {
      return findViolation(record.right, activeScopes, nonPlainReassigned);
    }
    if (isSafePlainMemberTarget(left, activeScopes)) {
      if (left.computed) {
        const keyViolation = findViolation(left.property, activeScopes, nonPlainReassigned);
        if (keyViolation) return keyViolation;
      }
      return findViolation(record.right, activeScopes, nonPlainReassigned);
    }
    return "assignment is not allowed (only local variables and direct properties/indices of locally created {} or [] objects may be assigned; do not mutate DOM nodes, parameters, or globals)";
  }
  if (type === "UpdateExpression") {
    const arg = /** @type {any} */ (record.argument);
    if (arg?.type === "Identifier" && isLocalIdentifier(arg.name, activeScopes)) {
      return null;
    }
    if (isSafePlainMemberTarget(arg, activeScopes)) {
      return arg.computed ? findViolation(arg.property, activeScopes, nonPlainReassigned) : null;
    }
    return "increment and decrement are not allowed";
  }
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

  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        const violation = findViolation(child, activeScopes, nonPlainReassigned);
        if (violation) return violation;
      }
    } else if (value && typeof value === "object") {
      const violation = findViolation(value, activeScopes, nonPlainReassigned);
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
