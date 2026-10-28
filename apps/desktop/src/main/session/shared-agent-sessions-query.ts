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
import { parseSessionSortRule } from "@repo/api/src/types/agent-session-sort";
import {
  PRIORITY_FILTER_VALUES,
  type PriorityFilterValue,
} from "@repo/api/src/types/priority-filter";
import type { SessionDateWindowField } from "../../shared/session-date-window-contract.js";
import type { SharedAgentSessionsQuery } from "../../shared/shared-agent-sessions-contract.js";
import { coerceSessionQuality } from "./session-quality-query.js";
import { isLocalSessionSortColumn } from "./session-sort-columns.js";
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
  componentSlug?: string;
  componentSessionIds?: readonly string[];
  startDate: Date | null;
  endDate: Date | null;
  // ISS-5443: which timestamp the `startDate`/`endDate` window is measured
  // against. Set once by the read entrypoint — the Sessions surface (list,
  // usage/KPI, page data, analytics) declares
  // `SESSIONS_SURFACE_DATE_WINDOW_FIELD` — and then flows
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
  // ISS-10332: the priority facet, validated against the cloud's vocabulary.
  priorities: PriorityFilterValue[];
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
  // ISS-9479: an expression is lowered at the IPC boundary
  // (`compileSessionListQueryRequest`). Nothing below reads it, so one that
  // reached a read unlowered would be answered with every row.
  if (query.listQuery !== undefined) {
    throw new SharedAgentSessionsInputError(
      "listQuery reached the read without being lowered"
    );
  }
  const scope = resolveUserScope(
    coerceOptionalString(query.userId),
    coerceStringArray(query.userIds)
  );
  const sort = resolveSortRule(query);
  return {
    ...(query.componentSlug ? { componentSlug: query.componentSlug } : {}),
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
    priorities: coercePriorityFilterValues(query.priorities),
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
    sortBy: sort.sortBy,
    sortDir: sort.sortDir,
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

/**
 * ISS-8679: the ONE sort rule this read orders by — refusing, never truncating,
 * a `sorts` list that asks for more than one.
 *
 * `sorts` wins over the scalar `sortBy`/`sortDir` pair when it carries anything,
 * which is the same precedence the cloud's `resolveSessionSortRules` applies:
 * a caller sending both is speaking the newer contract, and the scalar pair is
 * only its back-compat echo of the lead rule. Reading the pair while ignoring
 * `sorts` is exactly how the primary rule got applied silently and alone.
 *
 * The refusal is the honest answer rather than a shortfall. This source's
 * ordering lives in three co-operating places that each carry ONE column — the
 * cursor-page SQL, the repository-scoped id SQL, and the hydrated key
 * comparator — so a second rule has nowhere to be applied. An explicit input
 * error reaches the reader as the list's error state; dropping the rule would
 * leave the toolbar reporting an order the rows are not in.
 */
function resolveSortRule(query: SharedAgentSessionsQuery): {
  sortBy: string | null;
  sortDir: "asc" | "desc";
} {
  const rules = parseSortRules(query.sorts);
  const [rule, ...extraRules] = rules;
  if (extraRules.length > 0) {
    throw new SharedAgentSessionsInputError(
      `sorts asked for ${rules.length} ordered rules; the local session source applies one`
    );
  }
  if (!rule) {
    return {
      sortBy: coerceOptionalString(query.sortBy),
      sortDir: query.sortDir === "asc" ? "asc" : "desc",
    };
  }
  return { sortBy: rule.column, sortDir: rule.dir };
}

/**
 * The raw `sorts` value as rules, de-duplicated by COLUMN with the first
 * occurrence winning — the same fold the cloud applies, so the two surfaces
 * agree on how many rules a request actually asks for and desktop cannot refuse
 * a repeat the cloud collapses.
 *
 * NOTHING here is filtered. Every other array on this query is coerced with
 * `coerceStringArray`, which DROPS an empty or non-string entry — the right
 * reading for a facet, where a junk entry selects nothing, and the wrong one
 * here: `["repo:asc", ""]` would resolve to one rule and be answered silently
 * while `["repo:asc", "repo"]` threw, which is the same silent-drop under a
 * different spelling. A rule the caller meant and this source cannot read is
 * refused, whatever shape the unreadability takes.
 *
 * `parseSessionSortRule` only SPLITS the entry — it deliberately owns the
 * encoding and neither side's vocabulary — so BOTH halves are narrowed here:
 * the direction against the cloud validator's own closed `asc`/`desc` check,
 * and the column against {@link isLocalSessionSortColumn}, this side's half of
 * that vocabulary.
 *
 * The scalar `sortBy`/`sortDir` pair keeps coercing an unrecognized value (a
 * direction to `desc`, a column to the comparator's started fallback). That is
 * the shipped meaning of a pair every version-skewed build already sends, and
 * changing it is not this seam's job.
 */
function parseSortRules(value: unknown): SessionSortRuleEntry[] {
  const entries = sortRuleEntries(value);
  const rules: SessionSortRuleEntry[] = [];
  for (const entry of entries) {
    const rule = toSortRule(entry);
    if (rules.some((existing) => existing.column === rule.column)) {
      continue;
    }
    rules.push(rule);
  }
  return rules;
}

/**
 * The raw entries to parse, refused rather than coerced when `sorts` is not a
 * list, and bounded before anything walks it.
 *
 * The bound is why it is checked HERE: {@link parseSortRules} de-duplicates by
 * scanning what it has accumulated, so an unbounded caller-controlled array
 * would cost O(N²) on the single-threaded main process before the one-rule
 * refusal could fire. The same bound `sanitizeIds` puts on `ids`.
 */
function sortRuleEntries(value: unknown): readonly unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new SharedAgentSessionsInputError(
      "sorts is not a list of <column>:<dir> rules"
    );
  }
  if (value.length > MAX_SORT_RULE_ENTRIES) {
    throw new SharedAgentSessionsInputError(
      `sorts carries more than ${MAX_SORT_RULE_ENTRIES} entries`
    );
  }
  return value;
}

/** One wire entry as a rule, or a refusal naming why it could not be read. */
function toSortRule(entry: unknown): SessionSortRuleEntry {
  const parts =
    typeof entry === "string" ? parseSessionSortRule(entry.trim()) : null;
  if (!parts) {
    throw new SharedAgentSessionsInputError(
      "a sorts entry is not a <column>:<dir> rule"
    );
  }
  if (parts.dir !== "asc" && parts.dir !== "desc") {
    throw new SharedAgentSessionsInputError(
      "a sorts entry names a direction that is not asc or desc"
    );
  }
  // A column with no case in `sessionSortKey` is not readable either: that
  // switch's `default` arm answers it with the `started` key, so accepting
  // `autonomy:asc` (a real v2 toolbar column this source cannot order by) would
  // serve started order under an unrelated column's name — a quietly wrong
  // answer of exactly the kind the entries above are refused to prevent.
  if (!isLocalSessionSortColumn(parts.column)) {
    throw new SharedAgentSessionsInputError(
      "a sorts entry names a column the local session source cannot order by"
    );
  }
  return { column: parts.column, dir: parts.dir };
}

/** One ordered sort rule as this boundary reads it off the wire. */
type SessionSortRuleEntry = { column: string; dir: "asc" | "desc" };

/**
 * The most `sorts` entries {@link parseSortRules} will walk before refusing.
 *
 * Generous by design: this source applies ONE rule and the toolbar can stack at
 * most one per sortable column, so no honest request comes close. It is a bound
 * on a caller-controlled array crossing the IPC boundary, not a product limit.
 */
const MAX_SORT_RULE_ENTRIES = 32;

/**
 * ISS-10332: the priority facet's selection, refused rather than thinned when a
 * value is outside the cloud's vocabulary — dropping it would widen the answer
 * to every row, and the cloud validator answers the same request with a 400.
 */
function coercePriorityFilterValues(value: unknown): PriorityFilterValue[] {
  if (value === undefined) {
    return [];
  }
  if (!(Array.isArray(value) && value.every(isPriorityFilterValue))) {
    throw new SharedAgentSessionsInputError(
      "priorities is not a list of priority filter values"
    );
  }
  return [...new Set(value)];
}

function isPriorityFilterValue(value: unknown): value is PriorityFilterValue {
  return PRIORITY_FILTER_VALUES.some((member) => member === value);
}
