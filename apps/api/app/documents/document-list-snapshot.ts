import type { CustomFieldQueryRejection } from "@repo/api/src/types/custom-field-list-query";
import type { FindDocumentsOptions } from "@repo/api/src/types/document";
import {
  type Result,
  Result as ResultHelpers,
} from "@repo/api/src/types/result";
import { Prisma, withDb } from "@repo/database";
import type { DocumentListQueryOptions } from "./custom-field-ordered-read";
import {
  type CustomFieldQueryParams,
  resolveCustomFieldQueryContext,
} from "./custom-field-route-helpers";
import {
  createScopedPopulationReader,
  type ScopedPopulationFactory,
} from "./custom-field-scoped-population";
import { buildDocumentListWhere } from "./document-list-query";
import { resolveCustomFieldTxOptions } from "./document-list-service";

/**
 * One MVCC snapshot for the whole custom-field list read (ISS-7211 review).
 *
 * **The facet ids used to be resolved before the transaction opened.** The page
 * and its total then agreed with each other — they shared the snapshot — but
 * both were computed from ids resolved against an EARLIER state, while the
 * custom-field values hydrated onto each returned row were read from the LATER
 * one. A value edited in that window produced a row that visibly contradicted
 * the filter the user had applied: present in a list filtered to `Priority=P0`,
 * rendering a Priority cell that no longer said P0 (whitlockk).
 *
 * Resolving inside the transaction closes it. `withDb` picks up the ambient
 * transaction client through `AsyncLocalStorage`, so the facet reads, the
 * candidate scan, the ordering query, the page hydration, and the `count()` all
 * observe the state as of the transaction's first read. A concurrent edit is
 * either wholly before that instant or wholly after it, so no returned row can
 * disagree with the filter that selected it.
 *
 * It also makes the population bounds CHECKABLE rather than hopeful: the
 * admission check in `resolveCustomFieldQueryContext` and the bounded candidate
 * scan in `findArtifactsOrderedByCustomField` now read one snapshot, so nothing
 * can grow between them.
 *
 * A request with no custom-field dimension does NOT come through here — see
 * {@link requiresCustomFieldSnapshot}. Opening a `RepeatableRead` transaction
 * pins a connection for its duration, and the ordinary unsorted list read has
 * nothing to keep consistent that it did not already.
 */
export async function readDocumentListInSnapshot<T>(
  base: FindDocumentsOptions & { organizationId: string },
  params: CustomFieldQueryParams,
  read: (options: DocumentListQueryOptions, now: Date) => Promise<T>
): Promise<Result<T, CustomFieldQueryRejection>> {
  const now = new Date();
  return await withDb.tx(
    async () => {
      // The scoped population is the request's OWN predicate, and it is what
      // every bound in this feature is measured against, so that the refusal's
      // "narrow your request" guidance is followable. Built per stage rather
      // than once: filter resolution passes no entity ids (that slice is what it
      // is resolving), the sort admission check passes the ones it resolved.
      // Both go through `buildDocumentListWhere`, so the population a bound
      // measures can never drift from the population the page is drawn from.
      const scopedPopulationFor: ScopedPopulationFactory = (entityIds) =>
        createScopedPopulationReader(
          buildDocumentListWhere(
            { ...base, customFieldEntityIds: entityIds },
            now
          )
        );
      const context = await resolveCustomFieldQueryContext(
        params,
        base.organizationId,
        scopedPopulationFor
      );
      if (!context.ok) {
        return ResultHelpers.err(context.error);
      }
      return ResultHelpers.ok(await read({ ...base, ...context.value }, now));
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      ...resolveCustomFieldTxOptions(Boolean(params.customFieldSortId)),
    }
  );
}

/**
 * Whether a request carries a custom-field dimension at all.
 *
 * The snapshot exists to keep facet resolution, paging, and hydration mutually
 * consistent; with no facet and no custom-field sort there is nothing for it to
 * reconcile, and the read stays on the path it has always taken.
 */
export function requiresCustomFieldSnapshot(
  params: CustomFieldQueryParams
): boolean {
  return Boolean(
    params.customFieldSortId ||
      (params.customFieldFilters && params.customFieldFilters.length > 0)
  );
}
