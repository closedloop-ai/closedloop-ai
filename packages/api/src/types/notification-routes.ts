// Resolves notification entity URLs from structured identifiers.
// Single source of truth for the route shapes used by inbox notifications,
// so backend dispatchers never hardcode frontend paths inline.

import {
  getRoutePrefixForType,
  LEGACY_TYPE_ROUTE_PREFIXES,
  TYPE_ROUTE_PREFIX,
} from "./document";

export const NotificationEntityKind = {
  Artifact: "artifact",
  Project: "project",
  Loop: "loop",
  Session: "session",
  Branch: "branch",
} as const;
export type NotificationEntityKind =
  (typeof NotificationEntityKind)[keyof typeof NotificationEntityKind];

/**
 * The branch-detail tab a notification deep-link can request via `?tab=`.
 * Mirrors `BranchDetailTab` in `branch-detail-page.tsx`; kept as a string-literal
 * union here (the SSOT for the notification route shape) so backend dispatchers
 * can select a tab without importing the client component. The branch page
 * defaults to `branch-details`, but the trace-comments rail is only mounted under
 * `sessions-timeline` — so a mention deep-link must request that tab for the
 * commented trace to actually surface.
 */
export const BranchDetailTabParam = {
  BranchDetails: "branch-details",
  SessionsTimeline: "sessions-timeline",
} as const;
export type BranchDetailTabParam =
  (typeof BranchDetailTabParam)[keyof typeof BranchDetailTabParam];

/** Query-string key the branch detail route reads to pick the initial tab. */
export const BRANCH_DETAIL_TAB_PARAM = "tab";

export type NotificationEntityRouteParams =
  | {
      kind: typeof NotificationEntityKind.Artifact;
      slug: string;
      // Document subtype (PRD | IMPLEMENTATION_PLAN | FEATURE | TEMPLATE).
      // Accepts a raw string so callers don't have to narrow before passing.
      subtype: string;
    }
  | {
      kind: typeof NotificationEntityKind.Project;
      teamId: string;
      projectId: string;
    }
  | {
      kind: typeof NotificationEntityKind.Loop;
      loopId: string;
    }
  | {
      kind: typeof NotificationEntityKind.Session;
      sessionId: string;
    }
  | {
      kind: typeof NotificationEntityKind.Branch;
      // Branch artifact id — the `/branches/{id}` detail route resolves the
      // branch by its artifact id (see `useBranchDetail`).
      branchId: string;
      // Optional detail tab to open on arrival, emitted as `?tab=<value>`. A
      // mention deep-link passes `sessions-timeline` so the trace-comments rail
      // (mounted only under that tab) actually shows the commented trace.
      tab?: BranchDetailTabParam;
    };

const ARTIFACT_FALLBACK_PREFIX = "documents";

export function getNotificationEntityPath(
  params: NotificationEntityRouteParams
): string {
  switch (params.kind) {
    case NotificationEntityKind.Artifact: {
      const prefix =
        getRoutePrefixForType(params.subtype) ?? ARTIFACT_FALLBACK_PREFIX;
      return `/${prefix}/${params.slug}`;
    }
    case NotificationEntityKind.Project:
      return `/teams/${params.teamId}/projects/${params.projectId}`;
    case NotificationEntityKind.Loop:
      return `/loops/${params.loopId}`;
    case NotificationEntityKind.Session:
      return `/sessions/${params.sessionId}`;
    case NotificationEntityKind.Branch: {
      const base = `/branches/${params.branchId}`;
      return params.tab
        ? `${base}?${BRANCH_DETAIL_TAB_PARAM}=${params.tab}`
        : base;
    }
    default: {
      const exhaustive: never = params;
      throw new Error(
        `Unhandled notification entity kind: ${JSON.stringify(exhaustive)}`
      );
    }
  }
}

/**
 * Every URL path prefix an Artifact deep-link can use, derived from the canonical
 * `TYPE_ROUTE_PREFIX` (`prds`, `implementation-plans`, `issues`) plus the retired
 * `LEGACY_TYPE_ROUTE_PREFIXES` aliases (`features`, FEA-4137) and the `documents`
 * fallback. Consumers that need to recognize an artifact-detail href (e.g. the
 * mobile navigation adapter's `resolveRouteFromHref`) read this instead of
 * re-hardcoding the prefixes, so the set cannot drift from the emitter above.
 * The legacy aliases are kept so old `/features/[slug]` deep-links (external
 * bookmarks, push notifications minted before the rename) still resolve to the
 * artifact-detail screen — do NOT drop them without human approval.
 */
export const ARTIFACT_ROUTE_PREFIXES: readonly string[] = [
  ...Object.values(TYPE_ROUTE_PREFIX),
  ...Object.values(LEGACY_TYPE_ROUTE_PREFIXES).flat(),
  ARTIFACT_FALLBACK_PREFIX,
];

/**
 * Whether a first path segment is one of the artifact-detail route prefixes an
 * {@link getNotificationEntityPath} Artifact href can start with.
 */
export function isArtifactRoutePrefix(prefix: string): boolean {
  return ARTIFACT_ROUTE_PREFIXES.includes(prefix);
}
