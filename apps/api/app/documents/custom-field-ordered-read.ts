import type { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import {
  CUSTOM_FIELD_FILTER_MAX_MATCHED_ENTITIES,
  type CustomFieldSort,
} from "@repo/api/src/types/custom-field-list-query";
import type { FindDocumentsOptions } from "@repo/api/src/types/document";
import { type Prisma, withDb } from "@repo/database";
import { orderRowsBy } from "@/lib/order-rows-by";
import {
  type CustomFieldEntityIdConstraint,
  type CustomFieldQueryDescriptor,
  customFieldListService,
} from "./custom-field-list-service";
import {
  documentIncludeWithContext,
  type RawDocumentWithContext,
} from "./document-utils";

/**
 * The read that backs "sort this list by a custom field" (ISS-7211). Its own
 * module so the grandfathered `document-service.ts` delegates in a few lines
 * instead of absorbing another multi-step read.
 *
 * Three phases, and the split is what keeps the built-in filters and the
 * custom-field ordering from becoming two implementations of "which artifacts
 * are in this list": Prisma decides the POPULATION with exactly the predicate
 * the unsorted path and the honest-total `count()` use; raw SQL decides only the
 * ORDER within it; Prisma hydrates the page through the ordinary include shape.
 */

/** The server-resolved custom-field context a document list query carries. */
export type DocumentListCustomFieldContext = {
  /**
   * Entity-id constraint from a resolved filter set. Resolved ONCE by the caller
   * and put on the shared options object so the page read and the count read
   * cannot be built from different filter sets.
   */
  customFieldEntityIds?: CustomFieldEntityIdConstraint;
  /** A validated, capability-checked sort request. */
  customFieldSort?: {
    field: CustomFieldQueryDescriptor;
    sort: CustomFieldSort;
    entityType: CustomFieldEntityType;
  };
};

/**
 * The full options object every document-list read takes. One alias, not the
 * same intersection at each call site, so adding a narrowing dimension to the
 * page read but not to its `count()` is a compile error, not a wrong total.
 */
export type DocumentListQueryOptions = FindDocumentsOptions & {
  organizationId: string;
} & DocumentListCustomFieldContext;

/**
 * Fetch one page of artifacts ordered by a custom field.
 *
 * **The candidate scan is bounded, and that bound is checked before the request
 * is admitted, not here.** Ordering by a column Prisma cannot reach means the
 * whole population has to be ranked before a page can be cut from it — you
 * cannot know which rows are on page 1 without comparing them all — so `limit=1`
 * used to turn into an org-wide scan marshalled through Node (whitlockk). It cannot
 * now: `resolveCustomFieldQueryContext` refuses a sort whose scoped population
 * is over {@link CUSTOM_FIELD_FILTER_MAX_MATCHED_ENTITIES}, with guidance the
 * caller can act on, and the ranking itself already happens in Postgres
 * (`ORDER BY … LIMIT … OFFSET`) rather than in Node.
 *
 * The `take` here is that bound restated at the read, and exceeding it is an
 * invariant violation rather than a caller error: the preflight and this scan
 * run inside ONE `RepeatableRead` snapshot, so no concurrent write can grow the
 * population between them. Refusing loudly beats truncating — a truncated
 * candidate set would silently rank a page against a population the total was
 * never computed from.
 *
 * The hydration re-orders in memory because `findMany({ id: { in: pageIds } })`
 * carries no ORDER BY that knows about the custom field, so Postgres may return
 * those rows in any order it likes.
 */
export async function findArtifactsOrderedByCustomField(
  where: Prisma.ArtifactWhereInput,
  context: NonNullable<DocumentListCustomFieldContext["customFieldSort"]>,
  organizationId: string,
  take: number | undefined,
  skip: number
): Promise<RawDocumentWithContext[]> {
  const candidates = await withDb((db) =>
    db.artifact.findMany({
      where,
      select: { id: true },
      take: CUSTOM_FIELD_FILTER_MAX_MATCHED_ENTITIES + 1,
    })
  );
  if (candidates.length > CUSTOM_FIELD_FILTER_MAX_MATCHED_ENTITIES) {
    throw new Error(
      `custom-field sort: scoped population exceeded ${CUSTOM_FIELD_FILTER_MAX_MATCHED_ENTITIES} after the request was admitted — the preflight in resolveCustomFieldQueryContext should have refused it`
    );
  }
  const pageIds = await customFieldListService.orderIdsByCustomField(
    candidates.map((candidate) => candidate.id),
    context.field,
    context.sort,
    context.entityType,
    organizationId,
    take,
    skip
  );
  if (pageIds.length === 0) {
    return [];
  }
  const rows = await withDb((db) =>
    db.artifact.findMany({
      // Org-scoped in its own right, not just via `pageIds` — every read in this
      // path states its tenant, per `apps/api/AGENTS.md`.
      where: { id: { in: pageIds }, organizationId },
      include: documentIncludeWithContext,
    })
  );
  return orderRowsBy(rows, pageIds);
}
