import { describe, expect, it } from "vitest";
import { resolveBranchesSummaryPending } from "../branches-summary-state";

describe("resolveBranchesSummaryPending", () => {
  it("keeps existing rows visible while a list refetch is pending", () => {
    expect(
      resolveBranchesSummaryPending({
        analyticsPending: false,
        cohortPending: false,
        listPending: true,
        hasData: true,
      })
    ).toBe(false);
  });

  it("holds summary cards for missing rows, analytics, or cohort reads", () => {
    expect(
      resolveBranchesSummaryPending({
        analyticsPending: false,
        cohortPending: false,
        listPending: true,
        hasData: false,
      })
    ).toBe(true);
    expect(
      resolveBranchesSummaryPending({
        analyticsPending: true,
        cohortPending: false,
        listPending: false,
        hasData: true,
      })
    ).toBe(true);
    expect(
      resolveBranchesSummaryPending({
        analyticsPending: false,
        cohortPending: true,
        listPending: false,
        hasData: true,
      })
    ).toBe(true);
  });
});
