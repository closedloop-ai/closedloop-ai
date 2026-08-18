/**
 * @file shared-agent-sessions-query.ts
 * @description The desktop Sessions request -> {@link SanitizedQuery} boundary:
 * the sanitized query shape every local Sessions read runs on, the one function
 * that builds it, and the pure coercions it is made of.
 *
 * Split out of `shared-agent-sessions-api.ts` (a shrink-only grandfathered file)
 * by ISS-5443, which gave `SanitizedQuery` a new responsibility — carrying the
 * read's `dateWindowField`, the single decision that keeps a read's SQL fast
 * path and its hydrated fold windowing on the same timestamp. That decision
 * belongs with the sanitizer that makes it, not buried in the middle of the read
 * surface. Nothing here touches a session row or a data source: it is request
 * validation only, which is why it can be lifted whole.
 */

import type { SessionQuality } from "@repo/api/src/agent-session-filters";
import type { SharedAgentSessionsQuery } from "../../shared/shared-agent-sessions-contract.js";
import type { SessionDateWindowField } from "../agent-sync/session-date-window.js";
import { coerceSessionQuality } from "./session-quality-query.js";
import {
  clampLimit,
  clampOffset,
} from "./shared-agent-sessions-list-bounds.js";

/**
 * Thrown when a request field cannot be sanitized into a {@link SanitizedQuery}
 * (today: an unparseable date bound). Lives here, with the sanitizer that is its
 * only thrower, and is re-exported from `shared-agent-sessions-api.ts` for the
 * callers that catch it.
 */
export class SharedAgentSessionsInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SharedAgentSessionsInputError";
  }
}

export type SanitizedQuery = {
  startDate: Date | null;
  endDate: Date | null;
  // ISS-5443: which timestamp the `startDate`/`endDate` window is measured
  // against. Set once by the read entrypoint — the Sessions surface (list,
  // usage/KPI, page data) declares `SESSIONS_SURFACE_DATE_WINDOW_FIELD`,
  // analytics declares `SESSIONS_ANALYTICS_DATE_WINDOW_FIELD` — and then flows
  // to BOTH the hydrated `matchesDateBounds` fold and, via
  // `buildAggregateFilters`, the SQL aggregate. One decision per read, so a
  // read's two implementations cannot window on different columns.
  dateWindowField: SessionDateWindowField;
  // FEA-3009: completion-time lower bound (`endedAt >= completedAfter`). Null =
  // no completion filter.
  completedAfter: Date | null;
  harness: string | null;
  status: string | null;
  statuses: string[];
  userId: string | null;
  userIds: string[];
  // FEA-4304: the scoped `userId` (the FIXED cross-surface scope — the
  // user-scoped deep link whose badge claims "sessions for the selected user")
  // is AND-ed with the `userIds` Owner facet, never widened/replaced by it —
  // parity with the cloud `applyUserScope`. `sanitizeQuery` intersects the two:
  // when the facet keeps the scoped user, `userId`/`userIds` collapse to the
  // single scoped user; when the facet EXCLUDES the scoped user, the
  // intersection is empty and this flag is set so every read short-circuits to
  // an empty response rather than honoring the wider facet.
  scopeUnsatisfiable: boolean;
  repositories: string[];
  harnesses: string[];
  models: string[];
  autonomyTiers: string[];
  costBuckets: string[];
  changePresence: string[];
  prAssociation: string[];
  // FEA-3284: `substantive` (default) hides idle rows; `all` reveals them.
  quality: SessionQuality;
  search: string | null;
  // FEA-4142: count-only projection hint (the Agents sidebar badge). See
  // `canAnswerWithCount` for when it engages the cheap SQL `COUNT(*)`.
  countOnly: boolean;
  limit: number;
  offset: number;
  sortBy: string | null;
  sortDir: "asc" | "desc";
  hasUnsupportedCloudFilter: boolean;
};

export function sanitizeQuery(
  query: SharedAgentSessionsQuery,
  dateWindowField: SessionDateWindowField
): SanitizedQuery {
  const scope = resolveUserScope(
    coerceOptionalString(query.userId),
    coerceStringArray(query.userIds)
  );
  return {
    startDate: parseOptionalDate(query.startDate, "startDate"),
    endDate: parseOptionalDate(query.endDate, "endDate"),
    dateWindowField,
    completedAfter: parseOptionalDate(query.completedAfter, "completedAfter"),
    harness: coerceOptionalString(query.harness),
    status: coerceOptionalString(query.status),
    statuses: coerceStringArray(query.statuses),
    userId: scope.userId,
    userIds: scope.userIds,
    scopeUnsatisfiable: scope.unsatisfiable,
    repositories: coerceStringArray(query.repositories),
    harnesses: coerceStringArray(query.harnesses),
    models: coerceStringArray(query.models),
    autonomyTiers: coerceStringArray(query.autonomyTiers),
    costBuckets: coerceStringArray(query.costBuckets),
    changePresence: coerceStringArray(query.changePresence),
    prAssociation: coerceStringArray(query.prAssociation),
    // FEA-3284/FEA-3345/FEA-4145: `substantive` hides idle rows and `idle` shows
    // only idle rows; absent (or unrecognized) `quality` resolves to
    // `DEFAULT_SESSION_QUALITY` (`all`, fail-open) so ungated desktop surfaces
    // (Dashboard, Insights) show every session until the Sessions list opts into
    // a narrowed segment. One chokepoint for list/usage/analytics.
    quality: coerceSessionQuality(query.quality),
    search: coerceOptionalString(query.search),
    countOnly: query.countOnly === true,
    limit: clampLimit(query.limit),
    offset: clampOffset(query.offset),
    sortBy: coerceOptionalString(query.sortBy),
    sortDir: query.sortDir === "asc" ? "asc" : "desc",
    hasUnsupportedCloudFilter: hasUnsupportedCloudFilter(query),
  };
}

export function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    const text = coerceNonEmptyString(entry);
    if (text && !seen.has(text)) {
      seen.add(text);
      result.push(text);
    }
  }
  return result;
}

/**
 * FEA-4304: resolve the effective owner scope by AND-ing the scoped `userId`
 * (the FIXED cross-surface scope) with the `userIds` Owner facet — the local
 * mirror of the cloud `applyUserScope`. The facet may only NARROW within the
 * scoped user, never widen past it, so the scoped-user badge can never lie:
 *   • no scoped `userId` → the facet stands alone (its `in` set).
 *   • scoped `userId`, facet keeps it (or no facet) → collapse to the single
 *     scoped user; the redundant/superset facet is dropped.
 *   • scoped `userId`, facet EXCLUDES it → the intersection is empty; flag it
 *     unsatisfiable so every read returns no rows instead of honoring the wider
 *     facet (which would leak another user's sessions under the scoped label).
 */
function resolveUserScope(
  scopedUserId: string | null,
  facetUserIds: string[]
): { userId: string | null; userIds: string[]; unsatisfiable: boolean } {
  if (!scopedUserId) {
    return { userId: null, userIds: facetUserIds, unsatisfiable: false };
  }
  if (facetUserIds.length > 0 && !facetUserIds.includes(scopedUserId)) {
    return { userId: null, userIds: [], unsatisfiable: true };
  }
  return { userId: scopedUserId, userIds: [], unsatisfiable: false };
}

function hasUnsupportedCloudFilter(query: SharedAgentSessionsQuery): boolean {
  return Boolean(
    coerceOptionalString(query.teamId) || coerceOptionalString(query.projectId)
  );
}

export function parseOptionalDate(
  value: unknown,
  fieldName: string
): Date | null {
  const text = coerceOptionalString(value);
  if (!text) {
    return null;
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw new SharedAgentSessionsInputError(
      `${fieldName} must be a valid date`
    );
  }
  return date;
}

export function coerceOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function coerceNonEmptyString(value: unknown): string | null {
  return coerceOptionalString(value);
}

/**
 * {@link coerceStringArray} with a ceiling: the deduped, non-empty session ids
 * of `ids`, stopping at `options.limit` (`null` = unbounded).
 *
 * Extracted from `shared-agent-sessions-api.ts` (ISS-5625) under the ISS-4771
 * shrink-only discipline — it belongs beside the other coercions anyway, since
 * `coerceStringArray` is this same fold without the ceiling.
 */
export function sanitizeIds(
  ids: readonly unknown[],
  options: { limit: number | null }
): string[] {
  const seen = new Set<string>();
  const sanitized: string[] = [];
  for (const value of ids) {
    const id = coerceNonEmptyString(value);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    sanitized.push(id);
    if (options.limit !== null && sanitized.length >= options.limit) {
      break;
    }
  }
  return sanitized;
}
