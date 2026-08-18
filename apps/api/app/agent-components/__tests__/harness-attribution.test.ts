/**
 * FEA-3758: unit tests for the shared per-session harness attribution used by
 * the agent-component rollup (list + detail + orphan-only paths).
 */
import { Harness } from "@repo/api/src/types/agent-component";
import { describe, expect, it } from "vitest";
import {
  createHarnessAccumulator,
  foldUsageHarness,
  resolveComponentHarness,
} from "../harness-attribution";

function accFrom(values: Array<string | null | undefined>) {
  const acc = createHarnessAccumulator();
  for (const v of values) {
    foldUsageHarness(acc, v);
  }
  return acc;
}

describe("resolveComponentHarness", () => {
  it("returns the single harness a component ran in (codex-only subagent)", () => {
    expect(resolveComponentHarness(accFrom(["codex", "codex"]), "claude")).toBe(
      Harness.Codex
    );
  });

  it("returns 'both' when a component ran in more than one harness", () => {
    expect(
      resolveComponentHarness(accFrom(["claude", "codex"]), "claude")
    ).toBe(Harness.Both);
  });

  it("falls back to the inventory harness when no usage carries one", () => {
    expect(
      resolveComponentHarness(accFrom([null, undefined, ""]), "codex")
    ).toBe(Harness.Codex);
  });

  it("falls back to 'claude' when neither usage nor inventory carries a harness", () => {
    expect(resolveComponentHarness(accFrom([]), null)).toBe(Harness.Claude);
    expect(resolveComponentHarness(accFrom([]), "")).toBe(Harness.Claude);
  });

  it("prefers the usage harness over the inventory harness", () => {
    // Inventory row says claude (defaulted/stale) but the component only ran in
    // Codex sessions — usage wins. This is the FEA-3758 fix.
    expect(resolveComponentHarness(accFrom(["codex"]), "claude")).toBe(
      Harness.Codex
    );
  });

  it("ignores blank/whitespace harness values so they don't trip the 'both' case", () => {
    expect(
      resolveComponentHarness(accFrom(["codex", "  ", null]), "claude")
    ).toBe(Harness.Codex);
  });
});

describe("foldUsageHarness", () => {
  it("trims and de-dupes harness values", () => {
    const acc = accFrom([" codex ", "codex", "claude"]);
    expect([...acc].sort()).toEqual(["claude", "codex"]);
  });

  it("skips null/blank values", () => {
    const acc = accFrom([null, undefined, "", "   "]);
    expect(acc.size).toBe(0);
  });
});
