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

const syncServiceMocks = vi.hoisted(() => ({
  refreshTombstonedBranchPullRequest: vi.fn(),
}));

vi.mock("@/app/integrations/github/sync-service", () => ({
  GitHubServerSyncReason: {
    NoEligibleSessionReference: "no_eligible_session_reference",
  },
  GitHubServerSyncStatus: {
    Failed: "failed",
    NotApplicable: "not_applicable",
    Refreshed: "refreshed",
    Retryable: "retryable",
  },
  githubServerSyncService: {
    refreshTombstonedBranchPullRequest:
      syncServiceMocks.refreshTombstonedBranchPullRequest,
  },
}));

const agentSessionsServiceMocks = vi.hoisted(() => ({
  findSessionDetail: vi.fn(),
}));

vi.mock("@/app/agent-sessions/service", () => ({
  agentSessionsService: {
    findSessionDetail: agentSessionsServiceMocks.findSessionDetail,
  },
}));

import { BranchDataState } from "@repo/api/src/types/branch";
import {
  branchId,
  collectSqlValues,
  createMockDb,
  makeBranchRow,
  makeOrphanSessionLink,
  makeSessionLink,
  makeTokenEvent,
  mockBranchCandidateIds,
  mockBranchCandidatePage,
  mockTokenEvents,
  now,
  organizationId,
  renderSql,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import {
  getMockWithDb,
  mockWithDbCall,
  mockWithDbTx,
} from "../../__tests__/utils/db-helpers";
import { branchReadService } from "./branch-read-service";

// FEA-4270 (per-event rework, shafty023 P1): a usage/analytics date filter is a
// PER-EVENT SPEND WINDOW. The original fix windowed by session START — a
// long-running session that began before the range contributed ZERO even for the
// turns it ran inside it, and a session that began just inside counted its ENTIRE
// lifetime spend. The rework windows each usage EVENT by its own
// `eventCreatedAt` (`AgentSessionTokenEvent`), so a session's spend SPLITS across
// windows by turn: only its in-window events count. Identity stays LIFETIME (the
// full link set is read; `sessionIds`/`dataState`/owner never window — a branch
// active in-window whose sessions all ran before it must NOT read as
// `NoSessions`; P1 chatgpt-codex #3667842008). These tests return the FULL
// lifetime link set from the mock AND per-event token rows, then assert the
// SERVICE narrows spend per-event in-JS.
describe("branchReadService per-event date-windowed AI spend (FEA-4270)", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockDb = createMockDb();
    getMockWithDb();
    mockWithDbCall(mockDb);
    mockWithDbTx(mockDb);
    mockDb.commitDetail.findMany.mockResolvedValue([]);
  });

  const windowStart = new Date("2026-07-02T00:00:00.000Z");
  const windowEnd = new Date("2026-07-03T23:59:59.000Z");
  const inWindow = new Date("2026-07-03T01:00:00.000Z");
  const inWindowLater = new Date("2026-07-03T09:00:00.000Z");
  const beforeWindow = new Date("2026-06-20T01:00:00.000Z");
  const ownerAId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  // Every LIFETIME session linked to the branch, ALWAYS returned in full (the
  // service windows spend per-event). The sessions carry LIFETIME cost on the
  // SessionDetail row, but under a window that lifetime figure is IGNORED — spend
  // comes only from the per-event rows below.
  function candidateLinks() {
    return [
      makeSessionLink(branchId, "s-split", "99.00", null, null, null, {
        sessionStartedAt: beforeWindow,
      }),
      makeSessionLink(branchId, "s-before", "4.00", null, null, null, {
        sessionStartedAt: beforeWindow,
      }),
      makeOrphanSessionLink(branchId),
    ];
  }

  // Per-event rows. `s-split` is a long-running session that STARTED before the
  // window but has turns BOTH inside and outside it: two in-window events ($1
  // each) and one pre-window event ($50). Only the $2 in-window spend must count —
  // NOT its $99 lifetime cost, NOT the $50 pre-window turn. `s-before` has a
  // single pre-window event ($4): fully out of window → excluded.
  function candidateEvents() {
    return [
      makeTokenEvent("s-split", inWindow, {
        inputTokens: 7,
        estimatedCost: "1.00",
      }),
      makeTokenEvent("s-split", inWindowLater, {
        inputTokens: 5,
        estimatedCost: "1.00",
      }),
      makeTokenEvent("s-split", beforeWindow, {
        inputTokens: 1000,
        estimatedCost: "50.00",
      }),
      makeTokenEvent("s-before", beforeWindow, {
        inputTokens: 1000,
        estimatedCost: "4.00",
      }),
    ];
  }

  function seedWindowedCorpus() {
    mockDb.artifact.findMany.mockResolvedValue([makeBranchRow()]);
    mockDb.artifactLink.findMany.mockResolvedValue(candidateLinks());
    mockTokenEvents(mockDb, candidateEvents());
  }

  it("counts only the in-window EVENTS of a session that straddles the window", async () => {
    mockBranchCandidateIds(mockDb, [branchId]);
    seedWindowedCorpus();

    const response = await branchReadService.getBranchUsage(organizationId, {
      limit: 50,
      offset: 0,
      startDate: windowStart,
      endDate: windowEnd,
    });

    // Only `s-split`'s two in-window events ($1 each) count. Its $50 pre-window
    // event, its $99 lifetime SessionDetail cost, and `s-before`'s wholly
    // pre-window $4 event are all excluded.
    expect(response.totalEstimatedCost).toBeCloseTo(2, 10);
    // Tokens window per-event too: only the two in-window events (7 + 5 = 12
    // input tokens), never the 1000-token pre-window turns.
    expect(response.totalInputTokens).toBe(12);
    // The per-event read is scoped by eventCreatedAt in the query itself.
    const evidenceQuery = evidenceQueryCalls(mockDb).at(-1)?.[0];
    expect(renderSql(evidenceQuery)).toContain("event.event_created_at >=");
    expect(renderSql(evidenceQuery)).toContain("event.event_created_at <=");
    expect(collectSqlValues(evidenceQuery)).toEqual(
      expect.arrayContaining([windowStart, windowEnd])
    );
  });

  it("keeps lifetime session metadata on a branch whose only events predate the window", async () => {
    // P1 (chatgpt-codex #3667842008): a branch selected on last_activity_at whose
    // linked sessions have only pre-window EVENTS must still report its sessions
    // (Ready / non-empty sessionIds), only with zero windowed spend — it must NOT
    // collapse to NoSessions with a null owner.
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([makeBranchRow()]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      makeSessionLink(branchId, "s-before-1", "4.00", ownerAId, null, null, {
        sessionStartedAt: beforeWindow,
      }),
    ]);
    mockTokenEvents(mockDb, [
      makeTokenEvent("s-before-1", beforeWindow, { estimatedCost: "4.00" }),
    ]);
    mockDb.user.findMany.mockResolvedValue([
      {
        id: ownerAId,
        email: "ada@example.com",
        firstName: "Ada",
        lastName: "Lovelace",
      },
    ]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
      startDate: windowStart,
      endDate: windowEnd,
    });

    const row = response.items[0];
    // Session identity remains lifetime, but Branch Owner requires exact
    // qualifying push evidence and is not inferred from Session ownership.
    expect(row.sessionIds).toEqual(["s-before-1"]);
    expect(row.dataState).toBe(BranchDataState.Ready);
    expect(row.owner).toBeNull();
    // Spend is WINDOWED per-event: the session's only event is pre-window, so the
    // row's AI-spend caption is null (never the $4 event/lifetime cost) — an
    // honest "no in-window spend", not a computed $0.00.
    expect(row.estimatedCostUsd).toBeNull();
    // The per-session cost map still LISTS the session (its identity is lifetime),
    // but at ZERO windowed cost — so the client's filtered re-derivation adds
    // nothing for it under this window.
    expect(response.sessionCostUsd).toEqual({ "s-before-1": 0 });
    // ISS-4632 (shafty023 review): under an ACTIVE window the two maps must
    // diverge — `sessionCostUsd` is windowed (0 here, the pre-window event) while
    // `lifetimeSessionCostUsd` carries the session's LIFETIME $4, the Value-per-$
    // denominator basis. A regression that omits this field or accidentally
    // windows it (making it equal `sessionCostUsd`) fails HERE, at the cloud
    // producer boundary, not only in the client projection tests.
    expect(response.lifetimeSessionCostUsd).toEqual({ "s-before-1": 4 });
    // ISS-4689 — the wire also carries each session's GLOBAL branch count, the
    // window-independent even-split divisor for the client's Value-per-$
    // denominator. The ids come from the LIFETIME usage map, so a session with no
    // in-window spend (this one) still gets a divisor instead of silently falling
    // back to the client's in-set count.
    expect(response.sessionBranchCount).toEqual({ "s-before-1": 1 });
  });

  // ISS-4689 (review of this PR): `getSessionBranchCounts` is fed ids collected
  // from the LIFETIME usage map rather than the windowed one. That choice is a
  // no-op TODAY and deliberately so — `usage.sessionIds` is identity, pushed by
  // `accumulateSessionLink` before any window gating, and both folds run over the
  // same links — but "the two maps always agree" is an invariant of the fold, not
  // something the two call sites show. Pin it here: if a future change ever
  // windows identity (or gates the lifetime fold differently), the sets diverge
  // and this fails at the producer, making the lifetime source load-bearing
  // instead of silently wrong.
  it("carries the SAME session-id set in the windowed and lifetime usage maps", async () => {
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([makeBranchRow()]);
    // Two sessions on one branch straddling the window boundary in OPPOSITE
    // directions: one spent only BEFORE it, one only INSIDE it. Windowed spend
    // therefore differs per session while identity must not.
    mockDb.artifactLink.findMany.mockResolvedValue([
      makeSessionLink(branchId, "s-before-1", "4.00", ownerAId, null, null, {
        sessionStartedAt: beforeWindow,
      }),
      makeSessionLink(branchId, "s-inside-1", "6.00", ownerAId, null, null, {
        sessionStartedAt: inWindow,
      }),
    ]);
    mockTokenEvents(mockDb, [
      makeTokenEvent("s-before-1", beforeWindow, { estimatedCost: "4.00" }),
      makeTokenEvent("s-inside-1", inWindow, { estimatedCost: "6.00" }),
    ]);
    mockDb.user.findMany.mockResolvedValue([]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
      startDate: windowStart,
      endDate: windowEnd,
    });

    const expectedSessionIds = ["s-before-1", "s-inside-1"];
    // The spend VALUES diverge — that is the windowed/lifetime split working.
    expect(response.sessionCostUsd).toEqual({
      "s-before-1": 0,
      "s-inside-1": 6,
    });
    expect(response.lifetimeSessionCostUsd).toEqual({
      "s-before-1": 4,
      "s-inside-1": 6,
    });
    // The session-id KEY SET does not. This is the equality the divisor read
    // relies on: every priced session reaches the wire with a divisor, from
    // whichever map the ids were collected off.
    expect(Object.keys(response.sessionCostUsd ?? {}).sort()).toEqual(
      expectedSessionIds
    );
    expect(Object.keys(response.lifetimeSessionCostUsd ?? {}).sort()).toEqual(
      expectedSessionIds
    );
    expect(Object.keys(response.sessionBranchCount ?? {}).sort()).toEqual(
      expectedSessionIds
    );
  });

  it("excludes an event with a NULL timestamp under an active window", async () => {
    // A per-event row whose `eventCreatedAt` is null cannot be proven inside a
    // bounded window, so a date-bounded spend metric drops it rather than miscount
    // it (AGENTS.md date-bounded null-exclusion). The windowed total therefore
    // reconciles with the events actually shown.
    mockBranchCandidateIds(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([makeBranchRow()]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      makeSessionLink(branchId, "s-null", "9.00", null, null, null, {
        sessionStartedAt: inWindow,
      }),
    ]);
    mockTokenEvents(mockDb, [
      makeTokenEvent("s-null", inWindow, {
        inputTokens: 3,
        estimatedCost: "1.00",
      }),
      // Null timestamp → excluded, even though it belongs to an in-window session.
      makeTokenEvent("s-null", null, {
        inputTokens: 100,
        estimatedCost: "8.00",
      }),
    ]);

    const response = await branchReadService.getBranchUsage(organizationId, {
      limit: 50,
      offset: 0,
      startDate: windowStart,
      endDate: windowEnd,
    });

    // Only the one dated in-window event ($1, 3 tokens) — the null-timestamp $8
    // event is dropped, so the total reconciles with the shown event.
    expect(response.totalEstimatedCost).toBeCloseTo(1, 10);
    expect(response.totalInputTokens).toBe(3);
  });

  it("excludes an orphaned session (no SessionDetail) from a windowed metric", async () => {
    // P2 (chatgpt-codex #3667842018): a linked SESSION with no `SessionDetail`
    // row is not a valid session — `accumulateSessionLink` skips it up front — so
    // under a window it contributes neither cost nor tokens (nor a session id).
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([makeBranchRow()]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      makeSessionLink(branchId, "s-in-1", "1.00", null, null, null, {
        sessionStartedAt: inWindow,
      }),
      makeSessionLink(branchId, "s-in-2", "1.00", null, null, null, {
        sessionStartedAt: inWindow,
      }),
      makeOrphanSessionLink(branchId),
    ]);
    mockTokenEvents(mockDb, [
      makeTokenEvent("s-in-1", inWindow, { estimatedCost: "1.00" }),
      makeTokenEvent("s-in-2", inWindow, { estimatedCost: "1.00" }),
    ]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
      startDate: windowStart,
      endDate: windowEnd,
    });

    const row = response.items[0];
    // Only the two valid in-window sessions — the orphan never enters sessionIds.
    expect([...row.sessionIds].sort()).toEqual(["s-in-1", "s-in-2"]);
    expect(row.estimatedCostUsd).toBeCloseTo(2, 10);
    expect(Object.keys(response.sessionCostUsd ?? {}).sort()).toEqual([
      "s-in-1",
      "s-in-2",
    ]);
  });

  it("leaves lifetime numeric spend unchanged and reads all-time event evidence", async () => {
    mockBranchCandidateIds(mockDb, [branchId]);
    seedWindowedCorpus();

    const response = await branchReadService.getBranchUsage(organizationId, {
      limit: 50,
      offset: 0,
    });

    // No date filter → every VALID linked session counts its LIFETIME
    // SessionDetail cost: $99 (s-split) + $4 (s-before) = $103 (the orphan
    // contributes nothing). The separate event read classifies completeness.
    expect(response.totalEstimatedCost).toBeCloseTo(103, 10);
    const evidenceQuery = evidenceQueryCalls(mockDb).at(-1)?.[0];
    expect(collectSqlValues(evidenceQuery)).toEqual(
      expect.arrayContaining(["s-split", "s-before"])
    );
  });

  it("windows the analytics AI-spend + value-per-$ KPIs by the same per-event bound", async () => {
    mockBranchCandidateIds(mockDb, [branchId]);
    mockBranchCandidateIds(mockDb, [branchId]);
    seedWindowedCorpus();

    const analytics = await branchReadService.getBranchAnalytics(
      organizationId,
      { limit: 50, offset: 0, startDate: windowStart, endDate: windowEnd }
    );

    // Same $2 per-event windowed spend as the usage summary — analytics must not
    // diverge.
    expect(analytics.totalSpendUsd.value).toBeCloseTo(2, 10);
    // ISS-4632 (wongk/shafty023 review): the windowed AND lifetime session-usage
    // maps are folded from ONE artifactLink scan. Before, a windowed analytics
    // request issued a SECOND unwindowed `getSessionUsageByBranch` purely to build
    // the lifetime map, re-scanning the identical links. Assert the session-usage
    // scan runs exactly ONCE (not twice) — so a regression re-introducing the
    // doubled scan / independent failure domain fails here.
    //
    // ISS-4469 adds one bounded global-divisor read (distinguishable by select
    // shape — it has no `source` relation) so canonical AI spend can evenly
    // allocate shared Session cost across the full filtered cohort.
    const linkCalls: { select?: { source?: unknown } }[] =
      mockDb.artifactLink.findMany.mock.calls.map((call) => call[0]);
    expect(linkCalls.filter((args) => args?.select?.source)).toHaveLength(1);
    expect(linkCalls.filter((args) => !args?.select?.source)).toHaveLength(1);
    expect(evidenceQueryCalls(mockDb)).toHaveLength(1);
  });

  // ISS-4469: the canonical full-cohort producer needs the global shared-Session
  // divisor, but its hydration budget is fixed for the whole request. This pins
  // one bounded divisor query for the small enriched fixture rather than the old
  // zero-query shortcut that produced mathematically incorrect shared cost.
  it("issues one bounded global-divisor scan for canonical analytics", async () => {
    mockBranchCandidateIds(mockDb, [branchId]);
    mockBranchCandidateIds(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({
        fileChanges: [{ additions: 120, deletions: 30, path: "src/a.ts" }],
      }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue(candidateLinks());
    mockTokenEvents(mockDb, candidateEvents());

    const analytics = await branchReadService.getBranchAnalytics(
      organizationId,
      { limit: 50, offset: 0, startDate: windowStart, endDate: windowEnd }
    );

    // The branch IS enriched, so Value-per-$ is computed (150 churn over the
    // even-split lifetime spend) rather than short-circuiting to Unavailable —
    // proving the assertion below is not passing on an unreachable branch.
    expect(analytics.locPerDollar.value).not.toBeNull();
    const linkCalls: { select?: { source?: unknown } }[] =
      mockDb.artifactLink.findMany.mock.calls.map((call) => call[0]);
    // The heavy session-usage scan still runs exactly once...
    expect(linkCalls.filter((args) => args?.select?.source)).toHaveLength(1);
    // ...and canonical shared-cost reconciliation adds exactly one divisor scan.
    expect(linkCalls.filter((args) => !args?.select?.source)).toHaveLength(1);
  });

  // ISS-4686 — the CLOUD half of the baseline-scope guard (the desktop mirror is
  // `apps/desktop/test/branch-analytics-baseline-scope.test.ts`). This producer's
  // `locPerDollar` is a corpus aggregate, but the branch-detail card that reads
  // it shows ONE branch's ratio; a baseline that does not say which population it
  // covers is what would let the card print a verdict about the org. No baseline
  // is computed here yet, and the day one is, `BranchKpiWithBaseline` requires
  // the scope at compile time — this pins the emitted payload at runtime.
  it("emits no 30-day baseline without the scope it was measured over", async () => {
    mockBranchCandidateIds(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({
        fileChanges: [{ additions: 120, deletions: 30, path: "src/a.ts" }],
      }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue(candidateLinks());
    mockTokenEvents(mockDb, candidateEvents());

    const analytics = await branchReadService.getBranchAnalytics(
      organizationId,
      { limit: 50, offset: 0 }
    );

    // Value-per-$ IS computed, so this is not passing on an inert KPI...
    expect(analytics.locPerDollar.value).not.toBeNull();
    // ...and it still carries no baseline, and claims no scope it doesn't have.
    expect(analytics.locPerDollar.baseline30d).toBeNull();
    expect(analytics.locPerDollar.deltaPct).toBeNull();
    expect(analytics.locPerDollar.comparisonScope).toBeUndefined();
    expect(analytics.leadTimeForChangeMs.baseline30d).toBeNull();
    expect(analytics.leadTimeForChangeMs.comparisonScope).toBeUndefined();
  });
});

function evidenceQueryCalls(mockDb: ReturnType<typeof createMockDb>) {
  return mockDb.$queryRaw.mock.calls.filter((call) =>
    renderSql(call[0]).includes("WITH evidence_size AS MATERIALIZED")
  );
}
