// ISS-4828 (secondary): the "Compute Target Freshness" card's population must
// not truncate a LIVE target out of its top-20 window.
//
// The `lastSyncTargets` read ranked by `lastAgentSessionSyncAt desc` first — the
// LANDED-DATA watermark, which ISS-4678 narrowed so it advances only when
// session rows actually persist. A target that is online right now but has
// nothing new to send therefore sank one place at a time as other targets landed
// data, and eventually fell out of the `take: 20` window entirely — on a card
// whose entire job is telling an operator which machines are fresh.
//
// The ordering is executed by Postgres, so the observable contract at this
// service boundary is the emitted `orderBy` precedence and page width. These
// tests pin exactly that: the ACCEPTED-sync watermark leads, so a target that
// synced with nothing new to send stays at the top of the page instead of
// sinking out of it, and the card's headline column remains the sort key.
//
// ISS-10165 CHANGED THE ORDERING, and the expectation below moved with it: the
// production `orderBy` gained a terminal `{ id: "asc" }`. That is a behavior
// change, not a widened assertion — all four keys this file already pinned are
// non-unique, so the ordering was PARTIAL and the planner was free to return a
// tied run in any order, which a walk across a page boundary can read as a row
// served twice or never. The precedence these cases exist to protect is
// untouched: `id` is the LAST term, so it decides only rows on which the four
// keys above it are already equal. The consequence — exactly-once delivery under
// ties — is asserted by `last-sync-targets-exactly-once.test.ts`, because an
// equality assertion on a literal array cannot fail when the terminal key is
// deleted in the same hand-motion that edits the literal.
//
// ISS-10851 CHANGED THE ORDERING AGAIN: the two watermark keys now pin
// `nulls: "last"` explicitly. The bare `"desc"` shorthand delegated null
// placement to Postgres's default for a DESC key, which is NULLS FIRST — the
// opposite of `sessionLastSyncTargets.sql`'s explicit `DESC NULLS LAST` and of
// the FEA-4330 convention that comment cites. A live comparison against
// representative data (multiple targets, most never synced) showed the two
// producers reordering all seven rows around exactly this: the one target with
// a real watermark sorted last here and first in the SQL candidate.
//
// The literal below pins the SPELLING and nothing more — reverting the query to
// the bare `"desc"` edits this expectation in the same hand-motion, exactly as
// the ISS-10165 note above says of the terminal key. The CONSEQUENCE, that a
// never-synced target sorts last rather than above the one that just synced, is
// asserted by `last-sync-targets-exactly-once.test.ts` against a fake that
// models Postgres's own default for an unspecified `nulls`, and by the real
// planner in `last-sync-targets-page-boundary.integration.test.ts`.

import { describe, expect, it, vi } from "vitest";
import {
  buildAgentSessionDbMock,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { agentSessionsService } from "../service";
import { LAST_SYNC_TARGET_PAGE_SIZE } from "./last-sync-targets";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});

function installUsageSummaryDb() {
  const computeTargetFindMany = vi.fn().mockResolvedValue([]);
  installDb({
    sessionDetail: buildAgentSessionDbMock({
      aggregate: vi.fn().mockResolvedValue({
        _count: { _all: 0 },
        _sum: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          estimatedCost: 0,
        },
        _min: { sessionStartedAt: null },
        _max: { sessionStartedAt: null },
      }),
      groupBy: vi.fn().mockResolvedValue([]),
    }),
    agentSessionTokenUsage: { groupBy: vi.fn().mockResolvedValue([]) },
    artifactLink: { findMany: vi.fn().mockResolvedValue([]) },
    computeTarget: { findMany: computeTargetFindMany },
  });
  return { computeTargetFindMany };
}

describe("lastSyncTargets ordering (ISS-4828)", () => {
  it("ranks the ACCEPTED-sync watermark FIRST so a live target cannot be truncated out of the page", async () => {
    const { computeTargetFindMany } = installUsageSummaryDb();

    await agentSessionsService.getUsageSummary({
      organizationId: "org-1",
      filters: {},
    });

    expect(computeTargetFindMany).toHaveBeenCalledTimes(1);
    const [args] = computeTargetFindMany.mock.calls[0];
    // Full precedence, in order. The ACCEPTED-sync watermark leading is the fix:
    // an idle-but-syncing target keeps a fresh attempt stamp, so it no longer
    // sinks below targets that merely landed data more recently.
    expect(args.orderBy).toEqual([
      // ISS-10851: NULLS LAST on both watermarks, matching the SQL candidate.
      { lastAgentSessionSyncAttemptAt: { sort: "desc", nulls: "last" } },
      { lastAgentSessionSyncAt: { sort: "desc", nulls: "last" } },
      { isOnline: "desc" },
      { lastSeenAt: "desc" },
      // ISS-10165: the unique terminal key that makes this ordering total.
      { id: "asc" },
    ]);
    // The landed-data watermark is explicitly no longer the primary key — the
    // regression this test exists to prevent.
    expect(args.orderBy[0]).not.toHaveProperty("lastAgentSessionSyncAt");
    expect(args.take).toBe(LAST_SYNC_TARGET_PAGE_SIZE);
  });

  // Review, PR #4256: an earlier revision led with `isOnline desc, lastSeenAt
  // desc`. That reordered the page on a dimension the card does not display, so
  // a laptop whose batch was accepted 30 seconds ago and then disconnected
  // ranked below every online-but-not-syncing machine and could be truncated out
  // of the top 20 — and it changed row order perceivably while the card's
  // closed-by-default flag was still off. Presence must stay a tie-break.
  it("does NOT rank presence ahead of the sync watermarks", async () => {
    const { computeTargetFindMany } = installUsageSummaryDb();

    await agentSessionsService.getUsageSummary({
      organizationId: "org-1",
      filters: {},
    });

    const [args] = computeTargetFindMany.mock.calls[0];
    expect(args.orderBy[0]).not.toHaveProperty("isOnline");
    expect(args.orderBy[0]).not.toHaveProperty("lastSeenAt");
  });

  it("selects both sync watermarks so the card can label each by what it measures", async () => {
    const { computeTargetFindMany } = installUsageSummaryDb();

    await agentSessionsService.getUsageSummary({
      organizationId: "org-1",
      filters: {},
    });

    const [args] = computeTargetFindMany.mock.calls[0];
    expect(args.select.lastAgentSessionSyncAt).toBe(true);
    expect(args.select.lastAgentSessionSyncAttemptAt).toBe(true);
  });
});
