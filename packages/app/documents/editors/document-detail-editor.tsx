"use client";

import { DocumentType } from "@repo/api/src/types/document";
import type { VersionedDocumentEditorProps } from "@repo/app/documents/components/versioned-document-editor-container";
import { DocumentEditor } from "@repo/app/documents/editors/documents/detail/document-editor";
import { PlanEditor } from "@repo/app/documents/editors/implementation-plans/detail/plan-editor";
import { IssueEditor } from "@repo/app/documents/editors/issues/detail/issue-editor";
import { PRDEditor } from "@repo/app/documents/editors/prds/detail/prd-editor";

type DocumentDetailEditorProps = VersionedDocumentEditorProps & {
  onNotFound: () => never;
};

/**
 * The one detail editor both shells mount for every document at
 * `/documents/:slug` (ISS-12855, PRD-799 G-01). A Template has no detail page
 * (PRD-799 "Template UI is absent"), so it resolves through the shell's
 * not-found action.
 */
export function DocumentDetailEditor({
  onNotFound,
  ...props
}: Readonly<DocumentDetailEditorProps>) {
  switch (props.document.type) {
    case DocumentType.Prd:
      return <PRDEditor {...props} />;
    case DocumentType.ImplementationPlan:
      return <PlanEditor {...props} />;
    case DocumentType.Feature:
      return <IssueEditor {...props} />;
    case DocumentType.Doc:
      return <DocumentEditor {...props} />;
    case DocumentType.Template:
      return onNotFound();
    default: {
      const unreachable: never = props.document.type;
      throw new Error(`Unsupported document type: ${unreachable}`);
    }
  }
}
