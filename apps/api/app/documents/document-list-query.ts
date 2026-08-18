import type { CustomFieldValueDetail } from "@repo/api/src/types/custom-field";
import {
  DOCUMENT_LIST_MAX_LIMIT,
  DOCUMENT_LIST_MAX_OFFSET,
  DOCUMENT_LIST_MAX_RECENCY_DAYS,
  DOCUMENT_LIST_MIN_RECENCY_DAYS,
  DocumentListRecency,
  type DocumentWithProject,
  type FindDocumentsOptions,
  normalizeDocumentType,
} from "@repo/api/src/types/document";
import { ProjectStatus } from "@repo/api/src/types/project";
import type { Prisma } from "@repo/database";
import { documentWhere } from "@/lib/artifact-adapters";

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
 * Otherwise the offset is clamped to [0, {@link DOCUMENT_LIST_MAX_OFFSET}].
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
  return Math.max(0, Math.min(offset, DOCUMENT_LIST_MAX_OFFSET));
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
 */
export function buildDocumentListWhere(
  options: Pick<
    FindDocumentsOptions,
    | "type"
    | "projectId"
    | "assigneeId"
    | "unassignedProject"
    | "recencyDays"
    | "includeArchivedProjects"
  > & { organizationId: string },
  now: Date = new Date()
) {
  const { organizationId, projectId, assigneeId, unassignedProject } = options;
  const type =
    options.type === undefined
      ? undefined
      : normalizeDocumentType(options.type);
  return documentWhere({
    organizationId,
    ...buildProjectFilter(projectId, unassignedProject),
    ...(type ? { subtype: type } : {}),
    ...(assigneeId ? { assigneeId } : {}),
    ...buildRecencyFilter(options, now),
    ...buildArchivedProjectFilter(options),
  });
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
 * the client send `recencyDays=all` to opt back out. wongk's review killed that
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

export type RecencyAnchorIsNonNullable = AssertTrue<
  [Prisma.ArtifactModel["updatedAt"]] extends [Date] ? true : false
>;
export type CreatedAtIsNonNullable = AssertTrue<
  [Prisma.ArtifactModel["createdAt"]] extends [Date] ? true : false
>;
export type ArtifactHasNoSoftDeleteColumn = AssertTrue<
  "deletedAt" extends keyof Prisma.ArtifactModel ? false : true
>;
