import {
  ArtifactGroupByMode,
  ArtifactSectionOrdering,
} from "@repo/api/src/types/artifact-group-by-mode";
import { STATUS_DISPLAY_ORDER } from "@repo/api/src/types/artifact-status-display-order";
import {
  DOCUMENT_STATUS_MAPPING,
  ISSUE_STATUS_MAPPING,
} from "@repo/api/src/types/artifact-status-mapping";
import { artifactStatusRootRank } from "@repo/api/src/types/artifact-status-rank";
import { PRIORITY_ORDINAL } from "@repo/api/src/types/search-query";
import { ArtifactSubtype, Prisma } from "@repo/database";

/**
 * ISS-10472 — the SQL half of a grouped board's SECTION order.
 *
 * Every rank here is GENERATED from the canonical table the browser reads, not
 * restated: a literal list would be a second statement of an order that decides
 * what a user sees, and the two would drift.
 *
 * NOT pinned against the client comparators over a shared fixture. There is no
 * such test, and this comment claimed one that never existed (tamsinb, PR
 * #9026). What covers these expressions today is the integration cases in
 * `__tests__/integration/assigned-tree-root-sections.test.ts`, which drive the
 * SQL only; `compareStatusSections` and `compareRootFirstStatusSections` are
 * private to `@repo/app/documents/lib/group-by`, which `apps/api` may not
 * import, so a shared-fixture harness needs a third home — ISS-12816.
 */

/**
 * Which lifecycle a row's freeform `status` is read against.
 *
 * `isIssueLifecycleSubtype` folds the input-only `ISSUE` alias onto the issue
 * lifecycle, so a stored `ISSUE` row must not fall through to the document
 * vocabulary — it would accept `APPROVED` and reject `DONE`.
 */
const ISSUE_LIFECYCLE_SUBTYPES = [
  ArtifactSubtype.FEATURE,
  ArtifactSubtype.ISSUE,
] as const;

export const IS_ISSUE_LIFECYCLE_SQL = Prisma.sql`a.subtype IN (${Prisma.join(
  ISSUE_LIFECYCLE_SUBTYPES.map(
    (subtype) => Prisma.sql`${subtype}::"ArtifactSubtype"`
  )
)})`;

/**
 * A rank lookup as a `CASE`, with the miss rank spelled by the caller.
 *
 * Values are BOUND, never inlined: they come from canonical tables rather than
 * from request input, but binding costs nothing here and keeps the one rule
 * (`Prisma.raw` only for enum literals the index needs folded) unqualified.
 */
export function rankCaseSql(
  subject: Prisma.Sql,
  ranks: ReadonlyMap<string, number>,
  miss: number | null
): Prisma.Sql {
  if (ranks.size === 0) {
    return Prisma.sql`${miss}::int`;
  }
  const arms = [...ranks].map(
    ([value, rank]) => Prisma.sql`WHEN ${value} THEN ${rank}`
  );
  // `::int` is REQUIRED, not tidiness. The THEN values are bound parameters, so
  // nothing anchors the CASE's type and Postgres resolves it to `text` — then
  // `min()` over it orders LEXICOGRAPHICALLY, where '10' sorts before '2'. That
  // puts rank 10 (DONE) ahead of rank 2 (BACKLOG) and misorders every section
  // once a rank reaches two digits, which the single-digit ranks hide.
  return Prisma.sql`(CASE ${subject} ${Prisma.join(arms, " ")} ELSE ${miss} END)::int`;
}

const STATUS_DISPLAY_RANKS = new Map(
  STATUS_DISPLAY_ORDER.map((status, index) => [status, index])
);

/** `statusDisplayRank`: anything the order does not name ranks after it. */
export function statusDisplayRankSql(subject: Prisma.Sql): Prisma.Sql {
  return rankCaseSql(
    subject,
    STATUS_DISPLAY_RANKS,
    STATUS_DISPLAY_ORDER.length
  );
}

/**
 * `parseStatusForSubtype`: the status a document ROW carries, which coerces an
 * off-vocabulary value to the lifecycle's fallback rather than showing it.
 *
 * The `vocabulary` ordering sections on this, and the other two section on the
 * raw column — that difference IS what the universal-status work changes, so
 * the two must not be collapsed here.
 */
export const COERCED_STATUS_SQL = Prisma.sql`
  CASE
    WHEN ${IS_ISSUE_LIFECYCLE_SQL} THEN
      CASE WHEN a.status IN (${Prisma.join(
        Object.keys(ISSUE_STATUS_MAPPING)
      )}) THEN a.status ELSE ${issueFallbackStatus()} END
    ELSE
      CASE WHEN a.status IN (${Prisma.join(
        Object.keys(DOCUMENT_STATUS_MAPPING)
      )}) THEN a.status ELSE ${documentFallbackStatus()} END
  END`;

/**
 * `toDisplayedArtifactStatus` as a rank: the raw status folded to its root, by
 * lifecycle, then ranked. Unrecognized folds to `unknown`, which ranks last.
 *
 * Read as `min(...)` over a section, because the fold depends on the SUBTYPE as
 * well as the status: `DRAFT` on a PRD is `in_progress`, and on a FEATURE it is
 * in no issue mapping at all and folds to `unknown`. One section key, two roots.
 */
const ROOT_RANK_SQL = Prisma.sql`
  CASE
    WHEN ${IS_ISSUE_LIFECYCLE_SQL}
      THEN ${rankCaseSql(Prisma.sql`a.status`, rootRanksFor(ISSUE_STATUS_MAPPING), artifactStatusRootRank(null))}
    ELSE ${rankCaseSql(Prisma.sql`a.status`, rootRanksFor(DOCUMENT_STATUS_MAPPING), artifactStatusRootRank(null))}
  END`;

/** The persisted value a section partitions on, by mode and ordering. */
export function sectionValueSql(
  mode: ArtifactGroupByMode,
  ordering: ArtifactSectionOrdering
): Prisma.Sql {
  if (mode === ArtifactGroupByMode.Priority) {
    return Prisma.sql`a.priority::text`;
  }
  if (mode === ArtifactGroupByMode.Assignee) {
    return Prisma.sql`a.assignee_id::text`;
  }
  // The client keys a status section on the status VALUE itself, so the server
  // partitions on the same value and leaves key FORMATTING to the renderer.
  return ordering === ArtifactSectionOrdering.Vocabulary
    ? COERCED_STATUS_SQL
    : Prisma.sql`a.status`;
}

/**
 * The per-row columns a section's ORDER reads, aliased for the aggregate below.
 * Selected once in the inner query so the outer `GROUP BY` can aggregate them.
 */
export function sectionOrderColumnsSql(mode: ArtifactGroupByMode): Prisma.Sql {
  if (mode === ArtifactGroupByMode.Priority) {
    return Prisma.sql`, ${rankCaseSql(Prisma.sql`a.priority::text`, new Map(Object.entries(PRIORITY_ORDINAL)), -1)} AS priority_rank`;
  }
  if (mode === ArtifactGroupByMode.Assignee) {
    // "Just use database order" (Cosimo, 2026-10-20): the browser orders these
    // sections by `getUserDisplayName(...).localeCompare(...)`, and ICU
    // collation is not reproducible in Postgres byte order the way `id ASC` is,
    // so no parity with it is claimed or tested. Unassigned still sorts last,
    // which is `compareAssigneeNames`' null rule rather than a collation effect.
    return Prisma.sql`, assignee.first_name AS assignee_first_name, assignee.last_name AS assignee_last_name, assignee.email AS assignee_email`;
  }
  return Prisma.sql`, ${ROOT_RANK_SQL} AS root_rank, ${statusDisplayRankSql(Prisma.sql`a.status`)} AS raw_status_rank, ${statusDisplayRankSql(COERCED_STATUS_SQL)} AS coerced_status_rank`;
}

/**
 * The `ORDER BY` that puts SECTIONS in the order the surface renders them.
 *
 * Aggregates, because it runs over the grouped set: every term but the root
 * rank is constant within a section, and the root rank is not (see
 * {@link ROOT_RANK_SQL}).
 */
export function sectionOrderBySql(
  mode: ArtifactGroupByMode,
  ordering: ArtifactSectionOrdering
): Prisma.Sql {
  if (mode === ArtifactGroupByMode.Priority) {
    // Urgent first, which is the DESCENDING direction of the server's ordinal:
    // `search-query`'s runs LOW=0 → URGENT=3 and the design system's runs the
    // other way, and `list-query-fields.ts` records that the two are
    // deliberately unreconciled. Pinned against `comparePriorityByRank`.
    return Prisma.sql`min(priority_rank) DESC, section_value ASC NULLS LAST`;
  }
  if (mode === ArtifactGroupByMode.Assignee) {
    return Prisma.sql`min(assignee_first_name) ASC NULLS LAST, min(assignee_last_name) ASC NULLS LAST, min(assignee_email) ASC NULLS LAST, section_value ASC NULLS LAST`;
  }
  if (ordering === ArtifactSectionOrdering.RootFirst) {
    // `compareRootFirstStatusSections`: the section's LOWEST root band first,
    // the raw display rank as the tiebreak under it, then the key by code unit
    // — which `COLLATE "C"` is, and which the key comparison needs only to be
    // total and machine-independent.
    return Prisma.sql`min(root_rank) ASC, min(raw_status_rank) ASC, section_value COLLATE "C" ASC`;
  }
  // `compareStatusSections` is rank-only and ties two unnamed statuses at 0, so
  // the renderer's insertion order decides between them. That order is first
  // appearance in whatever order the ROOTS were put in, which `min(row_ord)` is
  // — stack rank by default, and the requested column once ISS-12636's sort is
  // applied. Direction- and column-dependent, therefore, and deliberately: the
  // browser sorts the flat root list and bands it afterwards, so first
  // appearance in the SORTED order is what `compareStatusSections`' tie
  // actually resolves to.
  const rank =
    ordering === ArtifactSectionOrdering.Vocabulary
      ? Prisma.sql`min(coerced_status_rank)`
      : Prisma.sql`min(raw_status_rank)`;
  return Prisma.sql`${rank} ASC, min(row_ord) ASC`;
}

/** The lifecycle fallbacks `parseStatusForSubtype` coerces an unknown value to. */
function issueFallbackStatus(): string {
  return fallbackFor(ISSUE_STATUS_MAPPING, "BACKLOG");
}

function documentFallbackStatus(): string {
  return fallbackFor(DOCUMENT_STATUS_MAPPING, "DRAFT");
}

/**
 * The fallback, checked against the mapping that owns the vocabulary so a
 * renamed member fails here rather than coercing every off-vocabulary row to a
 * status the lifecycle no longer has.
 */
function fallbackFor(
  mapping: Readonly<Record<string, unknown>>,
  expected: string
): string {
  if (!Object.hasOwn(mapping, expected)) {
    throw new Error(
      `assigned-tree-section-order: ${expected} is not in its lifecycle vocabulary`
    );
  }
  return expected;
}

/** Each status in one lifecycle, ranked by the root it folds to. */
export function rootRanksFor(
  mapping: Readonly<Record<string, { root: string }>>
): ReadonlyMap<string, number> {
  return new Map(
    Object.entries(mapping).map(([status, { root }]) => [
      status,
      artifactStatusRootRank(root),
    ])
  );
}
