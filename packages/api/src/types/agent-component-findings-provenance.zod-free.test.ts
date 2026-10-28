/**
 * @file agent-component-findings-provenance.zod-free.test.ts
 * @description Pins the one property that lets `agent-component-findings-provenance.ts`
 * be imported by a bundle-sensitive `"use client"` cell (ISS-10727 renders the
 * label beside a count): it reaches zod through nothing. Its funnel sibling
 * does reach zod, so a single convenience re-export of a fold added to this
 * module would undo the property with nothing else going red.
 *
 * Same mechanism as the `artifact-status-*.zod-free.test.ts` siblings: the
 * probe is the module GRAPH, not the source text — the `zod` mock factory runs
 * only when something actually imports zod. Its own file so the registry is
 * clean; a static import of either module would load it before the assertion
 * could observe anything.
 *
 * The explicit timeout is deliberate: the siblings rely on the 5s default and
 * time out on a loaded box, where two dynamic imports of a cold module graph
 * are not a 5s operation.
 */

import { expect, it, vi } from "vitest";

const ZOD_FREE_PROBE_TIMEOUT_MS = 30_000;

const zodProbe = vi.hoisted(() => ({ evaluated: false }));

vi.mock("zod", async (importOriginal) => {
  zodProbe.evaluated = true;
  return await importOriginal();
});

it(
  "keeps zod out of its graph, where the funnel sibling pulls it in",
  async () => {
    await import("./agent-component-findings-provenance.ts");

    expect(zodProbe.evaluated).toBe(false);

    // Counterfactual in the same case, so neither half can be primed by test
    // order: the funnel module proves the probe can flip at all, which is what
    // stops the assertion above from being vacuously green.
    await import("./agent-component-findings-funnel.ts");

    expect(zodProbe.evaluated).toBe(true);
  },
  ZOD_FREE_PROBE_TIMEOUT_MS
);
