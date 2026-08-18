import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Guards the opt-in Stryker config (ISS-4777). The scoped `--mutate
 * src/genai-cost.ts` run people usually use never exercises the package-wide
 * default glob, so pin the two edges review caught (#4189):
 *   1. the default `mutate` glob must EXCLUDE colocated `*.test.ts` files, or a
 *      whole-package run mutates the tests themselves and mixes assertion
 *      mutants into the production score;
 *   2. the vitest runner plugin must be named explicitly, because pnpm's strict
 *      node_modules breaks Stryker's plugin auto-discovery.
 * Reading the declarative JSON config is not source-text scanning (allowed).
 */
const config = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../stryker.config.json", import.meta.url)),
    "utf8"
  )
) as { mutate: string[]; plugins: string[] };

describe("stryker.config.json", () => {
  it("mutates production source but excludes colocated test files", () => {
    expect(config.mutate).toContain("src/**/*.ts");
    expect(config.mutate).toContain("!src/**/*.test.ts");
  });

  it("names the vitest runner plugin explicitly (pnpm plugin-resolution gotcha)", () => {
    expect(config.plugins).toContain("@stryker-mutator/vitest-runner");
  });
});
