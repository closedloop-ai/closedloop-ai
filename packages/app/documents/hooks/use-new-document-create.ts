"use client";

import type { Document, DocumentStatus } from "@repo/api/src/types/document";
import {
  DocumentType,
  fallbackStatusForSubtype,
} from "@repo/api/src/types/document";
import { ApiError, getFriendlyError } from "@repo/app/shared/api/api-error";
import type { MutationToastOptions } from "@repo/app/shared/query/query-client";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { getDocumentRoute } from "../lib/document-navigation";
import { useCreateDocument } from "./use-documents";

/**
 * What the one-field New Document flow creates and where it lands, in ONE place
 * (ISS-8938).
 *
 * Both arms of the `documents-create-failure-recovery` gate create the same
 * record and route to the same editor; they differ only in how they report a
 * REJECTION. Holding the create here is what keeps that true — the property the
 * ticket cares most about (an organization-level, project-less `DOC`) cannot
 * drift between two dialogs that each build their own payload.
 */

// The single document type this org-level flow creates. It is deliberately the
// generic Document (not PRD/Implementation Plan/Feature, which need a project +
// repository context and are created from their own project surfaces; and not
// Template, which has no owning list/detail surface yet, so a created Template
// would vanish from the Doc-only index with no way to reopen it). Because there
// is exactly one type, the dialog exposes no type selector.
const ORG_LEVEL_DOCUMENT_TYPE: DocumentType = DocumentType.Doc;

/** Said only when the rejection carried no message of its own. */
export const NEW_DOCUMENT_CREATE_FAILURE_FALLBACK =
  "Couldn't create the document. Please try again.";

/** What a rejection is headed the dialog's way as. */
export const NEW_DOCUMENT_CREATE_FAILURE_TITLE =
  "Couldn't create this document";

export type NewDocumentCreateFailure = {
  /** The heading: what actually happened, not always a refusal. */
  title: string;
  /** The sentence under it — the server's own, where the server sent one. */
  description: string;
  /** What to do next, only where the canonical copy has something to say. */
  remediation?: readonly string[];
};

export type NewDocumentCreateHandlers = {
  /** The created artifact, before this hook routes into its editor. */
  onCreated?: (artifact: Document) => void;
  /** Why the create was rejected, for the dialog to render where the user is. */
  onFailure: (failure: NewDocumentCreateFailure) => void;
};

export function useNewDocumentCreate(
  options?: Readonly<MutationToastOptions>,
  initialStatus?: DocumentStatus
): {
  create: (title: string, handlers: NewDocumentCreateHandlers) => void;
  isSaving: boolean;
} {
  const buildOrgPath = useOrgPath();
  const navigation = useNavigation();
  const createDocument = useCreateDocument(options);

  const create = (title: string, handlers: NewDocumentCreateHandlers) => {
    // No projectId: an org-level Document carries no project. The create
    // validator only requires one for project-bound subtypes.
    createDocument.mutate(
      {
        type: ORG_LEVEL_DOCUMENT_TYPE,
        title,
        content: "",
        status:
          initialStatus ?? fallbackStatusForSubtype(ORG_LEVEL_DOCUMENT_TYPE),
      },
      {
        onSuccess: (artifact) => {
          handlers.onCreated?.(artifact);
          // The `getDocumentRoute` null-guard is kept so navigation is skipped
          // gracefully for any future subtype without a detail route.
          const route = getDocumentRoute(artifact);
          if (route) {
            navigation.navigate(buildOrgPath(route));
          }
        },
        onError: (mutationError: Error) => {
          handlers.onFailure(describeCreateFailure(mutationError));
        },
      }
    );
  };

  return { create, isSaving: createDocument.isPending };
}

/**
 * Turn a rejected create into what the dialog should say about it.
 *
 * A client deadline is separated out because `POST /documents` carries no
 * idempotency key: a timeout means no answer ever arrived, NOT that nothing was
 * written, so the create may well have committed. Heading that with "Couldn't
 * create this document" over a bare "Try again" invites a duplicate document
 * and asserts an outcome nobody observed. The copy is not invented here — it is
 * the canonical {@link getFriendlyError} timeout entry (ISS-5013), which already
 * says only what is known and leads its remediation with refreshing to see
 * whether the create landed.
 */
function describeCreateFailure(error: Error): NewDocumentCreateFailure {
  if (error instanceof ApiError && error.isTimeout()) {
    const friendly = getFriendlyError(error);
    return {
      title: friendly.title,
      description: friendly.description,
      remediation: friendly.remediation,
    };
  }
  return {
    title: NEW_DOCUMENT_CREATE_FAILURE_TITLE,
    description: error.message || NEW_DOCUMENT_CREATE_FAILURE_FALLBACK,
  };
}
