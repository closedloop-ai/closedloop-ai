import { describe, expect, it } from "vitest";
import {
  type BranchMetricLocContribution,
  reconcileBranchPublicationLoc,
} from "./branch-publication-loc";

const EARLY = "2026-08-20T12:00:00.000Z";
const LATE = "2026-08-21T12:00:00.000Z";

describe("reconcileBranchPublicationLoc", () => {
  it("deduplicates matching changes at their earliest trustworthy occurrence", () => {
    const result = reconcileBranchPublicationLoc([
      contribution({ sourceEventId: "push", occurredAt: LATE }),
      contribution({ sourceEventId: "pull-request", occurredAt: EARLY }),
    ]);

    expect(result).toEqual({
      values: [
        {
          changeIdentity: "change-a",
          branchId: "branch-a",
          occurredAt: EARLY,
          additions: 20,
          deletions: 5,
        },
      ],
      conflicted: false,
      malformed: false,
    });
  });

  it("drops every identity with conflicting Branch or LOC facts", () => {
    const result = reconcileBranchPublicationLoc([
      contribution({ changeIdentity: "branch-conflict" }),
      contribution({
        changeIdentity: "branch-conflict",
        branchId: "branch-b",
      }),
      contribution({
        changeIdentity: "branch-conflict",
        sourceEventId: "ignored-after-conflict",
      }),
      contribution({ changeIdentity: "additions-conflict" }),
      contribution({
        changeIdentity: "additions-conflict",
        additions: 21,
      }),
      contribution({ changeIdentity: "deletions-conflict" }),
      contribution({
        changeIdentity: "deletions-conflict",
        deletions: 6,
      }),
    ]);

    expect(result).toEqual({
      values: [],
      conflicted: true,
      malformed: false,
    });
  });

  it("marks malformed contributions and excludes them", () => {
    const result = reconcileBranchPublicationLoc([
      contribution({ sourceEventId: " " }),
      contribution({ changeIdentity: "blank-branch", branchId: " " }),
      contribution({ changeIdentity: "null-additions", additions: null }),
      contribution({ changeIdentity: "negative-deletions", deletions: -1 }),
      contribution({ changeIdentity: "nan-additions", additions: Number.NaN }),
      contribution({
        changeIdentity: "infinite-deletions",
        deletions: Number.POSITIVE_INFINITY,
      }),
    ]);

    expect(result).toEqual({
      values: [],
      conflicted: false,
      malformed: true,
    });
  });

  it.each([
    {
      name: "both absent",
      left: null,
      right: null,
      expected: null,
      malformed: false,
    },
    {
      name: "both invalid",
      left: "invalid-left",
      right: "invalid-right",
      expected: null,
      malformed: true,
    },
    {
      name: "invalid left and absent right",
      left: "invalid-left",
      right: null,
      expected: null,
      malformed: true,
    },
    {
      name: "absent left and invalid right",
      left: null,
      right: "invalid-right",
      expected: null,
      malformed: true,
    },
    {
      name: "absent left",
      left: null,
      right: EARLY,
      expected: EARLY,
      malformed: false,
    },
    {
      name: "invalid left",
      left: "invalid-left",
      right: EARLY,
      expected: EARLY,
      malformed: true,
    },
    {
      name: "absent right",
      left: EARLY,
      right: null,
      expected: EARLY,
      malformed: false,
    },
    {
      name: "invalid right",
      left: EARLY,
      right: "invalid-right",
      expected: EARLY,
      malformed: true,
    },
    {
      name: "valid right before left",
      left: LATE,
      right: EARLY,
      expected: EARLY,
      malformed: false,
    },
    {
      name: "valid left before right",
      left: EARLY,
      right: LATE,
      expected: EARLY,
      malformed: false,
    },
    {
      name: "equal valid instants",
      left: EARLY,
      right: "2026-08-20T07:00:00.000-05:00",
      expected: EARLY,
      malformed: false,
    },
  ])(
    "reconciles $name occurrence timestamps",
    ({ left, right, expected, malformed }) => {
      const result = reconcileBranchPublicationLoc([
        contribution({ sourceEventId: "left", occurredAt: left }),
        contribution({ sourceEventId: "right", occurredAt: right }),
      ]);

      expect(result.values).toHaveLength(1);
      expect(result.values[0]?.occurredAt).toBe(expected);
      expect(result.conflicted).toBe(false);
      expect(result.malformed).toBe(malformed);
    }
  );

  it("falls back to Branch and source-event identity", () => {
    const result = reconcileBranchPublicationLoc([
      contribution({
        changeIdentity: undefined,
        sourceEventId: "push-a",
        branchId: "branch-a",
      }),
      contribution({
        changeIdentity: " ",
        sourceEventId: "push-b",
        branchId: "branch-a",
      }),
    ]);

    expect(result).toEqual({
      values: [
        {
          changeIdentity: "branch-a:push-a",
          branchId: "branch-a",
          occurredAt: LATE,
          additions: 20,
          deletions: 5,
        },
        {
          changeIdentity: "branch-a:push-b",
          branchId: "branch-a",
          occurredAt: LATE,
          additions: 20,
          deletions: 5,
        },
      ],
      conflicted: false,
      malformed: false,
    });
  });
});

function contribution(
  overrides: Partial<BranchMetricLocContribution> = {}
): BranchMetricLocContribution {
  return {
    sourceEventId: "event-a",
    changeIdentity: "change-a",
    branchId: "branch-a",
    occurredAt: LATE,
    additions: 20,
    deletions: 5,
    ...overrides,
  };
}
