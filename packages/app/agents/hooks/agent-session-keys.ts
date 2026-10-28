import {
  hashKey,
  type QueryFilters,
  type QueryKey,
} from "@tanstack/react-query";
import type { AgentSessionQueryFilters } from "../data-source/agent-sessions-data-source";
/**
 * The filter-based reads (`list`/`usage`/`analytics`) carry a `scope` segment —
 * the active data source's identity — between the read-type prefix and the
 * filters. This isolates one source's cache entries from another's so a surface
 * that swaps sources (desktop local DB ↔ authenticated backend) never serves
 * stale cross-source rows for the same filters. The scope sits *after* the
 * prefix, so the unscoped prefixes (`lists`/`usages`/`analyticsRoot`) still
 * match every scope for invalidation. Detail also carries the source scope:
 * local and cloud detail projections can diverge during sync/version-skew
 * windows, so a source switch must never render a same-id stale detail row.
 */
export const agentSessionKeys = {
  all: ["agent-sessions"] as const,
  usages: () => [...agentSessionKeys.all, "usage"] as const,
  usage: (scope: string, filters: Record<string, unknown>) =>
    [...agentSessionKeys.usages(), scope, filters] as const,
  analyticsRoot: () => [...agentSessionKeys.all, "analytics"] as const,
  analytics: (scope: string, filters: Record<string, unknown>) =>
    [...agentSessionKeys.analyticsRoot(), scope, filters] as const,
  lists: () => [...agentSessionKeys.all, "list"] as const,
  list: (scope: string, filters: Record<string, unknown>) =>
    [...agentSessionKeys.lists(), scope, filters] as const,
  // FEA-4157: the combined list + usage read (mirrors `branchesKeys.pageData`).
  // Scoped after the prefix like the other filter-based reads, so the unscoped
  // `pageDataRoot` prefix still matches every scope for invalidation.
  pageDataRoot: () => [...agentSessionKeys.all, "page-data"] as const,
  pageData: (scope: string, filters: Record<string, unknown>) =>
    [...agentSessionKeys.pageDataRoot(), scope, filters] as const,
  details: () => [...agentSessionKeys.all, "detail"] as const,
  detail: (scope: string, id: string) =>
    [...agentSessionKeys.details(), scope, id] as const,
  // ISS-9857: every walk past ONE detail's event prefix, whatever cursor it
  // started from. The live bridge RESETS this prefix when that session changes:
  // a tail append that leaves the prefix (and so the first cursor) unchanged
  // re-keys nothing, and a walk already at exhaustion would otherwise keep
  // reporting "no more" over rows it never saw.
  eventsPagesOf: (scope: string, id: string) =>
    [...agentSessionKeys.detail(scope, id), "events"] as const,
  // ISS-10737: one session's whole agent-component invocation tree, under that
  // session's detail prefix so the live bridge's per-session invalidation
  // already reaches it.
  invocationTree: (scope: string, id: string) =>
    [...agentSessionKeys.detail(scope, id), "invocation-tree"] as const,
  // ISS-10796: one session's collaborator read. A builder rather than a key the
  // hook hand-assembles, so the convergence contract classifies it and its
  // suite walks it — a hand-built key under this same prefix was invisible to
  // `agentSessionCacheConvergence`, so nothing stated what it wanted and it
  // inherited the live bridge's per-detail invalidation plus the desktop
  // `details()` poll defaults (tamsinb review, PR #8461).
  collaborators: (scope: string, id: string) =>
    [...agentSessionKeys.detail(scope, id), "collaborators"] as const,
  // ISS-11004: one session's Activity feed walk, under its detail prefix.
  activity: (scope: string, id: string) =>
    [...agentSessionKeys.detail(scope, id), "activity"] as const,
  // Keyed by the FIRST cursor as well, because that cursor is minted from the
  // prefix's last event — a detail refetch that moves the prefix boundary names
  // a different walk, and the pages loaded after the old boundary must not be
  // served as a continuation of the new one.
  eventsPages: (scope: string, id: string, firstCursor: string) =>
    [...agentSessionKeys.eventsPagesOf(scope, id), firstCursor] as const,
  // Transcript reads (FEA-2717) carry no source scope: transcript bytes always
  // live in S3 and are read through the authenticated cloud route regardless of
  // which list/detail source a surface injects, so one cache is shared across
  // web and authenticated desktop. The parsed-file key folds in `rawSha256` so a
  // re-upload (new archive identity) invalidates the parsed entry automatically.
  transcripts: () => [...agentSessionKeys.all, "transcript"] as const,
  // Keyed by file too (ISS-12276): the route presigns only the requested
  // `fileKey`, so one file's descriptor set cannot serve another file's read.
  transcriptAccess: (id: string, fileKey: string) =>
    [...agentSessionKeys.transcripts(), "access", id, fileKey] as const,
  transcriptFile: (id: string, fileKey: string, rawSha256: string) =>
    [
      ...agentSessionKeys.transcripts(),
      "file",
      id,
      fileKey,
      rawSha256,
    ] as const,
};

/**
 * ISS-8718 — ONE session's detail entry, at whatever source scope, and NOT its
 * children.
 *
 * `eventsPagesOf`, `invocationTree`, `collaborators` and `activity` nest under `detail`, so an optimistic
 * one-field write that invalidated the `details()` prefix refetched every loaded
 * events page of every cached session (tamsinb review, PR #8315). A DEPTH match
 * rather than `detail(scope, id)` because a write does not know which source the
 * surface injected — the id is what it has, and the scope sits between.
 *
 * A filter rather than a member of {@link agentSessionKeys}: that object is key
 * BUILDERS, every one of which the convergence contract classifies and its suite
 * walks as a key. This returns `QueryFilters`, so it lives beside them.
 */
export function agentSessionDetailRowFilter(id: string): QueryFilters {
  const detailsPrefix = agentSessionKeys.details();
  return {
    queryKey: detailsPrefix,
    predicate: (query) =>
      query.queryKey.length === detailsPrefix.length + 2 &&
      query.queryKey.at(-1) === id,
  };
}

/**
 * ISS-11913 — the filters of `useSessionsOutsideWindow`'s unwindowed probe.
 * `countOnly`: the probe reads only `total`, so the desktop-local source can
 * answer with a COUNT; the HTTP source strips the hint. Keyed under `list`, so
 * the list invalidations refresh it.
 */
export const SESSIONS_OUTSIDE_WINDOW_PROBE_FILTERS: AgentSessionQueryFilters = {
  countOnly: true,
  limit: 1,
};

/**
 * True for the outside-window probe's entry at any source scope, so desktop's
 * poll defaults can give it its own cadence and keep it out of the list
 * service-time estimate.
 */
export function isSessionsOutsideWindowProbeKey(queryKey: QueryKey): boolean {
  const scope = queryKey[2];
  return (
    typeof scope === "string" &&
    hashKey(queryKey) ===
      hashKey(
        agentSessionKeys.list(scope, SESSIONS_OUTSIDE_WINDOW_PROBE_FILTERS)
      )
  );
}
