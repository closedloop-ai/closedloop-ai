import { STALE_SESSION_DISPLAY_THRESHOLD_HOURS } from "@repo/api/src/types/session-status";
import type { SessionAttributionResolverCache } from "../src/main/agent-sync/agent-session-attribution.js";
import type {
  AgentSessionUsageAggregate,
  RepositoryScopedSessionIdsOptions,
  SessionCursorRow,
  SessionListCursorPageRequest,
} from "../src/main/agent-sync/agent-session-read-model.js";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import type {
  AgentSessionSyncSource,
  SyncedSessionLoadOptions,
} from "../src/main/agent-sync/agent-session-sync-source.js";
import { isDisplayedStatusParityEnabled } from "../src/main/session/displayed-status-parity-gate.js";
import { matchesStatusFilter as matchesSharedStatusFilter } from "../src/main/session/session-status-filter-match.js";
import type { BillingMode } from "../src/shared/billing-mode.js";

/**
 * Shared canned-session fixtures + fake `AgentSessionSyncSource` for the
 * shared-agent-sessions serving-op tests. Extracted from
 * `shared-agent-sessions-api.test.ts` (ISS-4667) so focused siblings — such as
 * `shared-agent-sessions-loc-per-dollar.test.ts` — can reuse the exact same
 * fixture wiring without duplicating it, and so the grandfathered
 * `shared-agent-sessions-api.test.ts` shrinks. Pure fixtures only; no test state.
 */

export type SourceCall = {
  kind:
    | "listAllSessionCursorRows"
    | "listRepositoryScopedSessionIds"
    | "listSessionCursorPage"
    | "loadSyncedSessions"
    | "loadPendingOutboxIds"
    | "aggregateUsage"
    | "aggregateAnalytics"
    | "countSessions";
  ids?: string[];
  repositories?: string[];
  /** ISS-4558: the window/sort pushed into the repository-scoped id read. */
  repositoryScope?: RepositoryScopedSessionIdsOptions;
  cache?: SessionAttributionResolverCache;
  loadOptions?: SyncedSessionLoadOptions;
  cursorPageRequest?: SessionListCursorPageRequest;
  aggregateFilters?: unknown;
  countFilters?: unknown;
  sourceKey?: string;
};

export function createFakeSource(
  options: {
    cursorRows?: SessionCursorRow[];
    sessions?: Record<string, SyncedAgentSession>;
    loadOrder?: string[];
    rejectListAll?: Error;
    rejectLoad?: Error;
    aggregateUsage?: AgentSessionSyncSource["aggregateUsage"];
    aggregateAnalytics?: AgentSessionSyncSource["aggregateAnalytics"];
    // FEA-4142: when provided, the fake exposes a `countSessions` delegate so
    // the count-only badge read can be exercised without a hydrate. Omitted → no
    // delegate, so a count-only request falls through to the hydrated path.
    countSessions?: (filters: unknown) => number;
    // PRD-536 E6: the still-`pending` outbox ids this source returns. When
    // provided, the fake exposes a `loadPendingOutboxIds` delegate (matching a
    // real, outbox-capable source) so the list projection can stamp each row's
    // `cloudSyncState`. Omitted → no delegate (a fake/legacy source), so every
    // row projects `synced`.
    pendingOutboxIds?: string[];
    rejectLoadPendingOutboxIds?: Error;
  } = {}
): AgentSessionSyncSource & { calls: SourceCall[] } {
  const sessions = options.sessions ?? defaultSessions();
  const calls: SourceCall[] = [];
  // Captured once so the recording wrappers below call the SAME delegate the
  // `? :` already proved present. Reading `options.aggregateUsage` again inside
  // the closure re-widens it to `| undefined` and forces a fallback branch that
  // can never run — and that unreachable fallback is what silently drifted out
  // of `AgentSessionUsageAggregate` (it never grew `userSessionCounts` /
  // `repoSessionCounts`).
  const aggregateUsage = options.aggregateUsage;
  const aggregateAnalytics = options.aggregateAnalytics;

  return {
    calls,
    ...(options.pendingOutboxIds || options.rejectLoadPendingOutboxIds
      ? {
          loadPendingOutboxIds(sourceKey: string) {
            calls.push({ kind: "loadPendingOutboxIds", sourceKey });
            if (options.rejectLoadPendingOutboxIds) {
              throw options.rejectLoadPendingOutboxIds;
            }
            return options.pendingOutboxIds ?? [];
          },
        }
      : {}),
    ...(options.countSessions
      ? {
          countSessions(filters: unknown) {
            calls.push({ kind: "countSessions", countFilters: filters });
            return options.countSessions?.(filters) ?? 0;
          },
        }
      : {}),
    listAllSessionCursorRows() {
      if (options.rejectListAll) {
        throw options.rejectListAll;
      }
      calls.push({ kind: "listAllSessionCursorRows" });
      return (
        options.cursorRows ?? Object.keys(sessions).map((id) => cursor(id))
      );
    },
    listRepositoryScopedSessionIds(repositories, cache, scope) {
      // ISS-4535: model the real source — resolve each session's repository
      // identity PRE-hydration and return the matches newest-first (cursor
      // order). The fake resolves it from the SAME persisted-aware identity the
      // hydrate path produces (`attribution.repositoryFullName`, which the real
      // `resolveSyncAttributions` fills from the stored `repo_full_name` for a
      // deleted worktree), so a deleted-worktree repo resolves on both sides.
      //
      // ISS-4558: it must also HONOR the date window / sort it is handed, for
      // the same reason the real source does — the paging branch runs no
      // in-memory matcher, so a fake that quietly ignored the window would make
      // any production-shape regression test pass without the window ever being
      // applied. Its ordering model mirrors the real
      // `sessionDateWindowTsExpr`: `updated_at` IS the activity basis here, so a
      // last-activity sort is the cursor order the rows already carry, and only
      // `sortDir` can reorder them.
      calls.push({
        kind: "listRepositoryScopedSessionIds",
        repositories: [...repositories],
        cache,
        ...(scope ? { repositoryScope: { ...scope } } : {}),
      });
      const selected = new Set(repositories);
      const rows =
        options.cursorRows ?? Object.keys(sessions).map((id) => cursor(id));
      const windowed = filterCursorRowsForPageRequest(rows, sessions, {
        ...(scope?.startDate ? { startDate: scope.startDate } : {}),
        ...(scope?.endDate ? { endDate: scope.endDate } : {}),
      });
      const ordered =
        scope?.sortDir === "asc" ? [...windowed].reverse() : windowed;
      return ordered.flatMap((row) => {
        const loaded = sessions[row.id];
        const repositoryFullName =
          loaded?.attribution?.repositoryFullName ?? null;
        return repositoryFullName !== null && selected.has(repositoryFullName)
          ? [row.id]
          : [];
      });
    },
    listSessionCursorPage(request) {
      calls.push({
        kind: "listSessionCursorPage",
        cursorPageRequest: { ...request },
      });
      const rows =
        options.cursorRows ?? Object.keys(sessions).map((id) => cursor(id));
      const filteredRows = filterCursorRowsForPageRequest(
        rows,
        sessions,
        request
      );
      return {
        rows: filteredRows.slice(
          request.offset,
          request.offset + request.limit
        ),
        total: filteredRows.length,
      };
    },
    listUpdatedSessionCursorRows() {
      return [];
    },
    loadSyncedSessions(ids, cache, loadOptions) {
      if (options.rejectLoad) {
        throw options.rejectLoad;
      }
      calls.push({
        kind: "loadSyncedSessions",
        ids: [...ids],
        cache,
        ...(loadOptions ? { loadOptions: { ...loadOptions } } : {}),
      });
      const loadIds = options.loadOrder ?? ids;
      return loadIds.flatMap((id) => {
        const loaded = sessions[id];
        return loaded ? [loaded] : [];
      });
    },
    aggregateUsage: aggregateUsage
      ? (filters) => {
          calls.push({ kind: "aggregateUsage", aggregateFilters: filters });
          return aggregateUsage(filters);
        }
      : undefined,
    aggregateAnalytics: aggregateAnalytics
      ? (filters, cache) => {
          calls.push({ kind: "aggregateAnalytics", aggregateFilters: filters });
          return aggregateAnalytics(filters, cache);
        }
      : undefined,
  };
}

function filterCursorRowsForPageRequest(
  rows: SessionCursorRow[],
  sessions: Record<string, SyncedAgentSession>,
  // ISS-4558: only the window/search fields are read, so the repository-scoped
  // resolution (which has no limit/offset/sort of its own to declare) can reuse
  // this exact filter rather than restating the window comparison.
  request: Pick<
    SessionListCursorPageRequest,
    "startDate" | "endDate" | "search" | "statuses"
  >
): SessionCursorRow[] {
  return rows.filter((row) => {
    const loaded = sessions[row.id];
    if (!loaded) {
      return !(
        request.startDate ||
        request.endDate ||
        request.search ||
        (request.statuses && request.statuses.length > 0)
      );
    }
    const activityAt = sessionDateMs(row.updated_at);
    if (request.startDate && activityAt < request.startDate.getTime()) {
      return false;
    }
    if (request.endDate && activityAt > request.endDate.getTime()) {
      return false;
    }
    if (request.search && !fakeMatchesCursorSearch(loaded, request.search)) {
      return false;
    }
    // Goal stage 1: the Status facet now rides the cursor page, so the fake
    // honors it with the SAME shared matcher the hydrated fold applies —
    // the port contract requires an implementation to partition exactly as
    // `matchesStatusFilter` does (the sqlite source renders it via
    // `buildUsageStatusPredicate`).
    if (
      request.statuses &&
      request.statuses.length > 0 &&
      !request.statuses.some((status) =>
        matchesSharedStatusFilter(
          loaded,
          status,
          isDisplayedStatusParityEnabled()
        )
      )
    ) {
      return false;
    }
    return true;
  });
}

function fakeMatchesCursorSearch(
  session: SyncedAgentSession,
  search: string
): boolean {
  const needle = search.toLowerCase();
  return [
    session.name,
    session.externalSessionId,
    session.harness,
    session.cwd,
    session.branch,
    session.attribution?.repositoryFullName,
    session.attribution?.baseBranch,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

function sessionDateMs(value: string): number {
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

export function defaultSessions(): Record<string, SyncedAgentSession> {
  return {
    "session-a": session({
      id: "session-a",
      harness: "claude",
      billingMode: "api",
      repositoryFullName: "closedloop-ai/symphony-alpha",
      status: "completed",
    }),
    "session-b": session({
      id: "session-b",
      harness: "codex",
      billingMode: "subscription_unknown",
      worktreePath: "worktree-b",
      status: "running",
    }),
    "session-c": session({
      id: "session-c",
      harness: "opencode",
      billingMode: "unknown",
      cwd: "/tmp/session-c",
      status: "completed",
    }),
  };
}

export type SessionFixtureOptions = {
  id: string;
  status?: string;
  harness?: string;
  billingMode?: BillingMode;
  repositoryFullName?: string | null;
  worktreePath?: string | null;
  cwd?: string | null;
  startedAt?: string;
  updatedAt?: string;
  /**
   * ISS-5366: the staleness ANCHOR (`lastActivityAt ?? startedAt`). Left unset
   * these fixtures anchor on the fixed 2026-01-01 `startedAt`, which is silent
   * far past the display cutoff — so a fixture meant to be genuinely ACTIVE has
   * to say when it was last active, or the Active facet correctly drops it as
   * Stale. See {@link recentActivityAt}.
   */
  lastActivityAt?: string;
  awaitingInputSince?: string | null;
  endedAt?: string | null;
  branch?: string | null;
  attribution?: SyncedAgentSession["attribution"];
  metadata?: SyncedAgentSession["metadata"];
  events?: SyncedAgentSession["events"];
  userId?: string | null;
  throttleSources?: SyncedAgentSession["throttleSources"];
  activitySegmentRows?: SyncedAgentSession["activitySegmentRows"];
  tokenEvents?: SyncedAgentSession["tokenEvents"];
};

/**
 * ISS-5366: an activity instant inside the display staleness window, expressed
 * RELATIVE to now.
 *
 * Active is no longer a property of the stored status alone — a row silent past
 * `STALE_SESSION_DISPLAY_THRESHOLD_HOURS` displays (and now filters) as Stale.
 * A fixture asserting Active must therefore carry recent activity, and a
 * hard-coded literal would only be recent until the clock passed it, turning
 * every Active assertion red on a date nobody chose. One minute ago is inside
 * the window by three orders of magnitude, so no plausible suite runtime can
 * age it out mid-run.
 */
export function recentActivityAt(): string {
  return new Date(Date.now() - 60_000).toISOString();
}

/**
 * ISS-4556: the mirror of {@link recentActivityAt} — an activity instant OUTSIDE
 * the display staleness window, also expressed relative to now.
 *
 * Derived from the shared `STALE_SESSION_DISPLAY_THRESHOLD_HOURS` rather than a
 * literal so a change to the cutoff cannot leave these fixtures on the wrong side
 * of it. One hour past the boundary is far enough that no suite runtime can drift
 * the row back inside the window mid-run.
 */
export function staleActivityAt(): string {
  return new Date(
    Date.now() - (STALE_SESSION_DISPLAY_THRESHOLD_HOURS + 1) * 60 * 60 * 1000
  ).toISOString();
}

export function session(options: SessionFixtureOptions): SyncedAgentSession {
  return {
    externalSessionId: options.id,
    name: `Session ${options.id}`,
    status: options.status ?? "completed",
    harness: options.harness ?? "claude",
    billingMode: options.billingMode ?? "api",
    cwd: options.cwd ?? `/tmp/${options.id}`,
    model: "gpt-test",
    startedAt: options.startedAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: options.updatedAt ?? "2026-01-01T01:00:00.000Z",
    endedAt:
      "endedAt" in options ? options.endedAt : "2026-01-01T02:00:00.000Z",
    awaitingInputSince:
      "awaitingInputSince" in options
        ? options.awaitingInputSince
        : "2026-01-01T01:30:00.000Z",
    metadata: options.metadata ?? { kind: "fixture" },
    ...sessionOptionalFields(options),
    attribution: options.attribution ?? {
      repositoryFullName: options.repositoryFullName ?? null,
      worktreePath: options.worktreePath ?? null,
      sourceArtifactId: null,
      sourceLoopId: null,
      baseBranch: null,
    },
    agents: sessionAgents(options.id),
    events: options.events ?? sessionEvents(options.id),
    tokenUsageByModel: [
      {
        model: "gpt-test",
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
        estimatedCostUsd:
          options.billingMode === "subscription_unknown" ? 0.5 : 0.25,
      },
    ],
  };
}

/**
 * The fixture fields that must stay OMITTED (not `undefined`) when the caller
 * did not ask for them, so a fixture matches the real optional-field payload.
 */
function sessionOptionalFields(
  options: SessionFixtureOptions
): Partial<SyncedAgentSession> {
  return {
    ...(options.branch ? { branch: options.branch } : {}),
    ...(options.lastActivityAt
      ? { lastActivityAt: options.lastActivityAt }
      : {}),
    ...(options.userId ? { userId: options.userId } : {}),
    ...(options.throttleSources
      ? { throttleSources: options.throttleSources }
      : {}),
    ...(options.activitySegmentRows
      ? { activitySegmentRows: options.activitySegmentRows }
      : {}),
    ...(options.tokenEvents ? { tokenEvents: options.tokenEvents } : {}),
  };
}

/** The canned main + failed-reviewer agent pair every fixture session carries. */
function sessionAgents(id: string): SyncedAgentSession["agents"] {
  return [
    {
      externalAgentId: `${id}-main`,
      name: "Main",
      type: "main",
      status: "completed",
      task: "private task",
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T01:00:00.000Z",
      endedAt: "2026-01-01T02:00:00.000Z",
    },
    {
      externalAgentId: `${id}-reviewer`,
      name: "Reviewer",
      type: "subagent",
      subagentType: "reviewer",
      status: "failed",
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T01:00:00.000Z",
      endedAt: "2026-01-01T01:30:00.000Z",
    },
  ];
}

/**
 * The canned event pair: one `tool_use` whose `data` carries secret-ish fields
 * (so redaction coverage has something to strip) and one agent error.
 */
function sessionEvents(id: string): SyncedAgentSession["events"] {
  return [
    {
      externalEventId: `${id}-tool`,
      eventType: "tool_use",
      toolName: "Bash",
      summary: null,
      data: {
        filePath: "src/visible.ts",
        command: "cat secret.txt",
        stdout: "secret",
        stderr: "secret",
        nested: { visible: "yes", content: "secret" },
      },
      createdAt: "2026-01-01T00:05:00.000Z",
    },
    {
      externalEventId: `${id}-error`,
      agentExternalId: `${id}-reviewer`,
      eventType: "agent_error",
      createdAt: "2026-01-01T00:06:00.000Z",
    },
  ];
}

export function cursor(id: string, updatedAt = "2026-01-01T00:00:00.000Z") {
  return { id, updated_at: updatedAt };
}

/**
 * A COMPLETE `AgentSessionUsageAggregate` whose facets default to empty, for
 * suites that pin one facet of the SQL usage rollup.
 *
 * `AgentSessionUsageAggregate` is a required-field contract, so hand-rolling a
 * partial object literal per test made every facet added to it (Owner's
 * `userSessionCounts`, Repository's `repoSessionCounts`) a multi-site fixture
 * edit — and, while these suites sat outside typecheck, a silent one. Overriding
 * a single key here means the next required facet is one edit in one place, and
 * a fixture that no longer matches the aggregate fails at this signature.
 */
export function usageAggregate(
  overrides: Partial<AgentSessionUsageAggregate> = {}
): AgentSessionUsageAggregate {
  return {
    totalSessions: 0,
    earliestSessionAt: null,
    latestSessionAt: null,
    tokenGroups: [],
    harnessSessionCounts: [],
    userSessionCounts: [],
    repoSessionCounts: [],
    ...overrides,
  };
}
