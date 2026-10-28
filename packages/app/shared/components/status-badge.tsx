"use client";

import { Priority } from "@closedloop-ai/loops-api/common";
import { DocumentStatus, IssueStatus } from "@closedloop-ai/loops-api/document";
import type { ArtifactStatusVocabulary as ArtifactStatusVocabularyType } from "@repo/api/src/types/artifact-status-contract";
import { ArtifactStatusVocabulary } from "@repo/api/src/types/artifact-status-contract";
import {
  type ArtifactStatusDisplay,
  resolveStatusLabel,
} from "@repo/api/src/types/artifact-status-display";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import { ArtifactPriority } from "@repo/app/shared/components/artifact-priority/artifact-priority";
import { ArtifactStatus as UniversalArtifactStatus } from "@repo/app/shared/components/artifact-status/artifact-status";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useArtifactStatusDisplay } from "@repo/app/shared/hooks/use-artifact-status-display";
import { ArtifactPriorityVariant } from "@repo/app/shared/lib/artifact-priority-ownership";
import { artifactStatusView } from "@repo/app/shared/lib/artifact-status-adapter";
import {
  DOCUMENT_STATUS_LABELS,
  ISSUE_STATUS_LABELS,
} from "@repo/app/shared/lib/artifact-status-labels";
import { ArtifactStatusVariant } from "@repo/app/shared/lib/artifact-status-view-contract";
import { ARTIFACT_PRIORITY_SURFACES_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { PRIORITY_LABELS } from "@repo/app/shared/lib/priority-constants";
import { Badge } from "@repo/design-system/components/ui/badge";
import { cn } from "@repo/design-system/lib/utils";

type StatusBadgeProps = {
  status: string;
  colorMap: Record<string, string>;
  defaultStyle?: string;
  className?: string;
};

export function StatusBadge({
  status,
  colorMap,
  defaultStyle,
  className,
}: Readonly<StatusBadgeProps>) {
  return (
    <Badge
      className={cn(
        "font-medium",
        colorMap[status] ?? defaultStyle ?? colorMap[Object.keys(colorMap)[0]],
        className
      )}
      variant="outline"
    >
      {status}
    </Badge>
  );
}

const COLOR_SUCCESS = "bg-success/10 text-success-foreground border-success/30";
const COLOR_FAILURE =
  "bg-destructive/10 text-destructive border-destructive/30";
const COLOR_PROGRESS = "bg-info/10 text-info-foreground border-info/30";
const COLOR_PENDING = "bg-warning/10 text-warning-foreground border-warning/30";
const COLOR_INACTIVE = "bg-muted text-muted-foreground border-muted";
const COLOR_AI = "bg-ai/10 text-ai-foreground border-ai/30";
// Unfilled and dashed, so it parts from the four SOLID muted chips this file
// already paints (Draft, Backlog, Obsolete, Canceled all resolve to the same
// muted token). `border-dashed` is the repo's existing mark for a state nobody
// has committed to — `member-row.tsx` stages a pending member with it.
const COLOR_UNKNOWN =
  "bg-transparent text-muted-foreground border-dashed border-muted-foreground/40";

export const previewDeploymentStateColors: Record<string, string> = {
  READY: COLOR_SUCCESS,
  SUCCESS: COLOR_SUCCESS,
  IN_PROGRESS: COLOR_PROGRESS,
  BUILDING: COLOR_PROGRESS,
  PENDING: COLOR_PENDING,
  QUEUED: COLOR_PENDING,
  INACTIVE: COLOR_INACTIVE,
  FAILURE: COLOR_FAILURE,
  ERROR: COLOR_FAILURE,
};

// Document (PRD / IMPLEMENTATION_PLAN / TEMPLATE) status vocabulary (PRD-495).
export const artifactStatusColors: Record<DocumentStatus, string> = {
  [DocumentStatus.Draft]: "bg-muted text-muted-foreground border-muted",
  [DocumentStatus.InReview]: COLOR_PROGRESS,
  [DocumentStatus.ChangesRequested]: COLOR_PENDING,
  [DocumentStatus.Approved]: COLOR_SUCCESS,
  [DocumentStatus.Executed]: COLOR_SUCCESS,
  [DocumentStatus.Obsolete]: COLOR_INACTIVE,
};

// ISS-9560: the Document half of the consolidation `issueStatusLabels` below
// already made. This was a verbatim second copy of DOCUMENT_STATUS_LABELS, so
// one vocabulary had two label declarations that could drift apart. Colors stay
// here — they are badge-specific tokens, deliberately distinct from the
// icon/text colors in project-constants.
export const artifactStatusLabels = DOCUMENT_STATUS_LABELS;

export function DocumentStatusBadge({
  artifactId,
  status,
}: Readonly<{ artifactId?: string; status: DocumentStatus }>) {
  return (
    <DomainStatusBadge
      artifactId={artifactId}
      colorMap={artifactStatusColors}
      defaultColor={artifactStatusColors[DocumentStatus.Draft]}
      labelMap={artifactStatusLabels}
      status={status}
      vocabulary={ArtifactStatusVocabulary.Document}
    />
  );
}

export const PrdStatusBadge = DocumentStatusBadge;
export const ImplementationPlanStatusBadge = DocumentStatusBadge;

// Issue (subtype = FEATURE) delivery-lifecycle vocabulary (PRD-495). Distinct
// from the Document maps above — no longer an alias.
export const issueStatusColors: Record<IssueStatus, string> = {
  [IssueStatus.Triage]: COLOR_AI,
  [IssueStatus.Backlog]: "bg-muted text-muted-foreground border-muted",
  [IssueStatus.Todo]: COLOR_PENDING,
  [IssueStatus.InProgress]: COLOR_PROGRESS,
  [IssueStatus.InReview]: COLOR_PROGRESS,
  [IssueStatus.Blocked]: COLOR_FAILURE,
  [IssueStatus.Done]: COLOR_SUCCESS,
  [IssueStatus.Canceled]: COLOR_INACTIVE,
};

// Labels are owned by shared/lib/artifact-status-labels (single source of truth); re-exported
// here so the badge and its consumers keep one import surface. Colors above are
// badge-specific tokens and intentionally distinct from the icon/text colors in
// project-constants. (PRD-495 review: dedupe the duplicated label strings.)
export const issueStatusLabels = ISSUE_STATUS_LABELS;

export function IssueStatusBadge({
  artifactId,
  status,
}: Readonly<{ artifactId?: string; status: IssueStatus }>) {
  return (
    <DomainStatusBadge
      artifactId={artifactId}
      colorMap={issueStatusColors}
      defaultColor={issueStatusColors[IssueStatus.Backlog]}
      labelMap={issueStatusLabels}
      status={status}
      vocabulary={ArtifactStatusVocabulary.Issue}
    />
  );
}

function DomainStatusBadge({
  artifactId,
  colorMap,
  defaultColor,
  labelMap,
  status,
  vocabulary,
}: Readonly<{
  artifactId?: string;
  colorMap: Readonly<Record<string, string>>;
  defaultColor: string;
  labelMap: Readonly<Record<string, string>>;
  status: string;
  vocabulary: ArtifactStatusVocabularyType;
}>) {
  const champion = useFeatureFlagEnabledOptional(
    UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY
  );
  const unknownStatus = useArtifactStatusDisplay();
  if (champion && artifactId) {
    return (
      <UniversalArtifactStatus
        variant={ArtifactStatusVariant.Badge}
        view={artifactStatusView(artifactId, vocabulary, status)}
      />
    );
  }
  return (
    <Badge
      className={cn(
        "font-medium",
        resolveStatusBadgeColors(colorMap, status, unknownStatus, defaultColor)
      )}
      variant="outline"
    >
      {resolveStatusLabel(labelMap, status, unknownStatus)}
    </Badge>
  );
}

/**
 * The pre-ISS-9307 tone map. High and Urgent both take `COLOR_FAILURE`, so the
 * two loudest values are indistinguishable by tone — which is the presentation
 * fork `ARTIFACT_PRIORITY_OWNERSHIP` names and the champion collapses. Kept
 * reachable as the flag-OFF rendering, per the closed-by-default UI policy.
 */
export const issuePriorityColors: Record<Priority, string> = {
  [Priority.Low]: COLOR_PROGRESS,
  [Priority.Medium]: COLOR_PENDING,
  [Priority.High]: COLOR_FAILURE,
  [Priority.Urgent]: COLOR_FAILURE,
};

/**
 * ISS-9307: one read of `artifact-priority-surfaces`, swapping between two whole
 * shapes rather than threading the boolean on.
 *
 * ON, the badge is the champion's `badge` variant, which renders the design
 * system's `PriorityBadge` and so tells High and Urgent apart. OFF it is exactly
 * the badge that shipped, tone collision included.
 *
 * The name stays for the two search-result call sites, whose migration is a
 * later phase of PRD-706; what changed is that only one implementation of the
 * mark is left underneath.
 */
export function IssuePriorityBadge({
  priority,
}: Readonly<{ priority: Priority }>) {
  const champion = useFeatureFlagEnabledOptional(
    ARTIFACT_PRIORITY_SURFACES_FEATURE_FLAG_KEY
  );
  if (champion) {
    return (
      <ArtifactPriority
        priority={priority}
        variant={ArtifactPriorityVariant.Badge}
      />
    );
  }
  return (
    <Badge
      // Both fallbacks are load-bearing and neither is dead: `priority` is a wire
      // value from `/search`, so a member only a newer peer knows indexes both
      // maps to `undefined` and this arm would render an empty, untoned pill —
      // which a reader takes as "no priority". This IS the shipped path, because
      // the gate above is closed by default.
      className={cn(
        "font-medium",
        issuePriorityColors[priority] ?? issuePriorityColors[Priority.Low]
      )}
      variant="outline"
    >
      {PRIORITY_LABELS[priority] ?? priority}
    </Badge>
  );
}

/**
 * The badge tokens for `status`: its own, else the uncommitted treatment once
 * `unknownStatus` is non-null, else `fallback`.
 *
 * The color half of `resolveStatusLabel`, and it exists because keeping the two
 * halves apart is what shipped the defect ISS-9560 opened to fix: the label
 * resolved to "Unknown" while the class list still fell through to Draft's, so
 * an unrecognized status wore a recognized one's chip (PR #6973 review). The
 * icons part unknown from every real state with the `blank-ring` this
 * vocabulary never claims; this is the badge's half of that same statement.
 *
 * Flag-off is byte-identical to the pre-ISS-9560 render: `fallback` IS the
 * `?? artifactStatusColors[Draft]` this replaced, so the closed default keeps
 * whatever answer the badge already gave.
 *
 * `Object.hasOwn` for the reason `lookupStatusLabel` documents: `status` is
 * typed to a closed union at this boundary but originates in a freeform
 * column, so `"constructor"` would otherwise index into `Object.prototype` and
 * hand a function to `cn`.
 */
function resolveStatusBadgeColors(
  colors: Readonly<Record<string, string>>,
  status: string,
  unknownStatus: ArtifactStatusDisplay | null,
  fallback: string
): string {
  if (Object.hasOwn(colors, status)) {
    return colors[status];
  }
  return unknownStatus ? COLOR_UNKNOWN : fallback;
}
