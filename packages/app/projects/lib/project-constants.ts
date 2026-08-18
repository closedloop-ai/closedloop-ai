import {
  DocumentStatus,
  DocumentType,
  IssueStatus,
} from "@repo/api/src/types/document";
import {
  GITHUB_PR_STATE_LABELS,
  GitHubPRState,
} from "@repo/api/src/types/github";
import { ProjectStatus } from "@repo/api/src/types/project";
// Canonical artifact-type label maps live in the documents slice; re-bound here
// so project-scoped consumers keep their import path (FEA-3954 SSOT).
import {
  DOCUMENT_TYPE_BADGE_LABELS as DOCUMENT_TYPE_BADGE_LABELS_CANONICAL,
  DOCUMENT_TYPE_LABELS as DOCUMENT_TYPE_LABELS_CANONICAL,
} from "@repo/app/documents/lib/document-type-labels";
import type { StatusIconStatus } from "@repo/design-system/components/ui/status-icon";
import {
  BoxIcon,
  FileIcon,
  FileTextIcon,
  LayoutTemplateIcon,
  ListCheckIcon,
} from "lucide-react";
import type * as React from "react";

// Priority display constants moved to @repo/app/shared/lib/priority-constants
// (unified across all entities, keyed by the shared Priority enum).

// ---------------------------------------------------------------------------
// Status display config (PRD-495). Documents (PRD/IMPLEMENTATION_PLAN/TEMPLATE)
// and Features (FEATURE) carry disjoint status vocabularies. Single-artifact
// editors and per-type pickers use the per-vocabulary maps; the mixed
// documents table (which renders both kinds) uses the combined ARTIFACT_STATUS_LABELS
// map for lookup since the two sets overlap only on IN_REVIEW (identically).
// ---------------------------------------------------------------------------

export const DOCUMENT_STATUS_LABELS: Record<DocumentStatus, string> = {
  [DocumentStatus.Draft]: "Draft",
  [DocumentStatus.InReview]: "In Review",
  [DocumentStatus.ChangesRequested]: "Changes Requested",
  [DocumentStatus.Approved]: "Approved",
  [DocumentStatus.Executed]: "Executed",
  [DocumentStatus.Obsolete]: "Obsolete",
};

// Document/Issue status → icon mapping now lives in the dedicated
// DocumentStatusIcon / IssueStatusIcon components (each owns its own glyph per
// status). For status-grouped or mixed surfaces where the artifact type is not
// singular, use ArtifactStatusIcon. See
// @repo/app/documents/components/{document,issue,artifact}-status-icon.

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

/**
 * Combined label lookup map for the mixed documents table, which renders
 * Documents and Features in one list. The two vocabularies overlap only on
 * `IN_REVIEW` (identical label), so a flat status-keyed lookup is unambiguous.
 * Use this for read-only display by status string; use the per-vocabulary maps
 * above wherever the artifact type is known and options must be scoped.
 * Status *icons* are rendered by ArtifactStatusIcon (or the per-type
 * DocumentStatusIcon / IssueStatusIcon), not a map.
 */
export const ARTIFACT_STATUS_LABELS: Record<string, string> = {
  ...DOCUMENT_STATUS_LABELS,
  ...ISSUE_STATUS_LABELS,
};

// Artifact type icons. FileTextIcon (the most literal "a document" glyph) is
// the generic Doc; Template moves to the template-shaped LayoutTemplateIcon so
// the plainest glyph belongs to the plainest type (and no longer collides with
// the unknown-type fallback in document-type-badge.tsx).
export const DOCUMENT_TYPE_ICONS: Record<DocumentType, React.ElementType> = {
  [DocumentType.Prd]: FileIcon,
  [DocumentType.ImplementationPlan]: ListCheckIcon,
  [DocumentType.Template]: LayoutTemplateIcon,
  [DocumentType.Feature]: BoxIcon,
  [DocumentType.Doc]: FileTextIcon,
};

// Artifact type labels for display (re-bound from the canonical documents-slice
// maps above; do not re-declare the label strings — FEA-3954 SSOT).
export const DOCUMENT_TYPE_LABELS = DOCUMENT_TYPE_LABELS_CANONICAL;

// Artifact type colors for pills (bg + text)
export const DOCUMENT_TYPE_COLORS: Record<
  DocumentType,
  { bg: string; text: string }
> = {
  [DocumentType.Prd]: {
    bg: "bg-blue-100 dark:bg-blue-900/50",
    text: "text-blue-700 dark:text-blue-300",
  },
  [DocumentType.ImplementationPlan]: {
    bg: "bg-emerald-100 dark:bg-emerald-900/50",
    text: "text-emerald-700 dark:text-emerald-300",
  },
  [DocumentType.Template]: {
    bg: "bg-indigo-100 dark:bg-indigo-900/50",
    text: "text-indigo-700 dark:text-indigo-300",
  },
  // Violet matches the Feature badge the documents table has always rendered
  // (the table previously hardcoded violet and ignored this map's old amber).
  [DocumentType.Feature]: {
    bg: "bg-violet-100 dark:bg-violet-900/50",
    text: "text-violet-700 dark:text-violet-300",
  },
  // Neutral slate keeps the generic evergreen Doc distinct from the three cool
  // blues already in the set (blue/indigo PRD/Template + the named types) and
  // lets it sit quieter than the named artifact types.
  [DocumentType.Doc]: {
    bg: "bg-slate-100 dark:bg-slate-800/50",
    text: "text-slate-700 dark:text-slate-300",
  },
};

// Artifact type short badge labels (for compact displays like the Context
// table); re-bound from the canonical documents-slice map (FEA-3954 SSOT).
export const DOCUMENT_TYPE_BADGE_LABELS = DOCUMENT_TYPE_BADGE_LABELS_CANONICAL;

// Project status labels
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  [ProjectStatus.NotStarted]: "Not Started",
  [ProjectStatus.InProgress]: "In Progress",
  [ProjectStatus.Completed]: "Completed",
  [ProjectStatus.Archived]: "Archived",
};

// Branch (Pull Request) artifact status labels/icons.
export const BRANCH_STATUS_LABELS: Record<GitHubPRState, string> =
  GITHUB_PR_STATE_LABELS;

export const BRANCH_STATUS_TO_ICON: Record<GitHubPRState, StatusIconStatus> = {
  [GitHubPRState.Open]: "in-progress",
  [GitHubPRState.Merged]: "complete",
  [GitHubPRState.Closed]: "wont-do",
};

/**
 * Plural noun naming the population `ProjectWithDetails.completionPercentage`
 * summarizes — the project's `PROJECT_COMPLETION_ARTIFACT_TYPE` (DOCUMENT)
 * artifacts. Both nouns are required: a DOCUMENT artifact is a
 * PRD/plan/template/doc *or* an Issue (subtype FEATURE), and this product names
 * those two things separately — `DOCUMENT_TYPE_LABELS` renders FEATURE as
 * "Issue", and Documents and Issues are distinct primary-nav destinations.
 * Saying only "documents" would understate the population the same way the
 * previous "artifacts" overstated it (ISS-4636).
 *
 * Pinned to both the counted artifact type and `DOCUMENT_TYPE_LABELS` by
 * `__tests__/project-constants.test.ts`, so neither a widened population nor a
 * renamed type label can leave this copy behind.
 */
export const PROJECT_COMPLETION_POPULATION_PARTS = [
  "documents",
  "issues",
] as const;

/**
 * Plural noun naming the completion population in the *positive* sentence
 * ("X% of documents and issues complete"). Derived from
 * {@link PROJECT_COMPLETION_POPULATION_PARTS} so the parts stay the single
 * source of truth, while the conjunction is sentence-specific: a positive
 * assertion joins the parts with "and", but the negated empty-state sentence
 * must join them with "or" (English flips the conjunction under negation —
 * "no documents or issues", not "no documents and issues").
 */
export const PROJECT_COMPLETION_POPULATION_NOUN =
  PROJECT_COMPLETION_POPULATION_PARTS.join(" and ");

/**
 * Copy for the project completion ring — its tooltip and its accessible name.
 * Named from {@link PROJECT_COMPLETION_POPULATION_NOUN} rather than written at
 * the call site, so the sentence and the population it describes have one home.
 */
export function formatProjectCompletionSummary(percentage: number): string {
  return `${Math.round(percentage)}% of ${PROJECT_COMPLETION_POPULATION_NOUN} complete`;
}

/**
 * Copy for the completion ring's empty state — a project whose completion
 * population is empty (no documents/issues), which the ring renders as a dashed
 * backlog track rather than a solid 0% (ISS-4679). Built from the same
 * {@link PROJECT_COMPLETION_POPULATION_PARTS} as the positive summary, but with
 * an "or" conjunction: under negation English flips "and" to "or", so this
 * reads "No documents or issues yet" — the parts stay the single source of
 * truth, the conjunction does not survive the negation intact.
 */
export const PROJECT_COMPLETION_EMPTY_SUMMARY = `No ${PROJECT_COMPLETION_POPULATION_PARTS.join(
  " or "
)} yet`;
