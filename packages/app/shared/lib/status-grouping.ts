import { DocumentStatus, IssueStatus } from "@repo/api/src/types/document";

/**
 * Combined display order for the mixed documents table (Documents + Features in
 * one list). Blends both lifecycles: not-started → active → review → blocked →
 * terminal. `IN_REVIEW` is shared by both vocabularies and appears once.
 */
export const STATUS_DISPLAY_ORDER: string[] = [
  DocumentStatus.Draft,
  IssueStatus.Triage,
  IssueStatus.Backlog,
  IssueStatus.Todo,
  IssueStatus.InProgress,
  DocumentStatus.InReview,
  DocumentStatus.ChangesRequested,
  IssueStatus.Blocked,
  DocumentStatus.Approved,
  DocumentStatus.Executed,
  IssueStatus.Done,
  IssueStatus.Canceled,
  DocumentStatus.Obsolete,
];
