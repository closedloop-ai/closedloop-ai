import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import type { DocumentWithProject } from "@repo/api/src/types/document";
import { withDb } from "@repo/database";
import { customFieldValuesService } from "@/app/custom-fields/values-service";
import {
  type DocumentListQueryOptions,
  findArtifactsOrderedByCustomField,
} from "./custom-field-ordered-read";
import {
  attachCustomFieldValues,
  buildDocumentListWhere,
  resolveDocumentListSkip,
  resolveDocumentListTake,
} from "./document-list-query";
import {
  documentIncludeWithContext,
  type RawDocumentWithContext,
  toDocumentWithProject,
} from "./document-utils";

/**
 * The document LIST read, lifted out of `document-service.ts` (ISS-7211).
 *
 * `document-service.ts` is over the file-size ceiling and grandfathered
 * shrink-only, and the list read had grown into a multi-step orchestration —
 * predicate, ordering arm, custom-field batch — that is
 * a responsibility of its own rather than part of document CRUD. It now sits
 * beside the modules that already own the list concern (`document-list-query.ts`
 * for the predicate, `document-list-service.ts` for the paged envelope).
 *
 * `documentService.findAll` / `findAllWithCustomFields` remain as delegates, so
 * every existing caller is unaffected.
 */

/**
 * The two list reads, exposed as one object so the second can call the first
 * THROUGH the object rather than by direct reference.
 *
 * That indirection is deliberate and load-bearing for tests: a direct
 * intra-module call cannot be intercepted, so `findAllDocumentsWithCustomFields`
 * would become untestable in isolation. It is the same idiom
 * `documentService.findAll` used before this read moved out of that service, and
 * the same one `documentListService.countAll` uses.
 */
export const documentListRead = {
  findAllDocuments,
  findAllDocumentsWithCustomFields,
};

/**
 * Find all DOCUMENT artifacts with optional filters (org-scoped). Returns each
 * document with its project (with teams).
 */
export async function findAllDocuments(
  options: DocumentListQueryOptions,
  now: Date = new Date()
): Promise<DocumentWithProject[]> {
  // FEA-4373: the list is unbounded by default — every matching artifact is
  // loaded — which the shared Documents index, plan/document pickers, and
  // version-skewed API clients all still depend on to show and select older
  // artifacts. Only a caller that explicitly asks to page (My Tasks, whose
  // board renders one row/card per artifact and could crash on a very large
  // assigned set) opts into the bound by passing `limit`; when it is omitted
  // the query stays unbounded and this endpoint's default contract is
  // unchanged. When a caller does page, the value is clamped to
  // [1, DOCUMENT_LIST_MAX_LIMIT] (the validator clamps client input; this is
  // defense in depth for direct service callers) and `offset` floored at 0.
  // Offset without a limit is meaningless, so it applies only alongside a
  // limit.
  const take = resolveDocumentListTake(options.limit);
  const skip = resolveDocumentListSkip(take, options.offset);
  // ISS-4576: the same predicate builder the honest-total `count` uses, so the
  // page and its total always describe one population. ISS-7211 adds the
  // resolved custom-field id constraint to it, on both arms below, for the same
  // reason.
  const where = buildDocumentListWhere(options, now);

  // ISS-7211: ordering by a custom field needs a column Prisma cannot reach (the
  // value table is polymorphic, and ENUM orders by the option's declared
  // sort_order). That read runs the same predicate and differs only in ORDER BY,
  // so the population is identical either way.
  const artifacts = options.customFieldSort
    ? await findArtifactsOrderedByCustomField(
        where,
        options.customFieldSort,
        options.organizationId,
        take,
        skip ?? 0
      )
    : await withDb((db) =>
        db.artifact.findMany({
          where,
          include: documentIncludeWithContext,
          // Stable secondary sort on id so `createdAt` ties order deterministically
          // across pages (two rows sharing a millisecond can't swap between pages).
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take,
          skip,
        })
      );

  return artifacts.map((a: RawDocumentWithContext) => toDocumentWithProject(a));
}

/**
 * {@link findAllDocuments} plus batch-loaded custom field values for each
 * document. Shared by GET /documents and GET /projects/:id/tree?include=documents
 * so both surfaces return the identical document shape (PLN-874).
 */
export async function findAllDocumentsWithCustomFields(
  options: DocumentListQueryOptions,
  now: Date = new Date()
): Promise<DocumentWithProject[]> {
  const documents = await documentListRead.findAllDocuments(options, now);
  if (documents.length === 0) {
    return documents;
  }

  const allValues = await customFieldValuesService.getValuesForEntity(
    CustomFieldEntityType.Document,
    documents.map((d) => d.id),
    options.organizationId
  );

  return attachCustomFieldValues(documents, allValues);
}
