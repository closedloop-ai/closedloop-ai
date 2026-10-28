/**
 * @file artifact-status-display.zod-free.test.ts
 * @description Pins the one property that makes `artifact-status-display.ts` a
 * third module instead of part of `artifact-status-mapping.ts`: a bundle-
 * sensitive `"use client"` surface can import a label without pulling zod in.
 * The mapping module reaches zod through `@closedloop-ai/loops-api/document` and
 * `./project.ts`, so a single `import { ProjectStatus } from "./project.ts"`
 * added to the display module would undo the split with nothing going red
 * (marisolashgrove, PR #6835).
 *
 * The probe is the module graph itself, not the source text: the `zod` mock
 * factory runs only when something actually imports zod, so it stays unset for
 * the display module and flips for the mapping module. Its own file so the
 * registry is clean — a static import of either module would load it before
 * the assertion could observe anything.
 */

import { expect, it, vi } from "vitest";

const zodProbe = vi.hoisted(() => ({ evaluated: false }));

vi.mock("zod", async (importOriginal) => {
  zodProbe.evaluated = true;
  return await importOriginal();
});

it("keeps zod out of its graph, where the mapping sibling pulls it in", async () => {
  await import("./artifact-status-display.ts");

  expect(zodProbe.evaluated).toBe(false);

  // Counterfactual in the same case, so neither half can be primed by test
  // order: the mapping module proves the probe can flip at all, which is what
  // stops the assertion above from being vacuously green.
  await import("./artifact-status-mapping.ts");

  expect(zodProbe.evaluated).toBe(true);
});
