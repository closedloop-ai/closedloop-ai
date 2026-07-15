"use client";

import { DocumentStatus } from "@repo/api/src/types/document";
import { DOCUMENT_STATUS_LABELS } from "@repo/app/projects/lib/project-constants";
import {
  FilledStatusCircle,
  StatusRing,
} from "@repo/design-system/components/ui/status-icon-primitives";
import type * as React from "react";

interface DocumentStatusIconProps extends React.SVGAttributes<SVGSVGElement> {
  /** Document lifecycle status (PRD/Implementation Plan/Template). */
  status: DocumentStatus;
  /** Icon size in pixels (default 16). */
  size?: 16 | 20;
  /**
   * Show the spinning arc while an AI generation run is active. Applies to the
   * non-terminal ring states; ignored for the filled terminal state (Obsolete).
   */
  thinking?: boolean;
}

/**
 * Status icon for a Document (PRD, Implementation Plan, Template) — one glyph
 * per {@link DocumentStatus} (PRD-495). Documents progress through an authoring
 * lifecycle rendered as a filling ring, terminating in a filled ✕ for Obsolete:
 *
 * - Draft → empty ring
 * - In Review → 50% ring
 * - Changes Requested → filled amber circle with !
 * - Approved → full (100%) ring
 * - Executed → filled green circle with ✓ (matches Feature "Done")
 * - Obsolete → filled circle with ✕
 *
 * Features use the disjoint {@link import("./feature-status-icon").FeatureStatusIcon}.
 */
export function DocumentStatusIcon({
  status,
  size = 16,
  thinking = false,
  ...props
}: DocumentStatusIconProps) {
  const label = DOCUMENT_STATUS_LABELS[status] ?? "Status";
  const ringColor = "var(--progress-foreground)";

  switch (status) {
    case DocumentStatus.Draft:
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
    case DocumentStatus.InReview:
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
    case DocumentStatus.ChangesRequested:
      return (
        <FilledStatusCircle
          fill="var(--warning)"
          glyph="exclamation"
          label={label}
          size={size}
          {...props}
        />
      );
    case DocumentStatus.Approved:
      return (
        <StatusRing
          color={ringColor}
          label={label}
          percentage={100}
          size={size}
          thinking={thinking}
          {...props}
        />
      );
    case DocumentStatus.Executed:
      return (
        <FilledStatusCircle
          fill="var(--success)"
          glyph="check"
          label={label}
          size={size}
          {...props}
        />
      );
    case DocumentStatus.Obsolete:
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
