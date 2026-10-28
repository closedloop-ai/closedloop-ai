"use client";

import type { DocumentDetail } from "@repo/api/src/types/document";
import type { BasicUser } from "@repo/api/src/types/user";
import { CommentsSection } from "@repo/app/documents/components/comments-section";
import { ARTIFACT_DETAIL_CONTENT_WIDTH_CLASS } from "@repo/app/shared/components/artifact-detail-shell/artifact-detail-shell";
import { FeatureFlagged } from "@repo/app/shared/feature-flags/feature-flagged";
import { cn } from "@repo/design-system/lib/utils";
import type { ReactNode } from "react";

export type DocumentActivityMetadata = {
  createdAt: DocumentDetail["createdAt"];
  updatedAt: DocumentDetail["updatedAt"];
  createdBy: BasicUser | null;
};

type DocumentEditorDetailsProps = {
  documentId: string;
  active?: boolean;
  children: ReactNode;
};

/**
 * The Details tab container for every document subtype. Hosts metadata,
 * attachments and per-subtype relationships through `children`, plus the
 * existing feature-flagged artifact comments. Sessions and activity have
 * their own tabs.
 */
export function DocumentEditorDetails({
  documentId,
  active = true,
  children,
}: Readonly<DocumentEditorDetailsProps>) {
  return (
    <div
      className={cn(
        ARTIFACT_DETAIL_CONTENT_WIDTH_CLASS,
        "w-full space-y-6 px-5 py-6"
      )}
      data-testid={DOCUMENT_EDITOR_DETAILS_TEST_ID}
    >
      {children}
      <FeatureFlagged flag="the-one-flag">
        {/* key={documentId} resets the section's local draft/open state when the
            page swaps to a different document without unmounting (FEA-3910). */}
        <CommentsSection
          active={active}
          documentId={documentId}
          key={documentId}
        />
      </FeatureFlagged>
    </div>
  );
}

/**
 * Extracts artifact-level Activity metadata from a document detail response.
 * Intentionally ignores `document.version.*` so Activity provenance remains
 * tied to the original artifact rather than the selected content version.
 */
export function getDocumentActivityMetadata(
  document: Pick<DocumentDetail, "createdAt" | "createdBy" | "updatedAt">
): DocumentActivityMetadata {
  return {
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    createdBy: document.createdBy ?? null,
  };
}

/** Stable locator for the document's Details tab body. */
export const DOCUMENT_EDITOR_DETAILS_TEST_ID = "document-editor-details";
