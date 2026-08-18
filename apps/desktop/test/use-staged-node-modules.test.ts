/**
 * ISS-5303 — `use-staged-node-modules.mjs`, electron-builder's `beforeBuild`
 * hook (`electron-builder.yml`).
 *
 * electron-builder reads this hook's return value as a yes/no: truthy means
 * "go install and rebuild the dependency closure yourself", falsy means "it is
 * already there, leave it alone". By the time it runs,
 * `stage-packaging-app.mjs` has already assembled the exact production closure
 * in the stage dir — packed workspace tarballs included. Flipping this to
 * `true` would have electron-builder re-collect `node_modules` over the top of
 * that, producing a packaged bundle that does not match what was staged and
 * verified. One assertion, on the one value that matters.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import useStagedNodeModules from "../scripts/use-staged-node-modules.mjs";

describe("ISS-5303: the electron-builder beforeBuild hook", () => {
  test("returns false so electron-builder does not re-collect node_modules", () => {
    assert.equal(useStagedNodeModules(), false);
  });
});
