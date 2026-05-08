// Mock "server-only" which throws outside Next.js
// The @repo/database package uses it to prevent client-side imports,
// but the MCP server is a standalone Node process where it's safe.
require.extensions; // ensure CJS is initialized
const Module = require("node:module");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (
  request: string,
  parent: unknown,
  isMain: boolean,
  options: unknown
) {
  if (request === "server-only") {
    // Return a path to a noop module
    return require.resolve("./server-only-noop.cjs");
  }
  return originalResolve.call(this, request, parent, isMain, options);
};
