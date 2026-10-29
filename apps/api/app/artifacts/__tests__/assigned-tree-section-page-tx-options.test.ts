/**
 * Regression guard for the section-page snapshot's transaction bounds
 * (ISS-10472, marisolashgrove PR #9026).
 *
 * `resolveRootSectionPage` runs TWO statements under one `RepeatableRead`
 * snapshot, and both run the recursive root climb on the one connection the
 * interactive transaction pins. The readers this page exists for are the ones
 * past `MAX_TREE_ANCHORS` — exactly the ones with most to climb — so Prisma's
 * 5s default aborts them with a P2028 and 500s the board. The integration
 * fixtures are far too small to reach it, so nothing else fails if this call
 * site reverts to the default bounds.
 */

import { ArtifactGroupByMode } from "@repo/api/src/types/artifact-group-by-mode";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockWithDb, mockTransaction } = vi.hoisted(() => ({
  mockWithDb: vi.fn(),
  mockTransaction: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  // `withDb(fn)` hands the callback a client whose `$transaction` is captured.
  // The transaction callback is never invoked, so the assertion depends only on
  // the options wired at the call site.
  withDb: mockWithDb,
  ArtifactType: { BRANCH: "BRANCH" },
  ArtifactSubtype: { FEATURE: "FEATURE", ISSUE: "ISSUE" },
  Prisma: {
    sql: (...args: unknown[]) => args,
    raw: (value: string) => value,
    join: (...args: unknown[]) => args,
    empty: "",
    TransactionIsolationLevel: { RepeatableRead: "RepeatableRead" },
  },
}));

import { resolveRootSectionPage } from "../assigned-tree-root-sections";

/** The same budget `withStatusCountsSnapshot` pins for the sibling read. */
const EXPECTED_SECTION_PAGE_TX_OPTIONS = {
  isolationLevel: "RepeatableRead",
  timeout: 30_000,
};

const INPUT = {
  assigneeId: "33333333-3333-7333-8333-333333333333",
  groupBy: ArtifactGroupByMode.Status,
  ordering: "vocabulary",
  organizationId: "11111111-1111-7111-8111-111111111111",
  pageIndex: 0,
  pageSize: 50,
  viewerUserId: "22222222-2222-7222-8222-222222222222",
} as const;

describe("assigned-tree section page transaction bounds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTransaction.mockResolvedValue({
      ids: [],
      rowsBefore: 0,
      sections: [],
      total: 0,
      totalPages: 0,
    });
    mockWithDb.mockImplementation(
      (run: (db: { $transaction: typeof mockTransaction }) => unknown) =>
        run({ $transaction: mockTransaction })
    );
  });

  it("pins an explicit 30s timeout on the RepeatableRead section snapshot", async () => {
    await resolveRootSectionPage(INPUT);

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockTransaction.mock.calls[0][1]).toEqual(
      EXPECTED_SECTION_PAGE_TX_OPTIONS
    );
  });
});
