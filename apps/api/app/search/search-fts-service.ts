/**
 * FEA-3863 (parent FEA-3800, PLN-1456 Slice 3) — the unified full-text query
 * side over the `search_document` projection (FEA-3857). Runs one org-scoped,
 * type-faceted, date-windowed, ranked GIN query across the whole Phase-1 corpus
 * (documents/projects/loops) and returns a single heterogeneous
 * {@link UnifiedSearchResponse}.
 *
 * SECURITY — the index is NOT an access-control boundary. The GIN query returns
 * candidates; {@link reauthorizeHits} re-checks each candidate against the
 * authoritative source rows (Artifact/Project/Loop, org-scoped) with ONE
 * set-based query per entity type before any hit is returned. A candidate whose
 * source row the requester can't see (deleted, moved orgs, stale projection) is
 * dropped — the projection can never widen visibility.
 *
 * INJECTION-SAFE: the free-text query and every filter is a bound parameter via
 * `Prisma.sql`; nothing is string-interpolated into the SQL.
 */

import { ProjectStatus } from "@repo/api/src/types/project";
import {
  MAX_UNIFIED_SEARCH_LIMIT,
  type SearchHit,
  SearchMode,
  searchHitDeepLink,
  type UnifiedSearchResponse,
} from "@repo/api/src/types/search";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import {
  hasStructuredFilters,
  type IdLookup,
  PRIORITY_ORDINAL,
  type PriorityFilter,
  SearchFilterOperator,
  type SearchFilters,
  type StatusFilter,
  type UpdatedFilter,
} from "@repo/api/src/types/search-query";
import { expandSlugAliases } from "@repo/api/src/types/slug-prefix";
import { Prisma, withDb } from "@repo/database";

/** Default page size for a unified query; clamped to {@link MAX_LIMIT}. */
const DEFAULT_LIMIT = 25;
/** Shared unified-search page-size ceiling (SSOT in `@repo/api` search types). */
const MAX_LIMIT = MAX_UNIFIED_SEARCH_LIMIT;

/** Non-alphanumeric token delimiter for the prefix-mode tokenizer. */
const NON_ALPHANUMERIC = /[^a-z0-9]+/i;

/** Milliseconds in a day (for the `:updated=<day>` half-open range). */
const MS_PER_DAY = 86_400_000;

/** Parsed, validated inputs for a unified search. */
export type UnifiedSearchParams = {
  organizationId: string;
  query: string;
  mode: SearchMode;
  /** Corpus filter; empty means "all Phase-1 types". */
  types: SearchEntityType[];
  since: Date | null;
  until: Date | null;
  limit: number;
  /** Keyset cursor from a prior page's `nextCursor`, or null for the first page. */
  cursor: UnifiedSearchCursor | null;
  /**
   * Structured query-language filters lifted out of the raw `q` by
   * `parseSearchQuery` (FEA-3930): `@owner`→`assignee_id IN`, `:status`/
   * `:priority`→ the projection columns, `:project`→ resolved project ids, and
   * `:updated`→ an `updated_at` window. Empty object when the query carried no
   * inline filters. AND across different keys.
   */
  filters: SearchFilters;
  /**
   * Exact-record lookup lifted from the raw query (FEA-3930). Present when the
   * query carried a UUID or a known slug: the service runs an org-scoped exact
   * match and ranks that record ABOVE the full-text hits (see {@link IdLookup}).
   * Absent when no id/slug token was typed.
   */
  idLookup?: IdLookup;
};

/**
 * Keyset cursor: the `(rank, updatedAt, entityType, entityId)` tuple of the last
 * hit on the previous page. Ordering is `rank DESC, updated_at DESC, entity_type,
 * entity_id` so the tuple is a total order and pages never skip/duplicate.
 *
 * `ftsStart` marks the special "resume the FTS lane from its top" cursor emitted
 * when an exact ID/slug hit consumed the whole first page (`limit=1` etc.): no
 * FTS row could be shown, so the next page must start the FTS scan at row 0
 * rather than skip past the unshown rows. A non-null cursor still suppresses the
 * exact hit (it is emitted only on the first, cursor-less page), so `ftsStart`
 * shows the FTS top without re-emitting the promoted record. When `ftsStart` is
 * set, the keyset tuple fields are ignored (the predicate applies no bound).
 */
export type UnifiedSearchCursor = {
  rank: number;
  updatedAt: string;
  entityType: string;
  entityId: string;
  /** When true, resume the FTS lane from its top (no keyset bound). */
  ftsStart?: boolean;
};

/** A raw candidate row off the GIN query, before re-authorization. */
type CandidateRow = {
  entity_type: string;
  entity_id: string;
  title: string;
  snippet: string;
  rank: number;
  updated_at: Date;
  // Phase-2 route fields (nullable in the projection; null for the type that
  // does not carry them). Populated onto the returned SearchHit so the client
  // can build a real web route instead of the UUID-only deepLink.
  slug: string | null;
  entity_subtype: string | null;
  team_id: string | null;
  // Route anchor (FEA-3930 comment/PR/branch slice): the id of a different entity
  // this hit routes to (PR → owning branch; comment → anchored artifact).
  anchor_entity_id: string | null;
};

export const searchFtsService = {
  /**
   * Run the unified FTS query. Over-fetches candidates, re-authorizes them
   * against the source tables, and returns up to `limit` authorized ranked hits
   * plus a keyset cursor when more may remain.
   */
  async searchUnified(
    params: UnifiedSearchParams
  ): Promise<UnifiedSearchResponse> {
    // Empty text + only filters is valid: run a filter-only, recency-ordered
    // scan (no `tsv @@` match, rank pinned to 0). Otherwise build the tsquery.
    const tsQuery =
      params.query.trim().length === 0
        ? null
        : buildTsQuery(params.mode, params.query);

    // Exact ID/slug lookup (FEA-3930, Mike's explicit requirement): when the
    // query carried a UUID or a known slug, run an org-scoped exact match across
    // ALL entity types and rank it ABOVE the FTS hits. A query that is ONLY an
    // id/slug (no free text, no filters, first page) short-circuits the tsvector
    // scan and returns just that record.
    const exactOnly =
      params.idLookup !== undefined &&
      tsQuery === null &&
      params.cursor === null &&
      !hasStructuredFilters(params.filters);

    // Resolve the `@owner` mention tokens and the `:project` slug/name filter to
    // ids up front. Either, when present but resolving to zero rows, can never
    // match — short-circuit to an empty page rather than run a doomed scan.
    // (Skipped in exact-only mode, which runs no FTS scan.)
    const [ownerIds, projectIds] = exactOnly
      ? [null, null]
      : await Promise.all([
          resolveOwnerFilter(params),
          resolveProjectFilter(params),
        ]);
    if (
      (ownerIds !== null && ownerIds.length === 0) ||
      (projectIds !== null && projectIds.length === 0)
    ) {
      // A doomed owner/project filter cannot match. An exact id/slug lookup is a
      // separate, unfiltered lane, so still resolve it on the first page;
      // otherwise empty page. The exact hit is emitted only on the first page
      // (this path returns no cursor, so there is no FTS lane to re-scan it).
      const exactCandidates =
        params.cursor === null ? await runExactLookupQuery(params) : [];
      const exactHits = await authorizeAndMap(
        params.organizationId,
        exactCandidates
      );
      return {
        query: params.query,
        mode: params.mode,
        results: exactHits,
        nextCursor: null,
      };
    }
    // Over-fetch: re-auth can drop candidates, so pull an extra margin to still
    // fill a page. One extra row past `limit` distinguishes "more exist".
    const fetchLimit = Math.min(params.limit * 2 + 1, MAX_LIMIT * 2 + 1);

    // The exact-lookup lane and the FTS scan run independently; the exact record
    // is always ranked first (deduped if it also matched the FTS scan).
    const [exactCandidates, candidates] = await Promise.all([
      runExactLookupQuery(params),
      exactOnly
        ? Promise.resolve<CandidateRow[]>([])
        : runCandidateQuery(params, tsQuery, ownerIds, projectIds, fetchLimit),
    ]);

    // De-dupe the FTS candidates against the exact hits so a record that matched
    // both lanes is not returned twice; the exact hit wins its top slot. The
    // exclusion runs on EVERY page (the exact identity is resolved on every
    // page) so the promoted record cannot reappear through the FTS scan on a
    // later page once its native rank falls below the first page's cursor.
    const exactKeys = new Set(
      exactCandidates.map((c) => candidateKey(c.entity_type, c.entity_id))
    );
    const ftsCandidates = candidates.filter(
      (c) => !exactKeys.has(candidateKey(c.entity_type, c.entity_id))
    );

    // Only the first page EMITS the exact hits (they lead the results); later
    // pages continue the FTS keyset scan, using the exact identity only to
    // exclude the already-emitted record above.
    const emitExact = params.cursor === null;
    const authorizedIds = await reauthorizeHits(params.organizationId, [
      ...(emitExact ? exactCandidates : []),
      ...ftsCandidates,
    ]);
    const isAuthorized = (c: CandidateRow) =>
      authorizedIds.has(candidateKey(c.entity_type, c.entity_id));

    const authorizedExact = emitExact
      ? exactCandidates.filter(isAuthorized)
      : [];
    const authorizedFts = ftsCandidates.filter(isAuthorized);

    // Exact hits always lead; the FTS page fills the remaining slots.
    const remaining = Math.max(0, params.limit - authorizedExact.length);
    const results: SearchHit[] = [
      ...authorizedExact.map(toSearchHit),
      ...authorizedFts.slice(0, remaining).map(toSearchHit),
    ];

    return {
      query: params.query,
      mode: params.mode,
      results,
      nextCursor: nextCursorFor(
        params,
        candidates,
        authorizedFts,
        fetchLimit,
        authorizedExact.length
      ),
    };
  },
};

/**
 * Re-authorize a candidate set against the source of truth and map the surviving
 * rows to hits (used by the doomed-filter path, where only the exact lane runs).
 */
async function authorizeAndMap(
  organizationId: string,
  candidates: CandidateRow[]
): Promise<SearchHit[]> {
  if (candidates.length === 0) {
    return [];
  }
  const authorizedIds = await reauthorizeHits(organizationId, candidates);
  return candidates
    .filter((c) => authorizedIds.has(candidateKey(c.entity_type, c.entity_id)))
    .map(toSearchHit);
}

/**
 * Run the org-scoped EXACT ID/slug lookup (FEA-3930). Matches a projection row
 * whose `entity_id` equals the pasted UUID OR whose `slug` case-insensitively
 * equals the pasted slug, within the requested corpus `types`. Returns [] when
 * the query carried no id/slug lookup. Org-scoped here AND re-authorized per hit
 * by the caller, so a cross-org id returns nothing. The result is rank-boosted
 * to the top by construction (the caller places exact hits first).
 *
 * Runs on EVERY page, not just the first: the exact hit is only *emitted* on the
 * first page (the caller gates emission on `cursor === null`), but its identity
 * must stay available on later pages so the FTS lane can exclude it — otherwise
 * the promoted record could reappear through the full-text scan on page 2 once
 * its native rank drops below the first page's cursor.
 */
function runExactLookupQuery(
  params: UnifiedSearchParams
): Promise<CandidateRow[]> {
  const lookup = params.idLookup;
  if (lookup === undefined) {
    return Promise.resolve([]);
  }
  const matchClauses: Prisma.Sql[] = [];
  if (lookup.uuid !== undefined) {
    matchClauses.push(Prisma.sql`"entity_id" = ${lookup.uuid}::uuid`);
  }
  if (lookup.slug !== undefined) {
    // FEA-4137: `ISS-42` and `FEA-42` are the same numeric identity, so the
    // exact lane must match the pasted slug OR any of its cross-prefix aliases —
    // otherwise `ISS-42` can't find a stored `FEA-42` row (and vice-versa) and
    // exact-only mode returns nothing (the FTS lane is skipped).
    const aliasSlugs = expandSlugAliases(lookup.slug);
    matchClauses.push(
      Prisma.sql`lower("slug") IN (${Prisma.join(
        aliasSlugs.map((slug) => Prisma.sql`lower(${slug})`)
      )})`
    );
  }
  if (matchClauses.length === 0) {
    return Promise.resolve([]);
  }
  const matchPredicate = Prisma.join(matchClauses, " OR ");
  // Honor the corpus `types` filter on the exact lane too. Without it,
  // `/search?q=FEA-42&types=project` could surface a document exact hit while
  // the caller restricted the corpus to projects (the FTS lane already applies
  // this filter). Empty `types` means "all Phase-1 types" → no predicate.
  const typeFilter =
    params.types.length > 0
      ? Prisma.sql`AND "entity_type" IN (${Prisma.join(params.types)})`
      : Prisma.empty;
  return withDb((db) =>
    db.$queryRaw<CandidateRow[]>(Prisma.sql`
      SELECT
        "entity_type",
        "entity_id"::text AS "entity_id",
        "title",
        "title" AS "snippet",
        1::float8 AS "rank",
        "updated_at",
        "slug",
        "entity_subtype",
        "team_id"::text AS "team_id",
        "anchor_entity_id"::text AS "anchor_entity_id"
      FROM "search_document"
      WHERE "organization_id" = ${params.organizationId}::uuid
        AND (${matchPredicate})
        ${typeFilter}
      ORDER BY "updated_at" DESC, "entity_type" ASC, "entity_id" ASC
      LIMIT ${MAX_LIMIT}
    `)
  );
}

/**
 * Derive the keyset cursor for the next page over the FTS scan, or null when the
 * corpus is drained. Two "more may exist" signals:
 *   - more authorized FTS hits than the page's FTS slots held
 *     (`authorizedFts.length > ftsSlots`);
 *   - the raw candidate scan filled `fetchLimit` (there may be more matches the
 *     query hasn't seen yet — including authorized ones re-auth would keep).
 *
 * `exactCount` is how many page slots the always-first exact-lookup hits already
 * consumed, so `ftsSlots` is the remaining budget the FTS page filled.
 *
 * The cursor advances from the LAST SCANNED candidate, not the last returned
 * hit. If it advanced from the last returned hit while re-auth dropped the tail
 * of the scan, the next page would rescan — and re-drop — the same unauthorized
 * rows and stall. Advancing past the whole scanned window guarantees forward
 * progress even when an entire page's worth of candidates was redacted.
 */
function nextCursorFor(
  params: UnifiedSearchParams,
  candidates: CandidateRow[],
  authorizedFts: CandidateRow[],
  fetchLimit: number,
  exactCount: number
): string | null {
  const ftsSlots = Math.max(0, params.limit - exactCount);
  const moreAuthorized = authorizedFts.length > ftsSlots;
  const scanFilled = candidates.length >= fetchLimit;
  if (!(moreAuthorized || scanFilled)) {
    return null;
  }
  // Exact hit(s) consumed the whole page (`ftsSlots === 0`), yet the FTS scan
  // saw candidates that could not be shown. Advancing the keyset past the last
  // scanned FTS row would SKIP those unshown top results on the next page, so
  // emit the sentinel "resume FTS from the top" cursor instead. It suppresses
  // the exact hit (non-null cursor) without dropping the FTS top.
  if (ftsSlots === 0 && candidates.length > 0) {
    return encodeCursor(FTS_START_CURSOR);
  }
  // When there are extra authorized FTS hits AND the page had FTS slots, resume
  // right after the last returned FTS hit; otherwise resume after the last
  // scanned candidate so a fully-redacted window still advances.
  const anchor =
    moreAuthorized && ftsSlots > 0
      ? authorizedFts[ftsSlots - 1]
      : candidates.at(-1);
  if (!anchor) {
    return null;
  }
  return encodeCursor({
    rank: anchor.rank,
    updatedAt: anchor.updated_at.toISOString(),
    entityType: anchor.entity_type,
    entityId: anchor.entity_id,
  });
}

/**
 * Build the `tsquery` SQL fragment for the requested mode. `Fulltext` uses
 * `websearch_to_tsquery` (phrase/operator aware). `Prefix`/typeahead appends
 * `:*` to the trailing token via `to_tsquery`, so a half-typed word matches; the
 * user text is sanitized to alnum tokens joined by `&` (with the last token
 * prefixed) so no raw operator can break `to_tsquery`.
 */
function buildTsQuery(mode: SearchMode, query: string): Prisma.Sql {
  if (mode === SearchMode.Prefix) {
    const prefixExpr = toPrefixTsQueryExpression(query);
    if (prefixExpr === null) {
      // No usable tokens — a query that can never match. `to_tsquery('')` errors,
      // so fall back to a websearch query of the raw (which yields no rows).
      return Prisma.sql`websearch_to_tsquery('english', ${query})`;
    }
    return Prisma.sql`to_tsquery('english', ${prefixExpr})`;
  }
  return Prisma.sql`websearch_to_tsquery('english', ${query})`;
}

/**
 * Turn free text into a safe `to_tsquery` expression with the trailing token as
 * a prefix: `"impl pla"` -> `"impl & pla:*"`. Splits on non-alphanumerics and
 * drops empties so no raw `to_tsquery` operator survives. Returns null when the
 * text has no alphanumeric token.
 */
function toPrefixTsQueryExpression(query: string): string | null {
  const tokens = query
    .toLowerCase()
    .split(NON_ALPHANUMERIC)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) {
    return null;
  }
  const last = tokens.length - 1;
  return tokens.map((t, i) => (i === last ? `${t}:*` : t)).join(" & ");
}

/**
 * Execute the org-scoped ranked candidate query. The org predicate always
 * leads. Type, date-window, structured-filter, and keyset-cursor predicates are
 * conditional bound fragments. When `tsQuery` is non-null the GIN full-text
 * match refines and ranks the scan; when it is null (empty-text, filters-only)
 * the match/rank are dropped and rows come back recency-ordered with rank 0.
 * `ts_headline` produces the snippet (or a plain title fallback in filter-only
 * mode).
 */
function runCandidateQuery(
  params: UnifiedSearchParams,
  tsQuery: Prisma.Sql | null,
  ownerIds: string[] | null,
  projectIds: string[] | null,
  fetchLimit: number
): Promise<CandidateRow[]> {
  const typeFilter =
    params.types.length > 0
      ? Prisma.sql`AND "entity_type" IN (${Prisma.join(params.types)})`
      : Prisma.empty;
  const sinceFilter = params.since
    ? Prisma.sql`AND "updated_at" >= ${params.since}`
    : Prisma.empty;
  const untilFilter = params.until
    ? Prisma.sql`AND "updated_at" <= ${params.until}`
    : Prisma.empty;

  // Structured query-language predicates (FEA-3930). AND across keys.
  const ftsFilter = tsQuery
    ? Prisma.sql`AND "tsv" @@ ${tsQuery}`
    : Prisma.empty;
  const ownerFilter = ownerPredicate(ownerIds);
  const projectFilter = projectPredicate(projectIds);
  const statusFilter = statusPredicate(params.filters.status);
  const priorityFilter = priorityPredicate(params.filters.priority);
  const updatedFilter = updatedPredicate(params.filters.updated);

  // Rank + snippet are full-text-mode only; in filter-only mode rank is a
  // literal 0 and the snippet is the plain title.
  const rankExpr = tsQuery
    ? Prisma.sql`ts_rank_cd("tsv", ${tsQuery})::float8`
    : Prisma.sql`0::float8`;
  const snippetExpr = tsQuery
    ? Prisma.sql`ts_headline(
        'english',
        COALESCE("title", '') || ' ' || COALESCE("body", ''),
        ${tsQuery},
        'MaxWords=18, MinWords=5, ShortWord=2, MaxFragments=1'
      )`
    : Prisma.sql`"title"`;

  return withDb((db) =>
    db.$queryRaw<CandidateRow[]>(Prisma.sql`
      SELECT
        "entity_type",
        "entity_id"::text AS "entity_id",
        "title",
        ${snippetExpr} AS "snippet",
        ${rankExpr} AS "rank",
        "updated_at",
        "slug",
        "entity_subtype",
        "team_id"::text AS "team_id",
        "anchor_entity_id"::text AS "anchor_entity_id"
      FROM "search_document"
      WHERE "organization_id" = ${params.organizationId}::uuid
        ${ftsFilter}
        ${typeFilter}
        ${sinceFilter}
        ${untilFilter}
        ${ownerFilter}
        ${projectFilter}
        ${statusFilter}
        ${priorityFilter}
        ${updatedFilter}
        ${cursorPredicate(params.cursor, tsQuery)}
      ORDER BY "rank" DESC, "updated_at" DESC, "entity_type" ASC, "entity_id" ASC
      LIMIT ${fetchLimit}
    `)
  );
}

/**
 * `@owner` → `assignee_id IN (...)`. Multiple owner ids OR within the filter
 * (any assignee matches), AND with the other filters. null (no owner filter) →
 * no predicate. The tokens were already resolved to user UUIDs by
 * {@link resolveOwnerFilter}; an empty list short-circuits earlier in
 * {@link searchFtsService.searchUnified}, so it never reaches here.
 */
function ownerPredicate(ownerIds: string[] | null): Prisma.Sql {
  if (ownerIds === null || ownerIds.length === 0) {
    return Prisma.empty;
  }
  const casted = ownerIds.map((id) => Prisma.sql`${id}::uuid`);
  return Prisma.sql`AND "assignee_id" IN (${Prisma.join(casted)})`;
}

/** `:project` → `project_id IN (...)` over the resolved project ids. */
function projectPredicate(projectIds: string[] | null): Prisma.Sql {
  if (projectIds === null || projectIds.length === 0) {
    return Prisma.empty;
  }
  const casted = projectIds.map((id) => Prisma.sql`${id}::uuid`);
  return Prisma.sql`AND "project_id" IN (${Prisma.join(casted)})`;
}

/** `:status` → `status = value` or `status != value` on the projection column. */
function statusPredicate(status: StatusFilter | undefined): Prisma.Sql {
  if (!status) {
    return Prisma.empty;
  }
  if (status.operator === SearchFilterOperator.Neq) {
    // `!=` must still match a row whose status is NULL (it is "not the value").
    return Prisma.sql`AND ("status" IS DISTINCT FROM ${status.value})`;
  }
  return Prisma.sql`AND "status" = ${status.value}`;
}

/**
 * `:priority` → an ordinal comparison. The projected `priority` TEXT is mapped
 * to its ordinal via a CASE that mirrors {@link PRIORITY_ORDINAL}, so a
 * comparison operator (`>=` etc.) orders LOW<MEDIUM<HIGH<URGENT. A row whose
 * priority is NULL or unmapped yields NULL and is excluded by any comparison.
 */
function priorityPredicate(priority: PriorityFilter | undefined): Prisma.Sql {
  if (!priority) {
    return Prisma.empty;
  }
  const target = PRIORITY_ORDINAL[priority.value];
  if (target === undefined) {
    // Parser already validated the value; defensively drop an unmapped one.
    return Prisma.empty;
  }
  const ordinal = priorityOrdinalSql();
  switch (priority.operator) {
    case SearchFilterOperator.Eq:
      return Prisma.sql`AND ${ordinal} = ${target}`;
    case SearchFilterOperator.Neq:
      return Prisma.sql`AND ${ordinal} IS DISTINCT FROM ${target}`;
    case SearchFilterOperator.Gt:
      return Prisma.sql`AND ${ordinal} > ${target}`;
    case SearchFilterOperator.Lt:
      return Prisma.sql`AND ${ordinal} < ${target}`;
    case SearchFilterOperator.Gte:
      return Prisma.sql`AND ${ordinal} >= ${target}`;
    case SearchFilterOperator.Lte:
      return Prisma.sql`AND ${ordinal} <= ${target}`;
    default:
      return Prisma.empty;
  }
}

/**
 * The CASE expression that maps the projected `priority` TEXT column to its
 * ordinal, mirroring {@link PRIORITY_ORDINAL}. Built from the shared map so the
 * SQL ordering and the parser stay in lockstep.
 */
function priorityOrdinalSql(): Prisma.Sql {
  const whens = Object.entries(PRIORITY_ORDINAL).map(
    ([value, ordinal]) => Prisma.sql`WHEN ${value} THEN ${ordinal}`
  );
  return Prisma.sql`(CASE "priority" ${Prisma.join(whens, " ")} ELSE NULL END)`;
}

/** `:updated` → an `updated_at` bound or inclusive range. */
function updatedPredicate(updated: UpdatedFilter | undefined): Prisma.Sql {
  if (!updated) {
    return Prisma.empty;
  }
  if (updated.kind === "range") {
    return Prisma.sql`AND "updated_at" >= ${updated.from} AND "updated_at" <= ${updated.to}`;
  }
  switch (updated.operator) {
    case SearchFilterOperator.Gt:
      return Prisma.sql`AND "updated_at" > ${updated.date}`;
    case SearchFilterOperator.Lt:
      return Prisma.sql`AND "updated_at" < ${updated.date}`;
    case SearchFilterOperator.Gte:
      return Prisma.sql`AND "updated_at" >= ${updated.date}`;
    case SearchFilterOperator.Lte:
      return Prisma.sql`AND "updated_at" <= ${updated.date}`;
    default:
      // `=` on a day matches the whole calendar day [date, date+1day).
      return Prisma.sql`AND "updated_at" >= ${updated.date} AND "updated_at" < ${nextDay(updated.date)}`;
  }
}

/** The instant one day after `date` (for the `:updated=<day>` half-open range). */
function nextDay(date: Date): Date {
  return new Date(date.getTime() + MS_PER_DAY);
}

/**
 * Resolve the `@owner` mention tokens to org-scoped user ids. A token matches a
 * user by exact email, exact GitHub username, or a case-insensitive match on
 * first/last name (so `@alice`, `@alice@acme.com`, and `@Alice` all resolve).
 * Returns null when no owner filter was set (no predicate), or the deduped id
 * list when one was — an empty list means "no such member", which the caller
 * short-circuits to an empty result rather than silently ignoring the filter.
 */
function resolveOwnerFilter(
  params: UnifiedSearchParams
): Promise<string[] | null> {
  const owner = params.filters.owner;
  if (!owner || owner.length === 0) {
    return Promise.resolve(null);
  }
  return withDb(async (db) => {
    const rows = await db.user.findMany({
      where: {
        organizationId: params.organizationId,
        OR: owner.flatMap((token) => [
          { email: { equals: token, mode: Prisma.QueryMode.insensitive } },
          {
            githubUsername: {
              equals: token,
              mode: Prisma.QueryMode.insensitive,
            },
          },
          { firstName: { equals: token, mode: Prisma.QueryMode.insensitive } },
          { lastName: { equals: token, mode: Prisma.QueryMode.insensitive } },
        ]),
      },
      select: { id: true },
    });
    return [...new Set(rows.map((r) => r.id))];
  });
}

/**
 * Resolve a `:project` slug-or-name filter to the matching project ids within
 * the requester's org. Returns null when no project filter was set (no
 * predicate), or the (possibly empty) id list when one was. An empty list means
 * "matches nothing" — the caller short-circuits to an empty result.
 */
function resolveProjectFilter(
  params: UnifiedSearchParams
): Promise<string[] | null> {
  const project = params.filters.project;
  if (!project) {
    return Promise.resolve(null);
  }
  return withDb(async (db) => {
    const rows = await db.project.findMany({
      where: {
        organizationId: params.organizationId,
        OR: [{ slug: project.value }, { name: project.value }],
      },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  });
}

/**
 * Keyset predicate for pagination: rows strictly after the cursor tuple under
 * the `(rank DESC, updated_at DESC, entity_type ASC, entity_id ASC)` order. The
 * rank is recomputed from the same `tsQuery` so it matches the ORDER BY exactly;
 * in filter-only mode (`tsQuery === null`) the rank column is a literal 0, so
 * the cursor's rank comparisons collapse to equality and pagination falls
 * through to the `(updated_at, entity_type, entity_id)` tail — a total order.
 */
function cursorPredicate(
  cursor: UnifiedSearchCursor | null,
  tsQuery: Prisma.Sql | null
): Prisma.Sql {
  // The `ftsStart` sentinel resumes the FTS lane from its top (no keyset bound);
  // it exists only to suppress the exact hit on the page after an exact-filled
  // first page. A real keyset tuple is ignored in that case.
  if (cursor === null || cursor.ftsStart === true) {
    return Prisma.empty;
  }
  const rank = tsQuery
    ? Prisma.sql`ts_rank_cd("tsv", ${tsQuery})::float8`
    : Prisma.sql`0::float8`;
  const cRank = cursor.rank;
  const cUpdated = new Date(cursor.updatedAt);
  const cType = cursor.entityType;
  const cId = cursor.entityId;
  return Prisma.sql`AND (
    ${rank} < ${cRank}
    OR (${rank} = ${cRank} AND "updated_at" < ${cUpdated})
    OR (${rank} = ${cRank} AND "updated_at" = ${cUpdated} AND "entity_type" > ${cType})
    OR (${rank} = ${cRank} AND "updated_at" = ${cUpdated} AND "entity_type" = ${cType} AND "entity_id"::text > ${cId})
  )`;
}

/**
 * Per-hit re-authorization. Groups candidate ids by entity type and, with ONE
 * set-based query per type (bounded — never per-row), confirms each id still
 * exists under `organizationId` in its authoritative source table. Returns the
 * set of `entityType:entityId` keys the requester is authorized to see.
 *
 * Org membership is the visibility boundary for the Phase-1 corpus today; the
 * re-check is against the live source tables so a stale/misprojected row never
 * leaks. Archived projects are excluded (they are hidden from org search).
 */
export async function reauthorizeHits(
  organizationId: string,
  candidates: CandidateRow[]
): Promise<Set<string>> {
  const byType = new Map<string, string[]>();
  for (const c of candidates) {
    const list = byType.get(c.entity_type);
    if (list) {
      list.push(c.entity_id);
    } else {
      byType.set(c.entity_type, [c.entity_id]);
    }
  }

  // FEA-3930 query-side gate (defense-in-depth): even if `agent_session` rows
  // exist from when the org had transcript search on, only return them while the
  // gate is currently on. Resolved once, and only when the page actually holds
  // agent_session candidates, so the common query pays no extra read.
  const transcriptGateOn = byType.has(SearchEntityType.AgentSession)
    ? await isTranscriptSearchEnabled(organizationId)
    : false;

  const authorized = new Set<string>();
  await Promise.all(
    [...byType.entries()].map(async ([entityType, ids]) => {
      const allowedIds = await authorizedIdsForType(
        organizationId,
        entityType,
        ids,
        transcriptGateOn
      );
      for (const id of allowedIds) {
        authorized.add(candidateKey(entityType, id));
      }
    })
  );
  return authorized;
}

/**
 * One set-based visibility query for a single entity type. Returns the subset of
 * `ids` the requester (via `organizationId`) may see, read from the source of
 * truth — not the projection. `transcriptGateOn` is the org's current
 * `searchIncludeTranscripts` value, consulted only for the `agent_session` type.
 */
function authorizedIdsForType(
  organizationId: string,
  entityType: string,
  ids: string[],
  transcriptGateOn: boolean
): Promise<string[]> {
  if (ids.length === 0) {
    return Promise.resolve([]);
  }
  return withDb(async (db) => {
    switch (entityType) {
      case SearchEntityType.Document: {
        const rows = await db.artifact.findMany({
          where: { id: { in: ids }, organizationId },
          select: { id: true },
        });
        return rows.map((r) => r.id);
      }
      case SearchEntityType.Project: {
        const rows = await db.project.findMany({
          where: {
            id: { in: ids },
            organizationId,
            status: { not: ProjectStatus.Archived },
          },
          select: { id: true },
        });
        return rows.map((r) => r.id);
      }
      case SearchEntityType.Loop: {
        const rows = await db.loop.findMany({
          where: { id: { in: ids }, organizationId },
          select: { id: true },
        });
        return rows.map((r) => r.id);
      }
      case SearchEntityType.AgentSession: {
        // Fail-closed on the org gate: when transcript search is off, no
        // agent_session hit is authorized even if projection rows still exist.
        if (!transcriptGateOn) {
          return [];
        }
        // entityId is the session's artifactId; org-scope via the parent
        // artifact so a stale/cross-org projection row can never leak.
        const rows = await db.sessionDetail.findMany({
          where: {
            artifactId: { in: ids },
            artifact: { is: { organizationId } },
          },
          select: { artifactId: true },
        });
        return rows.map((r) => r.artifactId);
      }
      case SearchEntityType.Comment: {
        // entityId is the comment id; org-scope through the owning thread and
        // exclude soft-deleted comments so a deleted/cross-org comment never
        // leaks (the projection is not an access boundary). A comment routes to
        // the artifact its thread is anchored on; when that anchor is a
        // soft-deleted branch, the comment would link to a dead `/branches/…`
        // route, so exclude it here the same way the branch/PR gates do.
        // Session-anchored comments (branch relation absent) are unaffected.
        const rows = await db.comment.findMany({
          where: {
            id: { in: ids },
            deletedAt: null,
            thread: { is: { organizationId } },
            NOT: {
              thread: {
                is: {
                  artifact: {
                    is: { branch: { is: { deletedAt: { not: null } } } },
                  },
                },
              },
            },
          },
          select: { id: true },
        });
        return rows.map((r) => r.id);
      }
      case SearchEntityType.PullRequest: {
        // entityId is the PullRequestDetail id; org-scope via its denormalized
        // organizationId (write-once mirror of the branch's org). A PR routes to
        // its owning branch, so it must be hidden when that branch is soft-
        // deleted — otherwise the PR body stays searchable and links to a dead
        // `/branches/<deleted>` route. Gate on the owning branch being live here
        // (the read-side authority), since the projection is not an access
        // boundary and a delete may not have removed the PR projection row.
        const rows = await db.pullRequestDetail.findMany({
          where: {
            id: { in: ids },
            organizationId,
            branchArtifact: { is: { branch: { is: { deletedAt: null } } } },
          },
          select: { id: true },
        });
        return rows.map((r) => r.id);
      }
      case SearchEntityType.Branch: {
        // entityId is the branch's artifactId; org-scope via the branch detail's
        // denormalized organizationId and exclude soft-deleted branches.
        const rows = await db.branchDetail.findMany({
          where: { artifactId: { in: ids }, organizationId, deletedAt: null },
          select: { artifactId: true },
        });
        return rows.map((r) => r.artifactId);
      }
      case SearchEntityType.AgentComponent: {
        // FEA-4011 Slice A: entityId is the AgentComponent id; org-scope via its
        // own denormalized organizationId (the projection is not an access
        // boundary, so re-check against the source table). Exclude uninstalled
        // components the same way the branch/PR arms exclude soft-deleted rows —
        // the write hook removes an uninstalled component's projection row, but a
        // missed/raced removal must not let a since-uninstalled component keep
        // surfacing in search. The richer per-hit re-authz (usage joins etc.) is
        // Slice E; org membership + install state is the whole visibility
        // boundary for the component corpus today.
        const rows = await db.agentComponent.findMany({
          where: { id: { in: ids }, organizationId, uninstalledAt: null },
          select: { id: true },
        });
        return rows.map((r) => r.id);
      }
      default:
        // Any not-yet-wired corpus type has no source-of-truth re-auth mapping,
        // so it is fail-closed: never authorized until it is wired here.
        return [];
    }
  });
}

/**
 * Whether the org currently opts into unified search over session transcript
 * CONTENT (FEA-3930). The query-side half of the privacy gate: a stale
 * `agent_session` projection row from when it was on must not surface after the
 * org turns it off.
 */
function isTranscriptSearchEnabled(organizationId: string): Promise<boolean> {
  return withDb(async (db) => {
    const org = await db.organization.findUnique({
      where: { id: organizationId },
      select: { searchIncludeTranscripts: true },
    });
    return org?.searchIncludeTranscripts ?? false;
  });
}

function candidateKey(entityType: string, entityId: string): string {
  return `${entityType}:${entityId}`;
}

function toSearchHit(row: CandidateRow): SearchHit {
  const entityType = row.entity_type as SearchEntityType;
  const hit: SearchHit = {
    entityType,
    entityId: row.entity_id,
    title: row.title,
    snippet: row.snippet.trim().length > 0 ? row.snippet : row.title,
    rank: row.rank,
    updatedAt: row.updated_at,
    deepLink: searchHitDeepLink(entityType, row.entity_id),
  };
  // Preserve omission for absent optional fields (cross-repo compat): a
  // null/absent projection column becomes an omitted key, never `null`/
  // `undefined`, so the wire shape matches the optional contract and old clients
  // degrade gracefully. Loose `!= null` catches both null and a column an older
  // projection row has not backfilled.
  if (row.slug != null) {
    hit.slug = row.slug;
  }
  if (row.entity_subtype != null) {
    hit.entitySubtype = row.entity_subtype;
  }
  if (row.team_id != null) {
    hit.teamId = row.team_id;
  }
  if (row.anchor_entity_id != null) {
    hit.anchorEntityId = row.anchor_entity_id;
  }
  return hit;
}

/** Base64url-encode a cursor tuple for an opaque `nextCursor`. */
function encodeCursor(cursor: UnifiedSearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/**
 * Decode a `nextCursor` back to its tuple, or null when malformed (a bad cursor
 * degrades to a first-page query rather than erroring).
 */
export function decodeCursor(raw: string): UnifiedSearchCursor | null {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as Partial<UnifiedSearchCursor>;
    if (
      typeof parsed.rank === "number" &&
      Number.isFinite(parsed.rank) &&
      typeof parsed.updatedAt === "string" &&
      // `cursorPredicate` constructs `new Date(updatedAt)` for the keyset query;
      // an unparseable string would become an `Invalid Date` and turn the raw SQL
      // into a 500. Reject it here so a malformed cursor degrades to the first page.
      !Number.isNaN(new Date(parsed.updatedAt).getTime()) &&
      typeof parsed.entityType === "string" &&
      typeof parsed.entityId === "string"
    ) {
      const cursor: UnifiedSearchCursor = {
        rank: parsed.rank,
        updatedAt: parsed.updatedAt,
        entityType: parsed.entityType,
        entityId: parsed.entityId,
      };
      // Carry the "resume FTS from top" sentinel flag through so page 2 after an
      // exact-filled first page starts the FTS scan at its top instead of
      // skipping the unshown rows.
      if (parsed.ftsStart === true) {
        cursor.ftsStart = true;
      }
      return cursor;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The sentinel cursor emitted when an exact ID/slug hit consumed the whole first
 * page: its keyset fields are placeholders (ignored by `cursorPredicate` when
 * `ftsStart` is set), and it exists only to resume the FTS lane from its top on
 * the next page while suppressing the already-emitted exact hit. The placeholder
 * `updatedAt` is a valid ISO string so `decodeCursor`'s validation accepts it.
 */
const FTS_START_CURSOR: UnifiedSearchCursor = {
  rank: 0,
  updatedAt: new Date(0).toISOString(),
  entityType: "",
  entityId: "",
  ftsStart: true,
};

/** Clamp a requested page size to `[1, MAX_LIMIT]`, defaulting when absent. */
export function clampSearchLimit(raw: number | null): number {
  if (raw === null || Number.isNaN(raw)) {
    return DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(Math.floor(raw), MAX_LIMIT));
}
