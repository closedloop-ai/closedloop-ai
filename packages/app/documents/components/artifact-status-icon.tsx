"use client";

import {
  type ArtifactStatus,
  DocumentStatus,
  IssueStatus,
} from "@repo/api/src/types/document";
import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
import type * as React from "react";
import { DocumentStatusIcon } from "./document-status-icon";
import { IssueStatusIcon } from "./issue-status-icon";

interface ArtifactStatusIconProps extends React.SVGAttributes<SVGSVGElement> {
  /** A Document or Feature status string (the two vocabularies are disjoint). */
  status: ArtifactStatus;
  /** Icon size in pixels (default 16). */
  size?: 16 | 20;
}

const ISSUE_STATUSES = new Set<string>(Object.values(IssueStatus));
const DOCUMENT_STATUSES = new Set<string>(Object.values(DocumentStatus));

/**
 * Renders the correct domain status icon for a raw status string when the
 * artifact type is not singular — status-grouped headers, mixed filter chips,
 * and multi-type pickers that span both Documents and Issues. Prefer
 * {@link DocumentStatusIcon} / {@link IssueStatusIcon} directly wherever the
 * artifact type is known.
 *
 * `IN_REVIEW` belongs to both vocabularies; for these mixed surfaces it renders
 * the Issue (75%) form canonically (PRD-495).
 */
export function ArtifactStatusIcon({
  status,
  size = 16,
  ...props
}: ArtifactStatusIconProps) {
  // IN_REVIEW is shared by both vocabularies — render one canonical form.
  if (status === IssueStatus.InReview) {
    return (
      <IssueStatusIcon size={size} status={IssueStatus.InReview} {...props} />
    );
  }
  if (ISSUE_STATUSES.has(status)) {
    return (
      <IssueStatusIcon size={size} status={status as IssueStatus} {...props} />
    );
  }
  if (DOCUMENT_STATUSES.has(status)) {
    return (
      <DocumentStatusIcon
        size={size}
        status={status as DocumentStatus}
        {...props}
      />
    );
  }
  // Unrecognized status — e.g. a branch (GitHubPRState) or session (harness
  // string) row grouped by status in a mixed table. Render the generic neutral
  // marker rather than mislabeling it as a Document/Feature status (a
  // DocumentStatusIcon fallback would announce "Draft" to screen readers).
  return <StatusIcon size={size} status="decorative" {...props} />;
}
