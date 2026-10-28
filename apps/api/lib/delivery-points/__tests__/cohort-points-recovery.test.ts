import { Prisma } from "@repo/database";
import { describe, expect, it } from "vitest";
import {
  attributeDeliveryPoints,
  type DeliveryPointAttributionRow,
} from "@/lib/delivery-points/delivery-point-attribution";

/**
 * ISS-11117 (tamsinb, PR #7863) — one COHORT total counts a refusal that only
 * a PER-BRANCH answer has to refuse.
 *
 * `attributedPoints` sums per-branch totals, so an interaction naming two
 * branches is dropped from it: attributing it to either would put one branch's
 * share under the other. A single number over the whole cohort asks no such
 * question, and when every branch the interaction named is inside the cohort
 * its points are the cohort's. Dropping them makes the listing's ratio read low
 * by an amount nothing on screen can show, on exactly the stacked-PR and
 * relinked-branch shapes a listing shows most.
 */
const BRANCH_A = "branch-artifact-a";
const BRANCH_B = "branch-artifact-b";
const OUTSIDE = "branch-artifact-outside";

describe("attributeDeliveryPoints cohort recovery", () => {
  it("counts a two-branch refusal when BOTH branches are in the cohort", () => {
    const attribution = attributeDeliveryPoints(
      [
        row("a1", "4", BRANCH_A, "i-1"),
        row("s1", "6", BRANCH_A, "i-2"),
        row("s2", "6", BRANCH_B, "i-2"),
      ],
      [BRANCH_A, BRANCH_B]
    );

    // The per-branch answer is unchanged: i-2 is still refused there.
    expect(attribution.attributedPoints?.toString()).toBe("4");
    // The cohort answer recovers it: 4 + 6 + 6.
    expect(attribution.cohortPoints?.toString()).toBe("16");
    // And it is NOT also reported as the cohort's shortfall.
    expect(attribution.unattributed.cohortUnresolvedRowCount).toBe(0);
    // The per-branch shortfall is untouched — both rows named both branches.
    expect(attribution.unattributed.unresolvedBranchRowCount).toBe(2);
  });

  it("keeps a refusal OUT when one named branch is outside the cohort", () => {
    const attribution = attributeDeliveryPoints(
      [
        row("a1", "4", BRANCH_A, "i-1"),
        row("s1", "6", BRANCH_A, "i-2"),
        row("s2", "6", OUTSIDE, "i-2"),
      ],
      [BRANCH_A]
    );

    // Some unknown share of i-2 belongs to a branch this call did not ask
    // about, so the cohort total may not claim any of it.
    expect(attribution.cohortPoints?.toString()).toBe("4");
    expect(attribution.unattributed.cohortUnresolvedRowCount).toBe(2);
  });

  it("keeps a refusal OUT when no row resolved to any branch at all", () => {
    const attribution = attributeDeliveryPoints(
      [
        row("a1", "4", BRANCH_A, "i-1"),
        row("u1", "6", null, "i-2"),
        row("u2", "6", null, "i-2"),
      ],
      [BRANCH_A]
    );

    // An interaction that named no cohort member has no evidence tying it here.
    expect(attribution.cohortPoints?.toString()).toBe("4");
    expect(attribution.unattributed.cohortUnresolvedRowCount).toBe(2);
  });

  it("refuses a recovered group carrying a corrupt stored share", () => {
    const attribution = attributeDeliveryPoints(
      [
        row("a1", "4", BRANCH_A, "i-1"),
        row("s1", "-6", BRANCH_A, "i-2"),
        row("s2", "6", BRANCH_B, "i-2"),
      ],
      [BRANCH_A, BRANCH_B]
    );

    // A negative share SUBTRACTS from its siblings, so the total would stay
    // plausible while being wrong. The cohort gate is the same one the
    // per-branch fold applies.
    expect(attribution.cohortPoints?.toString()).toBe("4");
    // ISS-10608: both named branches are in the cohort, so ambiguity cost the
    // cohort nothing; the corrupt share is the only reason i-2 stays out.
    expect(attribution.unattributed.cohortUnresolvedRowCount).toBe(0);
    expect(attribution.unattributed.cohortCorruptStoredShareRowCount).toBe(2);
  });

  it("charges a sole-branch corrupt refusal to the cohort as unreadable values", () => {
    const attribution = attributeDeliveryPoints(
      [
        row("a1", "4", BRANCH_A, "i-1"),
        row("c1", "6", BRANCH_B, "i-2"),
        row("c2", "-6", BRANCH_B, "i-2"),
      ],
      [BRANCH_A, BRANCH_B]
    );

    expect(attribution.cohortPoints?.toString()).toBe("4");
    expect(attribution.unattributed.cohortUnresolvedRowCount).toBe(0);
    expect(attribution.unattributed.cohortCorruptStoredShareRowCount).toBe(2);
  });

  it("keeps a straddling refusal's cause as ambiguity even when a share is corrupt", () => {
    const attribution = attributeDeliveryPoints(
      [
        row("a1", "4", BRANCH_A, "i-1"),
        row("s1", "-6", BRANCH_A, "i-2"),
        row("s2", "6", OUTSIDE, "i-2"),
      ],
      [BRANCH_A]
    );

    // One refusal, one cause: i-2 names a branch outside the cohort, which
    // keeps it out whatever its values are.
    expect(attribution.unattributed.cohortUnresolvedRowCount).toBe(2);
    expect(attribution.unattributed.cohortCorruptStoredShareRowCount).toBe(0);
  });

  it("is a MEASUREMENT when only a recovered refusal counted, and null when nothing did", () => {
    const recovered = attributeDeliveryPoints(
      [row("s1", "6", BRANCH_A, "i-2"), row("s2", "6", BRANCH_B, "i-2")],
      [BRANCH_A, BRANCH_B]
    );
    // No branch resolved a total of its own, yet the cohort measured 12.
    expect(recovered.attributedPoints).toBeNull();
    expect(recovered.cohortPoints?.toString()).toBe("12");

    const nothing = attributeDeliveryPoints([], [BRANCH_A]);
    // Never a zero: `null` is "no publishable numerator", which renders LOC/$.
    expect(nothing.cohortPoints).toBeNull();
  });
});

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
