"use client";

import type { DocumentDetail } from "@repo/api/src/types/document";
import type { BasicUser } from "@repo/api/src/types/user";
import { CommentsSection } from "@repo/app/documents/components/comments-section";
import { UserLink } from "@repo/app/shared/components/user-link";
import { FeatureFlagged } from "@repo/app/shared/feature-flags/feature-flagged";
import { getUserDisplayName } from "@repo/app/shared/lib/user-utils";
import type { ReactNode } from "react";
import { DocumentActivitySection } from "./document-activity-section";

export type DocumentActivityMetadata = {
  createdAt: DocumentDetail["createdAt"];
  updatedAt: DocumentDetail["updatedAt"];
  createdBy: BasicUser | null;
};

type DocumentEditorDetailsProps = {
  documentId: string;
  activity: DocumentActivityMetadata;
  children: ReactNode;
};

/**
 * Shared 900px-max container rendered below the editor for every document
 * subtype. Hosts the per-subtype relationships/evaluation stack via
 * `children`, then appends feature-flagged comments and the version info
 * footer so the trailing rows are identical across PRD/Plan/Feature.
 */
export function DocumentEditorDetails({
  documentId,
  activity,
  children,
}: Readonly<DocumentEditorDetailsProps>) {
  return (
    <div className="mx-auto w-full max-w-[900px] space-y-6 px-5 py-6">
      {children}
      <FeatureFlagged flag="the-one-flag">
        <CommentsSection documentId={documentId} />
      </FeatureFlagged>
      <DocumentActivitySection
        createdAt={activity.createdAt}
        createdByContent={
          activity.createdBy ? (
            <UserLink
              className="text-foreground hover:underline"
              userId={activity.createdBy.id}
            >
              {getUserDisplayName(activity.createdBy)}
            </UserLink>
          ) : undefined
        }
        updatedAt={activity.updatedAt}
      />
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
