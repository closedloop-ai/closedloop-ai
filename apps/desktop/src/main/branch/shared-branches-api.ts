import {
  type BranchAnalytics,
  type BranchLeadTimeActivity,
  type BranchListResponse,
  type BranchPageDetail,
  type BranchRow,
  type BranchSession,
  decodeBranchId,
  encodeBranchId,
} from "@repo/api/src/types/branch";
import { BranchListPageMode } from "@repo/api/src/types/branch-list-contract";
import type { BranchUsageSummary } from "@repo/api/src/types/branch-usage";
import { compactBranchDetailPayload } from "@repo/lib/branches/branch-detail-payload";
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
import { readBranchAnalyticsLifecycleEventRows } from "../database/branch-analytics-phase-evidence.js";
import type {
  BranchListSnapshot,
  BranchListSnapshotRequest,
} from "../database/branch-list-snapshot-read.js";
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
import { buildBranchAnalyticsResult } from "./branch-analytics-builder.js";
import { sessionCostMapFromUsageRows } from "./branch-analytics-projection.js";
import { attachDesktopCanonicalDetailMetrics as attachMetrics } from "./branch-canonical-metric-projection.js";
import { buildDesktopPhaseAttribution } from "./branch-detail-phase-attribution.js";
import {
  type DesktopDetailPullRequestSelection,
  localDeliveredArtifactFields,
  selectDesktopDetailPullRequest,
  selectedPullRequestDetailFields,
} from "./branch-detail-selected-pull-request.js";
import { readBranchCanonicalActivityRowsForScope } from "./branch-empty-scope-reads.js";
import { projectDesktopBranchLastActive } from "./branch-last-active-projection.js";
import { buildBranchLeadTime } from "./branch-lead-time-projection.js";
import { groupBranchLifecycleEventsBySession } from "./branch-lifecycle-event-grouping.js";
import { lifecyclePhaseSegmentsBySession } from "./branch-lifecycle-phase-rollup.js";
import { readBranchListInputs } from "./branch-list-input-read.js";
import {
  branchIdsForLinks,
  projectBranchListItems,
} from "./branch-list-projection.js";
import { readCanonicalBranchMetricEventRows } from "./branch-metric-event-read.js";
import {
  rethrowAsBranchSourceError as rethrowAsSourceError,
  startBranchDetailPerf,
} from "./branch-read-boundaries.js";
import { toEnrichedBranchSession } from "./branch-session-projection.js";
import { resolveDesktopBranchCostCompleteness } from "./branch-usage-cost-completeness.js";
import {
  branchUsageRowFromTokenRow,
  projectBranchUsage,
} from "./branch-usage-projection.js";
import {
  assertBranchDefaultEligibilityCoverageComplete,
  denominatorEligibleBranchKeys,
  eligibleBranchKeys,
  filterEligibleBranchRows,
  resolveBranchProductEligibilitySnapshot,
} from "./shared-branches-default-eligibility.js";
import {
  buildBranchListResult,
  sliceSessionMap,
} from "./shared-branches-list-result.js";
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

/**
 * Parse an ISO instant to epoch millis for ordering. Unparseable / empty values
 * sort oldest (0) so a branch with a bad timestamp never floats to the top.
 */
function isoEpoch(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
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
  request: SharedBranchesListRequest = {}
): Promise<BranchListResponse> {
  if (!source) {
    return emptySharedBranchesListResponse();
  }
  if (hasUnsupportedCloudFilter(request)) {
    return emptySharedBranchesListResponse();
  }
  try {
    const evaluationNow = new Date();
    const [rawLinkRows, rawPrRows, rawCommitRows] = await Promise.all([
      readLocalBranchLinkRows(source.prisma),
      readLocalBranchPrRows(source.prisma),
      readLocalBranchCommitRows(source.prisma),
    ]);
    const eligibilitySnapshot =
      resolveBranchProductEligibilitySnapshot(rawLinkRows);
    const linkRows = filterEligibleBranchRows(rawLinkRows, eligibilitySnapshot);
    const prRows = filterEligibleBranchRows(rawPrRows, eligibilitySnapshot);
    const commitRows = filterEligibleBranchRows(
      rawCommitRows,
      eligibilitySnapshot
    );
    const branchKeys = eligibleBranchKeys(linkRows, eligibilitySnapshot);
    const denominatorKeys = denominatorEligibleBranchKeys(eligibilitySnapshot);
    const [tokenRows, activityRows] = await Promise.all([
      readBranchTokenAggregateRows(source.prisma, branchKeys, denominatorKeys),
      readBranchCanonicalActivityRowsForScope(source, { branchKeys }),
    ]);
    const lastActiveByBranch = projectDesktopBranchLastActive(
      branchIdsForLinks(linkRows),
      activityRows,
      prRows,
      commitRows,
      linkRows
    );
    return await buildBranchListResult({
      prisma: source.prisma,
      linkRows,
      prRows,
      tokenRows,
      lastActiveByBranch,
      request,
      denominatorKeys,
      evaluationNow,
    });
  } catch (error) {
    rethrowAsSourceError("getSharedBranches", error);
  }
}

/**
 * Build the canonical detail body for one already-projected branch row.
 *
 * The branch identity, status, PR fields, cost, and `sessionIds` come straight
 * from the shared list projection (`row`), so the detail and the list agree
 * byte-for-byte. The detail-only fields are filled from the branch's own PR/link
 * rows and the loaded sessions:
 * - `linkedPrNumbers` / `closedAt` are real (from `pull_requests`); `mergedAt`
 *   comes from the selected PR.
 * - `sessions`: when the session loader hydrated a linked session, it carries
 *   the real name/harness/started/ended + per-session token splits and priced
 *   cost (D1). A session that did NOT hydrate degrades to the minimal link-row
 *   spine (real `sessionId` + `isPrimary` + observed time, null/0 usage) rather
 *   than being dropped.
 * - `mergedTrace`: the chronological cross-session trace built from the loaded
 *   sessions' turn items (empty when no session hydrated).
 * - `prBody` / `prBodyHtmlUrl` / `headSha` / `mergeCommitSha` have no v1 local
 *   producer → null. `additions`/`deletions`/`filesChanged` are inherited from
 *   `row` and are null locally.
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
    const eligibilitySnapshot =
      resolveBranchProductEligibilitySnapshot(rawCandidateRows);
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
    const denominatorKeys = denominatorEligibleBranchKeys(eligibilitySnapshot);
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
      commitRows,
      linkRows
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
      options
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
    attachMetrics(detail, prRows, lifecycleEventRows, selectedRow, linkRows);
    perf.done("ok", {
      sessions: detail.sessions.length,
      idleSpans: detail.leadTime.idleSpans.length,
    });
    return compactBranchDetailPayload(detail);
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
 * them to the main-local `projectBranchUsage`. Owner has no v1 producer, so
 * `byActor` collapses to a single unattributed bucket; phase is unset, so
 * `phaseStacks` is empty; billing split follows whatever `billing_mode` the
 * local sessions carry (0 when unset).
 */
export async function getSharedBranchUsage(
  source: BranchSyncSource | null | undefined,
  request: SharedBranchesQuery = {}
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
    const eligibilitySnapshot =
      resolveBranchProductEligibilitySnapshot(rawLinkRows);
    assertBranchDefaultEligibilityCoverageComplete(eligibilitySnapshot);
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
      commitRows,
      linkRows
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

/** Read the Branches screen's list and failure-isolated analytics together. */
export async function getSharedBranchesPageData(
  source: BranchSyncSource | null | undefined,
  request: SharedBranchesListRequest = {},
  readListSnapshot?: (
    request: BranchListSnapshotRequest
  ) => Promise<BranchListSnapshot>
): Promise<SharedBranchesPageDataResponse> {
  if (!source) {
    return emptySharedBranchesPageDataResponse();
  }
  if (hasUnsupportedCloudFilter(request)) {
    return emptySharedBranchesPageDataResponse();
  }
  try {
    // List snapshot failure is fatal; analytics-only reads remain best-effort.
    const initialRawLinkRows = await readLocalBranchLinkRows(source.prisma);
    const eligibilitySnapshot =
      resolveBranchProductEligibilitySnapshot(initialRawLinkRows);
    const initialLinkRows = filterEligibleBranchRows(
      initialRawLinkRows,
      eligibilitySnapshot
    );
    const branchKeys = eligibleBranchKeys(
      initialLinkRows,
      eligibilitySnapshot
    ).map(toBranchSnapshotKey);
    const denominatorKeys =
      denominatorEligibleBranchKeys(eligibilitySnapshot).map(
        toBranchSnapshotKey
      );
    const snapshot = await readBranchListInputs({
      source,
      request,
      branchKeys,
      denominatorKeys,
      eligibleBranchIds: branchKeys.map(encodeBranchId),
      denominatorEligibleBranchIds: denominatorKeys.map(encodeBranchId),
      readListSnapshot,
      initialRawLinkRows,
    });
    const {
      linkRows: rawLinkRows,
      prRows: rawPrRows,
      commitRows: rawCommitRows,
      tokenRows,
      activityRows,
      sessionBranchCountEntries,
    } = snapshot;
    const linkRows = filterEligibleBranchRows(rawLinkRows, eligibilitySnapshot);
    const prRows = filterEligibleBranchRows(rawPrRows, eligibilitySnapshot);
    const commitRows = filterEligibleBranchRows(
      rawCommitRows,
      eligibilitySnapshot
    );
    const lastActiveByBranch = projectDesktopBranchLastActive(
      branchIdsForLinks(linkRows),
      activityRows,
      prRows,
      commitRows,
      linkRows
    );
    const requestBoundary = new Date();
    // FEA-4177: analytics SQL/cost-map failure degrades only summary cards.
    const buildAnalyticsHalf = async (): Promise<{
      analytics: BranchAnalytics;
      sessionCostUsd?: Readonly<Record<string, number>>;
      lifetimeSessionCostUsd?: Readonly<Record<string, number>>;
    }> => {
      const [usageTokenRows, metricEventRead, lifecycleEvidence] =
        await Promise.all([
          readBranchAnalyticsTokenRows(source.prisma),
          readCanonicalBranchMetricEventRows(source, request, requestBoundary),
          readBranchAnalyticsLifecycleEventRows(source.prisma, branchKeys),
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
      buildBranchListResult({
        prisma: source.prisma,
        linkRows,
        prRows,
        tokenRows,
        lastActiveByBranch,
        request,
        denominatorKeys,
        snapshotBranchCountsBySession:
          request.pageMode === BranchListPageMode.Server
            ? new Map(sessionBranchCountEntries)
            : undefined,
        evaluationNow: requestBoundary,
      }),
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
    if (request.pageMode === BranchListPageMode.Server) {
      return { list: listResult.value, analytics };
    }
    // `sessionBranchCount` (ISS-4689) is deliberately NOT attached here —
    // `buildBranchListResult` already emitted it, keeping this list byte-identical
    // to the standalone `getSharedBranches` one (the no-drift contract).
    const pageSessionCost = sliceSessionMap(
      sessionCostUsd,
      listResult.value.items
    );
    const pageLifetimeSessionCost = sliceSessionMap(
      lifetimeSessionCostUsd,
      listResult.value.items
    );
    const list = {
      ...listResult.value,
      ...(pageSessionCost ? { sessionCostUsd: pageSessionCost } : {}),
      ...(pageLifetimeSessionCost
        ? { lifetimeSessionCostUsd: pageLifetimeSessionCost }
        : {}),
    };
    return { list, analytics };
  } catch (error) {
    rethrowAsSourceError("getSharedBranchesPageData", error);
  }
}

function toBranchSnapshotKey(row: {
  repoFullName: string | null;
  branchName: string;
}): { repoFullName: string | null; branchName: string } {
  return { repoFullName: row.repoFullName, branchName: row.branchName };
}
