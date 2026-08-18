/**
 * The `AgentSessionSyncSource` port — the read/write surface the desktop sync
 * lane needs from the local store — plus the durable cursor/outbox contract that
 * travels with it (source keys, persisted watermark state, outbox rows) and the
 * component-inventory payload shape.
 *
 * This is the boundary between the sync service and whatever backs it (live
 * SQLite in production, a fake in tests). Extracted verbatim from
 * `agent-session-sync-service.ts` (ISS-4676).
 */
import type {
  AgentSessionSyncMode,
  SyncedComponent,
  TokenEventCostPoint,
} from "@repo/api/src/types/agent-session";
import type { SyncedArtifactRef } from "@repo/api/src/types/session-artifact-link";
import type { BranchKeyRow } from "../database/branch-reads.js";
import type {
  SyncBurndownQuery,
  SyncBurndownStoreSample,
} from "../database/sync-burndown-store.js";
import type { AgentComponentInvocationSyncSource } from "./agent-component-invocation-sync-service.js";
import type { SessionAttributionResolverCache } from "./agent-session-attribution.js";
import type {
  AgentSessionAnalyticsAggregate,
  AgentSessionCountFilters,
  AgentSessionUsageAggregate,
  AgentSessionUsageAggregateFilters,
  RepositoryScopedSessionIdsOptions,
  SessionCursorRow,
  SessionListCursorPage,
  SessionListCursorPageRequest,
} from "./agent-session-read-model.js";
import type {
  AgentSessionSyncClass,
  SyncedAgentSession,
} from "./agent-session-sync-contract.js";

// FEA-1962: the sync kind prefix for a cursor source key. Centralized so the
// service, the sqlite helpers, and tests never re-spell the literal.
export const AGENT_SESSION_SYNC_SOURCE_KIND = "agent_sessions" as const;

/**
 * ISS-6060: payload revision for the session lane's durable cursor, appended to
 * the source key only once a server advertises the monitored-activity carrier.
 *
 * BUMP THIS when a change alters what an ALREADY-IMPORTED session sends ON THIS
 * CARRIER. The keyset cursor walks `sessions.updated_at`, and re-deriving a
 * payload does not touch that column — so an install that already drained the
 * previous revision resumes past every affected row and the change ships dark on
 * precisely the long-lived installs it exists for (the trap
 * `AGENT_COMPONENT_SYNC_PAYLOAD_REVISION` below documents, wongk #4295).
 *
 * `monitored_activity_v2` is ISS-6479 (wongk, #5106). Re-tiering `url_in_message`
 * refs below commits changes which refs survive `boundNonCommitArtifactRefs` for
 * a link-heavy session, but rewrites no session row — so a URL-heavy session
 * acked under v1 would keep the dropped commit refs, and the branch/PR LOC
 * attribution reading their `linesAdded`/`linesRemoved`/`filesChanged`, missing
 * forever. Changing the key makes `hydratePersistedCursorIfNeeded` find no
 * persisted state and replay retained SQLite evidence once; the lane's upserts
 * are idempotent on their identities, so a replay re-sends rather than duplicates.
 *
 * This lever, NOT `AGENT_SESSION_SYNC_INTEGRITY_VERSION`, is the one a
 * carrier-scoped change bumps: those refs reach the wire only through
 * `monitoredActivityOnlyRefsFromMetadata` under `includeMonitoredSessionActivity`
 * — the same capability that selects this key — so no legacy-key cursor can hold
 * the stranded data, while the integrity stamp matches every `agent_sessions:`
 * key and would re-walk those installs' whole corpus for nothing.
 */
export const AGENT_SESSION_MONITORED_ACTIVITY_PAYLOAD_REVISION =
  "monitored_activity_v2" as const;

// T-8.7: the sync kind prefix for the component inventory sync lane.
export const AGENT_COMPONENT_SYNC_SOURCE_KIND = "agent_components" as const;

/**
 * FEA-1962: the persisted durable cursor for one source key. `observedTopUpdatedAt`
 * is the highest CONTIGUOUS-ACCEPTED watermark (never a discovery-only candidate);
 * `observedIdsAtTopUpdatedAt` are the accepted ids sharing that timestamp so
 * same-timestamp siblings sent later are still selected on restart.
 *
 * `deadLetteredIds` records the sessions intentionally abandoned this run
 * (locally oversize / validation_failed / exhausted-retry). Persisting them lets
 * the watermark advance PAST them: every NON-dead row up to the watermark was
 * acked before persist (both queues empty), so recording the dead ids as
 * "known but abandoned" skips nothing un-uploaded — it only stops the full
 * re-walk that a blocked cursor forced on every restart. On resume they are set
 * aside (not re-queued into normal backfill) and revisited last. Absent/legacy
 * rows load as `[]`.
 */
export type PersistedSyncState = {
  observedTopUpdatedAt: string | null;
  observedIdsAtTopUpdatedAt: string[];
  deadLetteredIds: string[];
};

// FEA-3473 (PRD-536): this lane's durable outbox status USED to be declared here
// as a private two-member const. PLN-1562 replaced it with the shared
// `OutboxStatus` in `shared/sync-lane-contract.ts` — the invocation parts lane had
// an identical private copy, and one vocabulary cannot drift lane-to-lane.
// Consumers import `OutboxStatus` directly; the semantics are unchanged (`pending`
// = enqueued, not yet acked; `dead_lettered` = intentionally abandoned this run; a
// row is CLEARED only on a verified server ack, mirroring `TranscriptSyncState`).

/**
 * FEA-3473: a single durable outbox entry to enqueue. `syncClass` records which
 * lane discovered it (backfill vs incremental) for diagnostics only — selection
 * is still driven by the in-memory queues; the outbox is the crash-durable
 * shadow that survives a kill mid-backfill.
 */
export type AgentSessionOutboxEntry = {
  externalSessionId: string;
  syncClass: AgentSessionSyncClass;
};

/**
 * FEA-3659: the durable retry state of a single still-`pending` outbox row,
 * returned by `loadPendingOutboxRetryState` so a resume can rehydrate the
 * in-memory retry budget + deferred deadline. `nextAttemptAt` / `lastError` are
 * nullable because a row can carry a count without a scheduled deadline or a
 * recorded reason class.
 */
export type OutboxRetryState = {
  id: string;
  attemptCount: number;
  nextAttemptAt: string | null;
  lastError: string | null;
};

/**
 * Build the durable cursor key for one authenticated compute target. The legacy
 * spelling remains byte-identical until a server explicitly advertises the
 * monitored-activity carrier. The first capable connection selects the stable
 * payload revision and therefore performs one bounded full replay of retained
 * SQLite evidence; subsequent capable reconnects resume its persisted cursor.
 * Org/user stay out because they become known on a different auth path.
 */
export function buildAgentSessionSyncSourceKey(
  computeTargetId: string,
  includeMonitoredSessionActivity = false
): string {
  return includeMonitoredSessionActivity
    ? `${AGENT_SESSION_SYNC_SOURCE_KIND}:${AGENT_SESSION_MONITORED_ACTIVITY_PAYLOAD_REVISION}:${computeTargetId}`
    : `${AGENT_SESSION_SYNC_SOURCE_KIND}:${computeTargetId}`;
}

/**
 * ISS-4662: payload revision for the component inventory lane's durable cursor.
 *
 * BUMP THIS whenever the component payload starts carrying data that already
 * exists locally for rows the cursor has ALREADY passed. The keyset cursor
 * advances over `agent_components`, and learning about a new sibling table does
 * not touch those parent rows — so an install that had already drained its cursor
 * before upgrading would never re-emit them, and the new data would be stranded
 * below the watermark forever (wongk, #4295).
 *
 * `v2` was the ISS-4662 retained-variant expansion: `agent_component_versions`
 * rows for components synced before the upgrade need exactly one replay to reach
 * the cloud. Changing the key makes `hydrateCursorFor` find no persisted state
 * and restart from the beginning, which is the same one-time full re-backfill the
 * key already performs on a compute-target change — the lane's upserts are
 * idempotent on their identities, so a replay re-sends rather than duplicates.
 *
 * `v3` is ISS-5029 (wongk, #4391), and it is exactly the case this comment
 * describes. `variantsTruncated` / `variantsTruncatedReason` are derived from
 * `agent_component_versions` — a SIBLING table the keyset cursor does not walk —
 * so learning to send them does not touch the `agent_components` rows the cursor
 * has already passed. Without this bump every install that had already drained
 * v2 would keep the marker below its watermark forever: the truncation feature
 * would ship dark on precisely the long-lived installs whose histories have had
 * time to grow past the cap, i.e. the ones it exists for.
 */
export const AGENT_COMPONENT_SYNC_PAYLOAD_REVISION = "v3" as const;

/**
 * T-8.7: build the durable cursor key for the component inventory sync lane.
 * Uses a separate source-kind prefix so its cursor never collides with the
 * session sync cursor for the same compute target, plus the payload revision
 * above so a payload expansion can force one replay.
 */
export function buildAgentComponentSyncSourceKey(
  computeTargetId: string
): string {
  return `${AGENT_COMPONENT_SYNC_SOURCE_KIND}:${AGENT_COMPONENT_SYNC_PAYLOAD_REVISION}:${computeTargetId}`;
}

/**
 * T-8.7: payload for `POST /desktop/components/sync`. Mirrors the Zod schema
 * in `apps/api/lib/desktop-agent-sessions-schema.ts`; re-exported from the
 * contract file by T-8.8.
 */
export type DesktopAgentComponentsPayload = {
  schemaVersion: 1;
  batchId: string;
  syncMode: AgentSessionSyncMode;
  componentCount: number;
  components: SyncedComponent[];
};

/** Schema version constant for the component inventory sync payload. */
export const AGENT_COMPONENT_SYNC_SCHEMA_VERSION = 1 as const;

/** Maximum number of components packed per batch sent to the cloud. */
export const AGENT_COMPONENT_BATCH_SIZE = 200 as const;

/**
 * FEA-1962: defensive parse of the JSONB `observed_ids_at_top_updated_at`
 * column (or any untrusted ids value). A malformed value falls back to an
 * empty array so a corrupt row degrades to a full re-discovery, never a throw.
 */
export function parsePersistedObservedIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

export type AgentSessionSyncSource =
  Partial<AgentComponentInvocationSyncSource> & {
    listAllSessionCursorRows():
      | SessionCursorRow[]
      | Promise<SessionCursorRow[]>;
    /**
     * ISS-4535: ids of the sessions whose resolved repository identity is one of
     * `repositories`, newest-first, resolved PRE-hydration from `(cwd,
     * repo_full_name)` via the same live-first/stored-fallback identity the
     * Repository facet options use. Lets the read layer apply the Repository facet
     * predicate against every session's metadata — not just the
     * MAX_WORKING_SET_SESSIONS newest window — while still capping the MATCHED id
     * set, so the FEA-4286 full-corpus hydration bound stays intact and a repo
     * offered as a filter option (including a deleted-worktree repo) always
     * resolves to its rows. Optional so fake/legacy sources fall back to the
     * hydrate-then-match path in `getSharedAgentSessions`.
     *
     * ISS-4558: `options` carries the list's date window and sort so this read
     * can answer the REAL Sessions request shape (bounded window + `sortBy:
     * lastActivity`) pre-hydration. An implementation MUST honor it or not be
     * admitted to the paging branch: `canPageBeforeLoading` runs NO in-memory
     * matcher over the ids this returns, so a window silently dropped here is a
     * filter silently dropped on screen. Omitted → the legacy whole-corpus,
     * `updated_at DESC, id DESC` behavior the capped fallback still relies on.
     */
    listRepositoryScopedSessionIds?(
      repositories: readonly string[],
      cache: SessionAttributionResolverCache,
      options?: RepositoryScopedSessionIdsOptions
    ): string[] | Promise<string[]>;
    /**
     * Lightweight cursor page for local list views. Unlike sync cursors, this may
     * order by list-specific metadata so the renderer can hydrate only visible
     * rows for default sorted pages instead of loading the full local corpus.
     */
    listSessionCursorPage?(
      request: SessionListCursorPageRequest
    ): SessionListCursorPage | Promise<SessionListCursorPage>;
    /**
     * Cursor rows for the newest `updated_at` group only. Used when startup
     * deliberately defers historical backfill: incremental sync only needs the
     * high-water mark plus tied IDs, not the full session corpus.
     */
    listTopSessionCursorRows?():
      | SessionCursorRow[]
      | Promise<SessionCursorRow[]>;
    /**
     * PRD-536 E1: incremental cursor rows. Returns everything strictly newer than
     * `sinceUpdatedAt`, PLUS the tied-top-timestamp cluster with the exact
     * `observedTopIds` set excluded — `WHERE updated_at > $1 OR (updated_at = $1
     * AND id NOT IN (<observedTopIds>))`. Excluding the observed-id SET (rather
     * than gating by a single `id > maxId` boundary) is what keeps a genuinely-new
     * sibling row that lands at the SAME top `updated_at` with a LOWER-sorting id
     * from being silently skipped (it is not `> maxId`, but it IS `NOT IN` the
     * observed set, so it is selected). An already-seen top cluster is still not
     * re-emitted (its ids are all in the set), preserving the keyset perf win.
     */
    listUpdatedSessionCursorRows(
      sinceUpdatedAt: string,
      observedTopIds: readonly string[]
    ): SessionCursorRow[] | Promise<SessionCursorRow[]>;
    loadSyncedSessions(
      ids: string[],
      cache: SessionAttributionResolverCache,
      options?: SyncedSessionLoadOptions
    ): SyncedAgentSession[] | Promise<SyncedAgentSession[]>;
    /**
     * ISS-6031: of `ids`, which still have a row in the local `sessions` table?
     *
     * The narrowest possible existence probe — a single `SELECT id`, no
     * relations, no assembly — and the ONLY sanctioned way to conclude that a
     * queued session is gone. An empty {@link loadSyncedSessions} result is
     * evidence that a READ produced nothing; it is not evidence that the rows
     * were deleted, and the sync lane used to treat the two as the same thing
     * and permanently dead-letter present rows on a bad read.
     *
     * Implementations must answer from `sessions` alone. Widening it with a
     * hydratability or substantive-content predicate would re-create exactly the
     * conflation this exists to break: a row that is present but momentarily
     * unreadable must come back as PRESENT so the caller retries instead of
     * disposing.
     *
     * Optional so fake/legacy sources keep their current shape. A source without
     * it can never CONFIRM an absence, so the caller retries indefinitely rather
     * than guessing — absence is proven or it is not acted on.
     */
    findExistingSessionIds?(ids: string[]): string[] | Promise<string[]>;
    /**
     * ISS-5407 (stage review): optional WHOLE-RUN event counts for the given
     * sessions, aggregated by the store rather than folded from loaded rows.
     *
     * The session-detail read is bounded (`eventRowCap`), so folding
     * `toolUseCount`/`errorCount` over the rows it loaded answers for the PREFIX
     * — and those two render as bare stats on the detail while the SAME session's
     * Sessions-list row folds the full stream. The detail calls this ONLY when
     * its read actually hit the ceiling, so a normal open costs no extra query.
     *
     * Optional so fake test sources keep their current shape; a source without it
     * leaves the counts on their loaded-row basis, which is the pre-ISS-5407
     * behavior for any source that never truncates.
     */
    loadSessionEventCounts?(
      ids: string[]
    ):
      | Map<string, SessionEventCounts>
      | Promise<Map<string, SessionEventCounts>>;
    /**
     * Optional lightweight proof that selected sessions cannot fit the existing
     * sync cap even with their events removed. Implementations must only return
     * an ID when the old full hydrate path would also have locally dead-lettered
     * it; unknown or borderline sessions should be omitted and hydrated normally.
     */
    findLocallyOversizedSessions?(
      ids: string[],
      maxBytes: number
    ):
      | { id: string; payloadBytes: number }[]
      | Promise<{ id: string; payloadBytes: number }[]>;
    /**
     * FEA-1834: optional lightweight load for the usage summary — session
     * metadata + tokenUsageByModel only (no agents/events/attribution). Sources
     * without it fall back to the full hydrate path in `getSharedAgentSessionUsage`.
     */
    loadUsageSessions?(
      ids: string[]
    ): SyncedAgentSession[] | Promise<SyncedAgentSession[]>;
    /**
     * FEA-1834 / PLN-941 §4: O(grouped) usage aggregation. Returns SQL SUM/COUNT
     * rollups so the usage summary never hydrates the full corpus on the live
     * refresh cadence. Optional: sources without it (and `ids`-scoped requests)
     * fall back to `loadUsageSessions` / the full hydrate in
     * `getSharedAgentSessionUsage`.
     */
    aggregateUsage?(
      filters: AgentSessionUsageAggregateFilters
    ): AgentSessionUsageAggregate | Promise<AgentSessionUsageAggregate>;
    /**
     * FEA-4142: O(1)-shaped `COUNT(*)` of sessions matching a metadata-only
     * filter (status / ownership / started-window / `ended_at` completion
     * bound), so a count-only reader — the Agents sidebar activity badge — reads
     * its `total` with a single grouped SQL read instead of hydrating up to
     * `MAX_WORKING_SET_SESSIONS` full sessions just to size the list (the
     * FEA-2038 db-host OOM path). Clone-safe (a plain object in, a number out),
     * so it forwards across the db-host proxy. Optional: sources without it (and
     * non-count-expressible reads) fall back to the hydrate path in
     * `getSharedAgentSessions`.
     */
    countSessions?(filters: AgentSessionCountFilters): number | Promise<number>;
    /**
     * FEA-2038: O(grouped) analytics aggregation. Returns SQL rollups (byTool /
     * byAgentType / byRepository) so the analytics response never hydrates the
     * full session/event/agent/token corpus (the db-host OOM, exit code 5). The
     * per-request attribution `cache` is shared so cwd→repositoryFullName lookups
     * are reused. Optional: sources without it (and `ids`/`search`-scoped requests)
     * fall back to the full hydrate path in `getSharedAgentSessionAnalytics`.
     */
    aggregateAnalytics?(
      filters: AgentSessionUsageAggregateFilters,
      cache: SessionAttributionResolverCache
    ): AgentSessionAnalyticsAggregate | Promise<AgentSessionAnalyticsAggregate>;
    /**
     * FEA-1962: load the persisted durable cursor for `sourceKey`, or `null` when
     * none exists (fresh sqlite / first run after upgrade → full backfill as today).
     * Optional so fake test sources and pre-FEA-1962 sources behave like today.
     */
    loadSyncState?(
      sourceKey: string
    ): PersistedSyncState | null | Promise<PersistedSyncState | null>;
    /**
     * FEA-1962: persist the durable cursor for `sourceKey`. Called ONLY after an
     * accepted ack for a contiguous prefix of rows — never for discovery-only
     * candidates or failed/retryable/dead-lettered rows.
     */
    advanceSyncState?(
      sourceKey: string,
      state: PersistedSyncState
    ): void | Promise<void>;
    /**
     * FEA-3473: append `pending` outbox rows for the given entries under
     * `sourceKey`. Idempotent upsert keyed by (sourceKey, externalSessionId): a
     * re-enqueue of an id already present leaves its row untouched (never resets a
     * dead-lettered row back to pending). Called when the service enqueues ids;
     * NEVER advances/clears — the crash-durable record of "known but not yet
     * acked". Optional so pre-FEA-3473 / fake sources behave like today.
     */
    enqueueOutboxEntries?(
      sourceKey: string,
      entries: AgentSessionOutboxEntry[]
    ): void | Promise<void>;
    /**
     * FEA-3473: delete the outbox rows for `ids` under `sourceKey`. Called ONLY
     * after a VERIFIED server ack (mirrors `TranscriptSyncState`) — per-item
     * durable progress, so a kill mid-backfill re-uploads only the ids whose rows
     * survive.
     */
    clearOutboxEntries?(sourceKey: string, ids: string[]): void | Promise<void>;
    /**
     * FEA-3473: mark an outbox row `dead_lettered` with the recorded `reason`, so
     * an intentionally-abandoned session (oversize / validation_failed /
     * exhausted-retry / locally-deleted-after-enqueue) is durably recorded rather
     * than silently dropped, and a single stuck item never blocks cursor
     * persistence.
     */
    markOutboxDeadLettered?(
      sourceKey: string,
      id: string,
      reason: string,
      attemptCount?: number
    ): void | Promise<void>;
    /**
     * FEA-3697: durably flip a `dead_lettered` outbox row back to `pending` when a
     * dead-letter is RECOVERED for retry (its finite retry-after deadline elapsed,
     * or a set-aside straggler is promoted after backfill drains). This is the
     * durable twin of the in-memory re-enqueue in `recoverExpiredDeadLetters` /
     * `promoteDeadLetterIfIdle`: without it the row stays `dead_lettered` on disk,
     * `loadPendingOutboxIds` skips it after a restart, and the recovered session is
     * silently stranded (or its recovery progress lost). Resets `attempt_count` to
     * 0 and clears `next_attempt_at` / `last_error` so the recovered row restarts
     * the bounded retry/dead-letter budget from scratch, mirroring the in-memory
     * `clearFailureStateForId`. Only ever flips a `dead_lettered` row (a `pending`
     * row is left untouched — an in-flight retry must not have its budget reset out
     * from under it, and an absent row is a no-op). Exactly-once is preserved: the
     * durable delete still fires ONLY on a verified server ack via
     * `clearOutboxEntries`, and the server dedupes an already-applied payload, so
     * re-pending a recovered row can never double-apply or drop it. Optional so
     * pre-FEA-3697 / fake sources behave like today.
     */
    reEnqueueRecoveredDeadLetter?(
      sourceKey: string,
      id: string
    ): void | Promise<void>;
    /**
     * FEA-3659: durably record a transient retry-with-backoff on an outbox row —
     * stamp the incremented `attemptCount`, the `nextAttemptAt` deadline, and the
     * `reason` class, leaving the row `pending`. The persisted twin of the
     * in-memory per-session retry budget, so a deferred transient rejection
     * reflects its backoff in the outbox instead of misreporting `attempt_count=0`.
     * The `reason` param is generic, but TODAY only the `ingestion_failed` defer
     * branch is wired to call this; `rate_limited` / `ack_timeout` still defer with
     * an in-memory-only budget (a future change can route them through here too).
     * Optional so pre-FEA-3659 / fake sources behave like today.
     */
    recordOutboxRetry?(
      sourceKey: string,
      id: string,
      attemptCount: number,
      nextAttemptAt: string,
      reason: string
    ): void | Promise<void>;
    /**
     * FEA-3473: the still-`pending` session ids for `sourceKey`, oldest first.
     * Read once per identity on hydration so a restart re-enqueues exactly the
     * sessions that were enqueued-but-not-acked before the kill (bounded by the
     * outbox size), instead of re-walking the whole local corpus.
     */
    loadPendingOutboxIds?(sourceKey: string): string[] | Promise<string[]>;
    /**
     * FEA-3659: the persisted retry state for still-`pending` outbox rows that have
     * recorded a transient backoff (`attemptCount > 0`). Read once per identity on
     * hydration so the in-memory retry budget + deferred-retry deadline are seeded
     * from the durable outbox — without it, a restart mid-backoff retries the row
     * immediately and recomputes the count from 0, discarding a partly-burned
     * dead-letter budget and the persisted `nextAttemptAt`. Optional so pre-FEA-3659
     * / fake sources behave like today (no seeding → today's reset-on-restart).
     */
    loadPendingOutboxRetryState?(
      sourceKey: string
    ): OutboxRetryState[] | Promise<OutboxRetryState[]>;
    loadSessionTokenEvents?(
      sessionId: string
    ): TokenEventCostPoint[] | Promise<TokenEventCostPoint[]>;
    /**
     * ISS-5567: the branch-artifact identities behind the session's branch
     * writes, so the desktop session detail can link its Branch row to that
     * branch's detail page the way web already does.
     *
     * Read-only and detail-scoped: only `getSharedAgentSessionDetail` calls it,
     * and only for a session that resolved a branch, so a normal list read costs
     * no extra query. An empty array means the session wrote no branch.
     *
     * Returns every DISTINCT identity rather than a store-picked winner: the same
     * branch NAME can hold two artifact rows under different scopes, and choosing
     * between them depends on what the pane is displaying, which the store cannot
     * see (see `readSessionBranchLinkKeys` and `resolveSessionBranchRouteId`).
     *
     * Optional so fake/older sources keep their current shape — a source without
     * it yields no `branchArtifactId`, and the shared Properties pane keeps
     * rendering the Branch row as plain text (the pre-ISS-5567 behavior).
     */
    loadSessionBranchLinkKeys?(
      sessionId: string
    ): SessionBranchLinkKey[] | Promise<SessionBranchLinkKey[]>;
    /**
     * ISS-5617: ONE session's `closedloop_artifact` refs, read UNBOUNDED by the
     * sync producer's ref budget.
     *
     * `loadSyncedSessions` applies `boundNonCommitArtifactRefs` — a 100-slot
     * budget shared with branch/PR refs, in which documents hold only a floor of
     * 50 — because that is what the sync WIRE accepts. The detail's "Linked
     * artifacts" row is a local read and has no such constraint, and folding it
     * from the capped array made the row state a total it could not back (60
     * document refs rendered as "+44" instead of "+54"). Read here instead, so
     * the served list and `linkedArtifactsTotal` describe the same complete set.
     *
     * Called once per detail open, for the ONE session being opened.
     * Clone-safe (a string in, plain ref objects out) so it forwards across the
     * db-host proxy.
     *
     * Optional so fake/older sources keep their current shape — a source without
     * it leaves the fold on the sync-capped `artifactRefs` and OMITS
     * `linkedArtifactsTotal`, which is the pre-ISS-5617 degradation (the shared
     * pane falls back to `linkedArtifacts.length`).
     */
    loadSessionDocumentArtifactRefs?(
      sessionId: string
    ): SyncedArtifactRef[] | Promise<SyncedArtifactRef[]>;
    /**
     * T-8.6/Gap B: keyset cursor reader for the component inventory sync lane.
     * Returns rows from `agent_components` ordered by (last_seen_at, id) STRICTLY
     * AFTER the `(sinceTs, sinceId)` keyset position — `COALESCE(last_seen_at,'')
     * > sinceTs OR (= sinceTs AND id > sinceId)`. Pass `('', '')` for the initial
     * full backfill. Includes tombstoned rows. Optional so fake test sources
     * without it behave like today.
     */
    listComponentCursorRows?(
      sinceTs: string,
      sinceId: string,
      limit: number
    ): AgentComponentCursorRow[] | Promise<AgentComponentCursorRow[]>;
    /**
     * T-8.6/Gap B: full-row loader for component inventory sync. Returns the
     * `SyncedComponent`-shaped rows for the given component ids.
     */
    loadComponentRows?(
      ids: string[]
    ): SyncedComponent[] | Promise<SyncedComponent[]>;
    /**
     * ISS-5387: one AGGREGATE, read-only burn-down sample across every lane
     * store — queue depths, byte remainders, oldest-pending ages, dead-letter
     * counts, and durable cursor positions. Read on a slow timer by
     * `main/sync/sync-burndown-reporter.ts`, never on a lane's hot path, and it
     * mutates nothing. Query in and sample out are plain structured-clone-safe
     * objects so the db-host proxy forwards them unchanged. Optional so fake
     * test sources without it behave like today (the reporter no-ops).
     */
    readSyncBurndown?(
      query: SyncBurndownQuery
    ): Promise<SyncBurndownStoreSample>;
    close?: () => void | Promise<void>;
  };

/**
 * T-8.7: lightweight cursor row for the component inventory sync lane.
 * Mirrors `SqliteAgentComponentCursorRow` without the database dependency.
 */
export type AgentComponentCursorRow = {
  id: string;
  last_seen_at: string | null;
};

/**
 * Per-call knobs for {@link AgentSessionSyncSource.loadSyncedSessions}. Optional
 * throughout so fake test sources keep their current shape.
 *
 * FEA-2038 OOM fix: when `omitEventData` is set the loader skips the heavy
 * per-event `data` JSON blob (events still carry `toolName`/`eventType`). The
 * full-corpus list/analytics reads pass it because they never read `event.data`;
 * the detail/branch callers omit it and keep full event data.
 *
 * FEA-2718: the cloud-sync payload build ALSO passes `omitEventData` (synced
 * events no longer carry turn text, so hydrating it is pure waste) together with
 * `includeComponentUsage: true` — because component usage (T-8.6) is still
 * emitted on the sync payload and used to be gated on `!omitEventData`.
 * `includeComponentUsage` defaults to `!omitEventData`, so every other caller
 * keeps its current behavior unchanged.
 *
 * ISS-5407: `eventRowCap` bounds the PER-SESSION event read at `eventRowCap + 1`
 * rows — one PAST the ceiling, the ISS-5075 idiom — so the caller can DETECT a
 * read that hit the bound and report it instead of serving a prefix as the whole
 * stream. The session-detail reader passes `SESSION_DETAIL_EVENT_MAX_ROWS`, the
 * same ceiling its cloud twin uses; that read runs on the heap-capped db-host
 * worker and carries the multi-KB per-event `data` blob.
 *
 * Absent → the read stays unbounded. That is REQUIRED for the cloud-sync payload
 * build (a prefix there would upsync a silently partial session), and it is what
 * the remaining lanes still do — including the desktop branch merged trace
 * (`shared-branch-trace.ts`), which fans this read across N sessions with the
 * blob attached and has no bound of its own. Its cloud twin reports partiality
 * through `BranchTraceCompleteness`, which has no desktop producer yet, so
 * bounding it is its own change rather than something to smuggle in here.
 *
 * ISS-6119: `omitPreviewStrippedMetadata` narrows `sessions.metadata` in SQL to
 * the keys the caller can observe, dropping the `OMITTED_METADATA_KEYS` set
 * (`tokenSeries` — 52.5% of the real corpus's metadata bytes) before the driver
 * materializes the column. Only a caller that provably discards those keys may
 * set it: the cloud-sync drain (whose every session goes through
 * `compactMetadataForPreview`, which drops them) and the list/analytics folds
 * (which read `metadata.messages` and nothing else). The detail and branch-trace
 * loads retain the blob verbatim for the renderer and must NOT set it. See
 * `sessionMetadataSelectExpression` for the full argument.
 */
export type SyncedSessionLoadOptions = {
  omitEventData?: boolean;
  includeComponentUsage?: boolean;
  /** Project ISS-6060's optional activity carrier only for a capable cloud. */
  includeMonitoredSessionActivity?: boolean;
  eventRowCap?: number;
  omitTokenEventCostColumns?: boolean;
  omitPreviewStrippedMetadata?: boolean;
};

/**
 * ISS-5407 (stage review): one session's WHOLE-RUN event counts, on a basis the
 * `eventRowCap` bound cannot narrow. The two fields are the store-side twins of
 * `countToolUseEvents` and `countErrorEvents`, so a detail served from a bounded
 * read reports the same numbers its Sessions-list row does.
 */
export type SessionEventCounts = {
  toolUseCount: number;
  errorCount: number;
};

/**
 * ISS-5567: the `(repoFullName, branchName)` identity of the branch artifact a
 * session wrote — the exact pair the desktop Branches list encodes into its route
 * ids, so a session detail can address the same branch the list does. A repo-less
 * branch artifact carries `null`, which `encodeBranchId` maps to its local-repo
 * sentinel.
 *
 * A port-local NAME for the canonical {@link BranchKeyRow}, not a second
 * declaration of it: the branch reads already own that identity, and two
 * structurally-identical copies would silently diverge the first time one gained
 * a field. Type-only, so this contract keeps no runtime dependency on the
 * database layer (the same shape as this file's `sync-burndown-store` imports).
 */
export type SessionBranchLinkKey = BranchKeyRow;
