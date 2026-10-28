import assert from "node:assert/strict";
import {
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListPageMode,
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract.js";
import { describe, test } from "vitest";
import { coerceSharedBranchesQuery } from "../src/main/dashboard/agent-dashboard-ipc-coercion.js";
import { LOCAL_BRANCH_READ } from "../src/shared/shared-branches-contract.js";

describe("shared Branches server-page IPC coercion", () => {
  test("retains the strict clone-safe contract and optional force refresh", () => {
    const request = {
      pageMode: BranchListPageMode.Server,
      limit: BRANCH_LIST_SERVER_PAGE_SIZE,
      offset: 20,
      names: ["feature/x"],
      sortKey: BranchListSortKey.Name,
      sortDir: BranchListSortDirection.Asc,
      forceRefresh: true,
    };

    assert.deepEqual(coerceSharedBranchesQuery(request), request);
  });

  test("rejects unknown fields, malformed arrays, and unaligned offsets", () => {
    assert.throws(() =>
      coerceSharedBranchesQuery({
        ...serverRequest(),
        unknownFilter: ["x"],
      })
    );
    assert.throws(() =>
      coerceSharedBranchesQuery({ ...serverRequest(), names: "feature/x" })
    );
    assert.throws(() =>
      coerceSharedBranchesQuery({ ...serverRequest(), offset: 1 })
    );
  });

  test("accepts only a boolean local read hint on the strict server-page path", () => {
    const request = { ...serverRequest(), ...LOCAL_BRANCH_READ };
    assert.deepEqual(coerceSharedBranchesQuery(request), request);
    assert.throws(() =>
      coerceSharedBranchesQuery({
        ...serverRequest(),
        skipCloudHydration: "yes",
      })
    );
  });

  test("preserves the permissive legacy compatibility path", () => {
    const legacy = { startDate: "2026-08-01T00:00:00.000Z", futureKey: true };
    assert.equal(coerceSharedBranchesQuery(legacy), legacy);
  });
});

function serverRequest() {
  return {
    pageMode: BranchListPageMode.Server,
    limit: BRANCH_LIST_SERVER_PAGE_SIZE,
    offset: 0,
    sortKey: BranchListSortKey.LastActivity,
    sortDir: BranchListSortDirection.Desc,
  };
}
