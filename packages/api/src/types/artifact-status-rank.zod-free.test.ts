/**
 * @file artifact-status-rank.zod-free.test.ts
 * @description Pins the one property that lets `artifact-status-rank.ts` be imported
 * by a bundle-sensitive `"use client"` sort path: it reaches zod through nothing.
 * `artifact-status-mapping.ts` does reach zod (through `@closedloop-ai/loops-api/document` and
 * `./project.ts`), so a single convenience import of a fold added to the rank module
 * would undo this with nothing else going red.
 *
 * Same mechanism as the sibling `artifact-status-display.zod-free.test.ts`: the probe
 * is the module GRAPH, not the source text — the `zod` mock factory runs only when
 * something actually imports zod. Its own file so the registry is clean; a static
 * import of either module would load it before the assertion could observe anything.
 */

import { expect, it, vi } from "vitest";

const zodProbe = vi.hoisted(() => ({ evaluated: false }));

vi.mock("zod", async (importOriginal) => {
  zodProbe.evaluated = true;
  return await importOriginal();
});

it("keeps zod out of its graph, where the mapping sibling pulls it in", async () => {
  await import("./artifact-status-rank.ts");

  expect(zodProbe.evaluated).toBe(false);

  // Counterfactual in the same case, so neither half can be primed by test order:
  // the mapping module proves the probe can flip at all, which is what stops the
  // assertion above from being vacuously green.
  await import("./artifact-status-mapping.ts");

  expect(zodProbe.evaluated).toBe(true);
});
