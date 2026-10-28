/**
 * The attribution fold on its own (ISS-9813) — the cases that are awkward to
 * reach through the two-pass read, and the accessor that keeps a caller from
 * turning "no evidence" into a measured zero.
 */

import { Prisma } from "@repo/database";
import { log } from "@repo/observability/log";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  attributeDeliveryPoints,
  branchCorruptStoredShareRowCount,
  branchDeliveryPoints,
  branchUnresolvedRowCount,
  type DeliveryPointAttributionRow,
} from "../delivery-point-attribution";

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const BRANCH_A = "art-branch-a";
const BRANCH_B = "art-branch-b";

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

describe("attributeDeliveryPoints", () => {
  it("keeps rows carrying no interaction id independent of one another", () => {
    // A row the provider models no interaction for has no siblings. Bucketing
    // every such row under one "null" key would make two branches look like a
    // self-contradicting interaction and suppress both.
    const attribution = attributeDeliveryPoints(
      [row("dp-1", "2.5", BRANCH_A, null), row("dp-2", "1.5", BRANCH_B, null)],
      [BRANCH_A, BRANCH_B]
    );

    expect(
      attribution.byBranchArtifactId.get(BRANCH_A)?.points.toString()
    ).toBe("2.5");
    expect(
      attribution.byBranchArtifactId.get(BRANCH_B)?.points.toString()
    ).toBe("1.5");
    expect(attribution.unattributed.rowCount).toBe(0);
    expect(attribution.attributedPoints?.toString()).toBe("4");
  });

  it("counts one interaction once however many shares it carries", () => {
    const attribution = attributeDeliveryPoints(
      [
        row("dp-1", "1", BRANCH_A, "int-1"),
        row("dp-2", "1", BRANCH_A, "int-1"),
        row("dp-3", "1", null, "int-1"),
        row("dp-4", "1", BRANCH_A, "int-2"),
      ],
      [BRANCH_A]
    );

    const branch = attribution.byBranchArtifactId.get(BRANCH_A);
    expect(branch?.interactionCount).toBe(2);
    expect(branch?.rowCount).toBe(4);
    expect(branch?.points.toString()).toBe("4");
  });

  it("skips an interaction resolved to a branch the caller did not ask about", () => {
    // Not our population, so not our missing coverage either: reporting it as
    // unattributed would overstate how short this answer is.
    const attribution = attributeDeliveryPoints(
      [row("dp-1", "7", BRANCH_B, "int-1")],
      [BRANCH_A]
    );

    expect(attribution.byBranchArtifactId.size).toBe(0);
    expect(attribution.attributedPoints).toBeNull();
    expect(attribution.unattributed.rowCount).toBe(0);
  });

  it("reports an interaction no row resolved without folding it in as zero", () => {
    const attribution = attributeDeliveryPoints(
      [
        row("dp-1", "4", null, "int-unresolved"),
        row("dp-2", "6", null, "int-unresolved"),
      ],
      [BRANCH_A]
    );

    expect(attribution.attributedPoints).toBeNull();
    expect(attribution.unattributed.rowCount).toBe(2);
    expect(attribution.unattributed.unresolvedBranchRowCount).toBe(2);
    expect(attribution.unattributed.interactionIds).toEqual(["int-unresolved"]);
  });

  it("sums in Decimal, so tenths do not drift the numerator", () => {
    // 0.1 + 0.2 + 0.3 + 0.4 is 0.9999999999999999 in IEEE-754 doubles.
    const attribution = attributeDeliveryPoints(
      [
        row("dp-1", "0.1", BRANCH_A, "int-1"),
        row("dp-2", "0.2", BRANCH_A, "int-1"),
        row("dp-3", "0.3", BRANCH_A, "int-1"),
        row("dp-4", "0.4", BRANCH_A, "int-1"),
      ],
      [BRANCH_A]
    );

    expect(attribution.attributedPoints?.toString()).toBe("1");
  });
});

describe("attributeDeliveryPoints with a corrupt stored share", () => {
  beforeEach(() => {
    vi.mocked(log.error).mockClear();
  });

  it("refuses a negative stored share instead of subtracting it from its siblings", () => {
    // `DECIMAL(12,4)` carries no nonnegative constraint, so this row is
    // reachable. Summed, `10 + -4` publishes `6` — a number nothing in the
    // response marks as wrong. The assertion is that no such number is
    // published at all.
    const attribution = attributeDeliveryPoints(
      [
        row("dp-1", "10", BRANCH_A, "int-corrupt"),
        row("dp-2", "-4", BRANCH_A, "int-corrupt"),
      ],
      [BRANCH_A]
    );

    expect(attribution.attributedPoints).toBeNull();
    expect(attribution.byBranchArtifactId.get(BRANCH_A)).toBeUndefined();
    expect(branchDeliveryPoints(attribution, BRANCH_A)).toBeNull();
    expect(attribution.unattributed.rowCount).toBe(2);
    // The rows all named BRANCH_A, so nothing here was ambiguous. A caller that
    // names a cause reads this, never the wider total (tamsinb, PR #7539).
    expect(attribution.unattributed.unresolvedBranchRowCount).toBe(0);
    expect(attribution.unattributed.interactionIds).toEqual(["int-corrupt"]);
    // ISS-10608: the corrupt cause is recorded against the branch it cost.
    expect(branchCorruptStoredShareRowCount(attribution, BRANCH_A)).toBe(2);
    expect(branchUnresolvedRowCount(attribution, BRANCH_A)).toBe(0);
  });

  it.each([
    ["NaN", "NaN"],
    ["positive infinity", "Infinity"],
    ["negative infinity", "-Infinity"],
  ])("refuses a non-finite stored share (%s)", (_label, points) => {
    const attribution = attributeDeliveryPoints(
      [
        row("dp-1", "10", BRANCH_A, "int-corrupt"),
        row("dp-2", points, BRANCH_A, "int-corrupt"),
      ],
      [BRANCH_A]
    );

    expect(attribution.attributedPoints).toBeNull();
    expect(attribution.byBranchArtifactId.get(BRANCH_A)).toBeUndefined();
    expect(attribution.unattributed.rowCount).toBe(2);
    expect(attribution.unattributed.unresolvedBranchRowCount).toBe(0);
    expect(attribution.unattributed.interactionIds).toEqual(["int-corrupt"]);
  });

  it("confines the refusal to the interaction that carries the corrupt row", () => {
    // A blanket bail would be its own lie: the clean interaction really was
    // measured, and its branch total is not in doubt.
    const attribution = attributeDeliveryPoints(
      [
        row("dp-1", "3", BRANCH_A, "int-clean"),
        row("dp-2", "-1", BRANCH_A, "int-corrupt"),
      ],
      [BRANCH_A]
    );

    const branch = attribution.byBranchArtifactId.get(BRANCH_A);
    expect(branch?.points.toString()).toBe("3");
    expect(branch?.interactionCount).toBe(1);
    expect(branch?.rowCount).toBe(1);
    expect(attribution.attributedPoints?.toString()).toBe("3");
    expect(attribution.unattributed.rowCount).toBe(1);
    expect(attribution.unattributed.unresolvedBranchRowCount).toBe(0);
    expect(attribution.unattributed.interactionIds).toEqual(["int-corrupt"]);
    expect(branchCorruptStoredShareRowCount(attribution, BRANCH_A)).toBe(1);
  });

  it("ISS-10608: records an ambiguous refusal and a corrupt one under their own causes", () => {
    const attribution = attributeDeliveryPoints(
      [
        row("dp-1", "3", BRANCH_A, "int-shared"),
        row("dp-2", "3", BRANCH_B, "int-shared"),
        row("dp-3", "5", BRANCH_B, "int-corrupt"),
        row("dp-4", "-1", BRANCH_B, "int-corrupt"),
      ],
      [BRANCH_A, BRANCH_B]
    );

    // Same refused rows as before the split: both interactions, four rows.
    expect(attribution.unattributed.rowCount).toBe(4);
    expect(attribution.attributedPoints).toBeNull();
    expect(branchUnresolvedRowCount(attribution, BRANCH_A)).toBe(2);
    expect(branchCorruptStoredShareRowCount(attribution, BRANCH_A)).toBe(0);
    expect(branchUnresolvedRowCount(attribution, BRANCH_B)).toBe(2);
    expect(branchCorruptStoredShareRowCount(attribution, BRANCH_B)).toBe(2);
  });

  it("keeps a measured zero legal", () => {
    const attribution = attributeDeliveryPoints(
      [row("dp-1", "0", BRANCH_A, "int-1")],
      [BRANCH_A]
    );

    expect(attribution.attributedPoints?.toString()).toBe("0");
    expect(attribution.unattributed.rowCount).toBe(0);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("surfaces the rejected rows and their stored values on the server log", () => {
    attributeDeliveryPoints(
      [
        row("dp-good", "10", BRANCH_A, "int-corrupt"),
        row("dp-bad", "-4", BRANCH_A, "int-corrupt"),
      ],
      [BRANCH_A]
    );

    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        branchArtifactIds: [BRANCH_A],
        providerInteractionId: "int-corrupt",
        rejectedRowCount: 2,
        corruptRows: [{ id: "dp-bad", points: "-4" }],
      })
    );
  });

  it("surfaces a two-branch refusal's corrupt rows on the same server log (whitlockk, PR #8131)", () => {
    const attribution = attributeDeliveryPoints(
      [
        row("dp-good", "6", BRANCH_A, "int-corrupt"),
        row("dp-bad", "-6", BRANCH_B, "int-corrupt"),
      ],
      [BRANCH_A, BRANCH_B]
    );

    expect(attribution.unattributed.cohortCorruptStoredShareRowCount).toBe(2);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        branchArtifactIds: [BRANCH_A, BRANCH_B],
        providerInteractionId: "int-corrupt",
        rejectedRowCount: 2,
        corruptRows: [{ id: "dp-bad", points: "-6" }],
      })
    );
  });
});

describe("branchDeliveryPoints", () => {
  it("tells a measured zero apart from a branch with no evidence", () => {
    const attribution = attributeDeliveryPoints(
      [row("dp-1", "0", BRANCH_A, "int-1")],
      [BRANCH_A, BRANCH_B]
    );

    expect(branchDeliveryPoints(attribution, BRANCH_A)?.toString()).toBe("0");
    expect(branchDeliveryPoints(attribution, BRANCH_B)).toBeNull();
  });
});

/**
 * ISS-11117 (tamsinb, chatgpt-codex-connector, PR #7863) — the WINDOWED fold.
 *
 * Both listings default to `Last7Days`, so a points ratio that published only
 * over a lifetime numerator published on a view nobody lands on. The fold is
 * what makes a bounded one computable: the READ stays un-windowed, so an
 * interaction still resolves from its whole row set, and only the shares the
 * provider dated inside the window are summed.
 */
describe("attributeDeliveryPoints over a window", () => {
  it("sums only the shares the provider dated inside it", () => {
    const rows = [
      row("dp-in", "3", BRANCH_A, "int-1", new Date("2026-01-10T00:00:00Z")),
      row("dp-out", "9", BRANCH_A, "int-1", new Date("2026-02-10T00:00:00Z")),
    ];

    const windowed = attributeDeliveryPoints(rows, [BRANCH_A], JANUARY);
    const lifetime = attributeDeliveryPoints(rows, [BRANCH_A]);

    // Paired deliberately: the windowed answer is only meaningful beside the
    // lifetime one it is NOT, and a fold that ignored the window would make
    // both assertions read `12`.
    expect(branchDeliveryPoints(windowed, BRANCH_A)?.toString()).toBe("3");
    expect(branchDeliveryPoints(lifetime, BRANCH_A)?.toString()).toBe("12");
  });

  it("still resolves the branch from an OUT-of-window sibling", () => {
    // The whole reason the read is un-windowed: the creator row carries the
    // largest share and no branch of its own, and the sibling that resolves it
    // routinely lands in another window. Windowing the SUM keeps that sibling's
    // resolving power while spending none of its points on this period.
    const attribution = attributeDeliveryPoints(
      [
        row("dp-creator", "8", null, "int-1", new Date("2026-01-10T00:00:00Z")),
        row(
          "dp-resolver",
          "2",
          BRANCH_A,
          "int-1",
          new Date("2026-02-10T00:00:00Z")
        ),
      ],
      [BRANCH_A],
      JANUARY
    );

    expect(branchDeliveryPoints(attribution, BRANCH_A)?.toString()).toBe("8");
  });

  it("is ADDITIVE: two disjoint windows sum to the lifetime total", () => {
    // What makes a windowed numerator safe to divide by a windowed cost. A fold
    // that selected whole INTERACTIONS by any-row-in-window would double-count
    // this one and fail here while passing the first case above.
    const rows = [
      row("dp-jan", "3", BRANCH_A, "int-1", new Date("2026-01-10T00:00:00Z")),
      row("dp-feb", "9", BRANCH_A, "int-1", new Date("2026-02-10T00:00:00Z")),
    ];
    const january = attributeDeliveryPoints(rows, [BRANCH_A], JANUARY);
    const february = attributeDeliveryPoints(rows, [BRANCH_A], {
      start: new Date("2026-02-01T00:00:00.000Z"),
      end: new Date("2026-02-28T23:59:59.999Z"),
    });

    expect(
      branchDeliveryPoints(january, BRANCH_A)
        ?.plus(branchDeliveryPoints(february, BRANCH_A) ?? 0)
        .toString()
    ).toBe(
      branchDeliveryPoints(
        attributeDeliveryPoints(rows, [BRANCH_A]),
        BRANCH_A
      )?.toString()
    );
  });

  it("includes a share dated ON either bound", () => {
    // `delivered_on` is a `@db.Date`, so a row sits at midnight UTC of its day
    // and the bounds a listing sends open at 00:00:00.000 and close at
    // 23:59:59.999. An exclusive comparison would silently drop the first day.
    const attribution = attributeDeliveryPoints(
      [
        row("dp-first", "1", BRANCH_A, "int-1", JAN_1),
        row(
          "dp-last",
          "1",
          BRANCH_A,
          "int-2",
          new Date("2026-01-31T00:00:00.000Z")
        ),
      ],
      [BRANCH_A],
      JANUARY
    );

    expect(branchDeliveryPoints(attribution, BRANCH_A)?.toString()).toBe("2");
  });

  it("publishes a MEASURED ZERO when every share is dated outside it", () => {
    // Not an absence: the read is un-windowed, so every share is in hand and
    // every one is dated elsewhere. That is a known zero, and `0 Pts / $` is
    // the honest render. Paired with a branch that has no evidence at all,
    // which stays `null` and keeps rendering LOC/$.
    const attribution = attributeDeliveryPoints(
      [row("dp-out", "9", BRANCH_A, "int-1", new Date("2026-02-10T00:00:00Z"))],
      [BRANCH_A, BRANCH_B],
      JANUARY
    );

    expect(branchDeliveryPoints(attribution, BRANCH_A)?.toString()).toBe("0");
    expect(branchDeliveryPoints(attribution, BRANCH_B)).toBeNull();
  });

  it("does not put an OUT-of-window ambiguity under an in-window number", () => {
    // A refusal whose every share is dated elsewhere cost this window's total
    // nothing, so it is not this answer's shortfall.
    const attribution = attributeDeliveryPoints(
      [
        row("dp-in", "3", BRANCH_A, "int-1", new Date("2026-01-10T00:00:00Z")),
        row("dp-x", "4", BRANCH_A, "int-2", new Date("2026-02-10T00:00:00Z")),
        row("dp-y", "4", BRANCH_B, "int-2", new Date("2026-02-10T00:00:00Z")),
      ],
      [BRANCH_A, BRANCH_B],
      JANUARY
    );

    expect(attribution.unattributed.unresolvedBranchRowCount).toBe(0);
    // Same rows, no window: the refusal IS this answer's shortfall.
    expect(
      attributeDeliveryPoints(
        [
          row(
            "dp-in",
            "3",
            BRANCH_A,
            "int-1",
            new Date("2026-01-10T00:00:00Z")
          ),
          row("dp-x", "4", BRANCH_A, "int-2", new Date("2026-02-10T00:00:00Z")),
          row("dp-y", "4", BRANCH_B, "int-2", new Date("2026-02-10T00:00:00Z")),
        ],
        [BRANCH_A, BRANCH_B]
      ).unattributed.unresolvedBranchRowCount
    ).toBe(2);
  });

  it("is byte-for-byte the lifetime fold when no window is given", () => {
    const rows = [
      row("dp-1", "3", BRANCH_A, "int-1", new Date("2020-01-01T00:00:00Z")),
      row("dp-2", "9", BRANCH_A, "int-1", new Date("2030-01-01T00:00:00Z")),
    ];

    expect(
      branchDeliveryPoints(
        attributeDeliveryPoints(rows, [BRANCH_A], undefined),
        BRANCH_A
      )?.toString()
    ).toBe("12");
  });
});

const JAN_1 = new Date("2026-01-01T00:00:00.000Z");
const JAN_31 = new Date("2026-01-31T23:59:59.999Z");
const JANUARY = { start: JAN_1, end: JAN_31 };
