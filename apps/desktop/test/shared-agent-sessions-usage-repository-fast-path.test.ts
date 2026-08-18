import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SessionCursorRow } from "../src/main/agent-sync/agent-session-read-model.js";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import {
  getSharedAgentSessionUsage,
  MAX_WORKING_SET_SESSIONS,
} from "../src/main/session/shared-agent-sessions-api.js";
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
 * events, artifact links, PRs, LOC for up to MAX_WORKING_SET_SESSIONS rows — on
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

  test("hydrates at most the ceiling on an over-cap repo (FEA-4286)", async () => {
    const sessions: Record<string, SyncedAgentSession> = {};
    const cursorRows: SessionCursorRow[] = [];
    for (let index = 0; index < MAX_WORKING_SET_SESSIONS + 50; index++) {
      const id = `over-${String(index).padStart(6, "0")}`;
      sessions[id] = session({ id, repositoryFullName: TARGET_REPO });
      cursorRows.push(cursor(id));
    }
    const { source, usageLoads } = createLightweightUsageSource(
      sessions,
      cursorRows
    );

    await getSharedAgentSessionUsage(source, { repositories: [TARGET_REPO] });

    assert.equal(
      usageLoads[0]?.length,
      MAX_WORKING_SET_SESSIONS,
      "the repo-filtered fast path must keep the FEA-4286 hydration ceiling"
    );
  });
});
