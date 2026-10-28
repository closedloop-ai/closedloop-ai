import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { getSharedAgentSessionDetail } from "../src/main/session/shared-agent-session-detail-read.js";
import {
  createFakeSource,
  cursor,
  session,
} from "./shared-agent-sessions-test-helpers.js";

/**
 * The desktop-local LOC/$ projection.
 *
 * ISS-9964 / ISS-9980 (RULED 2026-09-11): the LOC/$ numerator is the lines a
 * session landed in MERGED authored PRs, and nothing else. The desktop gateway
 * has no merged-PR data before its first cloud sync — the merged roll-up is
 * derived server-side — so the numerator here is NOT KNOWABLE rather than zero,
 * and the ratio is reported as unavailable (`null`).
 *
 * This file previously pinned the ISS-4667 contract: a numerator of
 * `max(local working-tree diff, branch diff)`, reading 528 and 16016 on the two
 * fixtures below. Those rungs are retired, not re-homed — the branch and
 * working-tree scalars measure work in progress (transcript-derived rather than
 * git per FEA-3922/FEA-3923, and folding a delegated sub-agent's churn in per
 * ISS-5402), so neither belongs in a delivered-code figure. The expectations
 * changed because the ruling changed what the number means, not to turn a red
 * green.
 *
 * `null` here is "nobody could look yet", NOT a measured zero. A session that
 * genuinely merged nothing reports `0` — that distinction is the whole point of
 * the ruling, and it is pinned on the shared derivation in
 * `packages/api/src/utils/loc-per-dollar.test.ts`.
 */

describe("shared agent sessions LOC/$ projection", () => {
  test("reports no ratio for a local-only session, because no merged LOC is knowable yet", async () => {
    const localSession = {
      ...session({ id: "session-local-only", status: "completed" }),
      linesAdded: 120,
      linesRemoved: 12,
    } satisfies SyncedAgentSession;
    const source = createFakeSource({
      cursorRows: [cursor("session-local-only")],
      sessions: { "session-local-only": localSession },
    });

    const detail = await getSharedAgentSessionDetail(
      source,
      "session-local-only"
    );

    // The raw churn still flows through untouched — it is a real local
    // measurement and the Properties panel still has uses for it. What it is no
    // longer allowed to do is stand in as a delivered-code numerator.
    assert.equal(detail?.linesAdded, 120);
    assert.equal(detail?.linesRemoved, 12);
    assert.equal(detail?.locPerDollar, null);
    assert.equal(detail?.kloc, null);
  });

  test("a large branch diff does not resurrect a numerator either", async () => {
    const mergedSession = {
      ...session({
        id: "session-merged-multi-pr",
        status: "completed",
      }),
      linesAdded: 50,
      linesRemoved: 6,
      branchDiffStats: {
        linesAdded: 3315,
        linesRemoved: 689,
        filesChanged: 88,
        source: "branch_fallback",
      },
    } satisfies SyncedAgentSession;
    const source = createFakeSource({
      cursorRows: [cursor("session-merged-multi-pr")],
      sessions: { "session-merged-multi-pr": mergedSession },
    });

    const detail = await getSharedAgentSessionDetail(
      source,
      "session-merged-multi-pr"
    );

    // 4,004 branch-diff lines are present and still not a numerator: the branch
    // diff is exactly the rung ISS-9980 retired. Reporting 16016 LOC/$ from it
    // would be a confident number over a basis the session never merged.
    assert.equal(detail?.locPerDollar, null);
    assert.equal(detail?.kloc, null);
  });
});
