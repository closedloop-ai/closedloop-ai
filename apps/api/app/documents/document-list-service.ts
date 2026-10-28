import type {
  DocumentListContinuation,
  DocumentListPage,
  DocumentWithProject,
} from "@repo/api/src/types/document";
import { normalizeDocumentType } from "@repo/api/src/types/document";
import { Prisma, withDb } from "@repo/database";
import type { DocumentListQueryOptions } from "./custom-field-ordered-read";
import {
  buildDocumentListWhere,
  resolveDocumentListHasMore,
  resolveDocumentListSkip,
  resolveDocumentListTake,
} from "./document-list-query";
import { documentService } from "./document-service";

/**
 * Paged read behind `GET /documents?includeTotal=true` (ISS-4576).
 *
 * FEA-4373 gave the endpoint `take`/`skip` but no count, so a paging client had
 * only `items.length` to reason about — which stops being a total the moment the
 * matching set exceeds one page. The My Tasks board then rendered a
 * "Showing X of N" footer whose N silently capped at the fetch bound. This
 * service returns the page AND a real `count()` over the identical predicate, so
 * the client states a total it was actually told rather than one it inferred.
 *
 * Lives in its own sibling module (not `document-service.ts`, which is over the
 * file-size ceiling and grandfathered) per `apps/api/AGENTS.md`.
 */
export const documentListService = {
  /**
   * Count every artifact matching a document-list query, ignoring `limit` and
   * `offset`. Org-scoped through the same {@link buildDocumentListWhere}
   * predicate the page is drawn from.
   */
  async countAll(
    options: DocumentListQueryOptions,
    now: Date = new Date()
  ): Promise<number> {
    return await withDb((db) =>
      db.artifact.count({ where: buildDocumentListWhere(options, now) })
    );
  },

  /**
   * `findAllWithCustomFields` plus the honest total, shaped as the
   * {@link DocumentListPage} envelope.
   *
   * The page and the count read from ONE consistent snapshot (davetho review):
   * both run inside a single `RepeatableRead` transaction, so an assignment or
   * delete landing between them can no longer make the envelope contradict
   * itself — 50 items with `total: 49`, or `hasMore: false` while the page read
   * saw another matching row. Separate reads (the old `Promise.all` of two
   * independent `withDb` calls) each took their own snapshot and could disagree.
   * Under `RepeatableRead` both statements observe the state as of the
   * transaction's first read, so `items`, `total`, and the derived `hasMore` are
   * mutually consistent. The reads are sequential rather than concurrent because
   * a transaction pins one connection and queues its statements on it anyway; the
   * fixed fan-out of two is still well within the pool bound in `apps/api/AGENTS.md`.
   *
   * `hasMore` is derived from the real total rather than a full page, which would
   * claim a phantom next page whenever the last page happens to fill exactly.
   */
  async findPageWithCustomFields(
    options: DocumentListQueryOptions
  ): Promise<DocumentListPage> {
    // FEA-1626: the recency window is a moving cutoff derived from "now", so the
    // page and the count must be built from ONE instant as well as one snapshot.
    // Two independent `new Date()` calls would give the two reads cutoffs a few
    // microseconds apart — a different population, which is exactly the
    // self-contradiction the shared transaction below exists to prevent.
    const now = new Date();
    return await withDb.tx(
      () => documentListService.readPageInSnapshot(options, now),
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        ...resolveCustomFieldTxOptions(Boolean(options.customFieldSort)),
      }
    );
  },

  /**
   * The BARE-ARRAY arm of `GET /documents`, plus the continuation metadata the
   * route states in response headers (ISS-6941).
   *
   * The response body is unchanged — it is the same `DocumentWithProject[]`
   * every shipped consumer already parses. What is new is that the server now
   * also says whether that array was capped, which a caller paging with
   * `limit` + `offset` could not previously determine at all: `limit` caps at
   * `DOCUMENT_LIST_MAX_LIMIT`, and a full page is evidence of neither "that was
   * everything" nor "the server capped me".
   *
   * TWO ARMS, AND ONLY ONE OF THEM COSTS ANYTHING. With no `limit` the read is
   * unbounded, so the whole matching set is already in `items`: the total is its
   * length, there is no next page, and no second query is issued. Only a caller
   * that actually asked to page pays the `count()`, and it pays it through
   * {@link findPageWithCustomFields} — the same single-`RepeatableRead`-snapshot
   * read the `includeTotal` envelope uses — so the headers cannot contradict the
   * body they describe.
   */
  async findArrayWithContinuation(
    options: DocumentListQueryOptions
  ): Promise<DocumentListArrayPage> {
    if (options.limit === undefined) {
      return unboundedArrayPage(
        await documentService.findAllWithCustomFields(options)
      );
    }
    return toArrayPage(
      await documentListService.findPageWithCustomFields(options)
    );
  },

  /**
   * {@link findArrayWithContinuation}, assuming an ambient snapshot.
   *
   * Split for the same reason {@link readPageInSnapshot} is: the custom-field
   * facet resolution opens the transaction itself, and `withDb.tx` fails closed
   * on a nested `isolationLevel` rather than silently joining a weaker one, so
   * there can only ever be one opener.
   */
  async readArrayWithContinuationInSnapshot(
    options: DocumentListQueryOptions,
    now: Date
  ): Promise<DocumentListArrayPage> {
    if (options.limit === undefined) {
      return unboundedArrayPage(
        await documentService.findAllWithCustomFields(options, now)
      );
    }
    return toArrayPage(
      await documentListService.readPageInSnapshot(options, now)
    );
  },

  /**
   * The page-and-total read itself, assuming an ambient snapshot.
   *
   * Split from {@link findPageWithCustomFields} so the custom-field facet
   * resolution can be pulled INSIDE that snapshot (whitlockk review) without either
   * caller opening a second transaction — `withDb.tx` fails closed on a nested
   * `isolationLevel` rather than silently joining a weaker one, so there can only
   * ever be one opener. See `document-list-snapshot.ts` for the caller that
   * resolves first.
   */
  async readPageInSnapshot(
    options: DocumentListQueryOptions,
    now: Date
  ): Promise<DocumentListPage> {
    const items = await documentService.findAllWithCustomFields(options, now);
    const total = await documentListService.countAll(options, now);
    // Report the page the server actually applied after clamping, not what the
    // caller asked for: a client that echoes its own request back into a range
    // readout would otherwise describe a window it never received.
    const take = resolveDocumentListTake(options.limit);
    const skip = resolveDocumentListSkip(take, options.offset) ?? 0;
    return {
      ...(options.types
        ? {
            appliedTypes: [
              ...new Set(options.types.map(normalizeDocumentType)),
            ],
          }
        : {}),
      items,
      total,
      limit: take ?? null,
      offset: skip,
      hasMore: resolveDocumentListHasMore(skip, items.length, total),
    };
  },
};

/**
 * Transaction options for a document-list snapshot.
 *
 * ISS-7211: a custom-field sort adds statements to this transaction — the facet
 * resolution, a candidate-id scan, and the raw ordering query — and Prisma's 5s
 * default was budgeted for the two reads that were here before. None of that
 * work can move outside the transaction without giving up the single-snapshot
 * guarantee, so the budget moves instead. Unsorted queries keep the default.
 */
export function resolveCustomFieldTxOptions(hasSort: boolean): {
  timeout?: number;
} {
  return hasSort ? { timeout: CUSTOM_FIELD_SORT_TX_TIMEOUT_MS } : {};
}

/**
 * Transaction budget for a custom-field-sorted page (ISS-7211).
 *
 * Prisma's default is 5s, sized for the two statements this transaction carried
 * before the custom-field sort added a candidate-id scan and a raw ordering
 * query. 15s keeps a large org's sorted first page inside the budget without
 * pinning a connection for anything close to a request timeout.
 */
export const CUSTOM_FIELD_SORT_TX_TIMEOUT_MS = 15_000;

/**
 * The bare-array response together with the facts the route renders as headers.
 *
 * A pair rather than an envelope: the array is what goes on the wire as the
 * body, unchanged, and the continuation never joins it there (ISS-6941).
 */
export type DocumentListArrayPage = {
  items: DocumentWithProject[];
  continuation: DocumentListContinuation;
};

/**
 * The continuation for an UNBOUNDED read, derived with no second query.
 *
 * Every matching row is in `items` by construction, so its length IS the total
 * and there is nothing beyond it. Stating that explicitly is the whole point:
 * "that was everything" was previously indistinguishable from a capped page.
 */
function unboundedArrayPage(
  items: DocumentWithProject[]
): DocumentListArrayPage {
  return {
    items,
    continuation: {
      total: items.length,
      offset: 0,
      pageCount: items.length,
      hasMore: false,
    },
  };
}

/**
 * Project the paged envelope onto the array pair, so the two arms of this
 * endpoint answer "is there more" from ONE derivation rather than two.
 */
function toArrayPage(page: DocumentListPage): DocumentListArrayPage {
  return {
    items: page.items,
    continuation: {
      total: page.total,
      offset: page.offset,
      pageCount: page.items.length,
      hasMore: page.hasMore,
    },
  };
}
