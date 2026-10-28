import { RELATED_SESSIONS_BATCH_ROUTE } from "@repo/api/src/types/related-session";
import { DOC_SYNC_TOKEN_PATH } from "@repo/realtime-contract/protocol";

const idSegment = "[^/]+";

/** Exact writes used by the shared Documents listing and versioned editors. */
export function buildDocumentWriteRoutes(uuidSegment: string) {
  return {
    POST: [
      collaborationAuthRoute,
      docSyncTokenRoute,
      documentsCollectionRoute,
      documentsBatchRoute,
      new RegExp(
        `^/documents/${uuidSegment}/(?:versions|attachments|attachments/resolve|context-attachments|custom-field-settings|threads)$`
      ),
      new RegExp(
        `^/documents/${uuidSegment}/threads/${idSegment}/(?:replies|resolve|unresolve)$`
      ),
      artifactLinksCollectionRoute,
      new RegExp(`^/projects/${uuidSegment}/artifacts/placement$`),
      new RegExp(`^${RELATED_SESSIONS_BATCH_ROUTE}$`),
      new RegExp(`^/artifacts/${uuidSegment}/favorite$`),
      tagsCollectionRoute,
      entityTagsCollectionRoute,
      customFieldsCollectionRoute,
      new RegExp(`^/custom-fields/${idSegment}/enum-options(?:/reorder)?$`),
    ],
    PUT: [
      new RegExp(`^/documents/${uuidSegment}$`),
      new RegExp(`^/custom-fields/${uuidSegment}$`),
      new RegExp(`^/custom-fields/${idSegment}/enum-options/${idSegment}$`),
    ],
    DELETE: [
      new RegExp(`^/documents/${uuidSegment}$`),
      new RegExp(
        `^/documents/${uuidSegment}/(?:attachments|custom-field-settings)/${idSegment}$`
      ),
      new RegExp(`^/artifact-links/${idSegment}$`),
      new RegExp(`^/artifacts/${uuidSegment}/favorite$`),
      entityTagsDeleteRoute,
    ],
  } as const satisfies Record<string, readonly RegExp[]>;
}

const collaborationAuthRoute = /^\/collaboration\/auth$/;

// PLN-2189 T-4.4: the document sync token the renderer's `DocSyncRoom` mints.
const docSyncTokenRoute = new RegExp(`^${DOC_SYNC_TOKEN_PATH}$`);

const documentsCollectionRoute = /^\/documents$/;

const documentsBatchRoute =
  /^\/documents\/(?:batch-update-status|batch-update-priority|batch-delete|merge|costs)$/;

const artifactLinksCollectionRoute =
  /^\/artifact-links(?:\/batch-move|\/pull-requests)?$/;

const tagsCollectionRoute = /^\/tags$/;

const entityTagsCollectionRoute = /^\/entity-tags(?:\/batch)?$/;

const customFieldsCollectionRoute = /^\/custom-fields$/;

const entityTagsDeleteRoute = /^\/entity-tags$/;
