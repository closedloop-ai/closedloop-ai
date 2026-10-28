/**
 * @file session-repository-facet-coverage.test.ts
 * @description ISS-8730 coverage for `session-repository-facet.ts` — the
 * FEA-4299 Repository facet/filter/sort identity helpers.
 *
 * `session-repository-scoped-reads.test.ts` already covers the SQLite
 * pre-hydration id read (`listSqliteRepositoryScopedSessionIds`), a different
 * module. Nothing in this directory exercises the pure facet helpers this file
 * targets: `sessionRepositoryName`, `accumulateUsageRepositoryTotals`,
 * `mapAggregateRepoCountsToBreakdowns`, `sessionMatchesRepositoryFilter`,
 * `resolveRepositoryScopedSessionIds`, and
 * `canPageRepositoryFilterBeforeHydration`.
 *
 * These are pure functions (the two source-dispatching ones take a duck-typed
 * `AgentSessionSyncSource`), so they are tested directly against plain
 * fixtures — no database, no mocked transaction.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";
import {
  accumulateUsageRepositoryTotals,
  canPageRepositoryFilterBeforeHydration,
  mapAggregateRepoCountsToBreakdowns,
  resolveRepositoryScopedSessionIds,
  sessionMatchesRepositoryFilter,
  sessionRepositoryName,
} from "../src/main/session/session-repository-facet.js";
import type { SharedAgentSessionRepositoryBreakdown } from "../src/shared/shared-agent-sessions-contract.js";
import { emptyAttributionCache } from "./attribution-test-helpers.js";
import { makeSyncedSession } from "./fake-sync-source.js";

function withRepo(
  id: string,
  repositoryFullName: string | null
): SyncedAgentSession {
  return {
    ...makeSyncedSession(id, "2026-06-08T00:00:00.000Z"),
    attribution: repositoryFullName === null ? null : { repositoryFullName },
  };
}

/**
 * A minimal `AgentSessionSyncSource` fixture. `listUpdatedSessionCursorRows`
 * and `loadSyncedSessions` are required by the interface but unused by the
 * facet helpers under test here, so they get harmless no-op defaults;
 * `listAllSessionCursorRows` and `listRepositoryScopedSessionIds` are the two
 * members these tests actually exercise and vary per case.
 */
function makeSyncSource(
  overrides: Partial<
    Pick<
      AgentSessionSyncSource,
      "listAllSessionCursorRows" | "listRepositoryScopedSessionIds"
    >
  > = {}
): AgentSessionSyncSource {
  return {
    listAllSessionCursorRows: () => [],
    listUpdatedSessionCursorRows: () => [],
    loadSyncedSessions: () => [],
    ...overrides,
  };
}

test("sessionRepositoryName returns the resolved repositoryFullName from attribution", () => {
  assert.equal(sessionRepositoryName(withRepo("s1", "acme/app")), "acme/app");
});

test("sessionRepositoryName returns null when attribution carries no repositoryFullName", () => {
  assert.equal(sessionRepositoryName(withRepo("s1", null)), null);
  assert.equal(
    sessionRepositoryName({
      ...makeSyncedSession("s2", "2026-06-08T00:00:00.000Z"),
      attribution: { repositoryFullName: null },
    }),
    null
  );
});

test("accumulateUsageRepositoryTotals sums session count and token/cost totals across repeat sessions of one repo", () => {
  const byRepository = new Map<string, SharedAgentSessionRepositoryBreakdown>();
  accumulateUsageRepositoryTotals(byRepository, withRepo("s1", "acme/app"), {
    inputTokens: 100,
    outputTokens: 50,
    estimatedCost: 0.01,
  });
  accumulateUsageRepositoryTotals(byRepository, withRepo("s2", "acme/app"), {
    inputTokens: 40,
    outputTokens: 10,
    estimatedCost: 0.002,
  });

  const group = byRepository.get("acme/app");
  assert.deepEqual(group, {
    repositoryFullName: "acme/app",
    sessionCount: 2,
    inputTokens: 140,
    outputTokens: 60,
    estimatedCost: 0.012,
    errorCount: 0,
  });
});

test("accumulateUsageRepositoryTotals skips a session with no resolvable repository identity", () => {
  const byRepository = new Map<string, SharedAgentSessionRepositoryBreakdown>();
  accumulateUsageRepositoryTotals(byRepository, withRepo("s1", null), {
    inputTokens: 100,
    outputTokens: 50,
    estimatedCost: 0.01,
  });

  assert.equal(
    byRepository.size,
    0,
    "a session with no resolved repo must not open a facet entry"
  );
});

// CURRENT BEHAVIOR, PINNED — not a fix. `SharedAgentSessionRepositoryBreakdown`
// carries an `errorCount` field, and the group literal seeds it at 0, but
// `accumulateUsageRepositoryTotals` never increments it on any call. Every
// breakdown this helper produces therefore reports errorCount 0 regardless of
// how many of the accumulated sessions actually errored.
test("accumulateUsageRepositoryTotals never increments errorCount (current behavior)", () => {
  const byRepository = new Map<string, SharedAgentSessionRepositoryBreakdown>();
  accumulateUsageRepositoryTotals(byRepository, withRepo("s1", "acme/app"), {
    inputTokens: 0,
    outputTokens: 0,
    estimatedCost: 0,
  });
  accumulateUsageRepositoryTotals(byRepository, withRepo("s2", "acme/app"), {
    inputTokens: 0,
    outputTokens: 0,
    estimatedCost: 0,
  });

  assert.equal(byRepository.get("acme/app")?.errorCount, 0);
});

test("mapAggregateRepoCountsToBreakdowns maps counts to breakdowns with zeroed token/cost/error fields", () => {
  const result = mapAggregateRepoCountsToBreakdowns([
    { repositoryFullName: "acme/app", sessionCount: 3 },
    { repositoryFullName: "acme/other", sessionCount: 1 },
  ]);

  assert.deepEqual(result, [
    {
      repositoryFullName: "acme/app",
      sessionCount: 3,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      errorCount: 0,
    },
    {
      repositoryFullName: "acme/other",
      sessionCount: 1,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      errorCount: 0,
    },
  ]);
});

test("sessionMatchesRepositoryFilter: an empty filter matches every session, including one with no resolved repo", () => {
  assert.equal(
    sessionMatchesRepositoryFilter(withRepo("s1", "acme/app"), []),
    true
  );
  assert.equal(sessionMatchesRepositoryFilter(withRepo("s2", null), []), true);
});

test("sessionMatchesRepositoryFilter: a session whose repo is in the filter list matches", () => {
  assert.equal(
    sessionMatchesRepositoryFilter(withRepo("s1", "acme/app"), [
      "acme/other",
      "acme/app",
    ]),
    true
  );
});

test("sessionMatchesRepositoryFilter: a session whose repo is not in the filter list does not match", () => {
  assert.equal(
    sessionMatchesRepositoryFilter(withRepo("s1", "acme/app"), ["acme/other"]),
    false
  );
});

test("sessionMatchesRepositoryFilter: a session with no resolved repo never matches a non-empty filter", () => {
  assert.equal(
    sessionMatchesRepositoryFilter(withRepo("s1", null), ["acme/app"]),
    false
  );
});

test("resolveRepositoryScopedSessionIds delegates to the source's method, forwarding repositories/cache/options", async () => {
  const calls: unknown[] = [];
  const cache = emptyAttributionCache();
  const options = { limit: 5 };
  const source = makeSyncSource({
    listAllSessionCursorRows: () => {
      throw new Error("must not fall back to the full cursor list");
    },
    listRepositoryScopedSessionIds: (repositories, resolverCache, opts) => {
      calls.push([repositories, resolverCache, opts]);
      return ["s-app-1", "s-app-2"];
    },
  });

  const ids = await resolveRepositoryScopedSessionIds(
    source,
    ["acme/app"],
    cache,
    options
  );

  assert.deepEqual(ids, ["s-app-1", "s-app-2"]);
  assert.deepEqual(calls, [[["acme/app"], cache, options]]);
});

test("resolveRepositoryScopedSessionIds falls back to mapping listAllSessionCursorRows to bare ids when the source lacks the method", async () => {
  const source = makeSyncSource({
    listAllSessionCursorRows: () => [
      { id: "s1", updated_at: "2026-06-08T00:00:00.000Z" },
      { id: "s2", updated_at: "2026-06-07T00:00:00.000Z" },
    ],
  });

  const ids = await resolveRepositoryScopedSessionIds(
    source,
    ["acme/app"],
    emptyAttributionCache()
  );

  assert.deepEqual(
    ids,
    ["s1", "s2"],
    "the fallback returns every cursor row's id unfiltered — the caller's in-memory matcher narrows it"
  );
});

test("canPageRepositoryFilterBeforeHydration: true when no repository filter is active, even if the source lacks the method", () => {
  const source = makeSyncSource();
  assert.equal(canPageRepositoryFilterBeforeHydration(source, []), true);
});

test("canPageRepositoryFilterBeforeHydration: true when a filter is active and the source implements the scoped read", () => {
  const source = makeSyncSource({ listRepositoryScopedSessionIds: () => [] });
  assert.equal(
    canPageRepositoryFilterBeforeHydration(source, ["acme/app"]),
    true
  );
});

test("canPageRepositoryFilterBeforeHydration: false when a filter is active and the source lacks the scoped read", () => {
  const source = makeSyncSource();
  assert.equal(
    canPageRepositoryFilterBeforeHydration(source, ["acme/app"]),
    false
  );
});
