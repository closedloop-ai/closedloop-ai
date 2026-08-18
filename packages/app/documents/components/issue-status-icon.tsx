"use client";

import { IssueStatus } from "@repo/api/src/types/document";
import { ISSUE_STATUS_LABELS } from "@repo/app/projects/lib/project-constants";
import {
  EMPTY_RING_TRACK_COLOR,
  FilledStatusCircle,
  StatusRing,
} from "@repo/design-system/components/ui/status-icon-primitives";
import type * as React from "react";

interface IssueStatusIconProps extends React.SVGAttributes<SVGSVGElement> {
  /** Issue delivery-lifecycle status. */
  status: IssueStatus;
  /** Icon size in pixels (default 16). */
  size?: 16 | 20;
}

/**
 * Status icon for an Issue — one glyph per {@link IssueStatus} (PRD-495).
 * Issues follow a delivery lifecycle distinct from Documents:
 *
 * - Triage → filled circle with a swap glyph (AI-triaged)
 * - Backlog → dashed ring
 * - Todo → empty ring
 * - In Progress → 50% ring
 * - In Review → 75% ring
 * - Blocked → filled amber circle with !
 * - Done → filled green circle with ✓
 * - Canceled → filled circle with ✕
 *
 * Documents use the disjoint {@link import("./document-status-icon").DocumentStatusIcon}.
 */
export function IssueStatusIcon({
  status,
  size = 16,
  ...props
}: IssueStatusIconProps) {
  const label = ISSUE_STATUS_LABELS[status] ?? "Status";
  const ringColor = "var(--progress-foreground)";

  switch (status) {
    case IssueStatus.Triage:
      return (
        <FilledStatusCircle
          fill="var(--ai)"
          glyph="swap"
          label={label}
          size={size}
          {...props}
        />
      );
    case IssueStatus.Backlog:
      return (
        <StatusRing
          color={ringColor}
          dashed
          label={label}
          percentage={0}
          size={size}
          {...props}
        />
      );
    case IssueStatus.Todo:
      return (
        <StatusRing
          color={ringColor}
          label={label}
          percentage={0}
          size={size}
          trackColor={EMPTY_RING_TRACK_COLOR}
          {...props}
        />
      );
    case IssueStatus.InProgress:
      return (
        <StatusRing
          color={ringColor}
          label={label}
          percentage={48.5}
          size={size}
          {...props}
        />
      );
    case IssueStatus.InReview:
      return (
        <StatusRing
          color={ringColor}
          label={label}
          percentage={73.5}
          size={size}
          {...props}
        />
      );
    case IssueStatus.Blocked:
      return (
        <FilledStatusCircle
          fill="var(--warning)"
          glyph="exclamation"
          label={label}
          size={size}
          {...props}
        />
      );
    case IssueStatus.Done:
      return (
        <FilledStatusCircle
          fill="var(--success)"
          glyph="check"
          label={label}
          size={size}
          {...props}
        />
      );
    case IssueStatus.Canceled:
      return (
        <FilledStatusCircle
          fill="var(--foreground)"
          glyph="x"
          label={label}
          size={size}
          {...props}
        />
      );
    default: {
      return renderUnexpectedStatusRing(status, {
        color: ringColor,
        label,
        percentage: 0,
        size,
        ...props,
      });
    }
  }
}

function renderUnexpectedStatusRing(
  _status: never,
  props: React.ComponentProps<typeof StatusRing>
) {
  return <StatusRing {...props} />;
}
