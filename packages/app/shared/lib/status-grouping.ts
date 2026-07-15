import { DocumentStatus, FeatureStatus } from "@repo/api/src/types/document";

/**
 * Combined display order for the mixed documents table (Documents + Features in
 * one list). Blends both lifecycles: not-started → active → review → blocked →
 * terminal. `IN_REVIEW` is shared by both vocabularies and appears once.
 */
export const STATUS_DISPLAY_ORDER: string[] = [
  DocumentStatus.Draft,
  FeatureStatus.Triage,
  FeatureStatus.Backlog,
  FeatureStatus.Todo,
  FeatureStatus.InProgress,
  DocumentStatus.InReview,
  DocumentStatus.ChangesRequested,
  FeatureStatus.Blocked,
  DocumentStatus.Approved,
  DocumentStatus.Executed,
  FeatureStatus.Done,
  FeatureStatus.Canceled,
  DocumentStatus.Obsolete,
];
