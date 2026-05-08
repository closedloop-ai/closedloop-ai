"use client";

import { FeatureFlagged } from "@repo/analytics/components/feature-flagged";
import type { ReactNode } from "react";
import { CommentsSection } from "@/components/document-editor/comments-section";
import { DocumentVersionInfo } from "@/components/document-editor/document-version-info";

type DocumentEditorDetailsProps = {
  documentId: string;
  createdAt: string | Date;
  updatedAt: string | Date;
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
  createdAt,
  updatedAt,
  children,
}: Readonly<DocumentEditorDetailsProps>) {
  return (
    <div className="mx-auto w-full max-w-[900px] space-y-6 px-5 py-6">
      {children}
      <FeatureFlagged flag="the-one-flag">
        <CommentsSection documentId={documentId} />
      </FeatureFlagged>
      <DocumentVersionInfo createdAt={createdAt} updatedAt={updatedAt} />
    </div>
  );
}
