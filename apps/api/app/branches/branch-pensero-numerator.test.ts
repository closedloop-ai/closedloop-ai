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
import { withBranchFailedAcquisitionDay } from "./branch-pensero-failed-day";
import {
  branchPenseroNumerator,
  readBranchPenseroNumerator,
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
 * ISS-9814 — folding a delivery attribution into one branch's numerator.
 *
 * Every attribution here is built by the PRODUCTION fold
 * (`attributeDeliveryPoints`) rather than hand-assembled, so a change to how
 * rows resolve is exercised too instead of being mocked past.
 */
const BRANCH = "branch-artifact-1";
const OTHER_BRANCH = "branch-artifact-2";

describe("ISS-9814 branch Pensero numerator", () => {
  it("returns null when the read refused — outside the rollout, nothing read", () => {
    // Not a zero. Nothing was measured, so the card must keep showing LOC/$.
    expect(branchPenseroNumerator(null, BRANCH)).toBeNull();
  });

  it("returns null for an EMPTY delivery table", () => {
    // The likely production state today: the rollout has never been on for any
    // org, so `delivery_points` holds nothing and every branch reads no-data.
    const attribution = attributeDeliveryPoints([], [BRANCH]);

    expect(attribution.attributedPoints).toBeNull();
    expect(branchPenseroNumerator(attribution, BRANCH)).toBeNull();
  });

  it("AC3: a MEASURED zero folds to 0, not to null", () => {
    // This is the assertion the whole feature most plausibly gets wrong. A
    // `?? 0` would break the empty case above; a `|| null`, a falsy test, or a
    // truthiness check on the Decimal would break this one.
    const attribution = attributeDeliveryPoints(
      [row("r1", "0", BRANCH, "interaction-1")],
      [BRANCH]
    );

    expect(branchPenseroNumerator(attribution, BRANCH)).toEqual({
      points: 0,
      hasAmbiguousPoints: false,
      hasUnreadablePointValues: false,
    });
  });

  it("sums every role's share of an interaction exactly once", () => {
    // Operator ruling: `points` is a per-row SHARE, not a per-row total, so all
    // four role rows sum to the interaction's one value. 12 + 5 + 2 + 1 = 20 —
    // the worked "one PR worth 20 points" example, reconstructed once.
    const attribution = attributeDeliveryPoints(
      [
        row("creator", "12", null, "interaction-1"),
        row("reviewer", "5", BRANCH, "interaction-1"),
        row("assignee", "2", null, "interaction-1"),
        row("other", "1", null, "interaction-1"),
      ],
      [BRANCH]
    );

    expect(branchPenseroNumerator(attribution, BRANCH)).toEqual({
      points: 20,
      hasAmbiguousPoints: false,
      hasUnreadablePointValues: false,
    });
  });

  it("preserves the tenths the provider emits", () => {
    // `DECIMAL(12,4)` summed in Decimal upstream; 0.1 + 0.2 through a float
    // accumulator is 0.30000000000000004.
    const attribution = attributeDeliveryPoints(
      [
        row("r1", "0.1", BRANCH, "interaction-1"),
        row("r2", "0.2", BRANCH, "interaction-2"),
      ],
      [BRANCH]
    );

    expect(branchPenseroNumerator(attribution, BRANCH)?.points).toBe(0.3);
  });

  it("keeps a branch's own total when a sibling interaction is refused", () => {
    // An interaction whose rows name two branches is refused, never arbitrated,
    // so this branch keeps its own 4 and none of the refused 9. The `false`
    // coverage verdict this case also asserted is retired by ISS-9930's ruling —
    // the kernel no longer withholds on any coverage verdict, so there is no
    // longer a boolean here to be wrong.
    const attribution = attributeDeliveryPoints(
      [
        row("r1", "4", BRANCH, "interaction-1"),
        row("r2", "9", BRANCH, "interaction-2"),
        row("r3", "9", OTHER_BRANCH, "interaction-2"),
      ],
      [BRANCH, OTHER_BRANCH]
    );

    const numerator = branchPenseroNumerator(attribution, BRANCH);
    expect(numerator?.points).toBe(4);
    // ISS-9930: the refusal no longer withholds the number, but it IS the
    // ambiguity the disclosure names — 4 published of a possible 13.
    expect(numerator?.hasAmbiguousPoints).toBe(true);
    expect(numerator?.hasUnreadablePointValues).toBe(false);
  });

  it("does not hand one branch another branch's points", () => {
    const attribution = attributeDeliveryPoints(
      [row("r1", "8", OTHER_BRANCH, "interaction-1")],
      [BRANCH, OTHER_BRANCH]
    );

    expect(branchPenseroNumerator(attribution, BRANCH)).toBeNull();
    expect(branchPenseroNumerator(attribution, OTHER_BRANCH)?.points).toBe(8);
  });
});

/**
 * ISS-9930 AC4 — the case the ticket was filed about, end to end.
 *
 * The attribution is built by the PRODUCTION fold and EVERY stored row resolves
 * to a branch, which is the state that used to publish `Complete`. The stored
 * rows were never the question: acquisition may not have stored the days at all.
 */
describe("ISS-9930 an all-attributable branch still reads Partial", () => {
  const COST: BranchMetricResult<number> = {
    state: BranchMetricAvailability.Complete,
    value: 10,
  };

  it("AC4: a failed acquisition day reads Partial and names the failed days", () => {
    const attribution = allAttributable();
    expect(attribution.unattributed.rowCount).toBe(0);

    const numerator = numeratorFor(attribution, true);

    expect(calculateDetailPenseroPointsPerDollar(numerator, COST)).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 2,
      disclosure: BranchMetricDisclosure.PenseroAcquisitionDaysFailed,
    });
  });

  it("AC1/AC3: with no failed day it is still Partial, naming unswept history", () => {
    // `PenseroBackfillCursor`'s schema doc: the backward walk has "no historical
    // cutoff and no total cap", so history below the cursor always remains —
    // there is no ledger state that makes this one Complete.
    const numerator = numeratorFor(allAttributable(), false);

    expect(calculateDetailPenseroPointsPerDollar(numerator, COST)).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 2,
      disclosure: BranchMetricDisclosure.PenseroAcquisitionIncomplete,
    });
  });

  it("ISS-9930: a branch short of its OWN rows says so, and still publishes", () => {
    // The ambiguity path, end to end through the production fold. `r2`/`r3`
    // name two branches for one interaction, so `attributeDeliveryPoints`
    // refuses it whole: BRANCH keeps 4 of a possible 13. Before the ruling that
    // refusal withheld the number; now it publishes 4 and NAMES the cause.
    const attribution = ambiguous();
    expect(attribution.unattributed.unresolvedBranchRowCount).toBeGreaterThan(
      0
    );

    const numerator = numeratorFor(attribution, false);

    expect(calculateDetailPenseroPointsPerDollar(numerator, COST)).toEqual({
      state: BranchMetricAvailability.Partial,
      // 4 points over $10 — the number the reader keeps, not a refusal.
      value: 0.4,
      disclosure: BranchMetricDisclosure.PenseroAttributionAmbiguous,
    });
  });

  it("ISS-9930: a failed day AND ambiguity compose, dropping neither cause", () => {
    const attribution = ambiguous();
    expect(attribution.unattributed.unresolvedBranchRowCount).toBeGreaterThan(
      0
    );

    const numerator = numeratorFor(attribution, true);

    expect(calculateDetailPenseroPointsPerDollar(numerator, COST)).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 0.4,
      disclosure:
        BranchMetricDisclosure.PenseroDaysFailedAndAttributionAmbiguous,
    });
  });

  it("ISS-10608: a CORRUPT stored share names unreadable values, not ambiguity", () => {
    // `attributeDeliveryPoints` refuses `interaction-corrupt` because `dp-bad`
    // holds a negative share, NOT because its rows named two branches — they
    // all named BRANCH. The reader is owed that cause, and not the ambiguity
    // one (tamsinb, PR #7539).
    const attribution = corrupt();
    expect(attribution.unattributed.rowCount).toBe(2);
    expect(attribution.unattributed.unresolvedBranchRowCount).toBe(0);

    const numerator = numeratorFor(attribution, false);

    expect(numerator?.hasAmbiguousPoints).toBe(false);
    expect(numerator?.hasUnreadablePointValues).toBe(true);
    expect(calculateDetailPenseroPointsPerDollar(numerator, COST)).toEqual({
      state: BranchMetricAvailability.Partial,
      // The 20 points that DID attribute still publish — the corrupt rows cost
      // the reader their share, never the number.
      value: 2,
      disclosure: BranchMetricDisclosure.PenseroPointValuesUnreadable,
    });
  });

  it("ISS-10608: ambiguity AND a corrupt share on one branch name both causes", () => {
    const attribution = attributeDeliveryPoints(
      [
        row("r1", "20", BRANCH, "interaction-1"),
        row("dp-good", "10", BRANCH, "interaction-corrupt"),
        row("dp-bad", "-4", BRANCH, "interaction-corrupt"),
        row("s1", "9", BRANCH, "interaction-shared"),
        row("s2", "9", OTHER_BRANCH, "interaction-shared"),
      ],
      [BRANCH, OTHER_BRANCH]
    );

    expect(
      calculateDetailPenseroPointsPerDollar(
        numeratorFor(attribution, false),
        COST
      )
    ).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 2,
      disclosure:
        BranchMetricDisclosure.PenseroAttributionAmbiguousAndPointValuesUnreadable,
    });
  });

  it("ISS-10608: a corrupt share on ANOTHER branch in the pass is not this branch's", () => {
    const attribution = attributeDeliveryPoints(
      [
        row("r1", "20", BRANCH, "interaction-1"),
        row("o1", "10", OTHER_BRANCH, "interaction-corrupt"),
        row("o2", "-4", OTHER_BRANCH, "interaction-corrupt"),
      ],
      [BRANCH, OTHER_BRANCH]
    );

    expect(branchPenseroNumerator(attribution, BRANCH)).toEqual({
      points: 20,
      hasAmbiguousPoints: false,
      hasUnreadablePointValues: false,
    });
  });

  /**
   * The production composition: the fold states what the attribution shows and
   * the ledger's day flag is added by the caller, exactly as
   * {@link readBranchPenseroNumerator} does it.
   */
  function numeratorFor(
    attribution: ReturnType<typeof attributeDeliveryPoints>,
    hasFailedAcquisitionDay: boolean
  ) {
    const numerator = branchPenseroNumerator(attribution, BRANCH);
    return numerator === null
      ? null
      : { ...numerator, hasFailedAcquisitionDay };
  }

  /** Two rows, one interaction each, both resolving to BRANCH: 20 points. */
  function allAttributable() {
    return attributeDeliveryPoints(
      [
        row("r1", "12", BRANCH, "interaction-1"),
        row("r2", "8", BRANCH, "interaction-2"),
      ],
      [BRANCH]
    );
  }

  /** One interaction carries a negative share and is refused: BRANCH keeps 20. */
  function corrupt() {
    return attributeDeliveryPoints(
      [
        row("r1", "20", BRANCH, "interaction-1"),
        row("dp-good", "10", BRANCH, "interaction-corrupt"),
        row("dp-bad", "-4", BRANCH, "interaction-corrupt"),
      ],
      [BRANCH]
    );
  }

  /** One interaction naming two branches is refused whole: BRANCH keeps 4/13. */
  function ambiguous() {
    return attributeDeliveryPoints(
      [
        row("r1", "4", BRANCH, "interaction-1"),
        row("r2", "9", BRANCH, "interaction-2"),
        row("r3", "9", OTHER_BRANCH, "interaction-2"),
      ],
      [BRANCH, OTHER_BRANCH]
    );
  }
});

describe("ISS-9814 readBranchPenseroNumerator is never fatal and never eager", () => {
  const identity = { userId: "user-1", clerkUserId: "clerk-1" };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("degrades to null when the delivery read throws, instead of propagating", () => {
    // apps/api/app/branches/AGENTS.md: "An optional analytics read on a required
    // path takes the whole surface down when it times out." The read opens a
    // RepeatableRead transaction, which can fail with a serialization error
    // under a concurrent backfill. That must not 500 the branch-detail page.
    mocks.isFeatureFlagEnabledForAnyIdentity.mockResolvedValue(true);
    mocks.readPenseroBranchDeliveryPoints.mockRejectedValue(
      new Error("could not serialize access due to concurrent update")
    );

    return expect(
      readBranchPenseroNumerator(identity, "org-1", BRANCH)
    ).resolves.toBeNull();
  });

  it("skips the database entirely when the display flag is off", async () => {
    // The gate is checked BEFORE the transaction, so an org in the write
    // rollout does not pay for a second interactive transaction per request
    // whose result nothing will render.
    mocks.isFeatureFlagEnabledForAnyIdentity.mockResolvedValue(false);

    await expect(
      readBranchPenseroNumerator(identity, "org-1", BRANCH)
    ).resolves.toBeNull();
    expect(mocks.readPenseroBranchDeliveryPoints).not.toHaveBeenCalled();
  });

  it("reads this branch's points for the caller's org when the flag is on", async () => {
    mocks.isFeatureFlagEnabledForAnyIdentity.mockResolvedValue(true);
    mocks.readPenseroBranchDeliveryPoints.mockResolvedValue(
      attributeDeliveryPoints(
        [row("r1", "20", BRANCH, "interaction-1")],
        [BRANCH]
      )
    );

    await expect(
      readBranchPenseroNumerator(identity, "org-1", BRANCH)
    ).resolves.toEqual({
      points: 20,
      hasAmbiguousPoints: false,
      hasUnreadablePointValues: false,
    });
    expect(mocks.readPenseroBranchDeliveryPoints).toHaveBeenCalledWith(
      identity,
      "org-1",
      [BRANCH]
    );
    // ISS-10653: the window the probe needs is projected later, by the detail
    // read, so asking the ledger here could only be the org-wide question.
    expect(mocks.hasFailedPenseroBackfillDay).not.toHaveBeenCalled();
  });

  it("degrades to null when the flag evaluation itself throws", async () => {
    mocks.isFeatureFlagEnabledForAnyIdentity.mockRejectedValue(
      new Error("posthog unreachable")
    );

    await expect(
      readBranchPenseroNumerator(identity, "org-1", BRANCH)
    ).resolves.toBeNull();
  });
});

describe("withBranchFailedAcquisitionDay", () => {
  const POINTS = {
    points: 20,
    hasAmbiguousPoints: false,
    hasUnreadablePointValues: false,
  };
  const FIRST = "2026-08-03T09:00:00.000Z";
  const LAST = "2026-08-07T17:00:00.000Z";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ISS-9930: the failed-day probe is read for the CALLER'S org", async () => {
    // Two orgs with different ledger states. A probe that ignored its argument,
    // or read a global one, would hand org-2's branch org-1's shortfall and
    // print the wrong disclosure under its number.
    mocks.hasFailedPenseroBackfillDay.mockImplementation(
      (organizationId: string) => Promise.resolve(organizationId === "org-1")
    );
    const activity = activitySpan(FIRST, LAST);

    await expect(
      withBranchFailedAcquisitionDay(POINTS, "org-1", activity)
    ).resolves.toEqual({ ...POINTS, hasFailedAcquisitionDay: true });
    await expect(
      withBranchFailedAcquisitionDay(POINTS, "org-2", activity)
    ).resolves.toEqual({ ...POINTS, hasFailedAcquisitionDay: false });
  });

  it("ISS-9930: a failing ledger probe costs the DISCLOSURE, never the NUMBER", async () => {
    // The probe picks which sentence prints; it is not an operand of the ratio.
    // Root `AGENTS.md`, "Never Delete a Capability You Cannot Compute".
    mocks.hasFailedPenseroBackfillDay.mockRejectedValue(
      new Error("statement timeout")
    );

    await expect(
      withBranchFailedAcquisitionDay(POINTS, "org-1", activitySpan(FIRST, LAST))
    ).resolves.toEqual({ ...POINTS, hasFailedAcquisitionDay: false });
  });

  it("ISS-9930: the ledger is not touched when there is no numerator to qualify", async () => {
    await expect(
      withBranchFailedAcquisitionDay(null, "org-1", activitySpan(FIRST, LAST))
    ).resolves.toBeNull();
    expect(mocks.hasFailedPenseroBackfillDay).not.toHaveBeenCalled();
  });

  it.each([
    ["both ends", FIRST, LAST, { start: new Date(FIRST), end: new Date(LAST) }],
    [
      "a reversed pair still spans both",
      LAST,
      FIRST,
      { start: new Date(FIRST), end: new Date(LAST) },
    ],
    [
      "only the first end leaves the window open after it",
      FIRST,
      null,
      { start: new Date(FIRST) },
    ],
    [
      "only the last end leaves the window open before it",
      null,
      LAST,
      { end: new Date(LAST) },
    ],
    ["neither end is the org-wide probe", null, null, undefined],
  ] as const)(
    "ISS-10653: probes the branch's activity window — %s",
    async (_name, first, last, window) => {
      mocks.hasFailedPenseroBackfillDay.mockResolvedValue(false);

      await withBranchFailedAcquisitionDay(
        POINTS,
        "org-1",
        activitySpan(first, last)
      );

      expect(mocks.hasFailedPenseroBackfillDay).toHaveBeenCalledWith(
        "org-1",
        window
      );
    }
  );
});

function activitySpan(
  firstActivityT: string | null,
  lastActivityT: string | null
) {
  return { firstActivityT, lastActivityT, idleSpans: [] };
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
