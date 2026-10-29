import assert from "node:assert/strict";
import { type BranchRow, BranchStatus } from "@repo/api/src/types/branch.js";
import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
} from "@repo/api/src/types/branch-metrics.js";
import { describe, test } from "vitest";
import { pageBranches } from "../src/main/branch/shared-branches-paging.js";
import {
  countRetainedUnavailableBranches,
  filterBranchItemsByWindow,
  sortBranchItemsByLastActive,
} from "../src/main/branch/shared-branches-window.js";

const NOW = new Date("2026-08-18T12:00:00.000Z");
const REQUEST = {
  startDate: "2026-08-11T12:00:00.000Z",
  endDate: NOW.toISOString(),
};

describe("Desktop Branch Last-active cohort", () => {
  test("retains a future canonical timestamp before range bounds", () => {
    const future = row({
      canonicalLastActiveAt: {
        state: BranchMetricAvailability.Complete,
        value: "2026-08-19T12:00:00.000Z",
      },
      lastActivityAt: "2026-08-18T10:00:00.000Z",
    });

    const filtered = filterBranchItemsByWindow([future], REQUEST, NOW);

    assert.equal(filtered.length, 1);
    assert.equal(countRetainedUnavailableBranches(filtered, REQUEST, NOW), 1);
  });

  test("excludes a trustworthy timestamp outside the finite window", () => {
    const outside = row({
      canonicalLastActiveAt: {
        state: BranchMetricAvailability.Partial,
        value: "2026-08-01T12:00:00.000Z",
        disclosure: BranchMetricDisclosure.DefaultIncomplete,
      },
      lastActivityAt: "2026-08-01T12:00:00.000Z",
    });

    assert.deepEqual(filterBranchItemsByWindow([outside], REQUEST, NOW), []);
  });

  test("orders every unavailable shape last before 19/20/21-row pagination", () => {
    for (const count of [19, 20, 21]) {
      const known = Array.from({ length: count - 3 }, (_, index) =>
        row({
          id: `known-${index}`,
          branchName: `known-${index}`,
          canonicalLastActiveAt: {
            state: BranchMetricAvailability.Complete,
            value: new Date(NOW.getTime() - index * 60_000).toISOString(),
          },
        })
      );
      const unavailable = [
        row({
          id: "future",
          branchName: "future",
          canonicalLastActiveAt: {
            state: BranchMetricAvailability.Complete,
            value: "2026-08-18T18:00:00.000Z",
          },
        }),
        row({
          id: "malformed",
          branchName: "malformed",
          canonicalLastActiveAt: {
            state: BranchMetricAvailability.Complete,
            value: "not-a-timestamp",
          },
        }),
        row({
          id: "unknown",
          branchName: "unknown",
          canonicalLastActiveAt: {
            state: "future_contract_state",
            value: "2026-08-18T10:00:00.000Z",
          } as never,
        }),
      ];

      const ordered = sortBranchItemsByLastActive(
        [...unavailable, ...known],
        REQUEST,
        NOW
      );
      assert.deepEqual(
        ordered.slice(-3).map((item) => item.id),
        ["future", "malformed", "unknown"]
      );
      assert.equal(pageBranches(ordered, 20, 0).length, Math.min(count, 20));
      assert.equal(
        pageBranches(ordered, 20, 20).length,
        Math.max(0, count - 20)
      );
    }
  });
});

function row(over: Partial<BranchRow>): BranchRow {
  return {
    id: "branch-1",
    branchName: "feature/cohort",
    baseBranch: "main",
    repoFullName: "acme/web",
    owner: null,
    status: BranchStatus.Open,
    prNumber: null,
    prTitle: null,
    prState: null,
    prUrl: null,
    multiPrWarning: false,
    checksStatus: null,
    checksPassed: null,
    checksTotal: null,
    reviewDecision: null,
    ahead: null,
    behind: null,
    additions: null,
    deletions: null,
    filesChanged: null,
    estimatedCostUsd: null,
    lastActivityAt: "",
    sessionIds: [],
    ...over,
  };
}
