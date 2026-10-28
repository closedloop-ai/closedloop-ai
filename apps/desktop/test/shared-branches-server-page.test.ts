import assert from "node:assert/strict";
import {
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListCapability,
  BranchListPageMode,
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract.js";
import { parseBranchServerPageResponse } from "@repo/app/branches/data-source/branch-server-page-response";
import { describe, test } from "vitest";
import { getSharedBranchesPageData } from "../src/main/branch/shared-branches-api.js";
import type { BranchListSnapshot } from "../src/main/database/branch-list-snapshot-read.js";
import { readLocalBranchLinkRows } from "../src/main/database/branch-reads.js";
import { link, makeSource } from "./shared-branches-test-helpers.js";

describe("Desktop shared Branches server page", () => {
  test("returns one repaired 20-row page with compact exact facets", async () => {
    const links = Array.from({ length: 47 }, (_, index) =>
      link({
        branch_name: `feature-${String(index).padStart(2, "0")}`,
        session_id: `session-${index}`,
      })
    );
    const result = await getSharedBranchesPageData(makeSource({ links }), {
      pageMode: BranchListPageMode.Server,
      limit: BRANCH_LIST_SERVER_PAGE_SIZE,
      offset: 60,
      sortKey: BranchListSortKey.Name,
      sortDir: BranchListSortDirection.Asc,
    });

    assert.equal(result.list.total, 47);
    assert.equal(result.list.items.length, 7);
    assert.equal(
      result.list.pageInfo?.capability,
      BranchListCapability.ServerPaginationV1
    );
    assert.equal(result.list.pageInfo?.requestedOffset, 60);
    assert.equal(result.list.pageInfo?.offset, 40);
    assert.equal(result.list.facets?.names.options.length, 47);
    assert.equal(result.list.facets?.repositories.options.length, 1);
    assert.equal(result.list.lastActiveCohort?.total, 47);
    assert.equal(
      result.list.lastActiveCohort?.evaluationNow,
      result.list.pageInfo?.now
    );
    assert.doesNotThrow(() => parseBranchServerPageResponse(result.list));
  });

  test("pins production rows, totals, facets, maps, and repair to one membership snapshot", async () => {
    const source = makeSource({
      links: Array.from({ length: 21 }, (_, index) =>
        link({
          branch_name: `snapshot-${String(index).padStart(2, "0")}`,
          session_id: `snapshot-session-${index}`,
        })
      ),
    });
    const initialRows = await readLocalBranchLinkRows(source.prisma);
    let currentRows = initialRows;
    const reached = deferred<void>();
    const release = deferred<void>();
    let firstRead = true;
    const readSnapshot = async (): Promise<BranchListSnapshot> => {
      const capturedRows = [...currentRows];
      if (firstRead) {
        firstRead = false;
        reached.resolve();
        await release.promise;
      }
      return snapshot(capturedRows);
    };
    const request = {
      pageMode: BranchListPageMode.Server,
      limit: BRANCH_LIST_SERVER_PAGE_SIZE,
      offset: 20,
      sortKey: BranchListSortKey.Name,
      sortDir: BranchListSortDirection.Asc,
    } as const;

    const inFlightPromise = getSharedBranchesPageData(
      source,
      request,
      readSnapshot
    );
    await reached.promise;
    currentRows = initialRows.slice(0, 20);
    release.resolve();
    const inFlight = await inFlightPromise;

    assert.equal(inFlight.list.total, 21);
    assert.equal(inFlight.list.items.length, 1);
    assert.equal(inFlight.list.pageInfo?.offset, 20);
    assert.equal(inFlight.list.facets?.names.options.length, 21);
    assert.equal(inFlight.list.lastActiveCohort?.total, 21);
    assert.equal(
      inFlight.list.lastActiveCohort?.evaluationNow,
      inFlight.list.pageInfo?.now
    );
    assert.deepEqual(inFlight.list.sessionBranchCount, {
      "snapshot-session-20": 1,
    });
    assert.doesNotThrow(() => parseBranchServerPageResponse(inFlight.list));

    const next = await getSharedBranchesPageData(source, request, readSnapshot);
    assert.equal(next.list.total, 20);
    assert.equal(next.list.items.length, 20);
    assert.equal(next.list.pageInfo?.requestedOffset, 20);
    assert.equal(next.list.pageInfo?.offset, 0);
    assert.equal(next.list.facets?.names.options.length, 20);
    assert.equal(next.list.lastActiveCohort?.total, 20);
    assert.equal(Object.keys(next.list.sessionBranchCount ?? {}).length, 20);
  });
});

function snapshot(
  linkRows: BranchListSnapshot["linkRows"]
): BranchListSnapshot {
  return {
    linkRows,
    prRows: [],
    commitRows: [],
    tokenRows: [],
    activityRows: [],
    sessionBranchCountEntries: linkRows.map((row) => [row.sessionId, 1]),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
