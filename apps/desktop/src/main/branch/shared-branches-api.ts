import {
  type BranchAnalytics,
  type BranchLeadTimeActivity,
  type BranchLifecyclePhaseSegment,
  type BranchListResponse,
  type BranchPageDetail,
  type BranchRow,
  type BranchSession,
  BranchViewerScope,
  decodeBranchId,
} from "@repo/api/src/types/branch";
import type { BranchUsageSummary } from "@repo/api/src/types/branch-usage";
import {
  type ActivitySegmentSpan,
  type ActivitySpendEvent,
  attributeBranchSessionActivity,
} from "@repo/lib/branches/activity-attribution";
import { isAnomalousSpendTotal } from "@repo/lib/branches/spend-kpi";
import { DESKTOP_LOCAL_SESSION_AUTHOR_LABEL } from "../../shared/shared-agent-sessions-contract.js";
import {
  emptySharedBranchesListResponse,
  emptySharedBranchesPageDataResponse,
  emptySharedBranchesUsageSummary,
  type SharedBranchesDetailRequest,
  type SharedBranchesListRequest,
  type SharedBranchesPageDataResponse,
  type SharedBranchesQuery,
} from "../../shared/shared-branches-contract.js";
import type { SessionAttributionResolverCache } from "../agent-sync/agent-session-attribution.js";
import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";
import type { BranchCanonicalActivityRow } from "../database/branch-activity-read.js";
import {
  type readBranchAnalyticsActivitySegmentRows,
  readBranchAnalyticsLifecycleEventRows,
} from "../database/branch-analytics-phase-evidence.js";
import {
  type BranchCommitRow,
  type BranchLifecycleEventRow,
  type BranchLinkRow,
  type BranchSessionTokenRow,
  readBranchAnalyticsTokenRows,
  readBranchCommitRowsForSessions,
  readBranchLifecycleEventRowsForBranch,
  readBranchSessionTokenRowsForBranch,
  readBranchTokenAggregateRows,
  readBranchTokenAggregateRowsForBranch,
  readBranchUsageEventRows,
  readBranchUsageTokenRows,
  readDistinctBranchKeyRows,
  readLocalBranchCommitRows,
  readLocalBranchLinkRows,
  readLocalBranchLinkRowsForBranch,
  readLocalBranchPrRows,
  readLocalBranchPrRowsForBranch,
  readSessionBranchCounts,
} from "../database/branch-reads.js";
import type { DbHostAgentDatabase } from "../database/sqlite.js";
import { writePersistentLog } from "../logging/persistent-log.js";
import {
  projectBranchAnalytics,
  sessionCostMapFromUsageRows,
  sumLocEnrichedSpend,
} from "./branch-analytics-projection.js";
import {
  attachDesktopCanonicalDetailMetrics,
  buildPhaseEvidence,
  projectDesktopCanonicalMetrics,
  selectExactBranchCohort,
} from "./branch-canonical-metric-projection.js";
import { buildDesktopPhaseAttribution } from "./branch-detail-phase-attribution.js";
import {
  type DesktopDetailPullRequestSelection,
  localDeliveredArtifactFields,
  selectDesktopDetailPullRequest,
  selectedPullRequestDetailFields,
} from "./branch-detail-selected-pull-request.js";
import { readBranchCanonicalActivityRowsForScope } from "./branch-empty-scope-reads.js";
import {
  type DesktopBranchLastActiveProjection,
  projectDesktopBranchLastActive,
} from "./branch-last-active-projection.js";
import { buildBranchLeadTime } from "./branch-lead-time-projection.js";
import { groupBranchLifecycleEventsBySession } from "./branch-lifecycle-event-grouping.js";
import { lifecyclePhaseSegmentsBySession } from "./branch-lifecycle-phase-rollup.js";
import {
  branchIdsForLinks,
  completeArtifactLoc,
  projectBranchListItems,
} from "./branch-list-projection.js";
import {
  type CanonicalBranchMetricEventRead,
  readCanonicalBranchMetricEventRows,
} from "./branch-metric-event-read.js";
import {
  rethrowAsBranchSourceError as rethrowAsSourceError,
  startBranchDetailPerf,
} from "./branch-read-boundaries.js";
import { priceSyncedBranchSession } from "./branch-session-pricing.js";
import { resolveDesktopBranchCostCompleteness } from "./branch-usage-cost-completeness.js";
import {
  branchUsageRowFromTokenRow,
  projectBranchUsage,
  sumStoredBranchCost,
} from "./branch-usage-projection.js";
import {
  applyCloudHydration,
  type BranchCloudHydrationSource,
} from "./shared-branches-cloud-hydration.js";
import {
  type BranchDefaultEligibilitySnapshot,
  denominatorEligibleBranchKeys,
  eligibleBranchKeys,
  filterEligibleBranchRows,
  isEligibilityCoverageCompleteForCohort,
  resolveBranchProductEligibilitySnapshot,
} from "./shared-branches-default-eligibility.js";
import { readGlobalBranchCountsForItems } from "./shared-branches-divisor.js";
import {
  pageBranches,
  selectRequestedBranches,
} from "./shared-branches-paging.js";
import {
  collectSessionIds,
  eventWindowSqlBounds,
  filterBranchItemsByWindow,
  filterEventRowsByEventWindow,
  hasUnsupportedCloudFilter,
  isDateWindowActive,
} from "./shared-branches-window.js";

/**
 * The slice of the local SQLite database the Branches serving reads through.
 *
 * A2 (PLN-983) pins this seam so the IPC handlers can register against a stable
 * source threaded by the runtime (the same `withDb`/`agentDatabase` accessor the
 * shared-agent-sessions handlers use). B1 (FEA-1948) fills the list + usage
 * bodies: they read `session_artifact_links` (the branch-naming source — the
 * desktop schema has no `artifacts(kind=branch)` table) joined to
 * `pull_requests`/`token_usage` via `source.prisma`, project through the
 * main-local `./branch-usage-projection` (the surface-agnostic
 * `@repo/app/branches/lib/branch-derivations` is unreachable under the main
 * process's `nodenext` resolution; pricing is still delegated to genai-cost),
 * sanitize read errors at this boundary, and never re-register the IPC handlers
 * (A2 is the sole registrar).
 *
 * D1 (FEA-1950) fills the detail body. It adds an OPTIONAL `syncSource` — the
 * same agent-session loader the Sessions handlers use — so the detail can hydrate
 * each linked session's real per-session token splits/cost/name/harness and build
 * the cross-session merged trace from the verified turn-item projection. It is
 * optional + additive: the list/usage/analytics ops never touch it, and a source
 * without it (e.g. a unit test exercising only the Prisma branch reads) degrades
 * to the minimal session spine + empty trace rather than failing.
 */
export type BranchSyncSource = Pick<
  DbHostAgentDatabase,
  "prisma" | "readBranchCanonicalActivityRows" | "readBranchMetricEventEvidence"
> &
  Partial<Pick<DbHostAgentDatabase, "syncSource">>;

// Eligibility awaits authority; PR-field-only legacy callers may still peek/warm.
export type { BranchCloudHydrationSource } from "./shared-branches-cloud-hydration.js";

/**
 * Parse an ISO instant to epoch millis for ordering. Unparseable / empty values
 * sort oldest (0) so a branch with a bad timestamp never floats to the top.
 */
function isoEpoch(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * The list projection's tail: given already-fetched link/PR/token/commit rows,
 * page and cloud-hydrate them into the canonical list response. Split out of
 * {@link getSharedBranches} so {@link getSharedBranchesPageData} can share ONE
 * set of reads between the list and analytics projections instead of each
 * independently re-reading the same tables (FEA-3056 follow-up).
 */
async function buildBranchListResult(
  prisma: Parameters<typeof readSessionBranchCounts>[0],
  linkRows: Awaited<ReturnType<typeof readLocalBranchLinkRows>>,
  prRows: Awaited<ReturnType<typeof readLocalBranchPrRows>>,
  tokenRows: Awaited<ReturnType<typeof readBranchTokenAggregateRows>>,
  lastActiveByBranch: DesktopBranchLastActiveProjection,
  request: SharedBranchesListRequest,
  cloudHydration: BranchCloudHydrationSource | undefined,
  eligibilitySnapshot: BranchDefaultEligibilitySnapshot | null,
  denominatorKeys: ReadonlyArray<{
    repoFullName: string | null;
    branchName: string;
  }>,
  // FEA-3695 — the AUTHORITATIVE per-session cost map (each session once), built
  // by the caller from the deduped per-session usage read. Optional: the
  // standalone list op prices per (branch, model) only, so it omits this and the
  // client falls back to the legacy branch-total inference; the page-data path
  // (the only caller feeding the filtered summary cards) supplies it.
  sessionCostUsd?: Readonly<Record<string, number>>
): Promise<BranchListResponse> {
  const projected = projectBranchListItems(
    linkRows,
    prRows,
    tokenRows,
    lastActiveByBranch
  );
  // Apply the canonical Last-active window to the complete eligible corpus
  // before id selection and paging. Unavailable rows survive the window because
  // absence is a typed result, not evidence that a row lies out of bounds.
  const windowed = filterBranchItemsByWindow(projected, request);
  const matched = selectRequestedBranches(windowed, request.ids);
  const items = pageBranches(matched, request.limit, request.offset);
  // ISS-4689 — the wire even-split divisor. Read off the PRE-DISPLAY link set
  // and keyed to this page's sessions; see `readGlobalBranchCountsForItems`.
  // Emitted from this SHARED builder so the standalone and page-data lists carry
  // one shape and the KPI cannot flip between read paths.
  const branchCountsBySession = await readGlobalBranchCountsForItems(
    prisma,
    items,
    denominatorKeys
  );
  return {
    items: await applyCloudHydration(items, cloudHydration, {
      forceRefresh: request.forceRefresh,
      resolvedResult: eligibilitySnapshot?.resolvedHydration,
      scope: "list",
    }),
    total: matched.length,
    viewerScope: BranchViewerScope.Self,
    ...(sessionCostUsd ? { sessionCostUsd } : {}),
    ...(branchCountsBySession.size > 0
      ? { sessionBranchCount: Object.fromEntries(branchCountsBySession) }
      : {}),
  };
}

/**
 * Project local SQLite-backed branches into the canonical shared list response.
 * Set-based grouped reads with no per-branch fan-out. Canonical activity is read
 * once for the eligible corpus after repository-default authority resolves. A
 * read failure rethrows a sanitized, code-only error so no raw SQL crosses the
 * IPC boundary (the renderer surfaces it as the list error state).
 *
 * These reads (and the sibling usage/analytics/page-data reads below) run via
 * plain `Promise.all`, not a serialized/exclusive gate. FEA-3056 originally
 * added one, reasoning that concurrent large result sets could blow the
 * db-host utilityProcess's `--max-old-space-size` and cause the recurring
 * `exit code 5` crash. PR #2806 later root-caused that crash for real: a
 * `@libsql/client` connection leak on every `transaction()` call exhausting
 * native fds/memory (a SIGTRAP, not a V8 heap OOM) — reproduced at ~12.5k
 * transactions, fixed via a version-pinned patch, confirmed flat at 56k+. The
 * SAME PR found the `--max-old-space-size=12288` flag FEA-3056 was defending
 * was itself inert in a utilityProcess (heap_size_limit stays ~4 GiB
 * regardless) and corrected the "exit 5 = V8 OOM" comments that flag had
 * anchored (see `db-host-memory-watchdog.ts`). With the real leak fixed,
 * serializing these reads no longer addresses a live failure mode — it only
 * re-adds the latency it was measured to cost (profiled against a real local
 * corpus: a full page-data read over 12k+ rows completes in ~150-200ms).
 * Re-add serialization only alongside new evidence of real memory pressure at
 * this call site, not a reprise of the corrected "exit 5 = OOM" theory.
 */
export async function getSharedBranches(
  source: BranchSyncSource | null | undefined,
  request: SharedBranchesListRequest = {},
  cloudHydration?: BranchCloudHydrationSource
): Promise<BranchListResponse> {
  if (!source) {
    return emptySharedBranchesListResponse();
  }
  if (hasUnsupportedCloudFilter(request)) {
    return emptySharedBranchesListResponse();
  }
  try {
    // Read the raw branch population before authority resolution so a cold
    // fail-closed view cannot prevent its own bounded authority warm-up.
    const [rawLinkRows, rawPrRows, rawCommitRows] = await Promise.all([
      readLocalBranchLinkRows(source.prisma),
      readLocalBranchPrRows(source.prisma),
      readLocalBranchCommitRows(source.prisma),
    ]);
    const eligibilitySnapshot = await resolveBranchProductEligibilitySnapshot(
      rawLinkRows,
      cloudHydration,
      { forceRefresh: request.forceRefresh, scope: "list" }
    );
    const linkRows = filterEligibleBranchRows(rawLinkRows, eligibilitySnapshot);
    const prRows = filterEligibleBranchRows(rawPrRows, eligibilitySnapshot);
    const commitRows = filterEligibleBranchRows(
      rawCommitRows,
      eligibilitySnapshot
    );
    const branchKeys = eligibleBranchKeys(linkRows, eligibilitySnapshot);
    const denominatorKeys = denominatorEligibleBranchKeys(
      rawLinkRows,
      eligibilitySnapshot
    );
    const [tokenRows, activityRows] = await Promise.all([
      readBranchTokenAggregateRows(source.prisma, branchKeys, denominatorKeys),
      readBranchCanonicalActivityRowsForScope(source, { branchKeys }),
    ]);
    const lastActiveByBranch = projectDesktopBranchLastActive(
      branchIdsForLinks(linkRows),
      activityRows,
      prRows,
      commitRows
    );
    return await buildBranchListResult(
      source.prisma,
      linkRows,
      prRows,
      tokenRows,
      lastActiveByBranch,
      request,
      cloudHydration,
      eligibilitySnapshot,
      denominatorKeys
    );
  } catch (error) {
    rethrowAsSourceError("getSharedBranches", error);
  }
}

/**
 * FEA-2276: build a loaded session's priced activity-segment tiling for the
 * offline/unauthenticated desktop path, from the `activitySegmentRows` (FEA-3568)
 * + `tokenEvents` (FEA-2730) that SURVIVE the branch detail's light hydration
 * (`omitEventData` only nulls the heavy `events.data` blob). Runs the SAME shared
 * `attributeBranchSessionActivity` kernel the cloud read uses, so an authenticated
 * (cloud-served) and an offline (local) branch page render an identical rollup.
 *
 * Returns `undefined` when the session carries NO tiling (older build / pre-backfill)
 * so the rollup routes its whole spend to `unattributed` — never a fabricated `[]`.
 *
 * CAP DIVERGENCE (accepted): the cloud read caps its token-event join at 10k ×
 * sessions (a pathological-scan backstop). This local read consumes the session's
 * FULL `tokenEvents` uncapped (they arrive via the shared `selectRowsByIds` reader,
 * used well beyond branches, so capping there is out of scope). Both bounds sit far
 * above any real session's turn count, so a divergence would require >10k events in
 * one session — not observed in practice; documented rather than mirrored.
 */
function buildBranchActivitySegments(
  session: SyncedAgentSession
): BranchSession["activitySegments"] {
  const rows = session.activitySegmentRows;
  if (rows == null) {
    return undefined;
  }
  const spans: ActivitySegmentSpan[] = rows.map((row) => ({
    phase: row.phase,
    startMs: row.startMs,
    endMs: row.endMs,
    confidence: row.confidence,
  }));
  const events: ActivitySpendEvent[] = (session.tokenEvents ?? []).map(
    (event) => ({
      tMs: Date.parse(event.createdAt),
      costUsd: event.estimatedCostUsd ?? null,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheReadTokens: event.cacheReadTokens,
      cacheWriteTokens: event.cacheWriteTokens,
      sourceId: event.externalEventId,
    })
  );
  return attributeBranchSessionActivity(spans, events);
}

/** Sum a loaded session's per-model token usage into one `BranchSession` row. */
function toEnrichedBranchSession(
  session: SyncedAgentSession,
  isPrimary: boolean,
  branchCount: number,
  phaseSegments: readonly BranchLifecyclePhaseSegment[] | undefined,
  tokenRow: BranchSessionTokenRow | undefined
): BranchSession {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  for (const usage of session.tokenUsageByModel) {
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    cacheReadTokens += usage.cacheReadTokens;
    cacheWriteTokens += usage.cacheWriteTokens;
  }
  const activitySegments = buildBranchActivitySegments(session);
  return {
    sessionId: session.externalSessionId,
    slug: null,
    name: session.name ?? null,
    harness: session.harness ?? "",
    startedAt: session.startedAt,
    endedAt: session.endedAt ?? null,
    isPrimary,
    // FEA-2276: even-split divisor the rollup applies to attributed segment cost.
    branchCount,
    estimatedCostUsd: priceSyncedBranchSession(session),
    ...(tokenRow ? { evenSplitCostUsd: tokenRow.evenSplitCostUsd } : {}),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    ...(phaseSegments && phaseSegments.length > 0 ? { phaseSegments } : {}),
    // FEA-3576 — the branch PR-activity timeline segments each hour by the human
    // stakeholder who spent the money. The desktop store is single-player local,
    // so every hydrated local session's human owner is the ONE local desktop
    // user; label it with the same `DESKTOP_LOCAL_SESSION_AUTHOR_LABEL` the
    // merged-trace human actor uses so the timeline reads consistently here.
    ownerUserName: DESKTOP_LOCAL_SESSION_AUTHOR_LABEL,
    ...(activitySegments !== undefined && { activitySegments }),
  };
}

/**
 * Build the canonical detail body for one already-projected branch row.
 *
 * The branch identity, status, PR fields, cost, and `sessionIds` come straight
 * from the shared list projection (`row`), so the detail and the list agree
 * byte-for-byte. The detail-only fields are filled from the branch's own PR/link
 * rows and the loaded sessions:
 * - `linkedPrNumbers` / `mergedAt` / `closedAt` are real (from `pull_requests`).
 * - `sessions`: when the session loader hydrated a linked session, it carries
 *   the real name/harness/started/ended + per-session token splits and priced
 *   cost (D1). A session that did NOT hydrate degrades to the minimal link-row
 *   spine (real `sessionId` + `isPrimary` + observed time, null/0 usage) rather
 *   than being dropped.
 * - `mergedTrace`: the chronological cross-session trace built from the loaded
 *   sessions' turn items (empty when no session hydrated).
 * - `prBody` / `prBodyHtmlUrl` / `headSha` / `mergeCommitSha` have no v1 local
 *   producer (Epic F enrichment) → null. `additions`/`deletions`/`filesChanged`
 *   are inherited from `row` — now populated from FEA-1899 branch enrichment
 *   when available, else null.
 */
function projectBranchDetail(
  row: BranchRow,
  associatedPullRequests: DesktopDetailPullRequestSelection["associatedPullRequests"],
  branchLinks: BranchLinkRow[],
  branchCommits: BranchCommitRow[],
  lifecycleEventRows: BranchLifecycleEventRow[],
  sessionTokenRows: BranchSessionTokenRow[],
  loadedSessions: SyncedAgentSession[],
  branchCounts: Map<string, number>
): BranchPageDetail {
  const selectedPullRequest = associatedPullRequests.selected;

  // One link row per session (a session may be linked more than once); prefer a
  // primary link, else keep the first seen.
  const linkBySession = new Map<string, BranchLinkRow>();
  for (const link of branchLinks) {
    const existing = linkBySession.get(link.sessionId);
    if (!existing || (link.isPrimary && !existing.isPrimary)) {
      linkBySession.set(link.sessionId, link);
    }
  }
  const loadedById = new Map(
    loadedSessions.map((session) => [session.externalSessionId, session])
  );
  const phaseSegmentsBySession =
    lifecyclePhaseSegmentsBySession(lifecycleEventRows);
  const lifecycleEvents =
    groupBranchLifecycleEventsBySession(lifecycleEventRows);
  const tokenBySession = new Map(
    sessionTokenRows.map((tokenRow) => [tokenRow.sessionId, tokenRow])
  );
  const sessions: BranchSession[] = row.sessionIds.map((sessionId) => {
    const link = linkBySession.get(sessionId);
    const isPrimary = link?.isPrimary ?? false;
    // FEA-2276: the session's even-split divisor (touches this branch only → 1).
    const branchCount = branchCounts.get(sessionId) ?? 1;
    const loaded = loadedById.get(sessionId);
    const phaseSegments = phaseSegmentsBySession.get(sessionId);
    const tokenRow = tokenBySession.get(sessionId);
    if (loaded) {
      return toEnrichedBranchSession(
        loaded,
        isPrimary,
        branchCount,
        phaseSegments,
        tokenRow
      );
    }
    // Session did not hydrate (not in the local store, or load returned a
    // subset): keep the honest link-row spine, never a fabricated zero-cost.
    return {
      sessionId,
      slug: null,
      name: null,
      harness: "",
      startedAt: link?.observedAt ?? row.lastActivityAt,
      endedAt: null,
      isPrimary,
      // FEA-2276: even-split divisor the rollup applies (touches this branch → 1).
      branchCount,
      estimatedCostUsd: tokenRow?.costUsdEstimated ?? null,
      ...(tokenRow ? { evenSplitCostUsd: tokenRow.evenSplitCostUsd } : {}),
      inputTokens: tokenRow?.inputTokens ?? 0,
      outputTokens: tokenRow?.outputTokens ?? 0,
      cacheReadTokens: tokenRow?.cacheReadTokens ?? 0,
      cacheWriteTokens: tokenRow?.cacheWriteTokens ?? 0,
      ...(phaseSegments && phaseSegments.length > 0 ? { phaseSegments } : {}),
      // FEA-3576 — un-hydrated (not in the local store) session: keep the honest
      // spine, never a fabricated owner. Null → the timeline's "unattributed"
      // bucket (and its null cost keeps it out of the cost-sized segments too).
      ownerUserName: null,
    };
  });

  // PLN-1148 Phase 2: the detail no longer builds the events-heavy mergedTrace —
  // it light-hydrates (`omitEventData`), so the heavy `data` blobs are never
  // loaded here. The trace is fetched lazily via `getSharedBranchTrace` when the
  // Sessions & timeline tab opens; the default view's only trace need (the
  // lead-time waterfall) is served by the lightweight `leadTime` summary below.
  // `buildBranchLeadTime` is guarded so a projection failure degrades to an empty
  // summary instead of 500-ing the whole detail (matching the loader's contract).
  let leadTime: BranchLeadTimeActivity;
  try {
    leadTime = buildBranchLeadTime(loadedSessions);
  } catch {
    leadTime = { firstActivityT: null, lastActivityT: null, idleSpans: [] };
  }
  const phaseAttribution = buildDesktopPhaseAttribution({
    sessions,
    lifecycleEventsBySession: lifecycleEvents,
    associatedPullRequests: associatedPullRequests.collection,
    loadedSessions,
  });

  return {
    ...row,
    associatedPullRequests: associatedPullRequests.collection,
    ...selectedPullRequestDetailFields(associatedPullRequests),
    prBody: null,
    prBodyHtmlUrl: null,
    headSha: null,
    mergeCommitSha: null,
    mergedAt: selectedPullRequest?.mergedAt ?? null,
    closedAt: selectedPullRequest?.closedAt ?? null,
    // PRD-486: PR-opened time + the per-commit dots for the activity rail. Commits
    // are ordered oldest-first by their real commit time (already ASC from the
    // read; sorted defensively in case the narrowing reorders).
    openedAt: selectedPullRequest?.openedAt ?? null,
    commits: branchCommits
      .map((commit) => ({
        sha: commit.sha,
        committedAt: commit.committedAt,
        message: commit.message ?? "",
      }))
      .sort((a, b) => isoEpoch(a.committedAt) - isoEpoch(b.committedAt)),
    sessions,
    // Deferred to the lazy trace fetch (PLN-1148 Phase 2) — never shipped here.
    mergedTrace: [],
    leadTime,
    phaseAttribution,
    ...(phaseAttribution.rollups.length > 0
      ? {
          lifecyclePhaseStacks: phaseAttribution.rollups.map((rollup) => ({
            phase: rollup.phase,
            estimatedCostUsd: rollup.estimatedCostUsd,
            inputTokens: rollup.inputTokens,
            outputTokens: rollup.outputTokens,
            cacheReadTokens: rollup.cacheReadTokens,
            cacheWriteTokens: rollup.cacheWriteTokens,
            sessionCount: rollup.sessionCount,
          })),
        }
      : {}),
    linkedPrNumbers: [
      ...new Set(
        associatedPullRequests.collection.items.map(
          (pullRequest) => pullRequest.number
        )
      ),
    ],
    ...localDeliveredArtifactFields(row.branchName),
  };
}

/**
 * Hydrate the branch's contributing sessions (real per-session token splits/cost
 * + the merged-trace source) via the optional agent-session loader. A source
 * without `syncSource`, an empty session set, or a load failure degrades to `[]`
 * so the detail still renders from the Prisma branch-reads projection (the
 * per-session usage falls back to the link-row spine and the trace to empty).
 */
async function loadBranchSessions(
  source: BranchSyncSource,
  sessionIds: readonly string[],
  options?: { omitEventData?: boolean }
): Promise<SyncedAgentSession[]> {
  if (!source.syncSource || sessionIds.length === 0) {
    return [];
  }
  const cache: SessionAttributionResolverCache = {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
  try {
    return await source.syncSource.loadSyncedSessions(
      [...sessionIds],
      cache,
      options
    );
  } catch {
    // The trace/usage enrichment is best-effort; a loader failure must not 500
    // the whole detail when the Prisma branch-reads projection already succeeded.
    return [];
  }
}

/**
 * Project one local branch into the canonical detail response. Reuses the list
 * projection for branch identity (so `id` round-trips with the list keys and the
 * Epic C detail route), hydrates the contributing sessions for per-session usage
 * + the cross-session merged trace, then fills the body via `projectBranchDetail`.
 * Returns `null` — translated to a typed 404 at the IPC boundary — for a missing
 * source, a non-string/empty id, or an id that matches no local branch.
 *
 * PLN-1148 Phase 1: payload reads stay scoped to the requested branch. The
 * authority gate separately reads only the DISTINCT global branch keys so its
 * even-split divisor is computed from the complete eligible corpus.
 */
export async function getSharedBranchDetail(
  source: BranchSyncSource | null | undefined,
  id: unknown,
  cloudHydration?: BranchCloudHydrationSource,
  options: Omit<SharedBranchesDetailRequest, "id"> = {}
): Promise<BranchPageDetail | null> {
  if (!source) {
    return null;
  }
  if (typeof id !== "string" || id.length === 0) {
    return null;
  }
  // The branch identity the scoped reads filter on — the exact inverse of the
  // list's `encodeBranchId`, so the detail reads the SAME branch the id names.
  const key = decodeBranchId(id);
  const perf = startBranchDetailPerf(id);
  try {
    const rawLinkRows = await readLocalBranchLinkRowsForBranch(
      source.prisma,
      key
    );
    if (rawLinkRows.length === 0) {
      perf.mark("links", 0);
      perf.done("not-found");
      return null;
    }
    const rawCandidateRows = await readDistinctBranchKeyRows(source.prisma);
    const eligibilitySnapshot = await resolveBranchProductEligibilitySnapshot(
      rawCandidateRows,
      cloudHydration,
      { forceRefresh: options.forceRefresh, scope: "detail" }
    );
    const linkRows = filterEligibleBranchRows(rawLinkRows, eligibilitySnapshot);
    perf.mark("links", linkRows.length);
    if (linkRows.length === 0) {
      perf.done("not-found");
      return null;
    }
    const sessionIds = [...new Set(linkRows.map((link) => link.sessionId))];
    const eligibleKeys = eligibleBranchKeys(
      rawCandidateRows,
      eligibilitySnapshot
    );
    const denominatorKeys = denominatorEligibleBranchKeys(
      rawCandidateRows,
      eligibilitySnapshot
    );
    // The remaining branch-scoped reads are independent — run them together.
    const [
      prRows,
      tokenRows,
      commitRows,
      activityRows,
      lifecycleEventRows,
      sessionTokenRows,
      branchCounts,
    ] = await Promise.all([
      readLocalBranchPrRowsForBranch(source.prisma, key).then((rows) =>
        filterEligibleBranchRows(rows, eligibilitySnapshot)
      ),
      readBranchTokenAggregateRowsForBranch(
        source.prisma,
        key,
        eligibleKeys,
        denominatorKeys
      ),
      readBranchCommitRowsForSessions(source.prisma, sessionIds, key),
      readBranchCanonicalActivityRowsForScope(source, {
        branchKeys: eligibleBranchKeys(linkRows, eligibilitySnapshot),
      }),
      readBranchLifecycleEventRowsForBranch(source.prisma, key),
      readBranchSessionTokenRowsForBranch(source.prisma, key, denominatorKeys),
      // FEA-2276: each session's global active-write branch count (the even-split
      // divisor) so the activity rollup splits attributed cost the same way the
      // branch total is split.
      readSessionBranchCounts(source.prisma, sessionIds, denominatorKeys),
    ]);
    perf.mark("reads");
    // The reads are already scoped to this branch, so the list projection yields
    // exactly this branch's row — no cross-branch `encodeBranchId` filter needed.
    const lastActiveByBranch = projectDesktopBranchLastActive(
      branchIdsForLinks(linkRows),
      activityRows,
      prRows,
      commitRows
    );
    const row = projectBranchListItems(
      linkRows,
      prRows,
      tokenRows,
      lastActiveByBranch
    ).find((item) => item.id === id);
    if (!row) {
      perf.done("not-found");
      return null;
    }
    const pullRequestSelection = selectDesktopDetailPullRequest(
      prRows,
      options,
      linkRows.map(completeArtifactLoc).find((loc) => loc != null) ?? null
    );
    if (!pullRequestSelection) {
      perf.done("not-found");
      return null;
    }
    const selectedRow: BranchRow = {
      ...row,
      ...pullRequestSelection.selectedRowFields,
    };
    // PLN-1148 Phase 2: LIGHT hydration — `omitEventData: true` drops the heavy
    // event `data` blobs (the dominant load term), keeping only what the sessions
    // list (token/cost/name/harness) and the lead-time summary (event instants)
    // need. The events-heavy `mergedTrace` is built lazily by `getSharedBranchTrace`
    // when the Sessions & timeline tab opens.
    const loadedSessions = await loadBranchSessions(source, row.sessionIds, {
      omitEventData: true,
    });
    perf.mark("sessions", loadedSessions.length);
    const detail = projectBranchDetail(
      selectedRow,
      pullRequestSelection.associatedPullRequests,
      linkRows,
      commitRows,
      lifecycleEventRows,
      sessionTokenRows,
      loadedSessions,
      branchCounts
    );
    const [hydrated] = await applyCloudHydration(
      [detail],
      pullRequestSelection.requested ? undefined : cloudHydration,
      {
        forceRefresh: options.forceRefresh,
        resolvedResult: eligibilitySnapshot?.resolvedHydration,
        scope: "detail",
      }
    );
    const resolved = hydrated ?? detail;
    attachDesktopCanonicalDetailMetrics(resolved, prRows, lifecycleEventRows);
    perf.done("ok", {
      sessions: resolved.sessions.length,
      idleSpans: resolved.leadTime.idleSpans.length,
    });
    return resolved;
  } catch (error) {
    perf.done("error");
    rethrowAsSourceError("getSharedBranchDetail", error);
  }
}

/**
 * The branch's events-heavy cross-session merged trace (PLN-1148 Phase 2),
 * fetched lazily by the Sessions & timeline tab — split out of
 * `getSharedBranchDetail` so the DEFAULT branch-detail view never loads the
 * multi-KB event `data` blobs the trace projection needs. Reuses the same scoped
 * link read for branch identity + the session set, then FULL-hydrates those
 * sessions (`omitEventData` off) and builds the trace.
 *
 * Best-effort like the in-detail trace it replaces: a missing source, an unknown
 * id, or any read/projection failure degrades to an empty trace rather than
 * throwing, so the tab renders an empty timeline instead of erroring.
 */
/**
 * Aggregate local branches into the canonical usage summary. Rolls up one token
 * row per `(session, model)` for branch-linked sessions (counted once) and hands
 * them to A3's `projectBranchUsageSummary`. Owner has no v1 producer, so
 * `byActor` collapses to a single unattributed bucket; phase is unset, so
 * `phaseStacks` is empty; billing split follows whatever `billing_mode` the
 * local sessions carry (0 when unset).
 */
export async function getSharedBranchUsage(
  source: BranchSyncSource | null | undefined,
  request: SharedBranchesQuery = {},
  cloudHydration?: BranchCloudHydrationSource
): Promise<BranchUsageSummary> {
  if (!source) {
    return emptySharedBranchesUsageSummary();
  }
  if (hasUnsupportedCloudFilter(request)) {
    return emptySharedBranchesUsageSummary();
  }
  try {
    // Project canonical Last-active from monitored activity + PR lifecycle +
    // commits so usage selects the same window as the list. One item per encoded
    // branch identity also supplies the all-time distinct-branch count.
    const [tokenRows, eventRows, rawLinkRows, rawPrRows, rawCommitRows] =
      await Promise.all([
        readBranchUsageTokenRows(source.prisma),
        // ISS-4941: bounded by the request window — a provable superset of the
        // `filterEventRowsByEventWindow` pass below, so no number moves.
        readBranchUsageEventRows(source.prisma, eventWindowSqlBounds(request)),
        readLocalBranchLinkRows(source.prisma),
        readLocalBranchPrRows(source.prisma),
        readLocalBranchCommitRows(source.prisma),
      ]);
    const eligibilitySnapshot = await resolveBranchProductEligibilitySnapshot(
      rawLinkRows,
      cloudHydration,
      { scope: "list" }
    );
    if (eligibilitySnapshot?.coverageComplete === false) {
      throw new Error("repository default eligibility coverage unavailable");
    }
    const linkRows = filterEligibleBranchRows(rawLinkRows, eligibilitySnapshot);
    const prRows = filterEligibleBranchRows(rawPrRows, eligibilitySnapshot);
    const commitRows = filterEligibleBranchRows(
      rawCommitRows,
      eligibilitySnapshot
    );
    const activityRows = await readBranchCanonicalActivityRowsForScope(source, {
      branchKeys: eligibleBranchKeys(linkRows, eligibilitySnapshot),
    });
    const lastActiveByBranch = projectDesktopBranchLastActive(
      branchIdsForLinks(linkRows),
      activityRows,
      prRows,
      commitRows
    );
    // No usage KPI surfaces per-branch cost, so the per-branch token aggregate is
    // skipped (pass [] for tokens); branch identity + canonical Last-active are
    // what the window keys on.
    const windowed = filterBranchItemsByWindow(
      projectBranchListItems(linkRows, prRows, [], lastActiveByBranch),
      request
    );
    const windowedSessionIds = collectSessionIds(windowed);
    const branchCount = windowed.length;
    // Restrict both reads so the rollup reconciles with the windowed surface.
    //
    // FEA-4270: each event's `created_at` splits long sessions across windows,
    // matching the cloud API producer so the shared Branches
    // cards report the SAME windowed AI spend.
    //   • WINDOW ACTIVE → totals AND hour buckets both come from per-event
    //     `token_events` rows (which now carry per-event cost) windowed by
    //     `created_at`. Each event counts in the window of its own timestamp.
    //   • ALL-TIME (no window) → totals/cost from the aggregate per-(session,
    //     model) `token_usage` read (so legacy sessions with totals but no
    //     per-event rows still count); hour buckets from per-event rows as before.
    const branchTokenRows = tokenRows.filter((row) =>
      windowedSessionIds.has(row.sessionId)
    );
    const branchEventRows = eventRows.filter((row) =>
      windowedSessionIds.has(row.sessionId)
    );
    const windowActive = isDateWindowActive(request);
    const selectedEventRows = filterEventRowsByEventWindow(
      branchEventRows,
      request
    );
    const rows = (windowActive ? selectedEventRows : branchTokenRows).map(
      branchUsageRowFromTokenRow
    );
    const hourRows = selectedEventRows.map(branchUsageRowFromTokenRow);
    const costEvidence = await resolveDesktopBranchCostCompleteness(
      source.prisma,
      branchTokenRows,
      branchEventRows,
      selectedEventRows,
      windowActive
    );
    return projectBranchUsage(rows, branchCount, hourRows, costEvidence);
  } catch (error) {
    rethrowAsSourceError("getSharedBranchUsage", error);
  }
}

/**
 * Project already-fetched branch and usage evidence into canonical analytics.
 * Standalone and page-data callers share this tail to avoid duplicate reads.
 */
export async function buildBranchAnalyticsResult(
  prisma: Parameters<typeof readSessionBranchCounts>[0],
  linkRows: Awaited<ReturnType<typeof readLocalBranchLinkRows>>,
  prRows: Awaited<ReturnType<typeof readLocalBranchPrRows>>,
  commitRows: Awaited<ReturnType<typeof readLocalBranchCommitRows>>,
  activityRows: readonly BranchCanonicalActivityRow[],
  usageTokenRows: Awaited<ReturnType<typeof readBranchAnalyticsTokenRows>>,
  request: SharedBranchesQuery,
  cloudHydration: BranchCloudHydrationSource | undefined,
  // Required: a window must never fall back to lifetime aggregate spend.
  metricEventRead: CanonicalBranchMetricEventRead,
  activitySegmentEvidence: Awaited<
    ReturnType<typeof readBranchAnalyticsActivitySegmentRows>
  >,
  lifecycleEvidence: Awaited<
    ReturnType<typeof readBranchAnalyticsLifecycleEventRows>
  >,
  cohortOptions?: {
    branchIds: readonly string[];
    onMatchedBranchIds: (branchIds: string[]) => void;
  },
  eligibilitySnapshot?: BranchDefaultEligibilitySnapshot | null,
  operationLastActiveByBranch?: DesktopBranchLastActiveProjection
): Promise<BranchAnalytics> {
  const { requestBoundary, rows: eventRows } = metricEventRead;
  const resolvedEligibility =
    eligibilitySnapshot ??
    (await resolveBranchProductEligibilitySnapshot(linkRows, cloudHydration, {
      scope: "list",
    }));
  const eligibleLinkRows = filterEligibleBranchRows(
    linkRows,
    resolvedEligibility
  );
  const eligiblePrRows = filterEligibleBranchRows(prRows, resolvedEligibility);
  const eligibleCommitRows = filterEligibleBranchRows(
    commitRows,
    resolvedEligibility
  );
  const lastActiveByBranch =
    operationLastActiveByBranch ??
    projectDesktopBranchLastActive(
      branchIdsForLinks(eligibleLinkRows),
      activityRows,
      eligiblePrRows,
      eligibleCommitRows
    );
  // Hydrate the exact selected population, then window both hydrated and local
  // rows by the immutable canonical Last-active result. The two arrays retain
  // identical membership because hydration cannot overwrite that field.
  const projectedItems = projectBranchListItems(
    eligibleLinkRows,
    eligiblePrRows,
    [],
    lastActiveByBranch
  );
  const allHydratedItems = await applyCloudHydration(
    projectedItems,
    cloudHydration,
    {
      resolvedResult: resolvedEligibility?.resolvedHydration,
      scope: "list",
    }
  );
  const selectedProjectedItems = cohortOptions
    ? selectExactBranchCohort(projectedItems, cohortOptions.branchIds)
    : projectedItems;
  const selectedHydratedItems = cohortOptions
    ? selectExactBranchCohort(allHydratedItems, cohortOptions.branchIds)
    : allHydratedItems;
  const windowedProjectedItems = filterBranchItemsByWindow(
    selectedProjectedItems,
    request
  );
  const windowed = filterBranchItemsByWindow(selectedHydratedItems, request);
  const windowedSessionIds = collectSessionIds(windowed);
  const windowActive = isDateWindowActive(request);
  const windowedUsageRows = windowActive
    ? filterEventRowsByEventWindow(
        eventRows.filter((row) => windowedSessionIds.has(row.sessionId)),
        request
      )
    : usageTokenRows.filter((row) => windowedSessionIds.has(row.sessionId));

  const totalSpendUsd = sumStoredBranchCost(
    windowedUsageRows.map(branchUsageRowFromTokenRow)
  );
  // Report corrupt totals here before the pure shared projector degrades them
  // to a null card value; Electron logging stays out of node tests.
  if (isAnomalousSpendTotal(totalSpendUsd)) {
    writePersistentLog(
      "warn",
      "branch-analytics",
      `invalid AI-spend total ${String(totalSpendUsd)} over ${windowedUsageRows.length} usage row(s); reporting no-data`
    );
  }
  // LOC/$ stays lifetime on both sides; only cohort membership is windowed.
  const lifetimeUsageRows = usageTokenRows.filter((row) =>
    windowedSessionIds.has(row.sessionId)
  );
  // Global session branch counts preserve the authoritative even-split divisor.
  const canonicalSessionIds = [...collectSessionIds(windowed)].sort();
  const admittedCanonicalSessionIds = canonicalSessionIds.slice(
    0,
    CANONICAL_METRIC_SESSION_MAX
  );
  const branchCountBySession = await readSessionBranchCounts(
    prisma,
    admittedCanonicalSessionIds,
    denominatorEligibleBranchKeys(linkRows, resolvedEligibility)
  );
  const locEnrichedSpendUsd = sumLocEnrichedSpend(
    windowed,
    lifetimeUsageRows,
    branchCountBySession
  );
  const analytics = projectBranchAnalytics(windowed, {
    totalSpendUsd,
    locEnrichedSpendUsd,
  });
  analytics.canonicalMetrics = projectDesktopCanonicalMetrics(
    windowed,
    eligibleLinkRows,
    eligiblePrRows,
    request,
    requestBoundary,
    eventRows,
    branchCountBySession,
    buildPhaseEvidence(activitySegmentEvidence, lifecycleEvidence, {
      admitted: admittedCanonicalSessionIds.length,
      canonical: canonicalSessionIds.length,
    }),
    windowedProjectedItems,
    isEligibilityCoverageCompleteForCohort(
      resolvedEligibility,
      windowed.map((item) => item.id)
    ),
    resolvedEligibility?.pullRequestCoverageComplete !== false
  );
  // Report identities from the same fail-closed cohort as canonical metrics.
  cohortOptions?.onMatchedBranchIds(windowed.map((item) => item.id));
  return analytics;
}

/**
 * Combined list + analytics read for the Branches screen (FEA-3056 follow-up).
 * The screen mounts its list and analytics reads together on every load;
 * independently, each re-runs the SAME link/PR/commit table scans, doubling the
 * actual DB + IPC work per page view. This op runs those reads ONCE, plus one
 * eligible-corpus canonical activity read and both token reads, which price the two
 * projections differently — see {@link buildBranchAnalyticsResult}) and derives
 * both responses from the shared rows, so a page load pays for the scan once.
 */
export async function getSharedBranchesPageData(
  source: BranchSyncSource | null | undefined,
  request: SharedBranchesListRequest = {},
  cloudHydration?: BranchCloudHydrationSource
): Promise<SharedBranchesPageDataResponse> {
  if (!source) {
    return emptySharedBranchesPageDataResponse();
  }
  if (hasUnsupportedCloudFilter(request)) {
    return emptySharedBranchesPageDataResponse();
  }
  try {
    // Shared list reads are FATAL — a failure here throws and blanks both halves
    // (the table can't render without them). The analytics-only token read
    // (`readBranchAnalyticsTokenRows`) is NOT in this list: it feeds only the
    // best-effort analytics half below (wongk review, FEA-4177 — see next block).
    const [rawLinkRows, rawPrRows, rawCommitRows] = await Promise.all([
      readLocalBranchLinkRows(source.prisma),
      readLocalBranchPrRows(source.prisma),
      readLocalBranchCommitRows(source.prisma),
    ]);
    const eligibilitySnapshot = await resolveBranchProductEligibilitySnapshot(
      rawLinkRows,
      cloudHydration,
      { forceRefresh: request.forceRefresh, scope: "list" }
    );
    const linkRows = filterEligibleBranchRows(rawLinkRows, eligibilitySnapshot);
    const prRows = filterEligibleBranchRows(rawPrRows, eligibilitySnapshot);
    const commitRows = filterEligibleBranchRows(
      rawCommitRows,
      eligibilitySnapshot
    );
    const branchKeys = eligibleBranchKeys(linkRows, eligibilitySnapshot);
    const denominatorKeys = denominatorEligibleBranchKeys(
      rawLinkRows,
      eligibilitySnapshot
    );
    const [tokenRows, activityRows] = await Promise.all([
      readBranchTokenAggregateRows(source.prisma, branchKeys, denominatorKeys),
      readBranchCanonicalActivityRowsForScope(source, { branchKeys }),
    ]);
    const lastActiveByBranch = projectDesktopBranchLastActive(
      branchIdsForLinks(linkRows),
      activityRows,
      prRows,
      commitRows
    );
    const requestBoundary = new Date();
    // FEA-4177 — independent failure domains. The list is the required half and
    // is built from the fatal shared reads only, so an analytics-side failure
    // never blanks the table.
    //
    // wongk review: the analytics-only per-session usage read
    // (`readBranchAnalyticsTokenRows`) and the FEA-3695 cost-map projection it
    // feeds MUST live inside the best-effort analytics half. Previously that read
    // ran in the outer fatal `Promise.all`, so an analytics SQL failure rejected
    // before the `allSettled` and the list disappeared — contrary to the
    // page-data contract. Moving it here means an analytics read/build failure
    // degrades ONLY the summary cards (`analytics` omitted, `analyticsError:
    // true`): the list still renders, just without `sessionCostUsd` (the client
    // falls back to the legacy branch-total inference, exactly like the
    // standalone `getSharedBranches` read).
    const buildAnalyticsHalf = async (): Promise<{
      analytics: BranchAnalytics;
      sessionCostUsd?: Readonly<Record<string, number>>;
      lifetimeSessionCostUsd?: Readonly<Record<string, number>>;
    }> => {
      const [usageTokenRows, metricEventRead, lifecycleEvidence] =
        await Promise.all([
          readBranchAnalyticsTokenRows(source.prisma),
          readCanonicalBranchMetricEventRows(source, request, requestBoundary),
          readBranchAnalyticsLifecycleEventRows(source.prisma),
        ]);
      // FEA-3695 — the authoritative per-session cost map (each session once),
      // built from the SAME rows the analytics spend KPI prices, so the client's
      // filtered re-derivation cannot drift from the headline. Omitted when
      // nothing prices so an unpriced corpus's list stays byte-for-byte identical
      // to the standalone read (the "no drift" contract).
      // FEA-4270: under an active window the map is per-session WINDOWED cost
      // (summed from in-window events), mirroring the cloud `sessionCostUsd`
      // map; all-time keeps the aggregate per-session lifetime cost.
      const costRows = isDateWindowActive(request)
        ? filterEventRowsByEventWindow(metricEventRead.rows, request)
        : usageTokenRows;
      const sessionCostMap = sessionCostMapFromUsageRows(costRows);
      const sessionCostUsd =
        Object.keys(sessionCostMap).length > 0 ? sessionCostMap : undefined;
      // ISS-4632 — the LIFETIME per-session cost map (always the aggregate
      // `usageTokenRows`, never windowed) for the client's Value-per-$ ratio
      // denominator, mirroring the cloud `lifetimeSessionCostUsd`. Equals
      // `sessionCostUsd` when no window is active.
      const lifetimeSessionCostMap = isDateWindowActive(request)
        ? sessionCostMapFromUsageRows(usageTokenRows)
        : sessionCostMap;
      const lifetimeSessionCostUsd =
        Object.keys(lifetimeSessionCostMap).length > 0
          ? lifetimeSessionCostMap
          : undefined;
      const analytics = await buildBranchAnalyticsResult(
        source.prisma,
        rawLinkRows,
        rawPrRows,
        rawCommitRows,
        activityRows,
        usageTokenRows,
        request,
        cloudHydration,
        metricEventRead,
        metricEventRead.activitySegments,
        lifecycleEvidence,
        undefined,
        eligibilitySnapshot,
        lastActiveByBranch
      );
      return { analytics, sessionCostUsd, lifetimeSessionCostUsd };
    };
    const [listResult, analyticsResult] = await Promise.allSettled([
      // The list is built WITHOUT `sessionCostUsd` here; the cost map is attached
      // below only when the analytics half succeeds, so a cost-map/analytics
      // failure cannot block or blank the list.
      buildBranchListResult(
        source.prisma,
        linkRows,
        prRows,
        tokenRows,
        lastActiveByBranch,
        request,
        cloudHydration,
        eligibilitySnapshot,
        denominatorKeys
      ),
      buildAnalyticsHalf(),
    ]);
    if (listResult.status === "rejected") {
      throw listResult.reason;
    }
    if (analyticsResult.status === "rejected") {
      return { list: listResult.value, analyticsError: true };
    }
    const { analytics, sessionCostUsd, lifetimeSessionCostUsd } =
      analyticsResult.value;
    // `sessionBranchCount` (ISS-4689) is deliberately NOT attached here —
    // `buildBranchListResult` already emitted it, keeping this list byte-identical
    // to the standalone `getSharedBranches` one (the no-drift contract).
    const list = {
      ...listResult.value,
      ...(sessionCostUsd ? { sessionCostUsd } : {}),
      ...(lifetimeSessionCostUsd ? { lifetimeSessionCostUsd } : {}),
    };
    return { list, analytics };
  } catch (error) {
    rethrowAsSourceError("getSharedBranchesPageData", error);
  }
}

const CANONICAL_METRIC_SESSION_MAX = 900;
