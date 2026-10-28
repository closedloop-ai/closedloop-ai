"use client";

import { LEGACY_UNKNOWN_STATUS_ICON_LABEL } from "@repo/api/src/types/artifact-status-display";
import { IssueStatus } from "@repo/api/src/types/document";
import { useArtifactStatusDisplay } from "@repo/app/shared/hooks/use-artifact-status-display";
import { ISSUE_STATUS_LABELS } from "@repo/app/shared/lib/artifact-status-labels";
import {
  type StatusAppearance,
  StatusAppearanceIcon,
} from "@repo/design-system/components/ui/status-icon-primitives";
import type * as React from "react";

interface IssueStatusIconProps extends React.SVGAttributes<SVGSVGElement> {
  /** Issue delivery-lifecycle status. */
  status: IssueStatus;
  /** Icon size in pixels (default 16). */
  size?: 16 | 20;
}

/**
 * Which shared mark each {@link IssueStatus} draws (PRD-495). Issues follow a
 * delivery lifecycle distinct from Documents: an AI-triaged swap, then a ring
 * that fills through Backlog/Todo/In progress/In review, then a terminal glyph.
 *
 * In review is `three-quarter-ring` where a Document's In review is
 * `half-ring`: the two vocabularies share that word and not that mark, which a
 * shared appearance name has to keep expressible rather than flatten.
 *
 * Exhaustive by construction, and `blank-ring` is excluded for the reason
 * {@link import("./document-status-icon").DocumentStatusIcon} gives.
 */
const ISSUE_STATUS_APPEARANCE: Record<
  IssueStatus,
  Exclude<StatusAppearance, "blank-ring">
> = {
  [IssueStatus.Triage]: "ai-swap",
  [IssueStatus.Backlog]: "dashed-ring",
  [IssueStatus.Todo]: "empty-ring",
  [IssueStatus.InProgress]: "half-ring",
  [IssueStatus.InReview]: "three-quarter-ring",
  [IssueStatus.Blocked]: "warning-exclamation",
  [IssueStatus.Done]: "success-check",
  [IssueStatus.Canceled]: "foreground-x",
};

/**
 * Status icon for an Issue — one mark per {@link IssueStatus}, per
 * {@link ISSUE_STATUS_APPEARANCE}.
 *
 * Documents use the disjoint {@link import("./document-status-icon").DocumentStatusIcon}.
 */
export function IssueStatusIcon({
  status,
  size = 16,
  ...props
}: IssueStatusIconProps) {
  const knownStatus = hasIssueStatusAppearance(status);
  const unknownStatus = useArtifactStatusDisplay();
  // ISS-9560, for the reason
  // {@link import("./document-status-icon").DocumentStatusIcon} gives.
  const unknownLabel =
    unknownStatus?.accessibleName ?? LEGACY_UNKNOWN_STATUS_ICON_LABEL;

  return (
    <StatusAppearanceIcon
      // A status string outside the enum reaches here only from persisted or
      // wire data, so it gets the ring this vocabulary never claims rather than
      // a mislabelled real status.
      appearance={knownStatus ? ISSUE_STATUS_APPEARANCE[status] : "blank-ring"}
      label={knownStatus ? ISSUE_STATUS_LABELS[status] : unknownLabel}
      size={size}
      {...props}
    />
  );
}

function hasIssueStatusAppearance(status: IssueStatus): status is IssueStatus {
  return Object.hasOwn(ISSUE_STATUS_APPEARANCE, status);
}
