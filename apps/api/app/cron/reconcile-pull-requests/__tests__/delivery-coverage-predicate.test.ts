/**
 * ISS-12034 — the shared coverage predicate's own boundaries.
 *
 * This module is the single owner of "covered" for the PRD-683 ratio, read in
 * one direction by `delivery-coverage-metrics.ts` and in the other (as SQL,
 * rendered from the same field map) by `session-linked-targets.ts`. These cases
 * pin the boundaries both sides inherit; that the SQL half actually agrees with
 * them on real rows is pinned in
 * `__tests__/integration/iss12034-delivery-coverage-gap-selector.integration.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  DELIVERY_COVERAGE_LOC_FIELDS,
  hasCompleteDeliveryCoverageLoc,
  isDeliveryCoverageCovered,
} from "../delivery-coverage-predicate";

const COMPLETE_LOC = { additions: 10, deletions: 2 } as const;

describe("hasCompleteDeliveryCoverageLoc", () => {
  it("requires every declared LOC field", () => {
    expect(hasCompleteDeliveryCoverageLoc(COMPLETE_LOC)).toBe(true);
  });

  it("is false when ANY single field is null", () => {
    // Driven off the field map rather than a hand-written list, so a field added
    // to the map is covered here the moment it is added.
    for (const { field } of DELIVERY_COVERAGE_LOC_FIELDS) {
      expect(
        hasCompleteDeliveryCoverageLoc({ ...COMPLETE_LOC, [field]: null })
      ).toBe(false);
    }
  });

  it("counts a real zero as present", () => {
    // A PR that genuinely changed nothing is enriched, not unmeasured. A
    // falsy check instead of a null check would read it as missing and send it
    // round the provider forever.
    expect(hasCompleteDeliveryCoverageLoc({ additions: 0, deletions: 0 })).toBe(
      true
    );
  });
});

describe("isDeliveryCoverageCovered", () => {
  it("counts a row with complete LOC", () => {
    expect(
      isDeliveryCoverageCovered({ ...COMPLETE_LOC, isCurrent: false })
    ).toBe(true);
  });

  it("counts a promoted row even with no LOC at all", () => {
    // This disjunct is why the self-heal arm could never reach an uncovered
    // row: it selects on `isCurrent`, which lands here.
    expect(
      isDeliveryCoverageCovered({
        additions: null,
        deletions: null,
        isCurrent: true,
      })
    ).toBe(true);
  });

  it("counts a promoted row with partial LOC", () => {
    expect(
      isDeliveryCoverageCovered({
        additions: 10,
        deletions: null,
        isCurrent: true,
      })
    ).toBe(true);
  });

  it("does NOT count a superseded row whose LOC never landed", () => {
    // The whole population ISS-12034 exists to heal, and the only shape for
    // which both disjuncts are false.
    expect(
      isDeliveryCoverageCovered({
        additions: null,
        deletions: null,
        isCurrent: false,
      })
    ).toBe(false);
  });

  it("does NOT count a superseded row missing only one LOC field", () => {
    expect(
      isDeliveryCoverageCovered({
        additions: 10,
        deletions: null,
        isCurrent: false,
      })
    ).toBe(false);
  });
});
