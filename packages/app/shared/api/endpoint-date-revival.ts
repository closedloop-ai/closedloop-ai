/**
 * Endpoint-scoped exceptions to the `Date` revival allowlist (ISS-6208).
 *
 * ## Why a key allowlist alone is not enough
 *
 * `DATE_REVIVAL_KEYS` is a repo-wide answer to a per-endpoint question. A key
 * earns its place there because SOME response contract declares it a `Date` —
 * but half of that list is declared BOTH ways across the API: `createdAt` is a
 * `Date` on `Document` and a `string` on `ComponentVersion` and
 * `SyncedAgentSessionEvent`; `updatedAt`, `startedAt`, `closedAt`, `mergedAt`
 * and friends collide the same way. One `Date`-typed use legitimized the key
 * globally, so every string contract sharing the name came back as a `Date`
 * while `tsc` still said `string` — the ISS-5771 defect, surviving inside the
 * fix for it.
 *
 * ## The rule
 *
 * The client knows the URL it asked for, so the decision moves to the endpoint.
 * For a request whose path matches a route in
 * `ENDPOINT_STRING_ONLY_DATE_KEYS` (`endpoint-date-revival-table.ts`), the
 * listed keys are NOT
 * revived: that route's own declared payloads resolve them to `string` and never
 * to `Date`, so a `Date` there contradicts the server's own contract.
 *
 * Suppression is deliberately one-directional and fail-safe. A path this table
 * does not know — a route added since, a desktop gateway call, a relay path —
 * falls back to the unscoped allowlist, i.e. exactly the previous behavior. A
 * missed match therefore costs a fix, never a regression.
 *
 * A key an endpoint declares BOTH ways within one response is deliberately
 * ABSENT here rather than suppressed: the reviver sees one key name per body and
 * cannot separate the two uses, so suppressing it would break the `Date` half.
 * `endpoint-date-revival-covered.test.ts` pins that unresolvable set so it
 * cannot grow unnoticed, and re-derives this table from the route payloads so it
 * cannot drift.
 */

import {
  ENDPOINT_STRING_ONLY_DATE_KEYS,
  type EndpointStringOnlyDateKeys,
} from "./endpoint-date-revival-table";

const DYNAMIC_SEGMENT = /^\[.*\]$/;
/** Everything from the first `?` or `#` on is not part of the route path. */
const QUERY_OR_HASH = /[?#]/;
const EMPTY_KEYS: ReadonlySet<string> = new Set<string>();

type CompiledEndpoint = {
  /** `null` marks a dynamic segment, which matches any single path segment. */
  segments: readonly (string | null)[];
  keys: ReadonlySet<string>;
};

/**
 * Compiled once, bucketed by segment count and each bucket ordered so a literal
 * segment outranks a dynamic one at the first position they differ — the same
 * precedence the App Router applies, so `/…/comments/conversation` wins over
 * `/…/comments/[id]`.
 *
 * The ordering is applied INSIDE a bucket, never across the whole table:
 * `compareSpecificity` reads segment by segment, so between two patterns of
 * different lengths it would compare a segment against `undefined` and stop
 * being a consistent total order — and `Array.prototype.sort` is free to permute
 * arbitrarily when its comparator is inconsistent.
 */
const ENDPOINTS_BY_SEGMENT_COUNT: ReadonlyMap<number, CompiledEndpoint[]> =
  groupBySegmentCount(ENDPOINT_STRING_ONLY_DATE_KEYS.map(toCompiledEndpoint));

/**
 * The allowlisted keys this request's endpoint declares only as `string`, and so
 * must NOT be revived into a `Date`.
 *
 * @param requestPath - The path passed to the API client, query string and all.
 * @returns The suppressed keys, or an empty set both for a path this table does
 *   not describe and for a shadow entry — either way the unscoped allowlist
 *   behavior stands for that request.
 */
export function stringOnlyDateKeysForPath(
  requestPath: string
): ReadonlySet<string> {
  const segments = toRequestSegments(requestPath);
  if (segments.length === 0) {
    return EMPTY_KEYS;
  }
  for (const endpoint of ENDPOINTS_BY_SEGMENT_COUNT.get(segments.length) ??
    []) {
    if (matches(endpoint.segments, segments)) {
      return endpoint.keys;
    }
  }
  return EMPTY_KEYS;
}

function toCompiledEndpoint(
  endpoint: EndpointStringOnlyDateKeys
): CompiledEndpoint {
  return {
    keys: new Set(endpoint.keys),
    segments: toSegments(endpoint.route).map((segment) =>
      DYNAMIC_SEGMENT.test(segment) ? null : segment
    ),
  };
}

function toSegments(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

/**
 * A request path is compared by its own segments. The query string and hash are
 * dropped, and each segment is decoded so a percent-encoded LITERAL still
 * matches its own entry rather than falling through to a dynamic sibling. A
 * malformed escape sequence keeps the raw segment rather than throwing — a bad
 * path must degrade to "no suppression", never break parsing.
 */
function toRequestSegments(requestPath: string): string[] {
  const withoutQuery = requestPath.split(QUERY_OR_HASH)[0];
  return toSegments(withoutQuery).map(decodeSegment);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function matches(
  pattern: readonly (string | null)[],
  segments: readonly string[]
): boolean {
  return pattern.every(
    (segment, index) => segment === null || segment === segments[index]
  );
}

/** Only valid between endpoints of EQUAL segment length; see the bucket note. */
function compareSpecificity(
  left: CompiledEndpoint,
  right: CompiledEndpoint
): number {
  for (let index = 0; index < left.segments.length; index += 1) {
    const leftDynamic = left.segments[index] === null;
    const rightDynamic = right.segments[index] === null;
    if (leftDynamic !== rightDynamic) {
      return leftDynamic ? 1 : -1;
    }
  }
  return 0;
}

function groupBySegmentCount(
  endpoints: readonly CompiledEndpoint[]
): Map<number, CompiledEndpoint[]> {
  const grouped = new Map<number, CompiledEndpoint[]>();
  for (const endpoint of endpoints) {
    const count = endpoint.segments.length;
    const existing = grouped.get(count);
    if (existing) {
      existing.push(endpoint);
      continue;
    }
    grouped.set(count, [endpoint]);
  }
  for (const bucket of grouped.values()) {
    bucket.sort(compareSpecificity);
  }
  return grouped;
}
