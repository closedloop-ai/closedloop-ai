"use client";

import { LEGACY_UNKNOWN_STATUS_ICON_LABEL } from "@repo/api/src/types/artifact-status-display";
import { DocumentStatus } from "@repo/api/src/types/document";
import { useArtifactStatusDisplay } from "@repo/app/shared/hooks/use-artifact-status-display";
import { DOCUMENT_STATUS_LABELS } from "@repo/app/shared/lib/artifact-status-labels";
import {
  type StatusAppearance,
  StatusAppearanceIcon,
} from "@repo/design-system/components/ui/status-icon-primitives";
import type * as React from "react";

interface DocumentStatusIconProps extends React.SVGAttributes<SVGSVGElement> {
  /** Document lifecycle status (PRD/Implementation Plan/Template). */
  status: DocumentStatus;
  /** Icon size in pixels (default 16). */
  size?: 16 | 20;
}

/**
 * Which shared mark each {@link DocumentStatus} draws (PRD-495). Documents
 * progress through an authoring lifecycle rendered as a filling ring,
 * terminating in a filled ✕ for Obsolete.
 *
 * Exhaustive by construction: a new `DocumentStatus` member fails typecheck
 * here until it is given an appearance, so no status can reach the fallback
 * below by omission. `blank-ring` is excluded because it IS that fallback — a
 * real status wearing it would be indistinguishable from an unknown one.
 */
const DOCUMENT_STATUS_APPEARANCE: Record<
  DocumentStatus,
  Exclude<StatusAppearance, "blank-ring">
> = {
  [DocumentStatus.Draft]: "empty-ring",
  [DocumentStatus.InReview]: "half-ring",
  [DocumentStatus.ChangesRequested]: "warning-exclamation",
  [DocumentStatus.Approved]: "full-ring",
  [DocumentStatus.Executed]: "success-check",
  [DocumentStatus.Obsolete]: "foreground-x",
};

/**
 * Status icon for a Document (PRD, Implementation Plan, Template) — one mark
 * per {@link DocumentStatus}, per {@link DOCUMENT_STATUS_APPEARANCE}.
 *
 * Issues use the disjoint {@link import("./issue-status-icon").IssueStatusIcon}.
 */
export function DocumentStatusIcon({
  status,
  size = 16,
  ...props
}: DocumentStatusIconProps) {
  const knownStatus = hasDocumentStatusAppearance(status);
  const unknownStatus = useArtifactStatusDisplay();
  // ISS-9560: an icon-only control's accessible name is its ONLY statement of
  // the value, so "Status" — the name of the FIELD — told the reader nothing.
  // The gated name is `Unknown, <sentence>`: the word first (WCAG 2.5.3), then
  // the sentence naming our limitation, because there is nowhere here to hover.
  const unknownLabel =
    unknownStatus?.accessibleName ?? LEGACY_UNKNOWN_STATUS_ICON_LABEL;

  return (
    <StatusAppearanceIcon
      // A status string outside the enum reaches here only from persisted or
      // wire data, so it gets the ring this vocabulary never claims rather than
      // a mislabelled "Draft".
      appearance={
        knownStatus ? DOCUMENT_STATUS_APPEARANCE[status] : "blank-ring"
      }
      label={knownStatus ? DOCUMENT_STATUS_LABELS[status] : unknownLabel}
      size={size}
      {...props}
    />
  );
}

function hasDocumentStatusAppearance(
  status: DocumentStatus
): status is DocumentStatus {
  return Object.hasOwn(DOCUMENT_STATUS_APPEARANCE, status);
}
