import type { CustomFieldValueDetail } from "@repo/api/src/types/custom-field";
import {
  type ArtifactStatus,
  DOCUMENT_LIST_MAX_LIMIT,
  DOCUMENT_LIST_MAX_RECENCY_DAYS,
  DOCUMENT_LIST_MIN_RECENCY_DAYS,
  DocumentListRecency,
  type DocumentWithProject,
  type FindDocumentsOptions,
  normalizeDocumentType,
} from "@repo/api/src/types/document";
import type { DocumentMetricScopeFilters } from "@repo/api/src/types/document-metric-scope";
import { ProjectStatus } from "@repo/api/src/types/project";
import { Prisma } from "@repo/database";
import { documentWhere } from "@/lib/artifact-adapters";
import { escapeSqlLikeLiteral } from "@/lib/sql-like";
import type { CustomFieldEntityIdConstraint } from "./custom-field-list-service";

/**
 * List-query paging helpers for `documentService.findAll` (FEA-4373). Extracted
 * from `document-service.ts` as a co-located sibling so the paging concern lives
 * in one small, unit-testable module instead of adding to the grandfathered
 * service file. Pure functions — no I/O, no DB, no import of the service.
 *
 * ISS-4576 added the predicate builder ({@link buildDocumentListWhere}) here too,
 * so the paged `findMany` and the `count` that produces the honest total are
 * built from ONE expression. A count over a drifted predicate is worse than no
 * count: it reports a total for a population the page was never drawn from.
 */

/**
 * Resolve the Prisma `take` for a document-list query. The bound is opt-in: an
 * undefined `limit` returns `undefined` so the query stays unbounded and the
 * endpoint's long-standing default contract (the Documents index, plan/document
 * pickers, and version-skewed API clients all read the full set) is preserved.
 * A caller that passes `limit` — only the My Tasks board today, whose
 * one-row-per-artifact render can crash on a very large assigned set — gets it
 * clamped to [1, {@link DOCUMENT_LIST_MAX_LIMIT}]. `Math.min` alone would not
 * floor a non-positive value, so the floor is explicit.
 */
export function resolveDocumentListTake(
  limit: number | undefined
): number | undefined {
  if (limit === undefined) {
    return undefined;
  }
  return Math.max(1, Math.min(limit, DOCUMENT_LIST_MAX_LIMIT));
}

/**
 * Resolve the Prisma `skip` for a document-list query. Only meaningful with a
 * `take` (an offset into an unbounded read does nothing), so callers pass the
 * resolved take and this returns `undefined` when the query is unbounded.
 * Otherwise the offset is floored at 0 and NOT capped (ISS-11161): a clamp
 * here would answer a deep page with a shallower one's rows.
 */
export function resolveDocumentListSkip(
  take: number | undefined,
  offset: number | undefined
): number | undefined {
  if (take === undefined) {
    return undefined;
  }
  if (offset === undefined) {
    return 0;
  }
  return Math.max(0, offset);
}

/**
 * Resolve the `projectId` slice of a document list `where` clause (FEA-4140).
 * A concrete `projectId` scopes to that project and wins. Otherwise, when
 * `unassignedProject` is set, narrow to project-less documents
 * (`projectId === null`). With neither, impose no project constraint.
 */
export function buildProjectFilter(
  projectId: string | undefined,
  unassignedProject: boolean | undefined
): { projectId?: string | null } {
  if (projectId) {
    return { projectId };
  }
  if (unassignedProject) {
    return { projectId: null };
  }
  return {};
}

/**
 * Build the org-scoped Prisma `where` for a document-list query (ISS-4576).
 *
 * The single source of truth for "which artifacts does this query describe",
 * shared by the paged `findMany` and the `count` behind the honest total, so the
 * page and its total can never be drawn from different populations. `projectId`
 * must already be resolved to a concrete id by the route (slugs are resolved at
 * the boundary).
 *
 * ISS-4397: `type` is the request-side superset and may be the `ISSUE` alias;
 * it is normalized to the persisted `DocumentType` before becoming a `subtype`
 * filter, so `type=ISSUE` matches FEATURE-typed rows.
 *
 * ISS-7211: a custom-field filter arrives here ALREADY RESOLVED, as a set of
 * entity ids on `customFieldEntityIds`. It enters the predicate as a constraint
 * on the artifact's own primary key, which is what makes the honest total stay
 * honest — see {@link buildCustomFieldIdFilter}.
 */
export function buildDocumentListWhere(
  options: Pick<
    FindDocumentsOptions,
    | "artifactIds"
    | "type"
    | "types"
    | "projectId"
    | "assigneeId"
    | "unassignedProject"
    | "recencyDays"
    | "includeArchivedProjects"
    | "search"
    | "status"
  > &
    DocumentListScopeConstraints & {
      organizationId: string;
      customFieldEntityIds?: CustomFieldEntityIdConstraint;
    },
  now: Date = new Date()
) {
  const { organizationId, projectId, assigneeId, unassignedProject } = options;
  return documentWhere({
    organizationId,
    ...buildProjectFilter(projectId, unassignedProject),
    ...buildDocumentTypeFilter(options),
    ...(assigneeId ? { assigneeId } : {}),
    ...buildRecencyFilter(options, now),
    ...buildArchivedProjectFilter(options),
    ...buildCustomFieldIdFilter(
      exactArtifactConstraint(options.artifactIds, options.customFieldEntityIds)
    ),
    ...composeConjuncts(
      buildDocumentSearchFilter(options.search),
      buildScopeConstraintConjuncts(options)
    ),
    ...buildDocumentStatusFilter(options.status),
  });
}

/**
 * The free-text slice of a document-list `where` — `{}` when no term applies
 * (ISS-9724).
 *
 * **It is emitted under `AND`, not as a bare `OR`, and that is the whole point
 * of the shape.** `buildArchivedProjectFilter` already contributes a top-level
 * `OR`, and both slices are spread into ONE object literal: a second bare `OR`
 * would not combine with the first, it would REPLACE it, and object-spread
 * clobbering is silent. Whichever lost would stop narrowing — either archived
 * projects would leak back into a bounded read, or the search would match
 * nothing it should not. Nesting under `AND` gives the term its own conjunct,
 * so the two predicates are composed rather than racing for one key.
 *
 * Matching is case-insensitive SUBSTRING over `Artifact.name` — the column the
 * API surfaces as `title` — and `Artifact.slug`, OR'd, which is the semantics
 * the index's client-side `matchesFilter` already applies to those same two
 * fields (see {@link FindDocumentsOptions.search} for why the FTS projection was
 * not reused). The term is a BOUND Prisma parameter, so `'` is never SQL — but
 * binding is not enough on its own: `contains` splices that parameter into an
 * `ILIKE '%' || $1 || '%'` pattern, where `%` and `_` are still read as pattern
 * syntax. Unescaped, `100%` matched every title merely starting `100` and
 * `release_notes` matched `releaseXnotes` — results not containing what was
 * typed, and a server predicate at odds with the client's pattern-free
 * `String.includes`. {@link escapeSqlLikeLiteral} is the shared fix, already
 * relied on by the Tags list's identical Prisma `contains` search; its own
 * docstring is explicit that the escape set must not be duplicated.
 *
 * `slug` is nullable and a `contains` on it cannot match NULL — the same
 * NULL-drops-the-row hazard {@link buildRecencyFilter} documents. It is harmless
 * HERE and only here: the two fields are OR'd, and `name` is non-nullable, so a
 * slug-less artifact is still reachable by its title rather than excluded.
 *
 * A blank term returns `{}`: the route rejects one before it gets here, so this
 * is defense in depth for a direct service caller, and "no narrowing" is the
 * only honest reading of a term that narrows nothing.
 */
export function buildDocumentSearchFilter(
  search: string | undefined
): DocumentSearchFilter {
  const term = search?.trim() ?? "";
  if (term === "") {
    return {};
  }
  const match: DocumentSearchMatch = {
    contains: escapeSqlLikeLiteral(term),
    mode: Prisma.QueryMode.insensitive,
  };
  return { AND: [{ OR: [{ name: match }, { slug: match }] }] };
}

/**
 * The lifecycle-status slice of a document-list `where` — `{}` when no status
 * applies (ISS-6778).
 *
 * **The predicate goes into the QUERY, which is the entire point of the
 * ticket.** A post-fetch `.filter()` behind a server-looking parameter would
 * reproduce the defect one layer down: the caller still pays for every row it
 * did not ask for, and the honest total that {@link buildDocumentListWhere}
 * exists to keep aligned with the page would count a population the page no
 * longer describes.
 *
 * Emitted as `in` for one value as well as many, so the two arms cannot drift
 * into different SQL for the same question. `Artifact` already carries
 * `@@index([organizationId, type, status])`, which this predicate's leading
 * equality columns match, so no new index is required.
 *
 * The set is DEDUPED before it reaches Prisma: the accepted vocabulary is
 * closed, so deduping bounds the `IN` list at the vocabulary size no matter how
 * repetitive a caller's query string is — the bind-parameter bound in
 * `apps/api/AGENTS.md` satisfied by construction rather than by a second cap.
 *
 * An empty array narrows nothing, and under the repeated-key wire shape that is
 * the SAME answer the boundary gives rather than a disagreement with it. A
 * client with nothing selected serializes an empty set to no `status`
 * occurrence at all (`buildDocumentListSearchParams`), so the route sees an
 * unfiltered request and never reaches the array-length check; what the route
 * still rejects is a blank `?status=`, which is a status that failed to spell
 * itself, not an empty selection. The two readings only collided while the
 * parameter was comma-joined, because `[].toString()` made "nothing selected"
 * and "malformed" the same six characters (tamsinb review).
 *
 * It is deliberately NOT the `include: []` reading of
 * {@link buildCustomFieldIdFilter}, where the empty array is a RESOLVED result
 * meaning "a facet matched nothing" rather than an unset filter.
 */
export function buildDocumentStatusFilter(
  status: readonly ArtifactStatus[] | undefined
): { status?: { in: ArtifactStatus[] } } {
  if (status === undefined || status.length === 0) {
    return {};
  }
  return { status: { in: [...new Set(status)] } };
}

/**
 * The custom-field slice of a document-list `where` — `{}` when no facet applies.
 *
 * **This is the reason the paged total is an entity count and not a row count.**
 * Joining the tall `custom_field_values` table into the artifact query would
 * make an artifact carrying three values join to three rows, and a `count()`
 * over that reports it three times. Constraining `Artifact.id` instead — the ids
 * having been resolved against the value table already — can only ever see each
 * artifact once, whatever it carries.
 *
 * `include: []` is preserved rather than collapsed to `{}`: it means a facet
 * matched nothing, and a falsy check would read that as "no filter" and return
 * the whole list.
 */
export function buildCustomFieldIdFilter(
  constraint: CustomFieldEntityIdConstraint | undefined
): { id?: { in?: string[]; notIn?: string[] } } {
  if (!constraint) {
    return {};
  }
  const { include, exclude } = constraint;
  if (include === undefined && exclude.length === 0) {
    return {};
  }
  return {
    id: {
      ...(include === undefined ? {} : { in: include }),
      ...(exclude.length === 0 ? {} : { notIn: exclude }),
    },
  };
}

/**
 * Whether rows matching the predicate exist beyond the page just served.
 *
 * Derived from the REAL total rather than `pageSize === items.length`, which
 * reports a phantom next page whenever the last page happens to fill exactly.
 */
export function resolveDocumentListHasMore(
  offset: number,
  pageCount: number,
  total: number
): boolean {
  return offset + pageCount < total;
}

const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * Resolve the recency window, in days, for a document-list query — or
 * `undefined` for "no window at all".
 *
 * **Omission means the legacy, unwindowed behavior, on every arm.** FEA-1626
 * originally defaulted the *user-scoped, paged* arm to a 90-day window and made
 * the client send `recencyDays=all` to opt back out. whitlockk's review killed that
 * polarity: `apps/app` and `apps/api` deploy independently, so a server-side
 * default lands for the already-deployed old app before any flag can control it,
 * and the old app's request is byte-identical to a new client's flag-off
 * request. With omission pinned to legacy, both skew orders are safe — an old
 * app gets exactly what it got yesterday, and a new app only narrows its own
 * read once it explicitly asks. The window is a capability the endpoint offers,
 * not a default it imposes.
 *
 * {@link DocumentListRecency.All} is kept as an explicit "no window" value even
 * though it is now the same as omission: it is what the My Tasks recency chip
 * sends when a user removes the window, and saying so on the wire is clearer
 * than dropping a param.
 *
 * A day count is clamped to
 * [{@link DOCUMENT_LIST_MIN_RECENCY_DAYS}, {@link DOCUMENT_LIST_MAX_RECENCY_DAYS}].
 * `Math.min` alone would not floor a zero or negative value into a usable
 * window, so the floor is explicit (the validator rejects out-of-range client
 * input; this is defense in depth for direct service callers).
 */
export function resolveDocumentListRecencyDays(
  options: Pick<FindDocumentsOptions, "recencyDays">
): number | undefined {
  const { recencyDays } = options;
  if (recencyDays === undefined || recencyDays === DocumentListRecency.All) {
    return undefined;
  }
  return Math.max(
    DOCUMENT_LIST_MIN_RECENCY_DAYS,
    Math.min(recencyDays, DOCUMENT_LIST_MAX_RECENCY_DAYS)
  );
}

/**
 * The `updatedAt` slice of a document-list `where` — `{}` when no window applies.
 *
 * **The window is deliberately anchored on `Artifact.updatedAt`, and that choice
 * is about NULLs as much as about semantics.** A date-window predicate excludes
 * every row whose anchor column is NULL, silently and permanently — so the
 * anchor must be a column that cannot be NULL. `updatedAt` is `@updatedAt` and
 * non-nullable in `schema.prisma` (as is `createdAt`), so Postgres itself
 * guarantees no row can be dropped for want of a timestamp; there is no
 * "unknown timestamp" case to include, exclude, or fall back for. A nullable
 * candidate such as `dueDate` would have needed an explicit null branch and was
 * rejected for exactly that reason. The non-nullability is pinned by a
 * compile-time assertion in `document-list-query.test.ts`, so making either
 * column optional fails typecheck and forces this predicate to be revisited.
 *
 * `updatedAt` over `createdAt` on semantics too: an artifact created two years
 * ago but worked on this morning is recent, and a `createdAt` window would drop
 * it. Since `updatedAt >= createdAt` always holds, an `updatedAt` window is a
 * strict superset of the equivalent `createdAt` window — the more forgiving of
 * the two.
 *
 * There is no soft-delete dimension to filter here: `Artifact` has no
 * `deletedAt` column — documents are hard-deleted (`DELETE`, with
 * `onDelete: Cascade` from `Project`) — so soft-deleted rows are excluded by
 * construction. That is pinned by the same compile-time assertion, which fails
 * if an `Artifact.deletedAt` is ever introduced without teaching this predicate
 * about it.
 */
export function buildRecencyFilter(
  options: Pick<FindDocumentsOptions, "recencyDays">,
  now: Date
): { updatedAt?: { gte: Date } } {
  const days = resolveDocumentListRecencyDays(options);
  if (days === undefined) {
    return {};
  }
  return {
    updatedAt: { gte: new Date(now.getTime() - days * MILLISECONDS_PER_DAY) },
  };
}

/**
 * The archived-project slice of a document-list `where` — `{}` when the filter
 * does not apply.
 *
 * **`projectId: null` means "not archived", not "unknown".** An artifact with no
 * parent project (an org-level Document or a Template — `Artifact.projectId` is
 * nullable for every type) has no archive state to inherit, so it must stay in
 * the result. A bare `project: { status: { not: ARCHIVED } }` would drop every
 * one of them, because a filter on a nullable to-one relation matches only rows
 * that HAVE a related row. The explicit `OR` is what encodes that decision
 * instead of letting it fall out of the SQL by accident.
 *
 * **Applied only when the caller explicitly asks for it** —
 * `includeArchivedProjects=false`. Omission keeps the legacy behavior of
 * returning artifacts regardless of their project's lifecycle, for the same
 * deploy-skew reason {@link resolveDocumentListRecencyDays} documents: a
 * server-side default would narrow the already-deployed old app's response
 * before its flag could control it. `true` is accepted and is the same as
 * omission, so a client can state the legacy intent on the wire.
 *
 * Skipped entirely when a concrete `projectId` was requested: asking for one
 * project by id is an explicit choice, and silently returning nothing because
 * that project is archived would be worse than honoring it. Mirrors
 * `GET /projects`, which drops its own default `ARCHIVED` exclusion the moment
 * the caller states a status filter.
 */
export function buildArchivedProjectFilter(
  options: Pick<FindDocumentsOptions, "projectId" | "includeArchivedProjects">
): {
  OR?: [{ projectId: null }, { project: { status: { not: ProjectStatus } } }];
} {
  if (
    options.includeArchivedProjects !== false ||
    options.projectId !== undefined
  ) {
    return {};
  }
  return {
    OR: [
      { projectId: null },
      { project: { status: { not: ProjectStatus.Archived } } },
    ],
  };
}

/**
 * Attach each artifact's custom-field values to its row, grouping the flat
 * batch read by entity id in one pass rather than scanning it per document.
 *
 * Lives here rather than in `document-service.ts` because it is pure list-shaping
 * with no I/O, and that service is over the file-size ceiling and grandfathered
 * (see `apps/api/AGENTS.md` and the repo's File Size and Organization rules) —
 * so the concern moves out as part of touching it, not on top of it.
 */
export function attachCustomFieldValues(
  documents: DocumentWithProject[],
  values: CustomFieldValueDetail[]
): DocumentWithProject[] {
  const valuesByEntityId = new Map<string, CustomFieldValueDetail[]>();
  for (const value of values) {
    const list = valuesByEntityId.get(value.entityId);
    if (list) {
      list.push(value);
    } else {
      valuesByEntityId.set(value.entityId, [value]);
    }
  }
  return documents.map((document) => ({
    ...document,
    customFields: valuesByEntityId.get(document.id) ?? [],
  }));
}

/**
 * Compile-time pins for the two schema facts FEA-1626's predicate depends on.
 *
 * A date-window predicate excludes every row whose anchor column is NULL, so the
 * window in {@link buildRecencyFilter} is only safe while `Artifact.updatedAt`
 * cannot be NULL — and "documents have no soft-delete state to filter" is only
 * true while `Artifact` has no `deletedAt`. Both are properties of the generated
 * Prisma model rather than of any code path, so neither can be asserted at
 * runtime: `AssertTrue` stops being satisfiable and `tsc --noEmit` fails,
 * forcing the predicate to be revisited instead of quietly deleting rows from
 * every user-scoped list. `createdAt` is pinned too because it is the standing
 * alternative anchor a future change would reach for.
 */
type AssertTrue<T extends true> = T;

/** One field's half of the ISS-9724 substring match. */
type DocumentSearchMatch = {
  contains: string;
  mode: typeof Prisma.QueryMode.insensitive;
};

/**
 * The free-text conjunct {@link buildDocumentSearchFilter} contributes, or `{}`.
 * Named so the `AND` nesting is part of the signature a caller reads rather than
 * an inferred shape — the nesting is what stops it clobbering a sibling `OR`.
 */
type DocumentSearchFilter = {
  AND?: [
    { OR: [{ name: DocumentSearchMatch }, { slug: DocumentSearchMatch }] },
  ];
};

export type RecencyAnchorIsNonNullable = AssertTrue<
  [Prisma.ArtifactModel["updatedAt"]] extends [Date] ? true : false
>;
export type CreatedAtIsNonNullable = AssertTrue<
  [Prisma.ArtifactModel["createdAt"]] extends [Date] ? true : false
>;
export type ArtifactHasNoSoftDeleteColumn = AssertTrue<
  "deletedAt" extends keyof Prisma.ArtifactModel ? false : true
>;

/** Scalar and union subtype filters compose as an intersection. */
export function buildDocumentTypeFilter(
  options: Pick<FindDocumentsOptions, "type" | "types">
) {
  const type =
    options.type === undefined
      ? undefined
      : normalizeDocumentType(options.type);
  if (options.types && options.types.length > 0) {
    const types = [...new Set(options.types.map(normalizeDocumentType))];
    return {
      subtype: {
        in:
          type === undefined ? types : types.filter((value) => value === type),
      },
    };
  }
  return type === undefined ? {} : { subtype: type };
}

function exactArtifactConstraint(
  ids: string[] | undefined,
  custom: CustomFieldEntityIdConstraint | undefined
): CustomFieldEntityIdConstraint | undefined {
  if (ids === undefined) {
    return custom;
  }
  const allowed =
    custom?.include === undefined
      ? ids
      : ids.filter((id) => custom.include?.includes(id));
  return { include: allowed, exclude: custom?.exclude ?? [] };
}

/**
 * ISS-12600: the Documents index filters the metric endpoints scope by, beside
 * the list vocabulary. Owners, tags and favorites match the list's client
 * predicate (`useArtifactListShellDerived`): any listed owner (or no owner when
 * Unassigned is selected), any listed tag id, and the reader's own favorites.
 * `favoritedByUserId` is supplied by the server from the caller, never the wire.
 */
export type DocumentListScopeConstraints = Pick<
  DocumentMetricScopeFilters,
  "assigneeIds" | "includeUnassigned" | "tagIds"
> & { favoritedByUserId?: string };

/**
 * The owner, tag and favorite conjuncts, each its own `AND` element so none can
 * clobber a sibling top-level `OR` or the scalar `assigneeId` the "mine" facet
 * sets. Index coverage: `assignee_id IN` rides `(organizationId, assigneeId)`;
 * the tag and favorite `EXISTS` ride the `(tagId, artifactId)` and
 * `(userId, artifactId)` uniques. Sets are deduped; the boundary caps them.
 */
export function buildScopeConstraintConjuncts(
  options: DocumentListScopeConstraints
): Prisma.ArtifactWhereInput[] {
  const conjuncts: Prisma.ArtifactWhereInput[] = [];
  const owners = [...new Set(options.assigneeIds ?? [])];
  const ownerArms: Prisma.ArtifactWhereInput[] = [];
  if (owners.length > 0) {
    ownerArms.push({ assigneeId: { in: owners } });
  }
  if (options.includeUnassigned) {
    ownerArms.push({ assigneeId: null });
  }
  if (ownerArms.length > 0) {
    conjuncts.push({ OR: ownerArms });
  }
  const tags = [...new Set(options.tagIds ?? [])];
  if (tags.length > 0) {
    conjuncts.push({ tagArtifacts: { some: { tagId: { in: tags } } } });
  }
  if (options.favoritedByUserId) {
    conjuncts.push({
      favoritedBy: { some: { userId: options.favoritedByUserId } },
    });
  }
  return conjuncts;
}

/** The search slice plus extra conjuncts under ONE `AND`; `{}` when none. */
function composeConjuncts(
  search: DocumentSearchFilter,
  extra: Prisma.ArtifactWhereInput[]
): DocumentSearchFilter | { AND: Prisma.ArtifactWhereInput[] } {
  if (extra.length === 0) {
    return search;
  }
  return { AND: [...(search.AND ?? []), ...extra] };
}
