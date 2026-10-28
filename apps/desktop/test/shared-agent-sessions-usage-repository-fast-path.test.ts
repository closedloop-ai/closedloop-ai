import assert from "node:assert/strict";
import {
  SESSION_COST_FILTER_OPTIONS,
  type SessionCostBucketId,
} from "@repo/api/src/agent-session-filters";
import { describe, test } from "vitest";
import type { SessionCursorRow } from "../src/main/agent-sync/agent-session-read-model.js";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { SESSION_HYDRATION_WINDOW } from "../src/main/session/session-hydration-window.js";
import { getSharedAgentSessionUsage } from "../src/main/session/shared-agent-sessions-api.js";
import {
  createFakeSource,
  cursor,
  session,
} from "./shared-agent-sessions-test-helpers.js";

/**
 * ISS-5626: the usage half of the combined Sessions page-data read used to lose
 * BOTH of its cheap paths to a Repository selection — the SQL `aggregateUsage`
 * (which genuinely cannot express the per-row repo identity) and the lightweight
 * `loadUsageSessions` load (which can, since ISS-5271 taught it the stored-first
 * `repositoryFullName`). The second exclusion was stale, and it cost a
 * repo-filtered Sessions view a FULL `loadSyncedSessions` hydrate — agents,
 * events, artifact links, PRs, LOC for up to SESSION_HYDRATION_WINDOW rows — on
 * every one of its 2-second background page-data polls, on the heap-capped
 * db-host worker.
 *
 * The invariant these tests hold: taking the lightweight load must not change
 * WHICH sessions the summary covers. So every behavioral assertion here is
 * pinned against the fully-hydrated path as the reference, and the two
 * mechanisms that decide the covered set — the pre-hydration repository scoping
 * and the FEA-4286 hydration ceiling — are asserted directly.
 */

const TARGET_REPO = "closedloop-ai/target";
const OTHER_REPO = "closedloop-ai/other";

/**
 * The rows the real `loadUsageSessions` returns: session metadata +
 * `tokenUsageByModel`, agents/events stripped, and a repo-only attribution
 * carrying the stored-first `repositoryFullName` (ISS-5271) with none of the
 * live worktree/launch-metadata fields. Mirroring that shape here is what makes
 * a summary matching the full-hydrate reference evidence about the production
 * load rather than about the fixture.
 */
function lightweightRows(
  sessions: Record<string, SyncedAgentSession>,
  ids: readonly string[]
): SyncedAgentSession[] {
  return ids.flatMap((id) => {
    const loaded = sessions[id];
    if (!loaded) {
      return [];
    }
    const repositoryFullName = loaded.attribution?.repositoryFullName ?? null;
    return [
      {
        ...loaded,
        agents: [],
        events: [],
        attribution: repositoryFullName
          ? {
              repositoryFullName,
              worktreePath: null,
              sourceArtifactId: null,
              sourceLoopId: null,
              baseBranch: null,
            }
          : undefined,
      },
    ];
  });
}

/**
 * A source that supports the lightweight usage load, recording the id sets it
 * is handed. The `calls` log of the wrapped fake still records
 * `listRepositoryScopedSessionIds` / `loadSyncedSessions`, so a test can prove
 * both that the repo scoping ran and that no full hydrate did.
 */
function createLightweightUsageSource(
  sessions: Record<string, SyncedAgentSession>,
  cursorRows?: SessionCursorRow[]
) {
  const fake = createFakeSource({
    sessions,
    ...(cursorRows ? { cursorRows } : {}),
  });
  const usageLoads: string[][] = [];
  return {
    source: {
      ...fake,
      loadUsageSessions(ids: string[]): SyncedAgentSession[] {
        usageLoads.push([...ids]);
        return lightweightRows(sessions, ids);
      },
    },
    usageLoads,
    calls: fake.calls,
  };
}

/** Two sessions in the selected repo, one in another, one with no repo at all. */
function mixedRepoSessions(): Record<string, SyncedAgentSession> {
  return {
    "target-a": session({ id: "target-a", repositoryFullName: TARGET_REPO }),
    "other-b": session({ id: "other-b", repositoryFullName: OTHER_REPO }),
    "target-c": session({ id: "target-c", repositoryFullName: TARGET_REPO }),
    "unknown-d": session({ id: "unknown-d" }),
  };
}

describe("repository-filtered usage read", () => {
  test("stays on the lightweight load instead of hydrating the corpus (ISS-5626)", async () => {
    const sessions = mixedRepoSessions();
    const { source, usageLoads, calls } =
      createLightweightUsageSource(sessions);

    await getSharedAgentSessionUsage(source, { repositories: [TARGET_REPO] });

    assert.equal(
      calls.filter((call) => call.kind === "loadSyncedSessions").length,
      0,
      "a repo-filtered usage read must not fall back to the full hydrate"
    );
    assert.equal(usageLoads.length, 1, "expected one lightweight usage load");
  });

  test("scopes the id set to the selection BEFORE hydrating (ISS-5626)", async () => {
    const sessions = mixedRepoSessions();
    const { source, usageLoads, calls } =
      createLightweightUsageSource(sessions);

    await getSharedAgentSessionUsage(source, { repositories: [TARGET_REPO] });

    const scoped = calls.find(
      (call) => call.kind === "listRepositoryScopedSessionIds"
    );
    assert.ok(scoped, "the selection must be resolved pre-hydration");
    assert.deepEqual(scoped.repositories, [TARGET_REPO]);
    // The load sees the MATCHED ids only. Resolving the corpus and letting
    // `matchesQuery` thin it afterwards would hand all four ids here — and past
    // the ceiling would truncate the repo's older rows away before the predicate
    // ever ran, which is the ISS-4535 defect the fallback already avoids.
    assert.deepEqual(usageLoads[0], ["target-a", "target-c"]);
  });

  test("covers the same sessions as the fully-hydrated path (ISS-5626)", async () => {
    const sessions = mixedRepoSessions();
    const requests = [
      { repositories: [TARGET_REPO] },
      { repositories: [TARGET_REPO, OTHER_REPO] },
      { repositories: [TARGET_REPO], harness: "claude" },
      { repositories: ["closedloop-ai/nonexistent"] },
    ];

    for (const request of requests) {
      // A source with no `loadUsageSessions` delegate takes the fully-hydrated
      // `loadWorkingSessions` fold — the reference this fast path must reproduce.
      const reference = await getSharedAgentSessionUsage(
        createFakeSource({ sessions }),
        request
      );
      const { source } = createLightweightUsageSource(sessions);
      const lightweight = await getSharedAgentSessionUsage(source, request);

      assert.deepEqual(
        lightweight,
        reference,
        `usage mismatch for ${JSON.stringify(request)}`
      );
    }
    // Guard the guard: the reference must not be the empty summary for the
    // selecting requests, or every assertion above would hold vacuously.
    const selected = await getSharedAgentSessionUsage(
      createFakeSource({ sessions }),
      { repositories: [TARGET_REPO] }
    );
    assert.equal(selected.totalSessions, 2);
  });

  test("still narrows on a source that cannot resolve repositories pre-hydration (ISS-5626)", async () => {
    const sessions = mixedRepoSessions();
    const reference = await getSharedAgentSessionUsage(
      createFakeSource({ sessions }),
      { repositories: [TARGET_REPO] }
    );
    const { source, usageLoads } = createLightweightUsageSource(sessions);
    // A fake/legacy source predating ISS-4535's pre-hydration read.
    // `resolveRepositoryScopedSessionIds` degrades to the full cursor list for
    // it, so the in-memory `sessionMatchesRepositoryFilter` is the only thing
    // narrowing the rows — and it can only do that because the lightweight rows
    // carry the stored-first repo identity.
    Reflect.deleteProperty(source, "listRepositoryScopedSessionIds");

    const lightweight = await getSharedAgentSessionUsage(source, {
      repositories: [TARGET_REPO],
    });

    assert.equal(usageLoads[0]?.length, 4, "the whole corpus is loaded here");
    assert.deepEqual(lightweight, reference);
    assert.equal(lightweight.totalSessions, 2);
  });

  // ISS-6895: the repo-filtered lightweight path keeps FEA-4286's residency
  // ceiling per call, but no longer buys it by discarding the tail — the repo's
  // 50 oldest sessions used to vanish from the usage cards while the list still
  // counted them.
  test("walks an over-window repo in bounded windows without dropping its tail (ISS-6895)", async () => {
    const matchedSessions = SESSION_HYDRATION_WINDOW + 50;
    const sessions: Record<string, SyncedAgentSession> = {};
    const cursorRows: SessionCursorRow[] = [];
    for (let index = 0; index < matchedSessions; index++) {
      const id = `over-${String(index).padStart(6, "0")}`;
      sessions[id] = session({ id, repositoryFullName: TARGET_REPO });
      cursorRows.push(cursor(id));
    }
    const { source, usageLoads } = createLightweightUsageSource(
      sessions,
      cursorRows
    );

    const usage = await getSharedAgentSessionUsage(source, {
      repositories: [TARGET_REPO],
    });

    for (const ids of usageLoads) {
      assert.ok(
        ids.length <= SESSION_HYDRATION_WINDOW,
        `a lightweight load carried ${ids.length} ids, above the ${SESSION_HYDRATION_WINDOW} residency ceiling`
      );
    }
    assert.equal(
      new Set(usageLoads.flat()).size,
      matchedSessions,
      "every repo-matched session must be folded across the windows"
    );
    assert.equal(
      usage.totalSessions,
      matchedSessions,
      "the repo-filtered usage total must cover the repo's whole population"
    );
  });
});

/**
 * ISS-6416: the Cost facet reads what the lightweight load STRIPS. Its
 * numeric-vs-Unknown boundary (`matchesLocalCostBucketFilter` →
 * `localSubstantiveCounts`) counts tool-use events, and `loadUsageSessions`
 * returns no events at all — so a session whose only evidence of work is a
 * tool-use event flips from a known `$0.00` to Unknown and is dropped, and the
 * usage cards answer with a confident, wrong ZERO.
 *
 * Neither facet alone reaches the defect the way this pair does, and neither
 * alone proves the fix: with only the repo filter every session below is
 * counted, and with only the cost bucket the OTHER_REPO row is too. So the
 * `totalSessions` guard is asserted first — if either facet stopped narrowing,
 * the parity comparison after it would hold for a reason that has nothing to do
 * with this ticket.
 */
const UNDER_ONE_DOLLAR: SessionCostBucketId = "under_1";

/**
 * A subscription session whose ONLY substantive signal is a tool-use event — no
 * turns, no tokens, no priced cost. The canned fixture events already carry one
 * `toolName`, and emptying `tokenUsageByModel` is what leaves the event as the
 * sole evidence, so `sessionCostIsNumeric` reads it as a known `$0.00` while the
 * events are visible and as Unknown once they are stripped.
 */
function toolOnlySubscriptionSession(
  id: string,
  repositoryFullName: string
): SyncedAgentSession {
  return {
    ...session({ id, repositoryFullName, billingMode: "subscription_unknown" }),
    tokenUsageByModel: [],
  };
}

/** A priced session well outside the "≤ $1" bucket. */
function pricedSession(
  id: string,
  repositoryFullName: string,
  estimatedCostUsd: number
): SyncedAgentSession {
  return {
    ...session({ id, repositoryFullName, billingMode: "api" }),
    tokenUsageByModel: [
      {
        model: "gpt-test",
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
        estimatedCostUsd,
      },
    ],
  };
}

describe("repository + cost-bucket usage read", () => {
  test("keeps a tool-only subscription session in the ≤ $1 bucket (ISS-6416)", async () => {
    const sessions: Record<string, SyncedAgentSession> = {
      "target-tool-only": toolOnlySubscriptionSession(
        "target-tool-only",
        TARGET_REPO
      ),
      "target-expensive": pricedSession("target-expensive", TARGET_REPO, 25),
      "other-tool-only": toolOnlySubscriptionSession(
        "other-tool-only",
        OTHER_REPO
      ),
    };
    const request = {
      repositories: [TARGET_REPO],
      costBuckets: [UNDER_ONE_DOLLAR],
    };

    const reference = await getSharedAgentSessionUsage(
      createFakeSource({ sessions }),
      request
    );
    assert.equal(
      reference.totalSessions,
      1,
      "both facets must narrow, or the parity assertion below is vacuous"
    );
    // …and the survivor must be the TOOL-ONLY row, not the priced one. A count
    // of 1 alone is also what an inverted cost predicate produces, and the
    // priced row is excluded from "≤ $1" on both paths — so the two paths would
    // still agree and this test would pass on a fold it says nothing about.
    assert.equal(reference.totalInputTokens, 0, "the priced row must be out");
    assert.equal(reference.totalEstimatedCost, 0);

    const { source, usageLoads } = createLightweightUsageSource(sessions);
    const lightweight = await getSharedAgentSessionUsage(source, request);

    assert.deepEqual(lightweight, reference);
    assert.equal(usageLoads.length, 0, "the cost predicate needs the events");
  });

  test("refuses the lightweight load for a cost bucket with no repo selected (ISS-6416)", async () => {
    // The exclusion is unconditional, and scoping it to a repo-filtered read is
    // the mutation the case above cannot see. This shape reaches the same branch
    // in production: `canUseAggregateSessionFilters` refuses any non-exhaustive
    // cost selection, so a bare Cost selection skips the SQL aggregate too.
    const sessions: Record<string, SyncedAgentSession> = {
      "target-tool-only": toolOnlySubscriptionSession(
        "target-tool-only",
        TARGET_REPO
      ),
      "target-expensive": pricedSession("target-expensive", TARGET_REPO, 25),
      "other-tool-only": toolOnlySubscriptionSession(
        "other-tool-only",
        OTHER_REPO
      ),
    };
    const request = { costBuckets: [UNDER_ONE_DOLLAR] };

    const reference = await getSharedAgentSessionUsage(
      createFakeSource({ sessions }),
      request
    );
    // Both tool-only rows, from either repo; the priced row is out.
    assert.equal(reference.totalSessions, 2);
    assert.equal(reference.totalInputTokens, 0);

    const { source, usageLoads } = createLightweightUsageSource(sessions);
    const lightweight = await getSharedAgentSessionUsage(source, request);

    assert.deepEqual(lightweight, reference);
    assert.equal(usageLoads.length, 0, "the cost predicate needs the events");
  });

  test("keeps the lightweight load for an EXHAUSTIVE cost selection (ISS-4481)", async () => {
    // An exhaustive selection excludes no row and `matchesLocalFacetFilters`
    // skips the matcher for it, so the carve-out must survive the ISS-6416
    // exclusion — without it every "all cost states" read pays the hydrate the
    // exclusion exists to buy correctness with, for a filter that filters
    // nothing.
    const sessions = mixedRepoSessions();
    const request = {
      costBuckets: SESSION_COST_FILTER_OPTIONS.map((option) => option.id),
    };

    const reference = await getSharedAgentSessionUsage(
      createFakeSource({ sessions }),
      request
    );
    assert.equal(reference.totalSessions, 4, "an exhaustive filter drops none");

    const { source, usageLoads } = createLightweightUsageSource(sessions);
    const lightweight = await getSharedAgentSessionUsage(source, request);

    assert.deepEqual(lightweight, reference);
    assert.equal(usageLoads.length, 1, "expected one lightweight usage load");
  });
});
