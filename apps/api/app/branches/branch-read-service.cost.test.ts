import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({
    ChecksStatus: { UNKNOWN: "UNKNOWN" },
  });
});

vi.mock("@repo/github", async () => {
  const actual =
    await vi.importActual<typeof import("@repo/github")>("@repo/github");
  return {
    ...actual,
    getSinglePullRequestWithProviderResult: vi.fn(),
  };
});

import { BranchStatus } from "@repo/api/src/types/branch";
import {
  branchId,
  branchIdB,
  createMockDb,
  makeBranchRow,
  makeSessionLink,
  mockBranchCandidatePage,
  now,
  organizationId,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import { mockWithDbCall, mockWithDbTx } from "../../__tests__/utils/db-helpers";
import { branchReadService } from "./branch-read-service";

/**
 * FEA-4331 — a session linked to N branches must NOT charge its full cost to
 * every branch it touched (the double-/triple-count bug). Each branch's list-row
 * `attributedCostUsd` is the EVEN-SPLIT share (session cost ÷ its global
 * active-write branch count), so a shared session's per-branch shares sum back to
 * its cost ONCE — never N times — matching the branch-detail header and the
 * desktop producer's per-branch list projection. The raw `estimatedCostUsd` field
 * stays the STABLE replicated total (a shared session's whole cost on every
 * branch) so pre-FEA-4331 clients (desktop ≤ v0.16.627 cloud mode) that infer
 * filtered spend from it are not skewed (review: wongk).
 *
 * These cases were split out of `branch-read-service.test.ts` (shrink-only
 * grandfathered) into this focused sibling so editing the oversized file does not
 * grow it further; they drive the same `branchReadService.listBranches` read off
 * the shared `branch-read-service.test-helpers` harness.
 */
describe("multi-branch session cost is even-split, not replicated (FEA-4331)", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockDb = createMockDb();
    mockWithDbCall(mockDb);
    mockWithDbTx(mockDb);
    mockDb.commitDetail.findMany.mockResolvedValue([]);
  });

  function findRow(
    response: Awaited<ReturnType<typeof branchReadService.listBranches>>,
    id: string
  ) {
    const item = response.items.find((row) => row.id === id);
    if (!item) {
      throw new Error(`branch ${id} missing from list response`);
    }
    return item;
  }

  // The EVEN-SPLIT per-branch attribution (`attributedCostUsd`) — the corrected
  // FEA-4331 value.
  function rowCost(
    response: Awaited<ReturnType<typeof branchReadService.listBranches>>,
    id: string
  ): number | null | undefined {
    return findRow(response, id).attributedCostUsd;
  }

  // The STABLE raw replicated per-branch total (`estimatedCostUsd`) — kept for
  // pre-FEA-4331 clients.
  function rawRowCost(
    response: Awaited<ReturnType<typeof branchReadService.listBranches>>,
    id: string
  ): number | null {
    return findRow(response, id).estimatedCostUsd;
  }

  it("even-splits a shared session across every branch it touched and leaves a single-branch session whole", async () => {
    // s-shared ($90) touches BOTH branches → 1/2 = $45 to each.
    // s-onlyA  ($10) touches only branch A → whole $10 to A.
    // So A = $45 + $10 = $55, B = $45; the shared session contributes $90 total
    // across the two branches (NOT $180 — the replication bug), and the
    // single-branch session is unchanged.
    const links = [
      makeSessionLink(branchId, "s-shared", "90.00"),
      makeSessionLink(branchIdB, "s-shared", "90.00"),
      makeSessionLink(branchId, "s-onlyA", "10.00"),
    ];
    mockBranchCandidatePage(mockDb, [branchId, branchIdB]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow(),
      makeBranchRow({ id: branchIdB, branchName: "feature-b" }),
    ]);
    // Both getSessionUsageByBranch and getSessionBranchCounts read
    // artifactLink.findMany; the same full link set drives both, so the shared
    // session's global branch count resolves to 2.
    mockDb.artifactLink.findMany.mockResolvedValue(links);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
      repository: ["closedloop-ai/symphony-alpha"],
      status: [BranchStatus.Open],
    });

    const costA = rowCost(response, branchId);
    const costB = rowCost(response, branchIdB);
    // Branch A: even-split shared ($45) + whole single-branch ($10) = $55.
    expect(costA).toBeCloseTo(55, 5);
    // Branch B: only the even-split shared share = $45 (NOT the full $90).
    expect(costB).toBeCloseTo(45, 5);
    // CONSERVATION: the shared session's per-branch shares sum to its real cost
    // ($90) exactly once — a full-replication regression would make this $180.
    const sharedContribution = (costB ?? 0) + ((costA ?? 0) - 10);
    expect(sharedContribution).toBeCloseTo(90, 5);
    // And the shared session's per-branch total can never exceed its real cost.
    expect(sharedContribution).toBeLessThanOrEqual(90 + 1e-6);
    // COMPAT (FEA-4331 review, wongk): the STABLE `estimatedCostUsd` field is NOT
    // switched to the even-split — it stays the raw replicated per-branch total so
    // a pre-`attributedCostUsd` client (desktop ≤ v0.16.627 cloud mode) that infers
    // filtered spend from it reads the same value it did before this change. Branch
    // A raw total = $90 + $10 = $100 (the shared session's WHOLE cost), branch B
    // raw total = the shared session's full $90.
    expect(rawRowCost(response, branchId)).toBeCloseTo(100, 5);
    expect(rawRowCost(response, branchIdB)).toBeCloseTo(90, 5);
  });

  it("surfaces the authoritative per-session cost once, keyed by session id", async () => {
    // The wire `sessionCostUsd` map is the deduped per-session cost (full, not
    // split) — one entry per session regardless of how many branches it touched.
    const links = [
      makeSessionLink(branchId, "s-shared", "90.00"),
      makeSessionLink(branchIdB, "s-shared", "90.00"),
      makeSessionLink(branchId, "s-onlyA", "10.00"),
    ];
    mockBranchCandidatePage(mockDb, [branchId, branchIdB]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow(),
      makeBranchRow({ id: branchIdB, branchName: "feature-b" }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue(links);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
      repository: ["closedloop-ai/symphony-alpha"],
      status: [BranchStatus.Open],
    });

    // Each distinct session appears once at its FULL captured cost; the split is
    // applied only to the per-branch `estimatedCostUsd`, not to this map.
    expect(response.sessionCostUsd).toEqual({
      "s-shared": 90,
      "s-onlyA": 10,
    });
  });

  it("leaves a session that touches a single branch charged in full", async () => {
    // A session on exactly one branch has a global branch count of 1, so its
    // even-split share is its whole cost — the fix must not deflate single-branch
    // spend.
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([makeBranchRow()]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      makeSessionLink(branchId, "s-solo", "12.50"),
    ]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
      repository: ["closedloop-ai/symphony-alpha"],
      status: [BranchStatus.Open],
    });

    expect(rowCost(response, branchId)).toBeCloseTo(12.5, 5);
  });

  // ISS-4689 (review): the client's paginating data source uses the presence of
  // `sessionCostUsd` as proof a page is new-shape, and marks the read SKEWED —
  // suppressing the divisor map for EVERY page — if a page carries that one but
  // not `sessionBranchCount`. Nothing on screen or in the logs says so; the card
  // just silently reverts to the window-sensitive in-set divisor. That IFF is a
  // producer contract, so pin it at the producer, at both ends: a page that emits
  // one of the three emits all three, and a page that emits none emits none.
  it("emits sessionCostUsd, lifetimeSessionCostUsd and sessionBranchCount together", async () => {
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([makeBranchRow()]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      makeSessionLink(branchId, "s-solo", "12.50"),
    ]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
      repository: ["closedloop-ai/symphony-alpha"],
      status: [BranchStatus.Open],
    });

    // All three present, over the SAME session key set — the shape the client's
    // `pageIsNewShape` check assumes.
    expect(response.sessionCostUsd).toBeDefined();
    expect(response.lifetimeSessionCostUsd).toBeDefined();
    expect(response.sessionBranchCount).toBeDefined();
    const sessionIds = Object.keys(response.sessionCostUsd ?? {}).sort();
    expect(sessionIds).toEqual(["s-solo"]);
    expect(Object.keys(response.lifetimeSessionCostUsd ?? {}).sort()).toEqual(
      sessionIds
    );
    expect(Object.keys(response.sessionBranchCount ?? {}).sort()).toEqual(
      sessionIds
    );
  });

  // ISS-4689 (review): the kernel floors the divisor at the in-set count, so a
  // global count that arrives SMALLER is absorbed with no trace — that one session
  // silently falls back to the pre-fix divisor while its neighbours in the same
  // denominator use the global one, and the card blends the two. The invariant
  // that prevents it belongs at the producer: `sessionBranchCount[s]` must never
  // be below the number of returned rows carrying `s`.
  it("never publishes a divisor below the count of returned rows carrying that session", async () => {
    // s-shared is on BOTH returned branches, so its in-set count is 2; the global
    // divisor read sees the same two links. A corpus-scope drift between the two
    // scans (a re-added push gate, a target filter the usage read lacks) would
    // report 1 here and this fails before it can reach the card.
    const links = [
      makeSessionLink(branchId, "s-shared", "90.00"),
      makeSessionLink(branchIdB, "s-shared", "90.00"),
      makeSessionLink(branchId, "s-onlyA", "10.00"),
    ];
    mockBranchCandidatePage(mockDb, [branchId, branchIdB]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow(),
      makeBranchRow({ id: branchIdB, branchName: "feature-b" }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue(links);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
      repository: ["closedloop-ai/symphony-alpha"],
      status: [BranchStatus.Open],
    });

    // In-set count per session, computed off the SAME rows the client would.
    const inSetCounts = new Map<string, number>();
    for (const item of response.items) {
      for (const sessionId of new Set(item.sessionIds)) {
        inSetCounts.set(sessionId, (inSetCounts.get(sessionId) ?? 0) + 1);
      }
    }
    expect(inSetCounts.get("s-shared")).toBe(2);
    for (const [sessionId, inSetCount] of inSetCounts) {
      expect(
        response.sessionBranchCount?.[sessionId] ?? 0
      ).toBeGreaterThanOrEqual(inSetCount);
    }
  });

  it("omits all three session maps on a page that links no session", async () => {
    // The other end of the IFF: an unpriced/unlinked page must omit the divisor
    // map too, so an old-shape page and a new-shape-but-empty page are
    // indistinguishable to the client and neither marks the read skewed.
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([makeBranchRow()]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
      repository: ["closedloop-ai/symphony-alpha"],
      status: [BranchStatus.Open],
    });

    expect(response.sessionCostUsd).toBeUndefined();
    expect(response.lifetimeSessionCostUsd).toBeUndefined();
    expect(response.sessionBranchCount).toBeUndefined();
  });

  it("uses the GLOBAL divisor: a branch NOT on the page still divides the visible branch's cost", async () => {
    // Thread #4 (wongk) — prove the divisor is GLOBAL, not page-local, by feeding
    // the two reads DIFFERENT link sets. The page-scoped usage read
    // (getSessionUsageByBranch, 1st artifactLink.findMany) sees ONLY branch A's
    // link, so the page/usage knows of one branch. The global divisor read
    // (getSessionBranchCounts, 2nd artifactLink.findMany) sees A AND an off-page
    // branch B for the same session. If the divisor were page-local it would be 1
    // and A would get the full $90; because it is global (2), A gets $45 — proving
    // the count came from the divisor read, not the mocked page rows.
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([makeBranchRow()]);
    mockDb.artifactLink.findMany
      // 1st call — page usage read: branch A only.
      .mockResolvedValueOnce([makeSessionLink(branchId, "s-shared", "90.00")])
      // 2nd call — global divisor read: A + an off-page B for the same session.
      .mockResolvedValueOnce([
        makeSessionLink(branchId, "s-shared", "90.00"),
        makeSessionLink(branchIdB, "s-shared", "90.00"),
      ]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
      repository: ["closedloop-ai/symphony-alpha"],
      status: [BranchStatus.Open],
    });

    // Branch A: $90 ÷ global count 2 = $45. A page-local divisor (1) would give $90.
    expect(rowCost(response, branchId)).toBeCloseTo(45, 5);
    // The raw replicated total is still the session's whole $90 on A (unchanged).
    expect(rawRowCost(response, branchId)).toBeCloseTo(90, 5);
  });

  it("scopes the even-split divisor query to corpus-member (session-linked) target branches, not push-qualified ones (FEA-4311)", async () => {
    // FEA-4331 + FEA-4311 — the global branch-count divisor must count exactly the
    // branches that are CORPUS MEMBERS (visible on the Branches list), so the 1/N
    // denominator matches the set of branches the session cost is actually split
    // across. FEA-4331 originally push-gated the divisor targets (an owned current
    // PR OR `firstPushedAt` set); FEA-4311 widened corpus membership to any
    // session-linked branch — a session-observed branch surfaces on the list BEFORE
    // any push/PR — so the divisor target is now the plain non-deleted BRANCH
    // corpus scope, NOT the push-evidence OR gate. The unit mock ignores the
    // `where`, so assert the QUERY SHAPE the service issues: the divisor
    // `artifactLink.findMany` scopes its target as a non-deleted BRANCH
    // (`type: BRANCH`, `branch: { deletedAt: null }`) and carries NO push-evidence
    // OR gate, while the plain usage read scopes only `type: BRANCH`.
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([makeBranchRow()]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      makeSessionLink(branchId, "s-solo", "12.50"),
    ]);

    await branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
      repository: ["closedloop-ai/symphony-alpha"],
      status: [BranchStatus.Open],
    });

    const membershipScopedCalls =
      mockDb.artifactLink.findMany.mock.calls.filter((call) => {
        const target = call[0]?.where?.target;
        // The divisor query scopes the target to the non-deleted BRANCH corpus:
        // no push-evidence OR gate (that would UNDER-count the widened corpus and
        // over-attribute a priced session's full cost to each session-only branch).
        return (
          target?.branch?.deletedAt === null &&
          target?.AND === undefined &&
          target?.OR === undefined
        );
      });
    // Exactly the divisor query carries the corpus-membership target scope
    // (non-deleted branch, no push gate) — proving the denominator counts every
    // session-linked branch the widened corpus admits, so a priced session over N
    // session-only branches divides by N, not 1.
    expect(membershipScopedCalls.length).toBe(1);
  });

  // ISS-4689 — the reviewer's worked example on PR #4120. The even-split divisor
  // must be the session's GLOBAL branch count, not the count of branches that
  // survived the date window: otherwise a session spanning branches of different
  // ages loses the out-of-window branch from the divisor at the same moment its
  // churn leaves the numerator, and the ratio still moves with the window.
  //
  // This is pinned on the LIST path, which is the path that feeds the rendered
  // card: `deriveFilteredBranchAnalytics` re-derives `locPerDollar` from
  // `sessionBranchCount` on the wire and overrides the server's own value on both
  // surfaces. It was previously pinned on `getBranchAnalytics`, but that producer
  // no longer takes a global divisor — a corpus-wide divisor read there was an
  // unbounded sequential artifactLink scan (wongk review) that could not change a
  // rendered number, since the only consumer of the server-side `locPerDollar` is
  // the branch-detail baseline and it queries UNWINDOWED. Asserting the wire map
  // here keeps the worked example on the path where it is load-bearing.
  it("puts the shared session's GLOBAL branch count on the wire when its other branch falls outside the window", async () => {
    const agedBranchId = "branch-aged";
    // Both branches carry 1000 churn; ONE session (session-1, $100 lifetime)
    // worked both. Only `branchId` is in-window, so only it enters the page.
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({
        fileChanges: [{ additions: 600, deletions: 400, path: "a.ts" }],
      }),
    ]);
    // The usage read is scoped to the in-window branch (it selects `source`);
    // `getSessionBranchCounts` is org-wide by session id (it does not), so it
    // still sees the aged branch's link — exactly the production asymmetry.
    mockDb.artifactLink.findMany.mockImplementation(
      (args: { select?: { source?: unknown } }) =>
        Promise.resolve(
          args?.select?.source
            ? [makeSessionLink(branchId, "session-1", "100.00")]
            : [
                makeSessionLink(branchId, "session-1", "100.00"),
                makeSessionLink(agedBranchId, "session-1", "100.00"),
              ]
        )
    );

    const response = await branchReadService.listBranches(organizationId, {
      limit: 10,
      offset: 0,
      startDate: new Date("2026-07-30T00:00:00.000Z"),
    });

    // 2, not 1: the aged branch is outside the window and absent from `items`,
    // but it still divides the session's spend. The client then computes
    // 1000 churn ÷ ($100 × 1/2) = 20 — the SAME ratio the all-time corpus reports
    // (2000 churn ÷ $100). The in-set count of 1 gave $100 and a ratio of 10,
    // halving the metric purely because the window narrowed.
    expect(response.sessionBranchCount).toEqual({ "session-1": 2 });
    expect(response.items).toHaveLength(1);
    // The LIFETIME per-session cost the divisor divides is on the wire alongside
    // it, so the client has both halves of the denominator without a second read.
    expect(response.lifetimeSessionCostUsd).toEqual({ "session-1": 100 });
  });
});
