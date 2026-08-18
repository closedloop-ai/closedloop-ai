import assert from "node:assert/strict";
import test from "node:test";
import { sumLocEnrichedSpend } from "../src/main/branch/branch-analytics-projection.js";
import {
  getSharedBranches,
  getSharedBranchesPageData,
} from "../src/main/branch/shared-branches-api.js";
import {
  link,
  makeBranchRowFixture as makeRow,
  makeSource,
} from "./shared-branches-test-helpers.js";

/**
 * ISS-4689 — the desktop half of the WINDOW-INDEPENDENT Value-per-$ divisor.
 *
 * The shared kernel apportions each session's cost evenly across the branches it
 * touched. Fed the WINDOWED item set, that divisor moved with the date window: a
 * session spanning branches of different ages lost the out-of-window branch from
 * the divisor at the same time its churn left the numerator, so the ratio shifted.
 * `readGlobalBranchCountsForItems` is desktop's equivalent of the cloud
 * `getSessionBranchCounts` — and, per review, it reads the count off the
 * PRE-DISPLAY active-write link set rather than counting the projected rows,
 * because the projection drops default branches that the cost split still counts.
 */

test("Value-per-$ denominator is unchanged when a shared branch drops out of the window", () => {
  // The reviewer's worked example (PR #4120): s1 cost $100 and touched TWO
  // enriched branches — bA (active today, 1000 churn) and bB (60d ago, 1000
  // churn). The corpus holds both regardless of the window.
  const branchA = makeRow({
    id: "bA",
    additions: 600,
    deletions: 400,
    sessionIds: ["s1"],
  });
  const branchB = makeRow({
    id: "bB",
    additions: 600,
    deletions: 400,
    sessionIds: ["s1"],
  });
  const usageRows = [{ sessionId: "s1", costUsdEstimated: 100 }];
  // s1 touched both corpus branches — the count the divisor read returns.
  const globalCounts = new Map([["s1", 2]]);

  // All-time: both branches windowed in → $100 × 2/2 over 2000 churn.
  const allTime = sumLocEnrichedSpend(
    [branchA, branchB],
    usageRows,
    globalCounts
  );
  // 7-day window: only bA survives → $100 × 1/2 over ITS 1000 churn.
  const windowed = sumLocEnrichedSpend([branchA], usageRows, globalCounts);

  assert.equal(allTime, 100);
  assert.equal(windowed, 50);
  // The rendered ratio is 20 on both — the fix's whole point.
  assert.equal(2000 / (allTime ?? 1), 20);
  assert.equal(1000 / (windowed ?? 1), 20);
});

test("without the global divisor the same narrowing still moves the ratio (pre-fix behavior)", () => {
  const branchA = makeRow({
    id: "bA",
    additions: 600,
    deletions: 400,
    sessionIds: ["s1"],
  });
  const branchB = makeRow({
    id: "bB",
    additions: 600,
    deletions: 400,
    sessionIds: ["s1"],
  });
  const usageRows = [{ sessionId: "s1", costUsdEstimated: 100 }];

  const allTime = sumLocEnrichedSpend([branchA, branchB], usageRows);
  const windowed = sumLocEnrichedSpend([branchA], usageRows);

  assert.equal(2000 / (allTime ?? 1), 20);
  assert.equal(1000 / (windowed ?? 1), 10);
});

test("un-enriched branches stay out of the numerator even with a global divisor", () => {
  // s1 touched 4 corpus branches; the supplied set holds one enriched and one
  // un-enriched, so only $100 × 1/4 of its spend has LOC to offset it.
  const enriched = makeRow({
    id: "bA",
    additions: 10,
    deletions: 10,
    sessionIds: ["s1"],
  });
  const unEnriched = makeRow({ id: "bB", sessionIds: ["s1"] });

  const spend = sumLocEnrichedSpend(
    [enriched, unEnriched],
    [{ sessionId: "s1", costUsdEstimated: 100 }],
    new Map([["s1", 4]])
  );

  assert.equal(spend, 25);
});

test("the standalone list and the combined page-data list publish the SAME divisor map", async () => {
  // ISS-4689 (code review): the divisor is emitted from the shared
  // `buildBranchListResult`, not the page-data caller, so BOTH desktop list read
  // paths carry it. If only the combined read published it, the same Branches
  // screen would divide Value-per-$ by the global count when served by
  // `pageData` and by the client's in-set count when served by `list()`.
  const rows = {
    links: [
      link({ branch_name: "a", session_id: "s1" }),
      link({ branch_name: "b", session_id: "s1" }),
    ],
    branchCounts: [{ session_id: "s1", branch_count: 2 }],
  };

  const combined = await getSharedBranchesPageData(makeSource(rows));
  const standalone = await getSharedBranches(makeSource(rows));

  // s1 touched both corpus branches, so the divisor is 2 on both read paths.
  assert.deepEqual(
    standalone.sessionBranchCount,
    combined.list.sessionBranchCount
  );
  assert.equal(Object.values(standalone.sessionBranchCount ?? {})[0], 2);
});

test("the divisor counts a hidden default branch the display projection drops", async () => {
  // ISS-4689 (wongk + chatgpt-codex review): `readLocalBranchLinkRows` →
  // `mapBranchLinkRows` strips default branches — display-only, "a pushed default
  // branch still counts in the token-split denominator, it just never lists". So
  // counting the PROJECTED rows reported 1 for a session that wrote `main` plus
  // one feature branch, while `readBranchTokenAggregateRows`' `branch_count` and
  // `readSessionBranchCounts` both divided that session's cost by 2 — the card
  // and the attribution beside it disagreed, and desktop diverged from cloud
  // (whose divisor scans the unfiltered link set).
  //
  // Fixture: the link rows carry ONLY the listable feature branch (exactly what
  // the mapper leaves behind), while the divisor read — which goes to the
  // pre-display link population — reports 2. A regression that goes back to
  // counting the projection reports 1 here.
  const rows = {
    links: [link({ branch_name: "feature/x", session_id: "s1" })],
    branchCounts: [{ session_id: "s1", branch_count: 2 }],
  };

  const standalone = await getSharedBranches(makeSource(rows));

  assert.equal(standalone.items.length, 1);
  assert.equal(standalone.items[0]?.branchName, "feature/x");
  assert.deepEqual(standalone.sessionBranchCount, { s1: 2 });
});

test("the divisor map is scoped to the sessions the RETURNED page references", async () => {
  // ISS-4689 (wongk review): the response is paginated, so a `limit`/`ids`
  // request must not carry a corpus-sized map. Values stay global; only the KEY
  // set narrows to sessions the returned items reference.
  const rows = {
    links: [
      link({ branch_name: "a", session_id: "s1" }),
      link({ branch_name: "b", session_id: "s2" }),
    ],
    branchCounts: [{ session_id: "s1", branch_count: 3 }],
  };

  const page = await getSharedBranches(makeSource(rows), { limit: 1 });

  assert.equal(page.items.length, 1);
  assert.equal(page.total, 2);
  // Only the returned item's session is published — s2 belongs to the branch
  // paged off — and its value is still the GLOBAL count (3), not the 1 branch
  // this page shows for it.
  assert.deepEqual(page.sessionBranchCount, { s1: 3 });
});
