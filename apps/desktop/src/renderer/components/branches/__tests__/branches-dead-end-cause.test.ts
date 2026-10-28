/**
 * @file branches-dead-end-cause.test.ts
 * @description ISS-9725: the four no-data states the Branches list can be in
 * must stay four different records. The point of these cases is not that a
 * failure produces SOMETHING — it is that a failure, a filtered-away result, a
 * genuinely empty org and an unsettled read cannot be confused for one another
 * downstream, which is the only way "how often does a reader hit a broken
 * Branches list" is answerable at all.
 */
import { describe, expect, it } from "vitest";
import {
  DeadEndFlowReason,
  DeadEndFlowState,
  DeadEndFlowTreatment,
} from "../../../../shared/dead-end-telemetry-contract";
import {
  type BranchesListDeadEndInputs,
  resolveBranchesListDeadEnd,
} from "../branches-dead-end-cause";

function inputs(
  overrides: Partial<BranchesListDeadEndInputs> = {}
): BranchesListDeadEndInputs {
  return {
    hasActiveFilters: false,
    hasWindow: false,
    httpStatus: null,
    isError: false,
    isPending: false,
    visibleRowCount: 0,
    ...overrides,
  };
}

describe("resolveBranchesListDeadEnd (ISS-9725)", () => {
  // The ONE case that spells the wire values out. Everything below references
  // the contract consts, per the repo's enum-reference rule; this case is the
  // deliberate exception, because a test that only ever compares the consts to
  // themselves cannot notice a rename that silently retires a shipped
  // treatment for every dashboard already querying it.
  it("pins the wire literals a renamed member would silently change", () => {
    expect(resolveBranchesListDeadEnd(inputs({ isError: true }))).toEqual({
      treatment: "branches_list_unavailable",
      state: "unavailable",
      reason: "fetch_failed",
      retryOffered: true,
    });
    expect(resolveBranchesListDeadEnd(inputs())).toMatchObject({
      treatment: "branches_list_empty",
      state: "true_zero",
      reason: "absent",
    });
    expect(
      resolveBranchesListDeadEnd(inputs({ hasActiveFilters: true }))
    ).toMatchObject({ state: "not_applicable", reason: "filtered_out" });
  });

  it("reports a failed read as unavailable/fetch_failed, not as an empty org", () => {
    expect(resolveBranchesListDeadEnd(inputs({ isError: true }))).toEqual({
      treatment: DeadEndFlowTreatment.BranchesListUnavailable,
      state: DeadEndFlowState.Unavailable,
      reason: DeadEndFlowReason.FetchFailed,
      retryOffered: true,
    });
  });

  it("reports a genuinely empty org as true_zero/absent", () => {
    expect(resolveBranchesListDeadEnd(inputs())).toEqual({
      treatment: DeadEndFlowTreatment.BranchesListEmpty,
      state: DeadEndFlowState.TrueZero,
      reason: DeadEndFlowReason.Absent,
      retryOffered: false,
    });
  });

  it("reports a filtered-away result as not_applicable/filtered_out", () => {
    expect(
      resolveBranchesListDeadEnd(inputs({ hasActiveFilters: true }))
    ).toEqual({
      treatment: DeadEndFlowTreatment.BranchesListEmpty,
      state: DeadEndFlowState.NotApplicable,
      reason: DeadEndFlowReason.FilteredOut,
      retryOffered: false,
    });
  });

  it("keeps the three settled zero-row states mutually distinct", () => {
    const failed = resolveBranchesListDeadEnd(inputs({ isError: true }));
    const filtered = resolveBranchesListDeadEnd(
      inputs({ hasActiveFilters: true })
    );
    const trueZero = resolveBranchesListDeadEnd(inputs());
    const keys = [failed, filtered, trueZero].map(
      (cause) => `${cause?.treatment}|${cause?.state}|${cause?.reason}`
    );
    expect(new Set(keys).size).toBe(3);
  });

  it("keeps a failed read unavailable even while a filter is narrowing", () => {
    // The precedence that matters: a read that failed establishes nothing about
    // the population, so a filter being active cannot downgrade it to "no
    // matches" — a false all-clear over an outage.
    const cause = resolveBranchesListDeadEnd(
      inputs({ hasActiveFilters: true, hasWindow: true, isError: true })
    );
    expect(cause?.treatment).toBe(DeadEndFlowTreatment.BranchesListUnavailable);
    expect(cause?.state).toBe(DeadEndFlowState.Unavailable);
  });

  it.each([401, 403])(
    "classifies a %i as permission_denied rather than fetch_failed",
    (httpStatus) => {
      expect(
        resolveBranchesListDeadEnd(inputs({ httpStatus, isError: true }))
      ).toEqual({
        treatment: DeadEndFlowTreatment.BranchesListUnavailable,
        state: DeadEndFlowState.Unavailable,
        reason: DeadEndFlowReason.PermissionDenied,
        retryOffered: true,
        httpStatus,
      });
    }
  );

  it("carries a 503 and still calls it fetch_failed", () => {
    expect(
      resolveBranchesListDeadEnd(inputs({ httpStatus: 503, isError: true }))
    ).toMatchObject({
      reason: DeadEndFlowReason.FetchFailed,
      httpStatus: 503,
    });
  });

  it("omits httpStatus entirely when no response carried one", () => {
    const cause = resolveBranchesListDeadEnd(inputs({ isError: true }));
    expect(cause).not.toHaveProperty("httpStatus");
  });

  it("reports nothing while the read is unsettled", () => {
    // A spinner in the first seconds is the product working, and Branches runs
    // no stall detector that could establish otherwise.
    expect(resolveBranchesListDeadEnd(inputs({ isPending: true }))).toBeNull();
    // The paired positive: the same inputs with the read SETTLED do report.
    expect(
      resolveBranchesListDeadEnd(inputs({ isPending: false }))
    ).not.toBeNull();
  });

  it("reports nothing while rows are on screen, even over a failed refetch", () => {
    expect(
      resolveBranchesListDeadEnd(inputs({ isError: true, visibleRowCount: 3 }))
    ).toBeNull();
    // The paired positive: drop the rows and the same failure IS reported.
    expect(
      resolveBranchesListDeadEnd(inputs({ isError: true, visibleRowCount: 0 }))
    ).not.toBeNull();
  });
});
