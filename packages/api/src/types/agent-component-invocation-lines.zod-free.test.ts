/**
 * @file agent-component-invocation-lines.zod-free.test.ts
 * @description ISS-10730. `agent-component-invocation-lines.ts` says it is
 * dependency-free so a bundle-sensitive client can import the LOC/$ coverage
 * vocabulary, and `packages/app`'s agent-components data source does exactly
 * that — it imports `InvocationLocPerDollarUncoveredOperand` as a RUNTIME
 * value. Nothing pinned that claim, and it was already broken once: bounding
 * the line count reached for `PR_INT_MAX` in `session-artifact-link.ts`, which
 * imports zod, pulling the whole validator graph into a client bundle for a
 * single integer. The ceiling now comes from the import-free
 * `@closedloop-ai/loops-api/column-limits` instead.
 *
 * Same mechanism as the `artifact-status-*` siblings: the probe is the module
 * GRAPH, not the source text — the mock factory runs only when something
 * actually imports zod. Its own file so the registry is clean.
 */

import { expect, it, vi } from "vitest";

const zodProbe = vi.hoisted(() => ({ evaluated: false }));

vi.mock("zod", async (importOriginal) => {
  zodProbe.evaluated = true;
  return await importOriginal();
});

it("keeps zod out of its graph, where the schema sibling pulls it in", async () => {
  await import("./agent-component-invocation-lines.ts");

  expect(zodProbe.evaluated).toBe(false);

  // Counterfactual in the same case, so neither half can be primed by test
  // order: the invocation schema proves the probe can flip at all, which is
  // what stops the assertion above from being vacuously green.
  await import("./agent-component-invocation-schema.ts");

  expect(zodProbe.evaluated).toBe(true);
  // Explicit, not the 5s default (root AGENTS.md): the probe resolves and
  // evaluates two real module graphs, which takes ~3s on an idle box and longer
  // on a loaded one — the two `artifact-status-*` siblings rely on the default
  // and both time out under load. A generous explicit bound still catches a
  // genuine hang without turning host load into a false red.
}, 30_000);
