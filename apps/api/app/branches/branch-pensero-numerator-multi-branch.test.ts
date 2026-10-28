import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
  type BranchMetricResult,
} from "@repo/api/src/types/branch-metrics";
import { Prisma } from "@repo/database";
import { calculateDetailPenseroPointsPerDollar } from "@repo/lib/branches/branch-detail-pensero-points";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  attributeDeliveryPoints,
  type DeliveryPointAttributionRow,
} from "@/lib/delivery-points/delivery-point-attribution";
import {
  branchPenseroNumerator,
  readCohortPenseroNumerator,
} from "./branch-pensero-numerator";

const mocks = vi.hoisted(() => ({
  isFeatureFlagEnabledForAnyIdentity: vi.fn(),
  readPenseroBranchDeliveryPoints: vi.fn(),
  hasFailedPenseroBackfillDay: vi.fn(),
}));

vi.mock("@/lib/feature-flag-identity", () => ({
  isFeatureFlagEnabledForAnyIdentity: mocks.isFeatureFlagEnabledForAnyIdentity,
}));

vi.mock("@/lib/delivery-points/delivery-point-read", () => ({
  readPenseroBranchDeliveryPoints: mocks.readPenseroBranchDeliveryPoints,
}));

vi.mock("../cron/backfill-pensero-delivery/ledger", () => ({
  hasFailedPenseroBackfillDay: mocks.hasFailedPenseroBackfillDay,
}));

/**
 * ISS-11117 — the listing page is the multi-branch caller
 * `branch-pensero-numerator.ts` used to forbid.
 *
 * `unattributed.unresolvedBranchRowCount` is a total over the whole attribution
 * pass. Read per row it is cross-row contamination: one branch's refused
 * interaction prints the ambiguity disclosure under every OTHER branch's
 * number in the same listing, over data that was never ambiguous. The whole file exists to hold that closed.
 */
const AMBIGUOUS_BRANCH = "branch-artifact-ambiguous";
const CLEAN_BRANCH = "branch-artifact-clean";
const UNREQUESTED_BRANCH = "branch-artifact-elsewhere";

const COST: BranchMetricResult<number> = {
  state: BranchMetricAvailability.Complete,
  value: 10,
};

describe("ISS-11117 a multi-branch attribution keeps ambiguity on its own row", () => {
  it("names ambiguity on the branch whose interaction was refused", () => {
    const attribution = listingAttribution();

    const numerator = branchPenseroNumerator(attribution, AMBIGUOUS_BRANCH);

    expect(numerator?.hasAmbiguousPoints).toBe(true);
    expect(
      calculateDetailPenseroPointsPerDollar(withNoFailedDay(numerator), COST)
    ).toEqual({
      state: BranchMetricAvailability.Partial,
      // 4 of a possible 13 points — the number the reader keeps.
      value: 0.4,
      disclosure: BranchMetricDisclosure.PenseroAttributionAmbiguous,
    });
  });

  it("does NOT put that ambiguity under the clean branch in the same pass", () => {
    const attribution = listingAttribution();
    // The fixture is only meaningful while the PASS total is non-zero: that
    // total is exactly what a per-row read of it would have printed here.
    expect(attribution.unattributed.unresolvedBranchRowCount).toBeGreaterThan(
      0
    );

    const numerator = branchPenseroNumerator(attribution, CLEAN_BRANCH);

    expect(numerator?.hasAmbiguousPoints).toBe(false);
    // Positively the unswept-history sentence, not merely "not the ambiguous
    // one": a row that rendered nothing at all would satisfy a bare negative.
    expect(
      calculateDetailPenseroPointsPerDollar(withNoFailedDay(numerator), COST)
    ).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 2,
      disclosure: BranchMetricDisclosure.PenseroAcquisitionIncomplete,
    });
  });

  it("counts a refusal against every REQUESTED branch its rows named", () => {
    // Both halves of an ambiguous interaction are in the requested cohort, so
    // both rows lost coverage to it and both say so. The per-branch view is a
    // view, not a disjoint split — neither branch received a share to divide.
    const attribution = attributeDeliveryPoints(
      [
        row("a1", "9", AMBIGUOUS_BRANCH, "i-shared"),
        row("b1", "9", CLEAN_BRANCH, "i-shared"),
      ],
      [AMBIGUOUS_BRANCH, CLEAN_BRANCH]
    );

    expect(
      attribution.unattributed.unresolvedBranchRowCountByBranchArtifactId.get(
        AMBIGUOUS_BRANCH
      )
    ).toBe(2);
    expect(
      attribution.unattributed.unresolvedBranchRowCountByBranchArtifactId.get(
        CLEAN_BRANCH
      )
    ).toBe(2);
    // Neither branch attributed anything, so neither publishes a numerator.
    expect(branchPenseroNumerator(attribution, AMBIGUOUS_BRANCH)).toBeNull();
    expect(branchPenseroNumerator(attribution, CLEAN_BRANCH)).toBeNull();
  });

  it("records nothing for a branch the refused interaction never named", () => {
    const attribution = listingAttribution();

    expect(
      attribution.unattributed.unresolvedBranchRowCountByBranchArtifactId.get(
        CLEAN_BRANCH
      )
    ).toBeUndefined();
    expect(
      attribution.unattributed.unresolvedBranchRowCountByBranchArtifactId.get(
        AMBIGUOUS_BRANCH
      )
    ).toBe(2);
  });
});

/**
 * One listing cohort's pass: `AMBIGUOUS_BRANCH` keeps 4 points and loses an
 * interaction to a branch outside the cohort; `CLEAN_BRANCH` has 20 points and
 * nothing refused.
 */
function listingAttribution() {
  return attributeDeliveryPoints(
    [
      row("a1", "4", AMBIGUOUS_BRANCH, "i-1"),
      row("a2", "9", AMBIGUOUS_BRANCH, "i-2"),
      row("x1", "9", UNREQUESTED_BRANCH, "i-2"),
      row("b1", "20", CLEAN_BRANCH, "i-3"),
    ],
    [AMBIGUOUS_BRANCH, CLEAN_BRANCH]
  );
}

/** The production composition: the ledger day flag is the caller's to add. */
function withNoFailedDay(numerator: ReturnType<typeof branchPenseroNumerator>) {
  return numerator === null
    ? null
    : { ...numerator, hasFailedAcquisitionDay: false };
}

function row(
  id: string,
  points: string,
  branchArtifactId: string | null,
  providerInteractionId: string | null,
  /** ISS-11117: the day the provider dated this share. Defaults inside the
   *  windows these cases use, so a case that does not exercise windowing keeps
   *  reading as a lifetime fold. */
  deliveredOn: Date = ROW_DELIVERED_ON
): DeliveryPointAttributionRow {
  return {
    id,
    points: new Prisma.Decimal(points),
    branchArtifactId,
    providerInteractionId,
    deliveredOn,
  };
}

/** The default `delivered_on` for a case that says nothing about windows. */
const ROW_DELIVERED_ON = new Date("2026-03-15T00:00:00.000Z");

describe("ISS-11117 readCohortPenseroNumerator", () => {
  const identity = { userId: "user-1", clerkUserId: "clerk-1" };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("asks for the WHOLE cohort in ONE read, and sums what it attributed", async () => {
    // One pass, not one per row: a per-branch loop would open a transaction per
    // row AND put each row on its own snapshot, so a relink mid-page would make
    // two rows of one listing disagree about the same interaction.
    mocks.isFeatureFlagEnabledForAnyIdentity.mockResolvedValue(true);
    mocks.hasFailedPenseroBackfillDay.mockResolvedValue(false);
    mocks.readPenseroBranchDeliveryPoints.mockResolvedValue(
      listingAttribution()
    );

    await expect(
      readCohortPenseroNumerator(identity, "org-1", [
        AMBIGUOUS_BRANCH,
        CLEAN_BRANCH,
      ])
    ).resolves.toEqual({
      // 4 attributed to one branch plus 20 to the other — the cohort total.
      points: 24,
      hasFailedAcquisitionDay: false,
      // The cohort's OWN shortfall: `i-2` names a branch OUTSIDE the cohort,
      // so its points stay out of the total and the disclosure says so.
      hasAmbiguousPoints: true,
      hasUnreadablePointValues: false,
    });
    expect(mocks.readPenseroBranchDeliveryPoints).toHaveBeenCalledTimes(1);
    expect(mocks.readPenseroBranchDeliveryPoints).toHaveBeenCalledWith(
      identity,
      "org-1",
      [AMBIGUOUS_BRANCH, CLEAN_BRANCH],
      // No window: the all-time view, where the lifetime numerator and the
      // cohort's own all-time cost are the same period.
      undefined
    );
  });

  it("carries a BOUNDED window down to the delivery read", async () => {
    // tamsinb / chatgpt-codex-connector, PR #7863. Both listings default to
    // `Last7Days`, so a reader that only ever asked for the lifetime total
    // published Pts / $ on a view nobody lands on. The window has to reach the
    // fold, or the numerator is branch-lifetime over a windowed cost.
    mocks.isFeatureFlagEnabledForAnyIdentity.mockResolvedValue(true);
    mocks.hasFailedPenseroBackfillDay.mockResolvedValue(false);
    mocks.readPenseroBranchDeliveryPoints.mockResolvedValue(
      listingAttribution()
    );
    const window = { start: LAST_7D_START, end: LAST_7D_END };

    await expect(
      readCohortPenseroNumerator(
        identity,
        "org-1",
        [AMBIGUOUS_BRANCH, CLEAN_BRANCH],
        window
      )
    ).resolves.toEqual(expect.objectContaining({ points: expect.any(Number) }));
    expect(mocks.readPenseroBranchDeliveryPoints).toHaveBeenCalledWith(
      identity,
      "org-1",
      [AMBIGUOUS_BRANCH, CLEAN_BRANCH],
      window
    );
  });

  it("publishes a points ratio on a 7-DAY window from real in-window rows", async () => {
    // The end-to-end shape of the finding: the fold runs unmocked over rows
    // straddling the boundary, and the cohort total is the in-window share
    // only. `30` is the lifetime total these same rows produce, so a reader
    // that dropped the window would answer 30 and this case would fail.
    mocks.isFeatureFlagEnabledForAnyIdentity.mockResolvedValue(true);
    mocks.hasFailedPenseroBackfillDay.mockResolvedValue(false);
    const rows = [
      row("w1", "10", CLEAN_BRANCH, "i-in", new Date("2026-09-20T00:00:00Z")),
      row("w2", "20", CLEAN_BRANCH, "i-out", new Date("2026-08-01T00:00:00Z")),
    ];
    mocks.readPenseroBranchDeliveryPoints.mockImplementation(
      (_identity, _org, ids, window) =>
        Promise.resolve(attributeDeliveryPoints(rows, ids, window))
    );

    await expect(
      readCohortPenseroNumerator(identity, "org-1", [CLEAN_BRANCH], {
        start: LAST_7D_START,
        end: LAST_7D_END,
      })
    ).resolves.toEqual({
      points: 10,
      hasFailedAcquisitionDay: false,
      hasAmbiguousPoints: false,
      hasUnreadablePointValues: false,
    });
    await expect(
      readCohortPenseroNumerator(identity, "org-1", [CLEAN_BRANCH])
    ).resolves.toEqual(expect.objectContaining({ points: 30 }));
  });

  it("counts an interaction both cohort branches named, and discloses nothing", async () => {
    // tamsinb, PR #7863. `attributedPoints` drops `i-shared` because no single
    // branch may claim it; one number over the whole cohort has no such
    // question to answer, and dropping it would read LOW by an invisible
    // amount on exactly the stacked-PR shape a listing shows most.
    mocks.isFeatureFlagEnabledForAnyIdentity.mockResolvedValue(true);
    mocks.hasFailedPenseroBackfillDay.mockResolvedValue(false);
    mocks.readPenseroBranchDeliveryPoints.mockResolvedValue(
      attributeDeliveryPoints(
        [
          row("a1", "9", AMBIGUOUS_BRANCH, "i-shared"),
          row("b1", "9", CLEAN_BRANCH, "i-shared"),
          row("b2", "20", CLEAN_BRANCH, "i-3"),
        ],
        [AMBIGUOUS_BRANCH, CLEAN_BRANCH]
      )
    );

    await expect(
      readCohortPenseroNumerator(identity, "org-1", [
        AMBIGUOUS_BRANCH,
        CLEAN_BRANCH,
      ])
    ).resolves.toEqual({
      // 20 attributed plus the 18 no single branch could claim.
      points: 38,
      hasFailedAcquisitionDay: false,
      // Nothing was lost to THIS total, so it claims no shortfall of its own.
      hasAmbiguousPoints: false,
      hasUnreadablePointValues: false,
    });
  });

  it("ISS-10608: names a cohort's corrupt share as unreadable values, not ambiguity", async () => {
    // `i-shared` names two cohort branches, so ambiguity costs the cohort
    // nothing; the negative share is the only reason it stays out of the total.
    mocks.isFeatureFlagEnabledForAnyIdentity.mockResolvedValue(true);
    mocks.hasFailedPenseroBackfillDay.mockResolvedValue(false);
    mocks.readPenseroBranchDeliveryPoints.mockResolvedValue(
      attributeDeliveryPoints(
        [
          row("a1", "-9", AMBIGUOUS_BRANCH, "i-shared"),
          row("b1", "9", CLEAN_BRANCH, "i-shared"),
          row("b2", "20", CLEAN_BRANCH, "i-3"),
        ],
        [AMBIGUOUS_BRANCH, CLEAN_BRANCH]
      )
    );

    const numerator = await readCohortPenseroNumerator(identity, "org-1", [
      AMBIGUOUS_BRANCH,
      CLEAN_BRANCH,
    ]);

    expect(numerator).toEqual({
      points: 20,
      hasFailedAcquisitionDay: false,
      hasAmbiguousPoints: false,
      hasUnreadablePointValues: true,
    });
    expect(calculateDetailPenseroPointsPerDollar(numerator, COST)).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 2,
      disclosure: BranchMetricDisclosure.PenseroPointValuesUnreadable,
    });
  });

  it.each([
    [
      "the attribution read saw nothing at all",
      () => attributeDeliveryPoints([], [CLEAN_BRANCH]),
    ],
    [
      "rows existed and none of them was countable for this cohort",
      () =>
        attributeDeliveryPoints(
          [row("u1", "9", null, "i-1"), row("u2", "9", null, "i-1")],
          [CLEAN_BRANCH]
        ),
    ],
    ["the principal is outside the WRITE rollout", () => null],
  ])("publishes NO numerator — never a zero — when %s", async (_name, read) => {
    // AC2, and the rule that outranks every other line in this file: absence of
    // the field is what keeps the LOC/$ card rendering. A `0` here is a
    // measured zero and renders `0 Pts / $`, so collapsing "nothing to divide"
    // into it publishes a confident number over a population nobody measured.
    mocks.isFeatureFlagEnabledForAnyIdentity.mockResolvedValue(true);
    mocks.hasFailedPenseroBackfillDay.mockResolvedValue(false);
    mocks.readPenseroBranchDeliveryPoints.mockResolvedValue(read());

    await expect(
      readCohortPenseroNumerator(identity, "org-1", [CLEAN_BRANCH])
    ).resolves.toBeNull();
  });

  it("publishes a MEASURED zero as a number, not an absence", async () => {
    // The other side of the same distinction: Pensero scored this cohort at
    // zero, which is a fact and renders `0 Pts / $`.
    mocks.isFeatureFlagEnabledForAnyIdentity.mockResolvedValue(true);
    mocks.hasFailedPenseroBackfillDay.mockResolvedValue(false);
    mocks.readPenseroBranchDeliveryPoints.mockResolvedValue(
      attributeDeliveryPoints(
        [row("b1", "0", CLEAN_BRANCH, "i-1")],
        [CLEAN_BRANCH]
      )
    );

    await expect(
      readCohortPenseroNumerator(identity, "org-1", [CLEAN_BRANCH])
    ).resolves.toEqual({
      points: 0,
      hasFailedAcquisitionDay: false,
      hasAmbiguousPoints: false,
      hasUnreadablePointValues: false,
    });
  });

  it("skips the database entirely when the display flag is off", async () => {
    mocks.isFeatureFlagEnabledForAnyIdentity.mockResolvedValue(false);

    await expect(
      readCohortPenseroNumerator(identity, "org-1", [CLEAN_BRANCH])
    ).resolves.toBeNull();
    expect(mocks.readPenseroBranchDeliveryPoints).not.toHaveBeenCalled();
  });

  it("degrades to null when the delivery read throws, instead of propagating", async () => {
    // A closed-by-default metric must not be able to 500 a listing.
    mocks.isFeatureFlagEnabledForAnyIdentity.mockResolvedValue(true);
    mocks.readPenseroBranchDeliveryPoints.mockRejectedValue(
      new Error("could not serialize access due to concurrent update")
    );

    await expect(
      readCohortPenseroNumerator(identity, "org-1", [CLEAN_BRANCH])
    ).resolves.toBeNull();
  });

  it("asks nothing at all for an EMPTY cohort", async () => {
    await expect(
      readCohortPenseroNumerator(identity, "org-1", [])
    ).resolves.toBeNull();
    expect(mocks.isFeatureFlagEnabledForAnyIdentity).not.toHaveBeenCalled();
  });
});

/** The UTC-day bounds `getStableUtcDateWindowForRange("7d")` sends. */
const LAST_7D_START = new Date("2026-09-18T00:00:00.000Z");
const LAST_7D_END = new Date("2026-09-24T23:59:59.999Z");
