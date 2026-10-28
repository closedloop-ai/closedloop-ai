import { BranchViewerScope } from "@repo/api/src/types/branch";
import { isValidCloudBranchId } from "@repo/api/src/types/branch-id";
import type { BranchTraceResponse } from "@repo/api/src/types/branch-trace";
import { clamp } from "@repo/api/src/utils/math";
import { withDb } from "@repo/database";
import type { BranchTraceQuery } from "../branch-list-query";
import { branchTraceService } from "../branch-trace-service";
import { branchHasCloudEligibility } from "../cloud-branch-eligibility";
import { readCachedBranchTrace } from "./branch-trace-cache";
import { findBranchArtifact } from "./persisted-row-read";

export const BRANCH_TRACE_DEFAULT_LIMIT = 50;

/** Read and page one complete cross-Session trace behind the Product gate. */
export async function readCloudBranchTrace(
  organizationId: string,
  branchId: string,
  query: BranchTraceQuery,
  signal?: AbortSignal
): Promise<BranchTraceResponse | null> {
  if (!isValidCloudBranchId(branchId)) {
    return null;
  }
  // Release the candidate read before per-Session hydration; each Session read
  // opens its own connection and must not contend with a held outer connection.
  const qualifyingSessions = await withDb(async (db) => {
    const row = await findBranchArtifact(db, organizationId, branchId);
    if (!row) {
      return null;
    }
    return branchTraceService.findQualifyingBranchTraceSessions(
      db,
      organizationId,
      branchId
    );
  });
  if (qualifyingSessions === null) {
    return null;
  }
  // Page the chronologically interleaved trace, not its source Sessions.
  const { trace, version } = await readCachedBranchTrace(
    organizationId,
    branchId,
    qualifyingSessions,
    () =>
      branchTraceService.buildCompleteBranchTrace(
        organizationId,
        qualifyingSessions,
        signal
      ),
    signal
  );
  const remainsEligible = await withDb((db) =>
    branchHasCloudEligibility(db, organizationId, branchId)
  );
  if (!remainsEligible) {
    return null;
  }
  if ("complete" in query) {
    return {
      branchId,
      viewerScope: BranchViewerScope.Organization,
      items: trace.items,
      hasMore: false,
      traceState: {
        sessions: trace.sessions,
        qualifyingSessionCount: trace.qualifyingSessionCount,
        completeness: trace.completeness,
        aggregateCompleteness: trace.aggregateCompleteness,
      },
    };
  }
  const limit = clamp(query.limit, 1, BRANCH_TRACE_MAX_LIMIT);
  const cursorMode = "pageMode" in query;
  const cursorParts = cursorMode ? query.cursor?.split(":") : undefined;
  const reset = cursorParts !== undefined && cursorParts[1] !== version;
  const cursorOffset = cursorParts && !reset ? Number(cursorParts[2]) : 0;
  const offset = cursorMode ? cursorOffset : Math.max(0, query.offset);
  const items = trace.items.slice(offset, offset + limit);
  return {
    branchId,
    viewerScope: BranchViewerScope.Organization,
    items,
    hasMore: offset + limit < trace.items.length,
    ...(cursorMode
      ? {
          ...(offset + limit < trace.items.length
            ? { nextCursor: `v1:${version}:${offset + limit}` }
            : {}),
          ...(offset === 0
            ? { overviewItems: trace.items.map(withoutToolBodies) }
            : {}),
          ...(reset ? { reset: true as const } : {}),
        }
      : {}),
    traceState: {
      sessions: trace.sessions,
      qualifyingSessionCount: trace.qualifyingSessionCount,
      completeness: trace.completeness,
      aggregateCompleteness: trace.aggregateCompleteness,
    },
  };
}

export const BRANCH_TRACE_MAX_LIMIT = 100;

// The overview drives the existing markers, costs, actors and playhead. Tool
// expansion bodies belong only to requested pages (ISS-12281).
function withoutToolBodies(item: BranchTraceResponse["items"][number]) {
  if (item.type === "tools") {
    const { items: _bodies, ...overview } = item;
    return overview;
  }
  return item;
}
