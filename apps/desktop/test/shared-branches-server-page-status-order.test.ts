import assert from "node:assert/strict";
import { ARTIFACT_STATUS_ROOT_ORDER_FLAG_KEY } from "@repo/api/src/types/artifact-status-root-order-flag.js";
import {
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListPageMode,
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract.js";
import { afterEach, describe, test } from "vitest";
import { publishDesktopMainFeatureFlagAssignmentStore } from "../src/main/auth/desktop-feature-flag-assignment.js";
import { getSharedBranchesPageData } from "../src/main/branch/shared-branches-api.js";
import { link, makeSource } from "./shared-branches-test-helpers.js";

/**
 * ISS-9437 — the MAIN-PROCESS half of the root-order flag read.
 *
 * `buildBranchListResult` calls `isDesktopMainFeatureFlagEnabled` only inside
 * its `pageMode === Server` arm, and only the server page is built by main. The
 * launched shell's LOCAL COMBINED path never asks for `pageMode=server`, so a
 * test over that path cannot notice this read disappearing.
 *
 * The local store holds no PR state, so every local branch derives the same
 * status and the two orderings cannot be told apart by their output. The read
 * itself is what this suite pins: the server page asks main's published
 * assignment store, by the root-order key, and an unpublished store reads
 * closed instead of throwing.
 */

const STATUS_ASC_REQUEST = {
  pageMode: BranchListPageMode.Server,
  limit: BRANCH_LIST_SERVER_PAGE_SIZE,
  offset: 0,
  sortKey: BranchListSortKey.Status,
  sortDir: BranchListSortDirection.Asc,
} as const;

afterEach(() => {
  publishDesktopMainFeatureFlagAssignmentStore(null);
});

describe("Desktop main server page status ordering", () => {
  for (const enabled of [true, false]) {
    test(`the server page reads the published main assignment (${enabled ? "on" : "off"})`, async () => {
      const keysRead: string[] = [];
      publishDesktopMainFeatureFlagAssignmentStore({
        isEnabled: (key: string) => {
          keysRead.push(key);
          return key === ARTIFACT_STATUS_ROOT_ORDER_FLAG_KEY && enabled;
        },
        read: () => {
          throw new Error("the ordering read must go through isEnabled");
        },
      } as unknown as Parameters<
        typeof publishDesktopMainFeatureFlagAssignmentStore
      >[0]);

      const result = await getSharedBranchesPageData(
        makeSource({
          links: [
            link({ branch_name: "b-one", session_id: "s-one" }),
            link({ branch_name: "a-two", session_id: "s-two" }),
          ],
        }),
        STATUS_ASC_REQUEST
      );

      assert.equal(result.list.items.length, 2);
      assert.ok(keysRead.includes(ARTIFACT_STATUS_ROOT_ORDER_FLAG_KEY));
    });
  }

  test("an unpublished assignment store reads closed", async () => {
    publishDesktopMainFeatureFlagAssignmentStore(null);

    const result = await getSharedBranchesPageData(
      makeSource({
        links: [link({ branch_name: "b-one", session_id: "s-one" })],
      }),
      STATUS_ASC_REQUEST
    );

    assert.equal(result.list.items.length, 1);
  });
});
