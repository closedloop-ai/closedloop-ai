// CJS preload — intercepts "server-only" imports in non-Next.js context.
// This must be .cjs (not compiled by tsc) because --require only loads CJS.
const Module = require("node:module");
const path = require("node:path");

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "server-only") {
    return path.join(__dirname, "server-only-noop.cjs");
  }
  return originalResolve.call(this, request, parent, isMain, options);
};
