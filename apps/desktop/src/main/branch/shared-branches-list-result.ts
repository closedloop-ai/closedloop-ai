import { ARTIFACT_STATUS_ROOT_ORDER_FLAG_KEY } from "@repo/api/src/types/artifact-status-root-order-flag";
import {
  type BranchListResponse,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import {
  BranchListCohortScope,
  branchListCohortKey,
  completeBranchLastActiveCohort,
} from "@repo/api/src/types/branch-list-cohort";
import { BranchListPageMode } from "@repo/api/src/types/branch-list-contract";
import { branchStatusOrderingFor } from "@repo/api/src/types/branch-status-order";
import {
  buildBranchServerPageSnapshot,
  countImpossibleBranchLastActiveInstants,
  countRetainedUnavailableBranchRows,
} from "@repo/lib/branches/branch-list-page";
import type { SharedBranchesListRequest } from "../../shared/shared-branches-contract.js";
import { isDesktopMainFeatureFlagEnabled } from "../auth/desktop-feature-flag-assignment.js";
import type { DbHostAgentDatabase } from "../database/sqlite.js";
import { writePersistentLog } from "../logging/durable-log-sink.js";
import type { DesktopBranchLastActiveProjection } from "./branch-last-active-projection.js";
import { projectBranchListItems } from "./branch-list-projection.js";
import { toDesktopBranchServerPageQuery } from "./branch-server-page-query.js";
import { readGlobalBranchCountsForItems } from "./shared-branches-divisor.js";
import {
  pageBranches,
  selectRequestedBranches,
} from "./shared-branches-paging.js";
import {
  countRetainedUnavailableBranches,
  filterBranchItemsByWindow,
  sortBranchItemsByLastActive,
} from "./shared-branches-window.js";

/** Build the Desktop list envelope from one already-loaded eligible corpus. */
export async function buildBranchListResult(input: {
  prisma: DbHostAgentDatabase["prisma"];
  linkRows: Parameters<typeof projectBranchListItems>[0];
  prRows: Parameters<typeof projectBranchListItems>[1];
  tokenRows: Parameters<typeof projectBranchListItems>[2];
  lastActiveByBranch: DesktopBranchLastActiveProjection;
  request: SharedBranchesListRequest;
  evaluationNow: Date;
  denominatorKeys: ReadonlyArray<{
    repoFullName: string | null;
    branchName: string;
  }>;
  snapshotBranchCountsBySession?: ReadonlyMap<string, number>;
  sessionCostUsd?: Readonly<Record<string, number>>;
}): Promise<BranchListResponse> {
  const projected = projectBranchListItems(
    input.linkRows,
    input.prRows,
    input.tokenRows,
    input.lastActiveByBranch
  );
  if (input.request.pageMode === BranchListPageMode.Server) {
    const serverQuery = toDesktopBranchServerPageQuery(input.request);
    const nowIso = input.evaluationNow.toISOString();
    // ISS-9437: ONE read of the key, here, resolved into a whole ordering that
    // decides both the Status rank and the Status facet. Main resolves it from
    // the signed-in account's own PostHog assignment (the same key space the
    // renderer reads), and an unresolved assignment is CLOSED — today's order.
    const { cohortRows, page } = buildBranchServerPageSnapshot(
      projected,
      serverQuery,
      nowIso,
      branchStatusOrderingFor(
        isDesktopMainFeatureFlagEnabled(ARTIFACT_STATUS_ROOT_ORDER_FLAG_KEY)
      )
    );
    const branchCountsBySession = await branchCountsForItems(input, page.items);
    const pageSessionCost = sliceSessionMap(input.sessionCostUsd, page.items);
    // ISS-9482 — the desktop half of "route bad server data to monitored paths".
    // A stored Last-active instant that cannot be true (unparseable, out of `Date`
    // range, or after `evaluationNow`) is RETAINED by the window, which stays, but
    // it is retained under the same shape as a branch with no instant at all.
    // Main reports it to the durable diagnostic log, exactly as
    // `branch-analytics-builder.ts` reports an impossible AI-spend total; the
    // shared kernel cannot log at all, because `@repo/lib` sits inside the
    // browser-reachable closure.
    const impossibleLastActiveCount = countImpossibleBranchLastActiveInstants(
      cohortRows,
      nowIso
    );
    if (impossibleLastActiveCount > 0) {
      writePersistentLog(
        "warn",
        "branch-list",
        `impossible last-active instant on ${impossibleLastActiveCount} of ${cohortRows.length} cohort branch(es); retaining them in the window`
      );
    }
    return {
      ...page,
      viewerScope: BranchViewerScope.Self,
      hasMore: page.pageInfo.offset + page.items.length < page.total,
      lastActiveCohort: completeBranchLastActiveCohort({
        scope: BranchListCohortScope.RequestFilters,
        cohortKey: branchListCohortKey(input.request),
        evaluationNow: input.evaluationNow,
        total: page.total,
        retainedUnavailable: countRetainedUnavailableBranchRows(
          cohortRows,
          nowIso
        ),
      }),
      ...(pageSessionCost ? { sessionCostUsd: pageSessionCost } : {}),
      ...(branchCountsBySession.size > 0
        ? { sessionBranchCount: Object.fromEntries(branchCountsBySession) }
        : {}),
    };
  }
  const windowed = filterBranchItemsByWindow(
    projected,
    input.request,
    input.evaluationNow
  );
  const matched = selectRequestedBranches(windowed, input.request.ids);
  const ordered = sortBranchItemsByLastActive(
    matched,
    input.request,
    input.evaluationNow
  );
  const items = pageBranches(
    ordered,
    input.request.limit,
    input.request.offset
  );
  const branchCountsBySession = await branchCountsForItems(input, items);
  return {
    items,
    total: matched.length,
    viewerScope: BranchViewerScope.Self,
    lastActiveCohort: completeBranchLastActiveCohort({
      scope: BranchListCohortScope.RequestFilters,
      cohortKey: branchListCohortKey(input.request),
      evaluationNow: input.evaluationNow,
      total: matched.length,
      retainedUnavailable: countRetainedUnavailableBranches(
        matched,
        input.request,
        input.evaluationNow
      ),
    }),
    ...(input.sessionCostUsd ? { sessionCostUsd: input.sessionCostUsd } : {}),
    ...(branchCountsBySession.size > 0
      ? { sessionBranchCount: Object.fromEntries(branchCountsBySession) }
      : {}),
  };
}

function branchCountsForItems(
  input: Parameters<typeof buildBranchListResult>[0],
  items: BranchListResponse["items"]
): Promise<ReadonlyMap<string, number>> | ReadonlyMap<string, number> {
  if (!input.snapshotBranchCountsBySession) {
    return readGlobalBranchCountsForItems(
      input.prisma,
      items,
      input.denominatorKeys
    );
  }
  const sessionIds = new Set(items.flatMap((item) => item.sessionIds));
  return new Map(
    [...input.snapshotBranchCountsBySession].filter(([sessionId]) =>
      sessionIds.has(sessionId)
    )
  );
}

/**
 * The entries of a per-session map that belong to the sessions of `items`, or
 * `undefined` when there are none. Shared with the snapshot path in
 * `shared-branches-api.ts`.
 */
export function sliceSessionMap(
  values: Readonly<Record<string, number>> | undefined,
  items: readonly { readonly sessionIds: readonly string[] }[]
): Readonly<Record<string, number>> | undefined {
  if (!values) {
    return;
  }
  const sessionIds = new Set(items.flatMap((item) => item.sessionIds));
  const selected = Object.fromEntries(
    [...sessionIds].flatMap((sessionId) => {
      const value = values[sessionId];
      return value === undefined ? [] : [[sessionId, value] as const];
    })
  );
  return Object.keys(selected).length > 0 ? selected : undefined;
}
