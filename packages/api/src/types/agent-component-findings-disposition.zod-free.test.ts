/**
 * @file agent-component-findings-disposition.zod-free.test.ts
 * @description Pins the one property that lets
 * `agent-component-findings-disposition.ts` be imported by a bundle-sensitive
 * `"use client"` cell — the surface that renders "Withheld this pass — evidence
 * unreadable" beside an absent funnel: it reaches zod through nothing. Its
 * funnel sibling does reach zod, so one convenience re-export of a fold added to
 * this module would undo the property with nothing else going red.
 *
 * The module's own docblock claims this property, which is why the test has to
 * exist: a claim with no pin is a sentence the next reader trusts and nobody
 * checks. Same mechanism and the same explicit timeout as
 * `agent-component-findings-provenance.zod-free.test.ts` — the probe is the
 * module GRAPH, not the source text, and two dynamic imports of a cold graph are
 * not a 5s operation on a loaded box.
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
    await import("./agent-component-findings-disposition.ts");

    expect(zodProbe.evaluated).toBe(false);

    // Counterfactual in the same case, so neither half can be primed by test
    // order: the funnel module proves the probe can flip at all, which is what
    // stops the assertion above from being vacuously green.
    await import("./agent-component-findings-funnel.ts");

    expect(zodProbe.evaluated).toBe(true);
  },
  ZOD_FREE_PROBE_TIMEOUT_MS
);
