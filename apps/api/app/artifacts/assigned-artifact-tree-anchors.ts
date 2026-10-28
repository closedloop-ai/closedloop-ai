import {
  ArtifactDateField,
  type ArtifactDateWindow,
} from "@repo/api/src/types/artifact-date-filter";
import {
  HIDE_COMPLETED_DOCUMENT_STATUSES,
  HIDE_COMPLETED_ISSUE_STATUSES,
} from "@repo/api/src/types/artifact-hide-completed";
import type { Priority } from "@repo/api/src/types/common";
import type { ArtifactStatus } from "@repo/api/src/types/document";
import {
  type PriorityFilterValue,
  splitPriorityFilter,
} from "@repo/api/src/types/priority-filter";
import { PRIORITY_VALUES } from "@repo/api/src/types/search-query";
import { ArtifactSubtype, ArtifactType, Prisma, withDb } from "@repo/database";
import { toSqlContainsPattern } from "@/lib/sql-like";

/**
 * Hard bound on how many anchor artifacts one assignee-scoped tree read walks.
 *
 * The anchors are the seed set for BOTH graph walks, so an unbounded anchor
 * count is an unbounded server workload and an unbounded `IN` predicate
 * (whitlockk, PR #4461). The cap is deliberately far above a realistic personal
 * queue — a user with more than this many open anchors is already past the
 * point where a single flat tree is a usable surface — and crossing it is
 * reported through `TreeTruncation`, never silently absorbed.
 */
export const MAX_TREE_ANCHORS = 500;

/**
 * Opt-in narrowing applied to the anchor predicate (ISS-10471).
 *
 * In the QUERY, never after the fetch: the anchor cap is what makes this worth
 * having, and a post-fetch filter would still spend the whole
 * {@link MAX_TREE_ANCHORS} budget on rows the caller asked to exclude — the
 * defect `buildDocumentStatusFilter` states in full for `GET /documents`.
 *
 * Omission narrows nothing, on every arm. That polarity is the same deploy-skew
 * contract `FindDocumentsOptions.recencyDays` carries and is not a default
 * waiting to be chosen.
 */
export type TreeAnchorFilters = {
  /**
   * Case-insensitive substring over title or slug (ISS-10472).
   *
   * Server-side because the board pages server-side: a client filter over one
   * page would search the rows on screen rather than the assignee's work, so
   * the search box would stop finding rows the reader knows exist. Blank or
   * whitespace-only narrows nothing.
   */
  search?: string;
  status?: readonly ArtifactStatus[];
  priority?: readonly PriorityFilterValue[];
  tagIds?: readonly string[];
  projectIds?: readonly string[];
  /**
   * Keep only artifacts the VIEWER has favorited (operator ruling 2026-10-16).
   * Not the assignee's: this route serves any org member's tree, and the chip
   * reads "My Favorites" — resolving it against the subject would filter your
   * view by someone else's bookmarks. `false` narrows nothing, exactly as
   * omission does.
   */
  favoritesOnly?: boolean;
  /**
   * Drop artifacts the table counts as completed (operator ruling 2026-10-16).
   * `false` narrows nothing, as omission does.
   */
  hideCompletedItems?: boolean;
  /**
   * A closed window on one of the artifact's two timestamps. Both ends
   * inclusive, both ABSOLUTE — see {@link ArtifactDateWindow} for why the
   * relative preset is resolved before it reaches the wire.
   */
  dateWindow?: ArtifactDateWindow;
};

/**
 * The anchors My Tasks is built from, resolved server-side: artifacts assigned
 * to `assigneeId` that are neither sessions nor branches.
 *
 * Branches are not tasks (ISS-12463, operator ruling 2026-10-16). The
 * exclusion is `<> BRANCH`, not `= DOCUMENT`, because the client prune this
 * read has to agree with (`pruneBranchSubtrees`) drops `BRANCH` and nothing
 * else: narrowing to documents here would drop an assigned deployment the
 * fan-out still shows (marisolashgrove, PR #7953).
 *
 * Sessions are excluded too (ISS-12251 D-5). Sessions carry their Owner as
 * `assignee_id`, which every session gets on first sync, so admitting them
 * here would fill My Tasks with every session a user ever recorded.
 */
export type TreeAnchors = {
  /** Anchor ids, capped at {@link MAX_TREE_ANCHORS}. */
  ids: string[];
  /**
   * A FLOOR on how many anchors matched. Equal to `ids.length` when the cap did
   * not bind; otherwise `MAX_TREE_ANCHORS + 1`, the overflow probe, which is
   * why it is named as a floor rather than a total.
   */
  matchedAtLeast: number;
};

/**
 * Resolve the anchor set for one assignee in one query, keeping the most recent
 * work when the cap binds. Org scoping is in the predicate, not applied
 * afterwards.
 */
export async function resolveTreeAnchors(
  assigneeId: string,
  organizationId: string,
  viewerUserId: string,
  filters: TreeAnchorFilters = {}
): Promise<TreeAnchors> {
  const narrowing = buildAnchorNarrowingSql(viewerUserId, filters);
  const rows = await withDb((db) =>
    db.$queryRaw<Array<{ id: string }>>(
      assignedNonBranchAnchorsSql(assigneeId, organizationId, narrowing)
    )
  );

  if (rows.length <= MAX_TREE_ANCHORS) {
    return { ids: rows.map((row) => row.id), matchedAtLeast: rows.length };
  }
  // One extra row was requested purely to detect the overflow, so this is a
  // FLOOR, not an exact count. Reporting it as an exact total would be the
  // plausible-but-wrong number the repo's bad-data rule forbids; the caller
  // pairs it with an explicit truncation reason so it is never read as exact.
  return {
    ids: rows.slice(0, MAX_TREE_ANCHORS).map((row) => row.id),
    matchedAtLeast: rows.length,
  };
}

/**
 * The tiebreak is `a.id DESC` so that
 * `artifacts_org_assignee_created_id_non_session_idx` can serve the sort as an
 * ordered scan rather than a `Sort` over the whole assigned set. That index
 * stores `(organization_id, assignee_id, created_at DESC, id DESC)`, and
 * Postgres can only read a btree forwards or exactly backwards — `created_at
 * DESC, id ASC` is neither, so it would sort every matching row before `LIMIT`
 * could trim it.
 *
 * That index is partial on `type <> 'SESSION'`, so the scan never visits a
 * session; an assigned BRANCH is still fetched and discarded as a heap recheck.
 */
function assignedNonBranchAnchorsSql(
  assigneeId: string,
  organizationId: string,
  narrowing: Prisma.Sql
): Prisma.Sql {
  return Prisma.sql`
      SELECT a.id
      FROM artifacts a
      WHERE ${assignedAnchorScopeSql(assigneeId, organizationId)}
        ${narrowing}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ${MAX_TREE_ANCHORS + 1}
    `;
}

/**
 * The org/assignee/type half of the anchor predicate, over an `artifacts a`.
 *
 * Shared with the ISS-10472 root page so the two reads cannot disagree about
 * WHICH artifacts are anchors. It admits DOCUMENT and DEPLOYMENT: the exclusion
 * is stated as `<> BRANCH AND <> SESSION` rather than `= DOCUMENT` because
 * `artifacts_org_assignee_created_id_non_session_idx` is partial on
 * `type <> 'SESSION'`, and because narrowing to DOCUMENT would silently drop an
 * assigned DEPLOYMENT from a shipped surface.
 */
export function assignedAnchorScopeSql(
  assigneeId: string,
  organizationId: string
): Prisma.Sql {
  return Prisma.sql`a.organization_id = ${organizationId}::uuid
        AND a.assignee_id = ${assigneeId}::uuid
        AND a.type <> ${ArtifactType.BRANCH}::"ArtifactType"
        AND a.type <> ${SESSION_TYPE_LITERAL}`;
}

/** The facet half of the anchor predicate, or a run of `Prisma.empty`. */
export function buildAnchorNarrowingSql(
  viewerUserId: string,
  filters: TreeAnchorFilters
): Prisma.Sql {
  return Prisma.sql`${anchorStatusSql(filters.status)} ${anchorPrioritySql(filters.priority)} ${anchorTagsSql(filters.tagIds)} ${anchorProjectsSql(filters.projectIds)} ${anchorFavoritesSql(filters.favoritesOnly, viewerUserId)} ${anchorHideCompletedSql(filters.hideCompletedItems)} ${anchorDateSql(filters.dateWindow)} ${anchorSearchSql(filters.search)}`;
}

/**
 * The SESSION exclusion inlined as a literal, never bound: a bound
 * `$n::"ArtifactType"` is an I/O cast Postgres does not fold, so it proves no
 * partial-index predicate under either plan mode and the scan falls back to
 * `artifacts_org_assignee_created_id_idx` (EXPLAIN in the
 * `iss12251_artifacts_assigned_non_session_index` migration). Built from the
 * enum constant, never from input.
 */
const SESSION_TYPE_LITERAL = Prisma.raw(
  `'${ArtifactType.SESSION}'::"ArtifactType"`
);

/**
 * Every `Priority` as an inlined enum literal, built once from the canonical
 * vocabulary.
 *
 * A `Map`, not an object literal: the lookup key is request-derived, and a
 * plain object would answer `__proto__` with `Object.prototype` rather than
 * `undefined` (root `AGENTS.md` on dispatch tables).
 */
const PRIORITY_LITERALS: ReadonlyMap<Priority, Prisma.Sql> = new Map(
  PRIORITY_VALUES.map((value) => [value, Prisma.raw(`'${value}'::"Priority"`)])
);

/**
 * The lifecycle-status slice, or `Prisma.empty`. Deduped before the `IN` list:
 * the vocabulary is closed, so the list stays bounded at its size however
 * repetitive the query string was ({@link buildDocumentStatusFilter}).
 */
function anchorStatusSql(
  status: readonly ArtifactStatus[] | undefined
): Prisma.Sql {
  if (status === undefined || status.length === 0) {
    return Prisma.empty;
  }
  return Prisma.sql`AND a.status IN (${Prisma.join([...new Set(status)])})`;
}

/**
 * The priority slice, or `Prisma.empty`.
 *
 * TWO arms, ORed, because `Artifact.priority` is nullable and null is a state a
 * user can see and filter rather than a stand-in for MEDIUM (ISS-9665,
 * ISS-9833). No value list matches `NULL`, so the unset arm cannot ride along
 * in the `IN`. The split comes from {@link splitPriorityFilter}, which the
 * Branches list also reads. `a.priority IS NULL` matches My Tasks' own two
 * predicates (`use-table-filters.ts`, `my-tasks/utils.ts`), which fold
 * `undefined` into the unset arm — NOT `matchesPriorityFilter`, which refuses
 * `undefined`. The column is either null or a value, so there is no third case.
 *
 * The enum literal is INLINED from the canonical vocabulary, never bound and
 * never cast on the column (ISS-12657). Both of the obvious spellings defeat
 * the index:
 *
 * - `a.priority::text IN ($1, …)` — what this used to send — casts the COLUMN,
 *   and an index on `(priority::text)` CANNOT BE CREATED: the enum-to-text cast
 *   is STABLE rather than IMMUTABLE, because enum labels are renameable, so
 *   Postgres rejects it with `functions in index expression must be marked
 *   IMMUTABLE`. No index can serve that predicate at all. Measured against a
 *   250k-row assignee it was a parallel sequential scan.
 * - a bound `$n::"Priority"` is an I/O cast Postgres does not fold, so it
 *   proves no partial-index predicate either — the reason the column cast was
 *   chosen in the first place.
 *
 * Inlining sidesteps both, and is the pattern {@link SESSION_TYPE_LITERAL}
 * already uses here. The BRANCH exclusion stays BOUND: that arm is an
 * inequality against a three-value column, so no partial-index predicate rests
 * on it. The literals come from {@link PRIORITY_LITERALS}, keyed off the
 * canonical `PRIORITY_VALUES`, so no request-derived string reaches
 * `Prisma.raw`.
 */
function anchorPrioritySql(
  priority: readonly PriorityFilterValue[] | undefined
): Prisma.Sql {
  if (priority === undefined || priority.length === 0) {
    return Prisma.empty;
  }
  const { members, includesUnset } = splitPriorityFilter(priority);
  const arms: Prisma.Sql[] = [];
  if (members.length > 0) {
    const literals = members.flatMap((member) => {
      const literal = PRIORITY_LITERALS.get(member);
      // A member that is not in the canonical vocabulary cannot be inlined
      // safely, so it is DROPPED rather than interpolated. `isPriority` already
      // narrowed it, so this is unreachable today and exists so that a weakened
      // validator loses a facet value instead of opening an injection surface.
      return literal ? [literal] : [];
    });
    if (literals.length > 0) {
      arms.push(Prisma.sql`a.priority IN (${Prisma.join(literals)})`);
    }
  }
  if (includesUnset) {
    arms.push(Prisma.sql`a.priority IS NULL`);
  }
  if (arms.length === 0) {
    // FAIL CLOSED. A selection that resolves to no arm must not fall through to
    // `Prisma.empty`: that emits no predicate at all, so a caller who asked to
    // narrow would be handed every assigned row. Unreachable past the route's
    // `z.enum(priorityFilterValues)` and `PRIORITY_LITERALS`' exhaustive
    // `PRIORITY_VALUES` keys, so there is no partial answer to degrade to.
    throw new Error(
      `anchorPrioritySql: ${priority.length} priority facet value(s) resolved to no SQL arm`
    );
  }
  return Prisma.sql`AND (${Prisma.join(arms, " OR ")})`;
}

/**
 * The tag slice, or `Prisma.empty`.
 *
 * ANY, not ALL: a row qualifies on ONE selected tag, which is the semantics
 * `matchesTagFilter` already applies in the browser
 * (`itemTags.some((t) => tagIds.includes(t.id))`). Moving the question into the
 * query must not change the answer it gives.
 *
 * A correlated `EXISTS`, and deliberately not the shape PRD-743 indicts on the
 * contributor arm: that one walks a JSONB predicate tree no index reaches,
 * while this one is two equality columns of `tag_artifacts`' own
 * `@@unique([tagId, artifactId])`, so each probe is an index lookup rather than
 * a scan.
 *
 * Ids are opaque here. An id naming a tag in another organization simply
 * matches no row — `tag_artifacts` rows reachable from `a` are already inside
 * the org predicate above — so this adds no cross-tenant read.
 */
function anchorTagsSql(tagIds: readonly string[] | undefined): Prisma.Sql {
  if (tagIds === undefined || tagIds.length === 0) {
    return Prisma.empty;
  }
  return Prisma.sql`AND EXISTS (
          SELECT 1
          FROM tag_artifacts ta
          WHERE ta.artifact_id = a.id
            AND ta.tag_id IN (${Prisma.join([...new Set(tagIds)].map((id) => Prisma.sql`${id}::uuid`))})
        )`;
}

/**
 * The project slice, or `Prisma.empty` (ISS-10471, operator ruling 2026-10-16:
 * the Project column is in `MY_TASKS_DEFAULT_COLUMNS` and had no filter behind
 * it).
 *
 * Ids only, with NO member standing for "no project" — the shape both existing
 * project filters have, `GET /documents` carrying project-less as a separate
 * boolean. `Artifact.projectId` is nullable for every type (FEA-1749), so an
 * assigned org-level artifact is NOT reachable through this facet; ISS-10471
 * raises that gap rather than deciding it.
 *
 * `::uuid` per element: comparing a `uuid` column against text would cost a
 * cast on every row of the ordered scan.
 */
function anchorProjectsSql(
  projectIds: readonly string[] | undefined
): Prisma.Sql {
  if (projectIds === undefined || projectIds.length === 0) {
    return Prisma.empty;
  }
  const ids = [...new Set(projectIds)].map((id) => Prisma.sql`${id}::uuid`);
  return Prisma.sql`AND a.project_id IN (${Prisma.join(ids)})`;
}

/**
 * The favorites slice, or `Prisma.empty` (ISS-10471).
 *
 * Scoped to the VIEWER, never to `assigneeId`: a tree filtered by a stranger's
 * bookmarks reads as an empty queue rather than as a bug.
 *
 * A correlated `EXISTS` over `favorite_artifacts`' own
 * `@@unique([userId, artifactId])`, so each probe is an index lookup rather
 * than a scan.
 */
function anchorFavoritesSql(
  favoritesOnly: boolean | undefined,
  viewerUserId: string
): Prisma.Sql {
  if (favoritesOnly !== true) {
    return Prisma.empty;
  }
  return Prisma.sql`AND EXISTS (
          SELECT 1
          FROM favorite_artifacts fa
          WHERE fa.artifact_id = a.id
            AND fa.user_id = ${viewerUserId}::uuid
        )`;
}

/**
 * The hide-completed slice, or `Prisma.empty` (ISS-10471).
 *
 * Per vocabulary, and the asymmetry is load-bearing: an `APPROVED` document
 * stays VISIBLE because it still awaits execution, so the domain-wide
 * `TERMINAL_DOCUMENT_STATUSES` — what every blocker check reaches for — must
 * NOT be used here.
 *
 * Subtypes come from the PERSISTED enum, and `ISSUE` joins `FEATURE` because
 * `normalizeArtifactRowSubtype` folds that input-only alias on read: the
 * predicate matches the normalizer, not the schema.
 *
 * `ELSE false` keeps a type neither arm covers visible. Hiding what it cannot
 * classify would remove work nobody decided was done. A BRANCH lands there
 * rather than on an arm of its own: ISS-12463 removed branches from the anchor
 * set, so no branch reaches this predicate.
 */
function anchorHideCompletedSql(
  hideCompletedItems: boolean | undefined
): Prisma.Sql {
  if (hideCompletedItems !== true) {
    return Prisma.empty;
  }
  const issueSubtypes = Prisma.join(
    [ArtifactSubtype.FEATURE, ArtifactSubtype.ISSUE].map(
      (subtype) => Prisma.sql`${subtype}`
    )
  );
  return Prisma.sql`AND NOT (
          CASE
            WHEN a.type::text = ${ArtifactType.DOCUMENT}
              AND a.subtype::text IN (${issueSubtypes})
              THEN a.status IN (${statusList(HIDE_COMPLETED_ISSUE_STATUSES)})
            WHEN a.type::text = ${ArtifactType.DOCUMENT}
              THEN a.status IN (${statusList(HIDE_COMPLETED_DOCUMENT_STATUSES)})
            ELSE false
          END
        )`;
}

/**
 * The date-window slice, or `Prisma.empty` (ISS-10471).
 *
 * BOTH ENDS INCLUSIVE, matching `matchesDateFilter`.
 *
 * The column is chosen by SWITCHING on the validated field, never by
 * interpolating the caller's string — an identifier spliced into SQL is an
 * injection surface upstream validation cannot make safe to rely on.
 *
 * Neither timestamp is nullable, so unlike every other facet here there is no
 * `IS NULL` arm to decide.
 */
function anchorDateSql(window: ArtifactDateWindow | undefined): Prisma.Sql {
  if (window === undefined) {
    return Prisma.empty;
  }
  const column =
    window.field === ArtifactDateField.CreatedAt
      ? Prisma.sql`a.created_at`
      : Prisma.sql`a.updated_at`;
  return Prisma.sql`AND ${column} >= ${window.from} AND ${column} <= ${window.to}`;
}

/**
 * Bind a shared status vocabulary as an `IN` list, never as one joined string.
 *
 * Non-empty by TYPE: `Prisma.join([])` throws a `TypeError` at request time, so
 * every caller must prove its vocabulary has a member rather than discover it
 * on a 500.
 */
function statusList(statuses: readonly [string, ...string[]]): Prisma.Sql {
  return Prisma.join(statuses.map((status) => Prisma.sql`${status}`));
}

/**
 * The title-or-slug search slice, or `Prisma.empty`.
 *
 * Matches `buildDocumentSearchFilter`, the document list's spelling, so the two
 * reads answer the same typed term the same way: case-insensitive SUBSTRING
 * over `name` (surfaced as `title`) OR `slug`, which is also what the client's
 * pattern-free `matchesFilter` applies to those same two fields.
 *
 * `ESCAPE` is explicit because `toSqlContainsPattern` escapes `%`, `_` and `\\`
 * into backslash sequences and a bare `ILIKE $n` carries no escape clause —
 * without it a typed `100%` would match every title merely starting `100`.
 *
 * `slug` is nullable and `ILIKE` cannot match NULL, which is harmless only
 * because the two are OR'd and `name` is NOT NULL: a slug-less artifact is
 * still reachable by its title. The same reasoning the document list records.
 */
function anchorSearchSql(search: string | undefined): Prisma.Sql {
  const term = search?.trim();
  if (!term) {
    return Prisma.empty;
  }
  const pattern = toSqlContainsPattern(term);
  return Prisma.sql`AND (a.name ILIKE ${pattern} ESCAPE '\\' OR a.slug ILIKE ${pattern} ESCAPE '\\')`;
}
