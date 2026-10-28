import assert from "node:assert/strict";
import { test } from "vitest";
import {
  getSharedBranches,
  getSharedBranchesPageData,
} from "../src/main/branch/shared-branches-api.js";
import { link, makeSource } from "./shared-branches-test-helpers.js";

/**
 * ISS-4689 — the desktop half of the WINDOW-INDEPENDENT even-split divisor the
 * list wire publishes as `sessionBranchCount`.
 *
 * `readGlobalBranchCountsForItems` is desktop's equivalent of the cloud
 * `getSessionBranchCounts` — and, per review, it reads the count off the
 * PRE-DISPLAY active-write link set rather than counting the projected rows,
 * because the projection drops default branches that the cost split still counts.
 */

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
  // ISS-4689 (whitlockk + chatgpt-codex review): `readLocalBranchLinkRows` →
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
  // ISS-4689 (whitlockk review): the response is paginated, so a `limit`/`ids`
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
