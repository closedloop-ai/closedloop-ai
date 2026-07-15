"use client";

import { FeatureStatus } from "@repo/api/src/types/document";
import { FEATURE_STATUS_LABELS } from "@repo/app/projects/lib/project-constants";
import {
  FilledStatusCircle,
  StatusRing,
} from "@repo/design-system/components/ui/status-icon-primitives";
import type * as React from "react";

interface FeatureStatusIconProps extends React.SVGAttributes<SVGSVGElement> {
  /** Feature delivery-lifecycle status. */
  status: FeatureStatus;
  /** Icon size in pixels (default 16). */
  size?: 16 | 20;
  /**
   * Show the spinning arc while an AI generation run is active. Applies to the
   * non-terminal ring states; ignored for the filled states (Triage, Blocked,
   * Done, Canceled).
   */
  thinking?: boolean;
}

/**
 * Status icon for a Feature — one glyph per {@link FeatureStatus} (PRD-495).
 * Features follow a delivery lifecycle distinct from Documents:
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
export function FeatureStatusIcon({
  status,
  size = 16,
  thinking = false,
  ...props
}: FeatureStatusIconProps) {
  const label = FEATURE_STATUS_LABELS[status] ?? "Status";
  const ringColor = "var(--progress-foreground)";

  switch (status) {
    case FeatureStatus.Triage:
      return (
        <FilledStatusCircle
          fill="var(--ai)"
          glyph="swap"
          label={label}
          size={size}
          {...props}
        />
      );
    case FeatureStatus.Backlog:
      return (
        <StatusRing
          color={ringColor}
          dashed
          label={label}
          percentage={0}
          size={size}
          thinking={thinking}
          {...props}
        />
      );
    case FeatureStatus.Todo:
      return (
        <StatusRing
          color={ringColor}
          label={label}
          percentage={0}
          size={size}
          thinking={thinking}
          {...props}
        />
      );
    case FeatureStatus.InProgress:
      return (
        <StatusRing
          color={ringColor}
          label={label}
          percentage={48.5}
          size={size}
          thinking={thinking}
          {...props}
        />
      );
    case FeatureStatus.InReview:
      return (
        <StatusRing
          color={ringColor}
          label={label}
          percentage={73.5}
          size={size}
          thinking={thinking}
          {...props}
        />
      );
    case FeatureStatus.Blocked:
      return (
        <FilledStatusCircle
          fill="var(--warning)"
          glyph="exclamation"
          label={label}
          size={size}
          {...props}
        />
      );
    case FeatureStatus.Done:
      return (
        <FilledStatusCircle
          fill="var(--success)"
          glyph="check"
          label={label}
          size={size}
          {...props}
        />
      );
    case FeatureStatus.Canceled:
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
