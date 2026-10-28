import {
  BRANCH_CONTRIBUTOR_USER_ID_PARAM,
  BRANCH_LOC_MIN_PARAM,
  BRANCH_SESSION_PRESENCE_PARAM,
  BranchSessionPresence,
  BranchStatus,
} from "@repo/api/src/types/branch";
import {
  BranchListPageMode,
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract";
import { describe, expect, it } from "vitest";
import { canUseCandidateOrderForServerAnalytics } from "./branch-analytics-query-scope";
import type { BranchListQuery } from "./branch-list-query";

describe("branch analytics query scope policy", () => {
  it("allows candidate-order analytics for filters already enforced by SQL", () => {
    expect(
      canUseCandidateOrderForServerAnalytics(
        query({
          endDate: new Date("2026-08-20T12:00:00.000Z"),
          repo: ["closedloop-ai/closedloop-ai"],
          search: "branch",
          status: [BranchStatus.Open],
          [BRANCH_CONTRIBUTOR_USER_ID_PARAM]:
            "00000000-0000-4000-8000-000000000001",
        })
      )
    ).toBe(true);
  });

  it("requires projected rows for projection-only and row-derived filters", () => {
    expect(
      canUseCandidateOrderForServerAnalytics(query({ names: ["branch-1"] }))
    ).toBe(false);
    expect(
      canUseCandidateOrderForServerAnalytics(
        query({ [BRANCH_LOC_MIN_PARAM]: 10 })
      )
    ).toBe(false);
  });

  it("treats sort as non-scope for order-insensitive analytics", () => {
    expect(
      canUseCandidateOrderForServerAnalytics(
        query({
          sortKey: BranchListSortKey.Name,
          sortDir: BranchListSortDirection.Asc,
        })
      )
    ).toBe(true);
  });

  it("treats legacy session-presence as non-scope for analytics shortcuts", () => {
    const legacyQuery = query({
      [BRANCH_SESSION_PRESENCE_PARAM]: BranchSessionPresence.Has,
    });

    expect(canUseCandidateOrderForServerAnalytics(legacyQuery)).toBe(true);
  });
});

function query(overrides: Partial<BranchListQuery> = {}): BranchListQuery {
  return {
    limit: 20,
    offset: 0,
    pageMode: BranchListPageMode.Server,
    ...overrides,
  };
}
