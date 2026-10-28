import {
  DOCUMENT_ROUTE_PREFIX,
  ISSUES_LIST_ROUTE_SEGMENT,
  LEGACY_TYPE_ROUTE_PREFIXES,
  RETIRED_ISSUES_ROUTE_SEGMENT,
} from "@repo/api/src/types/document";

/**
 * ISS-12855: the legacy per-type detail prefixes (`prds`,
 * `implementation-plans`, `issues`, `features`) redirect to `/documents/:slug`
 * in one hop; `/features/:slug` goes straight there, never via
 * `/issues/:slug`. `permanent` stays true only for the `/features` alias that
 * FEA-3955 specced as permanent; the `prds`/`implementation-plans`/`issues`
 * detail rewrites are temporary (the `RedirectStatus` default for a new
 * rewrite). Removing any of these redirects needs human approval.
 */

/** Segments whose bare list (and anything else under them) is renamed to `/issues` (FEA-4137). */
export const LEGACY_ISSUE_LIST_ROUTE_SEGMENTS: ReadonlySet<string> = new Set([
  RETIRED_ISSUES_ROUTE_SEGMENT,
]);

export type LegacyDocumentRouteRewrite = {
  segment: string;
  permanent: boolean;
};

const LEGACY_DOCUMENT_DETAIL_PREFIXES: ReadonlySet<string> = new Set(
  Object.values(LEGACY_TYPE_ROUTE_PREFIXES).flat()
);

export function resolveLegacyDocumentRouteRewrite(
  segments: readonly string[],
  routeSegmentIndex: number
): LegacyDocumentRouteRewrite | null {
  const routeSegment = segments[routeSegmentIndex];
  if (!routeSegment) {
    return null;
  }
  if (
    LEGACY_DOCUMENT_DETAIL_PREFIXES.has(routeSegment) &&
    isSingleSlugTail(segments, routeSegmentIndex)
  ) {
    return {
      segment: DOCUMENT_ROUTE_PREFIX,
      permanent: routeSegment === RETIRED_ISSUES_ROUTE_SEGMENT,
    };
  }
  if (LEGACY_ISSUE_LIST_ROUTE_SEGMENTS.has(routeSegment)) {
    return { segment: ISSUES_LIST_ROUTE_SEGMENT, permanent: true };
  }
  return null;
}

/**
 * Exactly one non-empty slug segment follows the route segment, optionally
 * followed by a single trailing empty segment (a trailing slash).
 */
function isSingleSlugTail(
  segments: readonly string[],
  routeSegmentIndex: number
): boolean {
  const tail = segments.slice(routeSegmentIndex + 1);
  const [slug, ...rest] = tail;
  if (!slug) {
    return false;
  }
  return rest.length === 0 || (rest.length === 1 && rest[0] === "");
}
