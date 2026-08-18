import type {
  DocumentListPage,
  FindDocumentsOptions,
} from "@repo/api/src/types/document";
import { Prisma, withDb } from "@repo/database";
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
    options: FindDocumentsOptions & { organizationId: string },
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
   * The page and the count read from ONE consistent snapshot (shafty023 review):
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
    options: FindDocumentsOptions & { organizationId: string }
  ): Promise<DocumentListPage> {
    // FEA-1626: the recency window is a moving cutoff derived from "now", so the
    // page and the count must be built from ONE instant as well as one snapshot.
    // Two independent `new Date()` calls would give the two reads cutoffs a few
    // microseconds apart — a different population, which is exactly the
    // self-contradiction the shared transaction below exists to prevent.
    const now = new Date();
    const { items, total } = await withDb.tx(
      async () => {
        const pageItems = await documentService.findAllWithCustomFields(
          options,
          now
        );
        const matchingTotal = await documentListService.countAll(options, now);
        return { items: pageItems, total: matchingTotal };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
    );
    // Report the page the server actually applied after clamping, not what the
    // caller asked for: a client that echoes its own request back into a range
    // readout would otherwise describe a window it never received.
    const take = resolveDocumentListTake(options.limit);
    const skip = resolveDocumentListSkip(take, options.offset) ?? 0;
    return {
      items,
      total,
      limit: take ?? null,
      offset: skip,
      hasMore: resolveDocumentListHasMore(skip, items.length, total),
    };
  },
};
