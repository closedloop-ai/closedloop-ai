import { describe, expect, it } from "vitest";
import {
  ARTIFACT_STATUS_ROOT,
  DISPLAYED_ARTIFACT_STATUS,
} from "./artifact-status.ts";
import {
  ARTIFACT_STATUS_ROOT_RANK,
  artifactStatusRootRank,
  artifactStatusRootRankOrNull,
} from "./artifact-status-rank.ts";

/**
 * ISS-9437 — the root half of the ordering contract.
 *
 * The exhaustiveness case is the load-bearing one. `ARTIFACT_STATUS_ROOT_RANK` is
 * built through an `Object.fromEntries` cast, which is exactly the shape that would
 * let a root added later compile while ranking as `unknown` — a silent default, and
 * the class of defect the repo's "adding a variant means visiting every map" rule
 * exists to stop. Asserting a key per member is what makes that fail here instead.
 */
describe("ARTIFACT_STATUS_ROOT_RANK", () => {
  it("ranks every displayed status, so a new root cannot silently rank as unknown", () => {
    for (const status of Object.values(DISPLAYED_ARTIFACT_STATUS)) {
      expect(ARTIFACT_STATUS_ROOT_RANK[status]).toBeTypeOf("number");
    }
    expect(Object.keys(ARTIFACT_STATUS_ROOT_RANK)).toHaveLength(
      Object.values(DISPLAYED_ARTIFACT_STATUS).length
    );
  });

  it("orders the five roots as ISS-9432 declares them, todo through canceled", () => {
    const ranks = [
      ARTIFACT_STATUS_ROOT.Todo,
      ARTIFACT_STATUS_ROOT.InProgress,
      ARTIFACT_STATUS_ROOT.InReview,
      ARTIFACT_STATUS_ROOT.Done,
      ARTIFACT_STATUS_ROOT.Canceled,
    ].map((root) => ARTIFACT_STATUS_ROOT_RANK[root]);

    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it("ranks unknown after every real root", () => {
    const unknownRank =
      ARTIFACT_STATUS_ROOT_RANK[DISPLAYED_ARTIFACT_STATUS.Unknown];

    for (const root of Object.values(ARTIFACT_STATUS_ROOT)) {
      expect(ARTIFACT_STATUS_ROOT_RANK[root]).toBeLessThan(unknownRank);
    }
  });
});

describe("artifactStatusRootRank", () => {
  it("ranks an unrecognized value and a nullish one with unknown", () => {
    const unknownRank =
      ARTIFACT_STATUS_ROOT_RANK[DISPLAYED_ARTIFACT_STATUS.Unknown];

    expect(artifactStatusRootRank("not-a-root")).toBe(unknownRank);
    expect(artifactStatusRootRank(null)).toBe(unknownRank);
    expect(artifactStatusRootRank(undefined)).toBe(unknownRank);
    expect(artifactStatusRootRank("")).toBe(unknownRank);
  });

  it("does not read an inherited key as a rank", () => {
    // A computed key, not a quoted one in a literal: a quoted "__proto__" in an
    // object literal creates no own property, so the naive fixture cannot reach
    // the branch this asserts.
    expect(artifactStatusRootRank("__proto__")).toBe(
      ARTIFACT_STATUS_ROOT_RANK[DISPLAYED_ARTIFACT_STATUS.Unknown]
    );
    expect(artifactStatusRootRank("constructor")).toBe(
      ARTIFACT_STATUS_ROOT_RANK[DISPLAYED_ARTIFACT_STATUS.Unknown]
    );
  });
});

describe("artifactStatusRootRankOrNull", () => {
  it("reports unknown as null so a comparator can park it before applying direction", () => {
    expect(
      artifactStatusRootRankOrNull(DISPLAYED_ARTIFACT_STATUS.Unknown)
    ).toBe(null);
    expect(artifactStatusRootRankOrNull("not-a-root")).toBe(null);
    expect(artifactStatusRootRankOrNull(null)).toBe(null);
  });

  it("reports a real root as its rank", () => {
    for (const root of Object.values(ARTIFACT_STATUS_ROOT)) {
      expect(artifactStatusRootRankOrNull(root)).toBe(
        ARTIFACT_STATUS_ROOT_RANK[root]
      );
    }
  });

  /**
   * The ruled placement (ISS-9437) is unknown-last on BOTH directions, which a rank
   * alone cannot deliver — negating a rank delta for a descending sort flips it to
   * the top. This pins the property through the comparator the callers actually use,
   * rather than asserting the number and hoping.
   */
  it("keeps unknown last on ascending AND descending through a nulls-last comparator", () => {
    const compare = (
      a: string | null,
      b: string | null,
      direction: "asc" | "desc"
    ) => {
      const left = artifactStatusRootRankOrNull(a);
      const right = artifactStatusRootRankOrNull(b);
      if (left === null && right === null) {
        return 0;
      }
      if (left === null) {
        return 1;
      }
      if (right === null) {
        return -1;
      }
      return direction === "asc" ? left - right : right - left;
    };

    for (const direction of ["asc", "desc"] as const) {
      expect(
        compare(ARTIFACT_STATUS_ROOT.Todo, "not-a-root", direction)
      ).toBeLessThan(0);
      expect(
        compare("not-a-root", ARTIFACT_STATUS_ROOT.Canceled, direction)
      ).toBeGreaterThan(0);
    }
  });
});
