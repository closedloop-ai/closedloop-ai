import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { getSharedBranchAnalytics } from "../src/main/branch/branch-analytics-read.js";
import {
  getSharedBranches,
  getSharedBranchesPageData,
} from "../src/main/branch/shared-branches-api.js";
import {
  type CannedRows,
  link,
  makeSource,
} from "./shared-branches-test-helpers.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";

describe("getSharedBranchesPageData (FEA-3056 follow-up: no drift from sharing rows)", () => {
  test("list + analytics exactly match the standalone reads", async () => {
    const rows: CannedRows = {
      links: [
        link({ branch_name: "merged-branch", session_id: "s1" }),
        link({ branch_name: "open-branch", session_id: "s2" }),
      ],
      prs: [
        {
          repo_full_name: "acme/web",
          branch_name: "merged-branch",
          pr_number: 1,
          pr_url: null,
          title: null,
          state: "closed",
          merged_at: "2026-06-11T10:00:00.000Z",
          closed_at: "2026-06-11T10:00:00.000Z",
          observed_at: "2026-06-11T10:00:00.000Z",
        },
        {
          repo_full_name: "acme/web",
          branch_name: "open-branch",
          pr_number: 2,
          pr_url: null,
          title: null,
          state: "open",
          merged_at: null,
          closed_at: null,
          observed_at: "2026-06-10T10:00:00.000Z",
        },
      ],
    };
    const request = { endDate: "2026-07-01T00:00:00.000Z" };
    // Each of the three reads stamps its OWN `new Date()` — surfaced as
    // `lastActiveCohort.evaluationNow` — so on the real clock this deep-equal
    // holds only while all three calls land in the same millisecond. What that
    // fails on is the clock, not the shared rows this test owns, and the
    // combined read's analytics half grew heavy enough that the gap now clears
    // a millisecond every run. Pin the clock; the comparison stays honest
    // because a genuine row-level drift still differs under a frozen `Date`.
    nodeTestTimers.enable(["Date"], {
      now: new Date("2026-08-01T00:00:00.000Z"),
    });
    try {
      const combined = await getSharedBranchesPageData(
        makeSource(rows),
        request
      );
      const list = await getSharedBranches(makeSource(rows), request);
      const analytics = await getSharedBranchAnalytics(
        makeSource(rows),
        request
      );
      // A pinned instant that emptied the population would make all three
      // reads agree on nothing at all, and the equalities below would hold
      // vacuously.
      assert.equal(combined.list.items.length, 2);
      assert.deepEqual(combined.list, list);
      assert.deepEqual(combined.analytics, analytics);
    } finally {
      nodeTestTimers.reset();
    }
  });
});
