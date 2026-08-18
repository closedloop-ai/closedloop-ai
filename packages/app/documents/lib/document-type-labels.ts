import { DocumentType } from "@repo/api/src/types/document";

// Canonical human-readable labels for each artifact/document type (FEA-3954:
// the FEATURE subtype displays as "Issue"). This is the single source of truth
// for these strings — projects/lib/project-constants.ts and the documents
// DocumentTypeBadge both re-use these maps instead of re-declaring them, so a
// copy label only ever changes in one place.

// Full artifact type labels for display.
export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  [DocumentType.Prd]: "PRD",
  [DocumentType.ImplementationPlan]: "Implementation Plan",
  [DocumentType.Template]: "Template",
  [DocumentType.Feature]: "Issue",
  [DocumentType.Doc]: "Document",
};

// Short badge labels for compact displays (e.g. the Context table pills).
export const DOCUMENT_TYPE_BADGE_LABELS: Record<DocumentType, string> = {
  [DocumentType.Prd]: "PRD",
  [DocumentType.ImplementationPlan]: "Plan",
  [DocumentType.Template]: "Template",
  [DocumentType.Feature]: "Issue",
  // Compact form matches the DOC- slug; the full label stays "Document".
  [DocumentType.Doc]: "Doc",
};
