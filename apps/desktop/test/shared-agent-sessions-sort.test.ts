import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  resolveSessionDurationLifecycle,
  SessionDurationLifecycle,
} from "@repo/api/src/types/session-status";
import type {
  SyncedAgentSession,
  SyncedAgentSessionTokenUsage,
} from "../src/main/agent-sync/agent-session-sync-contract.js";
import { SESSIONS_SURFACE_DATE_WINDOW_FIELD } from "../src/main/agent-sync/session-date-window.js";
import { sortSyncedSessions } from "../src/main/session/session-working-set-sort.js";
import {
  displayedSharedStatusRank,
  isKnownSharedStatus,
  projectDisplayedSharedStatus,
  resolveDisplayedSharedSessionStatus,
} from "../src/main/session/shared-agent-session-status.js";
import type { SanitizedQuery } from "../src/main/session/shared-agent-sessions-query.js";

// FEA-4426: the decorate-sort-undecorate rewrite of `sortSyncedSessions` must
// emit the SAME order as the previous comparator, which derived each row's sort
// key from scratch on both operands of every comparison. These tests pin that
// output-equivalence per sort column (and its asc/desc + tie behavior), plus a
// reference comparator run at scale so an ordering regression fails structurally
// (not on timing).

const SORT_KEYS = [
  "status",
  "repo",
  "harness",
  "model",
  "cost",
  "duration",
  "lastActivity",
  "started",
] as const;

describe("sortSyncedSessions decorate-sort-undecorate parity", () => {
  it("returns the incoming order untouched when sortBy is unset", () => {
    const sessions = [
      session({ externalSessionId: "a" }),
      session({ externalSessionId: "b" }),
      session({ externalSessionId: "c" }),
    ];

    const sorted = sortSyncedSessions(sessions, query({ sortBy: null }));

    assert.deepEqual(ids(sorted), ["a", "b", "c"]);
    // Unset sortBy short-circuits: the SAME array reference is returned.
    assert.equal(sorted, sessions);
  });

  it("matches the reference comparator for every sort column, both directions", () => {
    const sessions = mixedSessions();

    for (const sortBy of SORT_KEYS) {
      for (const sortDir of ["asc", "desc"] as const) {
        const actual = ids(
          sortSyncedSessions(sessions, query({ sortBy, sortDir }))
        );
        const expected = ids(referenceSort(sessions, sortBy, sortDir));
        assert.deepEqual(
          actual,
          expected,
          `order diverged for sortBy=${sortBy} sortDir=${sortDir}`
        );
      }
    }
  });

  it("preserves incoming order for tied keys (stable sort tiebreak)", () => {
    // Every row shares the same harness → all keys tie → the stable sort must
    // keep the incoming order, exactly like the old comparator returning 0.
    const sessions = [
      session({ externalSessionId: "first", harness: "claude" }),
      session({ externalSessionId: "second", harness: "claude" }),
      session({ externalSessionId: "third", harness: "claude" }),
    ];

    assert.deepEqual(
      ids(sortSyncedSessions(sessions, query({ sortBy: "harness" }))),
      ["first", "second", "third"]
    );
    assert.deepEqual(
      ids(
        sortSyncedSessions(
          sessions,
          query({ sortBy: "harness", sortDir: "desc" })
        )
      ),
      ["first", "second", "third"]
    );
  });

  it("orders cost by summed per-model estimated cost", () => {
    const sessions = [
      session({
        externalSessionId: "cheap",
        tokenUsageByModel: [usage({ estimatedCostUsd: 0.5 })],
      }),
      session({
        externalSessionId: "expensive",
        tokenUsageByModel: [
          usage({ estimatedCostUsd: 10 }),
          usage({ estimatedCostUsd: 5 }),
        ],
      }),
      session({
        externalSessionId: "mid",
        tokenUsageByModel: [usage({ estimatedCostUsd: 2 })],
      }),
    ];

    assert.deepEqual(
      ids(
        sortSyncedSessions(sessions, query({ sortBy: "cost", sortDir: "asc" }))
      ),
      ["cheap", "mid", "expensive"]
    );
  });

  it("orders lastActivity by activity timestamp, falling back to startedAt", () => {
    const sessions = [
      session({
        externalSessionId: "no-activity-old-start",
        startedAt: "2026-01-01T00:00:00.000Z",
        lastActivityAt: null,
      }),
      session({
        externalSessionId: "recent-activity",
        startedAt: "2026-01-01T00:00:00.000Z",
        lastActivityAt: "2026-03-01T00:00:00.000Z",
      }),
      session({
        externalSessionId: "mid-activity",
        startedAt: "2026-01-01T00:00:00.000Z",
        lastActivityAt: "2026-02-01T00:00:00.000Z",
      }),
    ];

    assert.deepEqual(
      ids(
        sortSyncedSessions(
          sessions,
          query({ sortBy: "lastActivity", sortDir: "asc" })
        )
      ),
      ["no-activity-old-start", "mid-activity", "recent-activity"]
    );
  });

  it("ISS-5131: keys the eventless-ended row on its own endedAt, closing the ISS-4989 divergence", () => {
    // The divergent row class flagged in review: raw `lastActivityAt` null with
    // a sweeper-set `endedAt`. The comparator keyed it at `endedAt - startedAt`
    // while its Duration CELL rendered "0s" (the served projection coalesced the
    // null `lastActivityAt` to `startedAt`), so on a DESC duration sort it could
    // sit above shorter real spans the reader could see.
    //
    // ISS-5131 closes it: the cell and the comparator now read the SAME two
    // inputs (status + `endedAt`), so this row both RENDERS and SORTS as 5h.
    const sessions = [
      session({
        externalSessionId: "ended-10h",
        startedAt: "2026-01-01T00:00:00.000Z",
        lastActivityAt: "2026-01-01T10:00:00.000Z",
        endedAt: "2026-01-01T10:00:00.000Z",
      }),
      session({
        externalSessionId: "eventless-ended-5h",
        startedAt: "2026-01-01T00:00:00.000Z",
        lastActivityAt: null,
        endedAt: "2026-01-01T05:00:00.000Z",
      }),
      session({
        externalSessionId: "ended-1h",
        startedAt: "2026-01-01T00:00:00.000Z",
        lastActivityAt: "2026-01-01T01:00:00.000Z",
        endedAt: "2026-01-01T01:00:00.000Z",
      }),
    ];

    assert.deepEqual(
      ids(
        sortSyncedSessions(
          sessions,
          query({ sortBy: "duration", sortDir: "desc" })
        )
      ),
      ["ended-10h", "eventless-ended-5h", "ended-1h"]
    );
  });

  it("ISS-5131: floats a terminal row with no end instant to the end in BOTH directions", () => {
    // Its Duration cell renders blank, so it must never interleave with the rows
    // that show a number.
    const sessions = [
      session({
        externalSessionId: "ended-5h",
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: "2026-01-01T05:00:00.000Z",
      }),
      session({
        externalSessionId: "no-end-instant",
        startedAt: "2026-01-01T00:00:00.000Z",
        lastActivityAt: null,
        endedAt: null,
      }),
      session({
        externalSessionId: "ended-1h",
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: "2026-01-01T01:00:00.000Z",
      }),
    ];

    assert.deepEqual(
      ids(
        sortSyncedSessions(
          sessions,
          query({ sortBy: "duration", sortDir: "desc" })
        )
      ),
      ["ended-5h", "ended-1h", "no-end-instant"]
    );
    assert.deepEqual(
      ids(
        sortSyncedSessions(
          sessions,
          query({ sortBy: "duration", sortDir: "asc" })
        )
      ),
      ["ended-1h", "ended-5h", "no-end-instant"]
    );
  });

  it("keeps a null-owner user sort as a stable no-op (all unresolved)", () => {
    // With no org directory warmed every owner resolves to null → every pair
    // ties → incoming order is preserved (the cloud cold-directory contract).
    const sessions = [
      session({ externalSessionId: "s-peter", userId: "user-peter" }),
      session({ externalSessionId: "s-alex", userId: "user-alex" }),
      session({ externalSessionId: "s-zara", userId: "user-zara" }),
    ];

    assert.deepEqual(
      ids(
        sortSyncedSessions(sessions, query({ sortBy: "user", sortDir: "asc" }))
      ),
      ["s-peter", "s-alex", "s-zara"]
    );
  });

  it("orders identically to the reference comparator at working-set scale", () => {
    // A structural (not timing) guard: build many rows with pseudo-random but
    // deterministic cost keys and confirm the decorate-sort output equals a
    // fresh per-comparison reference sort. A miscomputed or unstable key would
    // reorder rows here.
    const sessions = Array.from({ length: 1000 }, (_, index) =>
      session({
        externalSessionId: `s-${String(index).padStart(4, "0")}`,
        tokenUsageByModel: [usage({ estimatedCostUsd: (index * 7) % 13 })],
      })
    );

    for (const sortDir of ["asc", "desc"] as const) {
      assert.deepEqual(
        ids(sortSyncedSessions(sessions, query({ sortBy: "cost", sortDir }))),
        ids(referenceSort(sessions, "cost", sortDir))
      );
    }
  });
});

/**
 * Reference implementation of the PRE-FEA-4426 comparator: derive each row's key
 * from scratch on both operands of every comparison. `sortSyncedSessions` must
 * produce the identical order.
 */
function referenceSort(
  sessions: SyncedAgentSession[],
  sortBy: string,
  sortDir: "asc" | "desc"
): SyncedAgentSession[] {
  const factor = sortDir === "asc" ? 1 : -1;
  return [...sessions].sort((a, b) => {
    // FEA-4299/FEA-4330 (merged): the `repo` column keeps the "Unknown" (null
    // `repositoryFullName`) rows LAST in BOTH directions, so it owns its own
    // direction via `compareNullsLast` rather than the uniform `* factor` flip.
    if (sortBy === "repo") {
      return compareNullsLast(repoName(a), repoName(b), sortDir);
    }
    // ISS-5131: `duration` joined the nulls-last columns — a row whose Duration
    // cell renders blank collects with the other blanks in both directions
    // rather than ranking as a 0 among the real minima.
    if (sortBy === "duration") {
      return compareNumericNullsLast(
        referenceDuration(a),
        referenceDuration(b),
        sortDir
      );
    }
    // ISS-5592: `status` owns its own direction too — unknown-last in BOTH
    // directions, so it cannot ride the uniform `* factor` flip.
    if (sortBy === "status") {
      return referenceCompareStatus(a, b, sortDir);
    }
    return referenceCompare(a, b, sortBy) * factor;
  });
}

function referenceCompare(
  a: SyncedAgentSession,
  b: SyncedAgentSession,
  sortBy: string
): number {
  switch (sortBy) {
    // NOTE: "status", "repo" and "duration" are handled by referenceSort
    // directly (each owns its own direction) — none reaches this
    // ascending-then-flip path.
    case "harness":
      return (a.harness ?? "").localeCompare(b.harness ?? "");
    case "model":
      return (a.model ?? "").localeCompare(b.model ?? "");
    case "cost":
      return referenceCost(a) - referenceCost(b);
    // NOTE: "duration" is handled by referenceSort directly (nulls-last, both
    // directions) — it never reaches this ascending-then-flip path.
    case "lastActivity":
      return (
        timestamp(a.lastActivityAt ?? a.startedAt) -
        timestamp(b.lastActivityAt ?? b.startedAt)
      );
    default:
      return timestamp(a.startedAt) - timestamp(b.startedAt);
  }
}

function referenceCost(session: SyncedAgentSession): number {
  return session.tokenUsageByModel.reduce(
    (total, model) => total + (model.estimatedCostUsd ?? 0),
    0
  );
}

function referenceDuration(session: SyncedAgentSession): number | null {
  // ISS-5131: the displayed span is the session's own wall time — `now - start`
  // while running, `end - start` once terminal — and NO measurement at all for a
  // session with no end instant that is not known to be running, which the cell
  // renders blank.
  //
  // ISS-6270: "known to be running" is decided from the DISPLAYED status, not
  // the raw column. This used to hand-list the terminal spellings, which made
  // the reference blind to the one dimension the production key had just been
  // taught: `bravo` is `running` with no activity since January, so it DISPLAYS
  // as Stale and renders a blank Duration cell, while both this reference and
  // the production comparator measured it against `now` and ranked a seven-month
  // phantom span first on a Duration-descending page. Deriving through the same
  // shared resolver the row does is the posture `referenceCompareStatus` already
  // took for the Status column (#5075): a second IMPLEMENTATION of one rule, not
  // a second RULE.
  const running =
    resolveSessionDurationLifecycle(
      resolveDisplayedSharedSessionStatus(session)
    ) === SessionDurationLifecycle.Running;
  const endMs = session.endedAt ? timestamp(session.endedAt) : null;
  const end = running ? Date.now() : endMs;
  if (end === null) {
    return null;
  }
  const span = end - timestamp(session.startedAt);
  return span > 0 ? span : null;
}

function timestamp(value: string): number {
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * The status column's reference order, derived from scratch on BOTH operands the
 * way the pre-FEA-4426 comparator did — which for this column means recomputing
 * the DISPLAYED rank, not alphabetizing.
 *
 * It used to alphabetize `canonicalStatus`. That agreed with production only by
 * coincidence: `active` < `completed` < `failed` reads the same alphabetically
 * as by rank. ISS-5592 unranked `completed`, the coincidence broke, and the
 * "reference" turned out to be a different ALGORITHM rather than a second
 * implementation of the same one — so it could never have caught a real rank
 * regression either (#5075).
 */
function referenceCompareStatus(
  a: SyncedAgentSession,
  b: SyncedAgentSession,
  sortDir: "asc" | "desc"
): number {
  const displayedA = projectDisplayedSharedStatus(a);
  const displayedB = projectDisplayedSharedStatus(b);
  const knownA = isKnownSharedStatus(displayedA);
  const knownB = isKnownSharedStatus(displayedB);
  if (knownA !== knownB) {
    return knownA ? -1 : 1;
  }
  const delta =
    displayedSharedStatusRank(displayedA) -
    displayedSharedStatusRank(displayedB);
  return sortDir === "asc" ? delta : -delta;
}

// FEA-4299 (merged): repo identity is the resolved Git remote `repositoryFullName`
// or `null` when none has resolved — NO `worktreePath`/`cwd` fallback, matching
// `sessionRepositoryName` and the "Unknown" the Repository column renders.
function repoName(session: SyncedAgentSession): string | null {
  return session.attribution?.repositoryFullName ?? null;
}

// FEA-4330 (merged): NULL sorts LAST in both directions; present values follow
// `dir`. Mirrors the production `compareNullsLast` the `repo` sort routes through.
function compareNullsLast(
  a: string | null,
  b: string | null,
  dir: "asc" | "desc"
): number {
  if (a === null && b === null) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  const cmp = a.localeCompare(b);
  return dir === "asc" ? cmp : -cmp;
}

/**
 * ISS-5131: the numeric twin, for the Duration column — an unmeasurable span is
 * `null` and stays LAST in both directions, exactly like a null owner or repo.
 */
function compareNumericNullsLast(
  a: number | null,
  b: number | null,
  dir: "asc" | "desc"
): number {
  if (a === null && b === null) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  return dir === "asc" ? a - b : b - a;
}

function mixedSessions(): SyncedAgentSession[] {
  return [
    session({
      externalSessionId: "alpha",
      status: "completed",
      harness: "claude",
      model: "opus",
      cwd: "/repo/zeta",
      // FEA-4299: a resolved remote drives the repo sort; the `cwd` is ignored.
      attribution: { repositoryFullName: "closedloop-ai/symphony-alpha" },
      startedAt: "2026-01-05T00:00:00.000Z",
      lastActivityAt: "2026-01-06T00:00:00.000Z",
      endedAt: "2026-01-05T01:00:00.000Z",
      tokenUsageByModel: [usage({ estimatedCostUsd: 3 })],
    }),
    session({
      externalSessionId: "bravo",
      status: "running",
      harness: "codex",
      model: "sonnet",
      cwd: "/repo/alpha",
      // FEA-4299: no resolved remote → repo identity is null ("Unknown"), which
      // sorts LAST in both directions even though its `cwd` would sort first.
      startedAt: "2026-01-02T00:00:00.000Z",
      lastActivityAt: null,
      endedAt: null,
      tokenUsageByModel: [usage({ estimatedCostUsd: 12 })],
    }),
    session({
      externalSessionId: "charlie",
      status: "error",
      harness: "claude",
      model: "haiku",
      cwd: "/repo/mid",
      attribution: { repositoryFullName: "closedloop-ai/cl-tofu-aws-live" },
      startedAt: "2026-01-10T00:00:00.000Z",
      lastActivityAt: "2026-01-11T00:00:00.000Z",
      endedAt: "2026-01-10T03:00:00.000Z",
      tokenUsageByModel: [usage({ estimatedCostUsd: 0.25 })],
    }),
    session({
      externalSessionId: "delta",
      status: "completed",
      harness: "amp",
      model: "opus",
      cwd: "/repo/beta",
      attribution: { repositoryFullName: "acme/web" },
      startedAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-01T00:30:00.000Z",
      endedAt: "2026-01-01T00:10:00.000Z",
      tokenUsageByModel: [],
    }),
  ];
}

function session(
  overrides: Partial<SyncedAgentSession> & { externalSessionId: string }
): SyncedAgentSession {
  return {
    status: "completed",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    agents: [],
    events: [],
    tokenUsageByModel: [],
    ...overrides,
  };
}

function usage(
  overrides: Partial<SyncedAgentSessionTokenUsage>
): SyncedAgentSessionTokenUsage {
  return {
    model: "opus",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...overrides,
  };
}

function query(overrides: Partial<SanitizedQuery>): SanitizedQuery {
  return {
    startDate: null,
    endDate: null,
    dateWindowField: SESSIONS_SURFACE_DATE_WINDOW_FIELD,
    completedAfter: null,
    harness: null,
    status: null,
    statuses: [],
    userId: null,
    userIds: [],
    repositories: [],
    harnesses: [],
    models: [],
    autonomyTiers: [],
    costBuckets: [],
    changePresence: [],
    prAssociation: [],
    quality: "all",
    search: null,
    countOnly: false,
    limit: 50,
    offset: 0,
    sortBy: null,
    sortDir: "desc",
    hasUnsupportedCloudFilter: false,
    ...overrides,
  };
}

function ids(sessions: SyncedAgentSession[]): string[] {
  return sessions.map((session) => session.externalSessionId);
}
