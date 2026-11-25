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
const LOCAL_COLLECTION_NAMES = new Set(["Set", "Map", "URLSearchParams"]);
const LOCAL_COLLECTION_METHODS = new Set(["clear", "add", "set", "delete", "append"]);
const READ_ONLY_CACHE_MAX = 256;
/** @type {Map<string, string|null>} */
const readOnlyCache = new Map();

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
  const cached = readOnlyCache.get(source);
  if (cached !== undefined) {
    readOnlyCache.delete(source);
    readOnlyCache.set(source, cached);
    if (cached !== null) throw new Error(cached);
    return source;
  }
  let ast;
  try {
    ast = parse(`(${source})`, { ecmaVersion: "latest" });
  } catch {
    try {
      ast = parse(source, { ecmaVersion: "latest", allowReturnOutsideFunction: true });
    } catch (error) {
      const msg = `Browser evaluate could not parse the expression: ${error.message}`;
      if (readOnlyCache.size >= READ_ONLY_CACHE_MAX) {
        readOnlyCache.delete(readOnlyCache.keys().next().value);
      }
      readOnlyCache.set(source, msg);
      throw new Error(msg);
    }
  }
  const { nonPlainReassigned, reducePlainParams, safeNestedPaths } = analyzeAstState(ast);
  const violation = findViolation(ast, [], nonPlainReassigned, reducePlainParams, safeNestedPaths);
  const errMsg = violation ? `Browser evaluate is read-only: ${violation}` : null;
  if (readOnlyCache.size >= READ_ONLY_CACHE_MAX) {
    readOnlyCache.delete(readOnlyCache.keys().next().value);
  }
  readOnlyCache.set(source, errMsg);
  if (errMsg) throw new Error(errMsg);
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

/** @param {any} init @returns {boolean} */
function isLocalCollectionInit(init) {
  return Boolean(
    init &&
    init.type === "NewExpression" &&
    init.callee?.type === "Identifier" &&
    LOCAL_COLLECTION_NAMES.has(init.callee.name),
  );
}

/** @param {any} node @returns {string|null} */
function plainPathOf(node) {
  const parts = [];
  let cur = node;
  while (cur?.type === "MemberExpression") {
    if (!cur.computed && cur.property?.type === "Identifier") {
      parts.push(cur.property.name);
    } else if (cur.computed && cur.property?.type === "Literal" && (typeof cur.property.value === "string" || typeof cur.property.value === "number")) {
      parts.push(String(cur.property.value));
    } else {
      parts.push("*");
    }
    cur = cur.object;
  }
  if (parts.length === 0 || cur?.type !== "Identifier") return null;
  parts.push(cur.name);
  return parts.reverse().join(".");
}

/** @param {string} prefix @param {any} expr @param {Set<string>} safeNestedPaths */
function recordPlainSubpaths(prefix, expr, safeNestedPaths) {
  if (!expr || typeof expr !== "object") return;
  if (expr.type === "ObjectExpression") {
    safeNestedPaths.add(prefix);
    for (const prop of expr.properties ?? []) {
      if (prop?.type !== "Property") continue;
      let key = null;
      if (!prop.computed && prop.key?.type === "Identifier") key = prop.key.name;
      else if (prop.key?.type === "Literal") key = String(prop.key.value);
      if (key && isPlainContainerInit(prop.value)) {
        recordPlainSubpaths(`${prefix}.${key}`, prop.value, safeNestedPaths);
      }
    }
  } else if (expr.type === "ArrayExpression") {
    safeNestedPaths.add(prefix);
    if ((expr.elements ?? []).length > 0 && (expr.elements ?? []).every((el) => el && isPlainContainerInit(el))) {
      safeNestedPaths.add(`${prefix}.*`);
      for (const el of expr.elements) recordPlainSubpaths(`${prefix}.*`, el, safeNestedPaths);
    }
  } else if (isPlainContainerInit(expr)) {
    safeNestedPaths.add(prefix);
  }
}

/** @param {any} root @returns {{nonPlainReassigned:Set<string>, reducePlainParams:WeakMap<object, string>, safeNestedPaths:Set<string>}} */
function analyzeAstState(root) {
  const nonPlainReassigned = new Set();
  const reducePlainParams = new WeakMap();
  const safeNestedPaths = new Set();
  const taintedSubPaths = new Set();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" && isPlainContainerInit(node.init)) {
      recordPlainSubpaths(node.id.name, node.init, safeNestedPaths);
    } else if (node.type === "AssignmentExpression") {
      if (node.left?.type === "Identifier") {
        if (!(node.operator === "=" && (isPlainContainerInit(node.right) || isLocalCollectionInit(node.right)))) {
          nonPlainReassigned.add(node.left.name);
        } else if (isPlainContainerInit(node.right)) {
          recordPlainSubpaths(node.left.name, node.right, safeNestedPaths);
        }
      } else if (node.left?.type === "ObjectPattern" || node.left?.type === "ArrayPattern") {
        collectPatternIdentifiers(node.left, nonPlainReassigned);
      } else if (node.left?.type === "MemberExpression") {
        const path = plainPathOf(node.left);
        if (path) {
          if (node.operator === "=" && isPlainContainerInit(node.right)) {
            recordPlainSubpaths(path, node.right, safeNestedPaths);
          } else {
            taintedSubPaths.add(path);
          }
        }
      }
    } else if (
      node.type === "CallExpression" &&
      node.callee?.type === "MemberExpression" &&
      !node.callee.computed &&
      (node.callee.property?.name === "reduce" || node.callee.property?.name === "reduceRight") &&
      Array.isArray(node.arguments) &&
      node.arguments.length >= 2 &&
      isPlainContainerInit(node.arguments[1]) &&
      (node.arguments[0]?.type === "FunctionExpression" || node.arguments[0]?.type === "ArrowFunctionExpression") &&
      node.arguments[0].params?.[0]?.type === "Identifier"
    ) {
      const paramName = node.arguments[0].params[0].name;
      reducePlainParams.set(node.arguments[0], paramName);
      recordPlainSubpaths(paramName, node.arguments[1], safeNestedPaths);
    }
    for (const key in node) {
      if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) visit(value[i]);
      } else if (value && typeof value === "object") {
        visit(value);
      }
    }
  };
  visit(root);
  for (const path of taintedSubPaths) {
    safeNestedPaths.delete(path);
    const dotPrefix = `${path}.`;
    for (const candidate of safeNestedPaths) {
      if (candidate.startsWith(dotPrefix)) safeNestedPaths.delete(candidate);
    }
  }
  return { nonPlainReassigned, reducePlainParams, safeNestedPaths };
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
  for (const key in node) {
    if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) collectHoistedVars(value[i], out);
    } else if (value && typeof value === "object") {
      collectHoistedVars(value, out);
    }
  }
}

/** @param {any} statements @param {{locals:Set<string>, plainContainers:Set<string>, collections:Set<string>}} scope @param {Set<string>} nonPlainReassigned */
function collectDirectDeclarations(statements, scope, nonPlainReassigned) {
  for (const stmt of Array.isArray(statements) ? statements : []) {
    if (!stmt || typeof stmt !== "object") continue;
    if (stmt.type === "VariableDeclaration") {
      for (const decl of stmt.declarations ?? []) {
        collectPatternIdentifiers(decl.id, scope.locals);
        if (decl.id?.type === "Identifier" && !nonPlainReassigned.has(decl.id.name)) {
          if (isPlainContainerInit(decl.init)) {
            scope.plainContainers.add(decl.id.name);
          } else if (isLocalCollectionInit(decl.init)) {
            scope.collections.add(decl.id.name);
          }
        }
      }
    } else if ((stmt.type === "FunctionDeclaration" || stmt.type === "ClassDeclaration") && stmt.id?.name) {
      scope.locals.add(stmt.id.name);
    }
  }
}

/** @param {any} node @param {Set<string>} nonPlainReassigned @param {WeakMap<object, string>} reducePlainParams @returns {{locals:Set<string>, plainContainers:Set<string>, collections:Set<string>}} */
function createScopeForNode(node, nonPlainReassigned, reducePlainParams) {
  const scope = { locals: new Set(), plainContainers: new Set(), collections: new Set() };
  const type = node.type;
  if (type === "Program" || type === "BlockStatement") {
    collectDirectDeclarations(node.body, scope, nonPlainReassigned);
    if (type === "Program") {
      for (const stmt of node.body ?? []) collectHoistedVars(stmt, scope.locals);
    }
  } else if (type === "FunctionDeclaration" || type === "FunctionExpression" || type === "ArrowFunctionExpression") {
    if (node.id?.name) scope.locals.add(node.id.name);
    for (const param of node.params ?? []) collectPatternIdentifiers(param, scope.locals);
    const accName = reducePlainParams?.get(node);
    if (accName && !nonPlainReassigned.has(accName)) {
      scope.plainContainers.add(accName);
    }
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

/** @param {string} name @param {Array<{locals:Set<string>, plainContainers:Set<string>, collections:Set<string>}>} scopes @returns {boolean} */
function isLocalIdentifier(name, scopes) {
  for (let i = scopes.length - 1; i >= 0; i--) {
    if (scopes[i].locals.has(name)) return true;
  }
  return false;
}

/** @param {string} name @param {Array<{locals:Set<string>, plainContainers:Set<string>, collections:Set<string>}>} scopes @returns {boolean} */
function isLocalPlainContainer(name, scopes) {
  for (let i = scopes.length - 1; i >= 0; i--) {
    if (scopes[i].plainContainers.has(name)) return true;
    if (scopes[i].locals.has(name)) return false;
  }
  return false;
}

/** @param {string} name @param {Array<{locals:Set<string>, plainContainers:Set<string>, collections:Set<string>}>} scopes @returns {boolean} */
function isLocalCollection(name, scopes) {
  for (let i = scopes.length - 1; i >= 0; i--) {
    if (scopes[i].collections.has(name)) return true;
    if (scopes[i].locals.has(name)) return false;
  }
  return false;
}

/** @param {any} node @returns {boolean} */
function isSafePlainProperty(node) {
  if (!node.computed) return !FORBIDDEN_ASSIGN_PROPS.has(node.property?.name);
  if (node.property?.type === "Literal") {
    return !FORBIDDEN_ASSIGN_PROPS.has(String(node.property.value));
  }
  if (node.property?.type === "TemplateLiteral" && node.property.expressions?.length === 0) {
    return !FORBIDDEN_ASSIGN_PROPS.has(String(node.property.quasis?.[0]?.value?.cooked ?? ""));
  }
  return true;
}

/** @param {any} node @param {Array<{locals:Set<string>, plainContainers:Set<string>, collections:Set<string>}>} scopes @param {Set<string>} safeNestedPaths @returns {boolean} */
function isSafePlainMemberTarget(node, scopes, safeNestedPaths) {
  const parents = [];
  let cur = node;
  while (cur?.type === "MemberExpression") {
    if (!isSafePlainProperty(cur)) return false;
    parents.push(cur);
    cur = cur.object;
  }
  if (parents.length === 0 || cur?.type !== "Identifier" || !isLocalPlainContainer(cur.name, scopes)) {
    return false;
  }
  if (parents.length === 1) return true;
  // For depth >= 2 (e.g., out.meta.total = 5 or rows[0].rank = 1), require each intermediate
  // container step to originate from a statically known plain literal/array initializer,
  // blocking `const r = {}; r.el = el; r.el.value = '1'`.
  let prefix = cur.name;
  for (let i = parents.length - 1; i >= 1; i--) {
    const segNode = parents[i];
    let seg = null;
    if (!segNode.computed && segNode.property?.type === "Identifier") seg = segNode.property.name;
    else if (segNode.computed && segNode.property?.type === "Literal") seg = String(segNode.property.value);
    const exactCandidate = seg !== null ? `${prefix}.${seg}` : null;
    const wildcardCandidate = `${prefix}.*`;
    if (exactCandidate && safeNestedPaths.has(exactCandidate)) {
      prefix = exactCandidate;
    } else if (safeNestedPaths.has(wildcardCandidate)) {
      prefix = wildcardCandidate;
    } else {
      return false;
    }
  }
  return true;
}

/** @param {any} node @param {Array<{locals:Set<string>, plainContainers:Set<string>, collections:Set<string>}>} scopes @param {Set<string>} nonPlainReassigned @param {WeakMap<object, string>} reducePlainParams @param {Set<string>} safeNestedPaths @returns {string|null} */
function validateComputedKeys(node, scopes, nonPlainReassigned, reducePlainParams, safeNestedPaths) {
  for (let cur = node; cur?.type === "MemberExpression"; cur = cur.object) {
    if (cur.computed) {
      const violation = findViolation(cur.property, scopes, nonPlainReassigned, reducePlainParams, safeNestedPaths);
      if (violation) return violation;
    }
  }
  return null;
}

/**
 * @param {unknown} node
 * @param {Array<{locals:Set<string>, plainContainers:Set<string>, collections:Set<string>}>} scopes
 * @param {Set<string>} nonPlainReassigned
 * @param {WeakMap<object, string>} reducePlainParams
 * @param {Set<string>} safeNestedPaths
 * @returns {string|null}
 */
function findViolation(node, scopes = [], nonPlainReassigned = new Set(), reducePlainParams = new WeakMap(), safeNestedPaths = new Set()) {
  if (!node || typeof node !== "object") return null;
  const record = /** @type {Record<string, unknown>} */ (node);
  const type = record.type;

  const activeScopes = SCOPE_CREATORS.has(String(type))
    ? [...scopes, createScopeForNode(record, nonPlainReassigned, reducePlainParams)]
    : scopes;

  if (type === "AssignmentExpression") {
    const left = /** @type {any} */ (record.left);
    if (left?.type === "Identifier" && isLocalIdentifier(left.name, activeScopes)) {
      return findViolation(record.right, activeScopes, nonPlainReassigned, reducePlainParams, safeNestedPaths);
    }
    if (isSafePlainMemberTarget(left, activeScopes, safeNestedPaths)) {
      const keyViolation = validateComputedKeys(left, activeScopes, nonPlainReassigned, reducePlainParams, safeNestedPaths);
      if (keyViolation) return keyViolation;
      return findViolation(record.right, activeScopes, nonPlainReassigned, reducePlainParams, safeNestedPaths);
    }
    return "assignment is not allowed (only local variables and direct properties/indices of locally created {} or [] objects may be assigned; do not mutate DOM nodes, parameters, or globals)";
  }
  if (type === "UpdateExpression") {
    const arg = /** @type {any} */ (record.argument);
    if (arg?.type === "Identifier" && isLocalIdentifier(arg.name, activeScopes)) {
      return null;
    }
    if (isSafePlainMemberTarget(arg, activeScopes, safeNestedPaths)) {
      return validateComputedKeys(arg, activeScopes, nonPlainReassigned, reducePlainParams, safeNestedPaths);
    }
    return "increment and decrement are not allowed";
  }
  if (type === "UnaryExpression" && record.operator === "delete") {
    const arg = /** @type {any} */ (record.argument);
    if (isSafePlainMemberTarget(arg, activeScopes, safeNestedPaths)) {
      return validateComputedKeys(arg, activeScopes, nonPlainReassigned, reducePlainParams, safeNestedPaths);
    }
    return "delete is not allowed";
  }
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
      const isLocalCollCall =
        typeof property === "string" &&
        LOCAL_COLLECTION_METHODS.has(property) &&
        object?.type === "Identifier" &&
        isLocalCollection(object.name, activeScopes);
      const firstArg = Array.isArray(record.arguments) ? record.arguments[0] : null;
      const isSafeObjectAssign =
        namespaceOf(object) === "Object" &&
        property === "assign" &&
        Boolean(
          firstArg?.type === "ObjectExpression" ||
          (firstArg?.type === "Identifier" && isLocalPlainContainer(firstArg.name, activeScopes)) ||
          isSafePlainMemberTarget(firstArg, activeScopes, safeNestedPaths),
        );
      if (!isLocalCollCall && !isSafeObjectAssign) {
        if (typeof property === "string" && mutatingMethods.has(property)) {
          return `${property}() is not allowed`;
        }
        const namespace = namespaceOf(object);
        if (namespace && typeof property === "string" && mutatingNamespaces.get(namespace)?.has(property)) {
          return `${namespace}.${property}() is not allowed`;
        }
      }
    }
  }

  for (const key in record) {
    if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
    const value = record[key];
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const violation = findViolation(value[i], activeScopes, nonPlainReassigned, reducePlainParams, safeNestedPaths);
        if (violation) return violation;
      }
    } else if (value && typeof value === "object") {
      const violation = findViolation(value, activeScopes, nonPlainReassigned, reducePlainParams, safeNestedPaths);
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
