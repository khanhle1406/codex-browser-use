export default [{
  files: ["**/*.js"],
  ignores: ["node_modules/**"],
  languageOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    globals: Object.fromEntries([
      "process", "console", "Buffer", "URL", "setTimeout", "clearTimeout",
      "setInterval", "clearInterval", "AbortController", "fetch", "structuredClone",
      "performance", "TextDecoder", "TextEncoder", "queueMicrotask", "globalThis",
    ].map((name) => [name, "readonly"])),
  },
  rules: {
    "no-undef": "error",
    "no-unused-vars": ["error", {argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_"}],
    "no-constant-condition": ["error", {checkLoops: false}],
    "no-dupe-keys": "error",
    "no-unreachable": "error",
    "no-empty": "error",
    "valid-typeof": "error",
  },
}];
