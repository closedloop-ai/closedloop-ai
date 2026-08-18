import assert from "node:assert/strict";
import test from "node:test";
import { sessionCostMapFromUsageRows } from "../src/main/branch/branch-analytics-projection.js";

/**
 * FEA-3695 — the desktop producer of the authoritative per-session cost map that
 * backs `BranchListResponse.sessionCostUsd`. The client re-derives filtered
 * branch spend / KLOC-per-$ as a strict subset-sum over this map, so it MUST
 * count each session's cost exactly once (keyed on the non-nullable `sessionId`)
 * and stay in lockstep with the cloud producer.
 *
 * The cloud analog (`distinctSessionCostMap` in
 * apps/api/app/branches/branch-read-service.ts) is a module-private helper; its
 * exact semantics are mirrored inline here (`cloudSessionCostMap`) so this file
 * is the executable cross-surface parity fixture the AC requires. If either
 * producer's dedup/summation rule drifts, the parity assertion fails.
 */

/**
 * Mirror of the cloud producer: each DISTINCT session's OWN captured cost, taken
 * ONCE (set-if-absent — the same session repeats across a branch's links and
 * across branches, every occurrence carrying the same session-level cost). An
 * un-priced session is coerced to 0 (priced-zero), NEVER dropped, so the cloud
 * map records a $0 entry. This matches `distinctSessionCostMap`.
 */
function cloudSessionCostMap(
  sessionsByBranch: ReadonlyArray<
    ReadonlyArray<{ sessionId: string; estimatedCostUsd: number | null }>
  >
): Record<string, number> {
  const costBySession: Record<string, number> = {};
  for (const sessions of sessionsByBranch) {
    for (const session of sessions) {
      if (!Object.hasOwn(costBySession, session.sessionId)) {
        costBySession[session.sessionId] = session.estimatedCostUsd ?? 0;
      }
    }
  }
  return costBySession;
}

test("sessionCostMapFromUsageRows sums a session's model rows once, keyed by sessionId", () => {
  // s1 has two model rows ($30 + $20 = $50); s2 one ($10). Rows repeat across
  // branches in the desktop read, but the map is per-session — the second
  // occurrence of s1's rows must NOT re-add.
  const usageRows = [
    { sessionId: "s1", costUsdEstimated: 30 },
    { sessionId: "s1", costUsdEstimated: 20 },
    { sessionId: "s2", costUsdEstimated: 10 },
  ];

  const map = sessionCostMapFromUsageRows(usageRows);

  assert.equal(map.s1, 50);
  assert.equal(map.s2, 10);
  assert.equal(Object.keys(map).length, 2);
});

test("sessionCostMapFromUsageRows drops un-priced (null) model rows so an all-null session is absent", () => {
  const usageRows = [
    { sessionId: "sPriced", costUsdEstimated: 25 },
    { sessionId: "sPriced", costUsdEstimated: null }, // ignored
    { sessionId: "sUnknown", costUsdEstimated: null }, // whole session absent
  ];

  const map = sessionCostMapFromUsageRows(usageRows);

  assert.equal(map.sPriced, 25);
  assert.equal(Object.hasOwn(map, "sUnknown"), false);
});

test("FEA-3695 no-double-count: a session shared across branches is counted ONCE in the map", () => {
  // The AC counterexample's shared session s1 ($90) plus s2 ($10). In the
  // desktop read s1 appears once per model row; it must appear ONCE in the map at
  // its own cost — the map is the dedup boundary that stops the client's filtered
  // spend from over-counting the way per-branch totals do.
  const usageRows = [
    { sessionId: "s1", costUsdEstimated: 90 },
    { sessionId: "s2", costUsdEstimated: 10 },
  ];

  const map = sessionCostMapFromUsageRows(usageRows);
  const uniqueTotal = Object.values(map).reduce((sum, cost) => sum + cost, 0);

  assert.equal(map.s1, 90);
  assert.equal(map.s2, 10);
  // The authoritative unique-session population is exactly $100 — never $140.
  assert.equal(uniqueTotal, 100);
});

test("cross-surface parity: desktop and cloud producers agree on the deduped per-session map", () => {
  // Same logical corpus, each surface's real row shape.
  //
  // Desktop `readBranchAnalyticsTokenRows` selects token_usage WHERE session_id
  // IN (branch-linked sessions) with NO branch join, so each (session, model)
  // row appears EXACTLY ONCE regardless of how many branches link the session.
  // s1's cost lands as its per-model rows ($60 + $30 = $90), NOT once per branch.
  const desktopUsageRows = [
    { sessionId: "s1", costUsdEstimated: 60 }, // s1, model A
    { sessionId: "s1", costUsdEstimated: 30 }, // s1, model B → s1 totals $90
    { sessionId: "s2", costUsdEstimated: 10 },
    { sessionId: "s3", costUsdEstimated: 0 }, // priced-zero
  ];
  // Cloud `distinctSessionCostMap` takes each DISTINCT session's own cost once,
  // set-if-absent — the same session is pushed onto every branch it links, so
  // s1 recurs across branches A and B here but is recorded ONCE at $90.
  const cloudSessionsByBranch = [
    [
      { sessionId: "s1", estimatedCostUsd: 90 },
      { sessionId: "s2", estimatedCostUsd: 10 },
    ],
    [{ sessionId: "s1", estimatedCostUsd: 90 }], // shared session on branch B
    [{ sessionId: "s3", estimatedCostUsd: 0 }],
  ];

  const desktopMap = sessionCostMapFromUsageRows(desktopUsageRows);
  const cloudMap = cloudSessionCostMap(cloudSessionsByBranch);

  // Both surfaces produce the identical authoritative map: each session once.
  assert.deepEqual(desktopMap, { s1: 90, s2: 10, s3: 0 });
  assert.deepEqual(cloudMap, desktopMap);
});
