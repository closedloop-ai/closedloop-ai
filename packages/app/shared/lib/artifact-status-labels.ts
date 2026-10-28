import { DocumentStatus, IssueStatus } from "@repo/api/src/types/document";

// Status display config (PRD-495). Documents (PRD/IMPLEMENTATION_PLAN/TEMPLATE)
// and Features (FEATURE) carry disjoint status vocabularies. Single-artifact
// editors and per-type pickers use the per-vocabulary maps; the mixed
// documents table (which renders both kinds) uses the combined ARTIFACT_STATUS_LABELS
// map for lookup since the two sets overlap only on IN_REVIEW (identically).

export const DOCUMENT_STATUS_LABELS: Record<DocumentStatus, string> = {
  [DocumentStatus.Draft]: "Draft",
  [DocumentStatus.InReview]: "In Review",
  [DocumentStatus.ChangesRequested]: "Changes Requested",
  [DocumentStatus.Approved]: "Approved",
  [DocumentStatus.Executed]: "Executed",
  [DocumentStatus.Obsolete]: "Obsolete",
};

export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  [IssueStatus.Triage]: "Triage",
  [IssueStatus.Backlog]: "Backlog",
  [IssueStatus.Todo]: "Todo",
  [IssueStatus.InProgress]: "In Progress",
  [IssueStatus.InReview]: "In Review",
  [IssueStatus.Blocked]: "Blocked",
  [IssueStatus.Done]: "Done",
  [IssueStatus.Canceled]: "Canceled",
};
