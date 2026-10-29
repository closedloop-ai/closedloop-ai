/**
 * @file node-test-census-iss11285.test.ts
 * @description ISS-11285 — `installsLoaderHook` on `node:module` imports that
 * carry no named bindings. Both forms below do install a hook, but the census
 * reads only named `register`/`registerHooks` bindings, so it misses them.
 * These cases pin main's current false negatives; they are not a claim that
 * missing them is correct.
 */
import { describe, expect, it } from "vitest";
import { installsLoaderHook } from "../scripts/node-test-census.mjs";

describe("installsLoaderHook without named bindings", () => {
  it("does not fire on a default import of node:module", () => {
    // pins current behavior; looks odd because `nodeModule.registerHooks(...)`
    // does install a hook, but the census only reads named import bindings.
    expect(
      installsLoaderHook(
        'import nodeModule from "node:module";\nnodeModule.registerHooks({});\n',
        "d.ts"
      )
    ).toBe(false);
  });

  it("does not fire on a namespace import of node:module", () => {
    // pins current behavior; looks odd because `mod.registerHooks(...)` does
    // install a hook, but the census only reads named import bindings.
    expect(
      installsLoaderHook(
        'import * as mod from "node:module";\nmod.registerHooks({});\n',
        "n.ts"
      )
    ).toBe(false);
  });
});
