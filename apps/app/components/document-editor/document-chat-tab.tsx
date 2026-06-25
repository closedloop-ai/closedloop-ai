"use client";

import type { DocumentDetail } from "@repo/api/src/types/document";
import {
  DocumentType,
  getPrimaryRepoFromSnapshot,
} from "@repo/api/src/types/document";
import { DocumentChatDrawer } from "@/components/chat/DocumentChatDrawer";

const DOCUMENT_TYPE_CHAT_SLUG: Record<DocumentType, string> = {
  [DocumentType.Prd]: "prd",
  [DocumentType.ImplementationPlan]: "plan",
  [DocumentType.Feature]: "feature",
  [DocumentType.Template]: "template",
};

type DocumentChatTabProps = {
  document: DocumentDetail;
};

/**
 * Document-bound chat UI. Wraps `DocumentChatDrawer` with the
 * artifact-context wiring (type slug, primary repo) so callers only
 * need to pass the document. Used both as the standalone right-rail
 * `DocumentChatPanel` body and as the Chat tab of `FeedSidebar`.
 */
export function DocumentChatTab({ document }: Readonly<DocumentChatTabProps>) {
  const documentType = DOCUMENT_TYPE_CHAT_SLUG[document.type];
  const targetRepo =
    getPrimaryRepoFromSnapshot(document.repositorySnapshot)?.fullName ?? null;
  return (
    <DocumentChatDrawer
      documentId={document.id}
      documentSlug={document.slug}
      documentTitle={document.title}
      documentType={documentType}
      fillParent
      targetRepo={targetRepo}
    />
  );
}
