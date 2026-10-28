"use client";

import type { ArtifactDetailRowExtension } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-detail-sections";
import { columnWidthBounds } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-model";
import type {
  ArtifactListColumnExtension,
  ArtifactListSummaryMetric,
} from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-shells";
import type { ArtifactDetailsPresentation } from "@repo/app/shared/components/generic-artifact-surface/preview/components/generic-artifact-detail-shell";
import {
  ArtifactKind,
  type ArtifactSessionTrace,
  ArtifactStatus,
  type GenericArtifact,
  genericArtifactSessionTrace,
} from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";
import { PrototypeDetail } from "@repo/app/shell/v2/components/prototypes-preview/components/prototype-detail";
import {
  type PrototypeRow,
  PrototypeVersionStatus,
  prototypes,
  prototypeVersions,
} from "@repo/app/shell/v2/components/prototypes-preview/mock";
import {
  PrototypeStatus,
  type PrototypeStatus as PrototypeStatusValue,
} from "@repo/app/shell/v2/components/prototypes-preview/prototype-status";
import { Chip } from "@repo/design-system/components/ui/chip";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";
import { ColumnFieldKind } from "@repo/design-system/lib/column-registry";
import { ExternalLinkIcon, FileTextIcon } from "lucide-react";
import { ArtifactTypeIcons } from "../shared/artifact-icons";

// Declared above `prototypeArtifacts` on purpose: that map runs during module
// evaluation and reaches these values, so a bottom-of-file `const` would still
// be in its temporal dead zone and throw on import.
//
// The prototypes fixture stores an absolute `updatedAt` plus a pre-rendered
// `updated` label, while the generic artifact shell sorts and date-filters on
// minutes-ago. Anchor "now" to the freshest row so the derived ages reproduce
// the fixture's own labels and stay monotonic with `updatedAt`.
const FRESHEST_PROTOTYPE_AGE_MINUTES = 12;

const artifactStatusByPrototypeStatus: Record<
  PrototypeStatusValue,
  ArtifactStatus
> = {
  [PrototypeStatus.Draft]: ArtifactStatus.Draft,
  [PrototypeStatus.InProgress]: ArtifactStatus.Active,
  [PrototypeStatus.ReadyForReview]: ArtifactStatus.InReview,
  [PrototypeStatus.HandedOff]: ArtifactStatus.Completed,
};

export const prototypeArtifacts = prototypes.map(prototypeToArtifact);

const prototypeById = new Map(
  prototypes.map((prototype) => [prototype.id, prototype])
);

/** `null` for an artifact the prototypes fixture has no row for. */
export function prototypeRecord(
  artifact: GenericArtifact
): PrototypeRow | null {
  return prototypeById.get(artifact.id) ?? null;
}

// The status board mutates the artifact, so the artifact — not the frozen
// fixture row — owns this prototype's live review state. `null` is an artifact
// parked in a status that no prototype status maps to.
export function prototypeStatusForArtifact(
  artifact: GenericArtifact
): PrototypeStatusValue | null {
  return (
    Object.values(PrototypeStatus).find(
      (candidate) =>
        artifactStatusByPrototypeStatus[candidate] === artifact.status
    ) ?? null
  );
}

function prototypeToArtifact(prototype: PrototypeRow): GenericArtifact {
  return {
    activityCount: Math.max(2, prototype.version * 2),
    aiSpend:
      Math.round(
        (prototype.version * 12.84 + prototype.openComments * 2.7) * 100
      ) / 100,
    collaborators: [
      prototype.owner.name,
      ...prototype.collaborators.map((person) => person.name),
    ],
    commentCount: prototype.openComments,
    createdAgoDays: 14 + prototype.version * 2,
    currentVersion: String(prototype.version),
    id: prototype.id,
    kind: ArtifactKind.Prototype,
    outcomeScore: statusScore(prototype.status),
    owner: prototype.owner.name,
    ownerInitials: prototype.owner.initials,
    project: prototype.project,
    relationshipCount: prototype.collaborators.length + 2,
    repository: "closedloop-ai",
    slug: `PRT-${100 + prototype.version}`,
    status: artifactStatusByPrototypeStatus[prototype.status],
    summary: prototype.description,
    tags: prototype.tags,
    timeToReadyMinutes: 18 + prototype.version * 5,
    title: prototype.name,
    updated: prototype.updated,
    updatedAgoMinutes: prototypeUpdatedAgoMinutes(prototype),
  };
}

function statusScore(status: PrototypeStatusValue): number {
  if (status === PrototypeStatus.HandedOff) {
    return 94;
  }
  if (status === PrototypeStatus.ReadyForReview) {
    return 86;
  }
  if (status === PrototypeStatus.InProgress) {
    return 72;
  }
  return 48;
}

export const prototypeSummaryMetricDefinitions = [
  definition(
    "prototypes",
    "Prototypes",
    "Prototype artifacts",
    "Count of matching prototypes.",
    14
  ),
  definition(
    "versions",
    "Versions",
    "Published iterations",
    "Total versions across matching prototypes.",
    11
  ),
  definition(
    "comments",
    "Open comments",
    "Review feedback",
    "Unresolved comments on the selected prototype versions.",
    -8,
    MetricPolarity.LowerIsBetter
  ),
  definition(
    "ready",
    "Ready for review",
    "Review state",
    "Prototype artifacts currently ready for review.",
    16
  ),
] as const;

// Polarity defaults to Neutral: a rise in an inventory count is neither a win
// nor a loss, and the metric card must not claim a verdict the metric does not
// carry. Metrics with a real direction pass it explicitly.
function definition(
  key: string,
  label: string,
  what: string,
  how: string,
  delta: number,
  deltaPolarity: MetricPolarity = MetricPolarity.Neutral
) {
  return { delta, deltaPolarity, key, label, info: { what, how } };
}

export function buildPrototypeSummaryMetrics(
  artifacts: readonly GenericArtifact[]
): ArtifactListSummaryMetric[] {
  // Every metric sums the SAME population the count reports. The artifact
  // carries both figures itself, so a row with no fixture record contributes
  // its own numbers instead of being dropped out of the sum unannounced.
  const values = [
    String(artifacts.length),
    artifacts
      .reduce((total, artifact) => total + artifactVersion(artifact), 0)
      .toLocaleString(),
    prototypeCommentTotal(artifacts),
    String(
      artifacts.filter(
        (artifact) =>
          prototypeStatusForArtifact(artifact) ===
          PrototypeStatus.ReadyForReview
      ).length
    ),
  ];
  return prototypeSummaryMetricDefinitions.map((metric, index) => ({
    ...metric,
    value: values[index] ?? "0",
  }));
}

export const prototypeColumns: readonly ArtifactListColumnExtension[] = [
  column(
    "prototype-status",
    "Prototype status",
    140,
    prototypeStatusForArtifact,
    ColumnFieldKind.Choice,
    true
  ),
  // Both counts are host-rendered and grouped by their rendered string, which
  // `Number` refuses; `Custom` is the registry's escape hatch.
  column(
    "prototype-version",
    "Published version",
    132,
    (artifact) =>
      String(prototypeRecord(artifact)?.version ?? artifactVersion(artifact)),
    ColumnFieldKind.Custom
  ),
  column(
    "open-comments",
    "Open comments",
    120,
    (artifact) =>
      prototypeRecord(artifact)?.openComments ?? artifact.commentCount ?? null,
    ColumnFieldKind.Custom
  ),
  column(
    "preview",
    "Hosted preview",
    128,
    (artifact) =>
      prototypePreviewUrl(artifact) ? "Available" : NO_PROTOTYPE_VALUE,
    ColumnFieldKind.Choice,
    true
  ),
];

function column(
  id: string,
  label: string,
  width: number,
  value: (artifact: GenericArtifact) => string | number | null,
  kind: ColumnFieldKind,
  chip = false
): ArtifactListColumnExtension {
  const read = (artifact: GenericArtifact) =>
    value(artifact) ?? UNKNOWN_PROTOTYPE_VALUE;
  return {
    filterable: true,
    filterValues: (artifact) => [String(read(artifact))],
    groupable: true,
    groupValue: (artifact) => String(read(artifact)),
    id,
    kind,
    label,
    renderCell: (artifact) => {
      const rendered = read(artifact);
      return chip ? (
        <Chip variant="muted">{rendered}</Chip>
      ) : (
        <span className="truncate text-sm">{rendered}</span>
      );
    },
    sortable: true,
    sortValue: (artifact) => read(artifact),
    width: columnWidthBounds(width),
  };
}

export function PrototypeArtifactCanvas({
  artifact,
  commentsOpen,
  onCommentsOpenChange,
}: {
  artifact: GenericArtifact;
  commentsOpen: boolean;
  onCommentsOpenChange: (open: boolean) => void;
}) {
  const record = prototypeRecord(artifact);
  if (record === null) {
    return (
      <EmptyState
        description="This prototype has no published version to show."
        icon={FileTextIcon}
        size="compact"
        title="No preview yet"
      />
    );
  }
  return (
    <PrototypeDetail
      artifactOnly
      commentsOpen={commentsOpen}
      onCommentsOpenChange={onCommentsOpenChange}
      onPreviewRequested={() => undefined}
      // `artifactOnly` renders the preview panel alone, so the editable details
      // pane that would write back is never mounted here.
      onPrototypeChange={() => undefined}
      prototype={{
        ...record,
        status: prototypeStatusForArtifact(artifact) ?? record.status,
      }}
      showCommentsRail={false}
    />
  );
}

export function prototypeDetails(
  artifact: GenericArtifact
): ArtifactDetailsPresentation {
  const prototype = prototypeRecord(artifact);
  const reviewStatus =
    prototypeStatusForArtifact(artifact) ?? UNKNOWN_PROTOTYPE_VALUE;
  if (prototype === null) {
    return unknownPrototypeDetails(artifact, reviewStatus);
  }
  const versions =
    prototype.id === "branches-v2"
      ? prototypeVersions
      : [
          {
            number: prototype.version,
            label: String(prototype.version),
            createdAt: prototype.updated,
            createdBy: prototype.updatedBy,
            status: PrototypeVersionStatus.Current,
            changeSummary: "Current published prototype.",
          },
        ];
  return {
    additionalRows: [
      hostedPreviewRow(artifact),
      {
        id: "review-status",
        label: "Review status",
        editableValue: reviewStatus,
        value: reviewStatus,
      },
      {
        id: "updated-by",
        label: "Updated by",
        editableValue: prototype.updatedBy.name,
        value: prototype.updatedBy.name,
      },
    ],
    linkedArtifacts: [
      {
        icon: ArtifactTypeIcons.Branch,
        name: "Prototype implementation",
        relationship: "Rendered by",
        slug: "BR-4066",
        type: "Branch",
      },
      {
        icon: ArtifactTypeIcons.Document,
        name: "Generic artifact experience",
        relationship: "Specializes",
        slug: "PRD-595",
        type: "Document",
      },
    ],
    versions: versions.map((version) => ({
      author: version.createdBy.name,
      id: version.label,
      state: version.status,
      updated: version.createdAt,
    })),
    activity: [
      {
        actor: prototype.updatedBy.name,
        body: (
          <>
            published version <strong>{prototype.version}</strong>.
          </>
        ),
        date: prototype.updated,
        id: "prototype-published",
        kind: "event",
        version: String(prototype.version),
      },
      {
        actor: prototype.owner.name,
        body: (
          <>opened {prototype.openComments} version-scoped review comments.</>
        ),
        date: "just now",
        id: "prototype-comments",
        kind: "comment",
        version: String(prototype.version),
      },
    ],
  };
}

export function prototypeContributionTrace(
  artifact: GenericArtifact
): ArtifactSessionTrace {
  const prototype = prototypeRecord(artifact);
  if (prototype === null) {
    return { ...genericArtifactSessionTrace, sessions: [] };
  }
  return {
    ...genericArtifactSessionTrace,
    sessions: genericArtifactSessionTrace.sessions
      .slice(0, 3)
      .map((session, index) => ({
        ...session,
        id: `${artifact.id}-prototype-contribution-${index + 1}`,
        title:
          [
            `Create version ${Math.max(1, prototype.version - 1)} of ${prototype.name}`,
            "Address anchored prototype review comments",
            `Publish version ${prototype.version} for review`,
          ][index] ?? session.title,
        prompt:
          [
            "Implement the next prototype iteration from the approved design direction.",
            "Apply the selected anchored comments while preserving version-scoped review context.",
            "Validate the responsive states and publish the reviewed prototype version.",
          ][index] ?? session.prompt,
        outcome:
          [
            "Created a reviewable prototype iteration.",
            `Resolved ${Math.max(1, prototype.openComments)} anchored review comments.`,
            `Published version ${prototype.version} with a hosted preview.`,
          ][index] ?? session.outcome,
      })),
  };
}

function prototypeUpdatedAgoMinutes(prototype: PrototypeRow): number {
  const freshest = Math.max(...prototypes.map((row) => row.updatedAt));
  const now = freshest + FRESHEST_PROTOTYPE_AGE_MINUTES * 60_000;
  return Math.max(0, Math.round((now - prototype.updatedAt) / 60_000));
}

function unknownPrototypeDetails(
  artifact: GenericArtifact,
  reviewStatus: string
): ArtifactDetailsPresentation {
  return {
    activity: [],
    additionalRows: [
      hostedPreviewRow(artifact),
      { id: "review-status", label: "Review status", value: reviewStatus },
      {
        id: "updated-by",
        label: "Updated by",
        value: UNKNOWN_PROTOTYPE_VALUE,
      },
    ],
    linkedArtifacts: [],
    versions: [],
  };
}

/**
 * The create dialog collects a preview URL, so an artifact with no fixture row
 * still carries one; only a prototype nobody gave a URL has nothing to link.
 */
function prototypePreviewUrl(artifact: GenericArtifact): string {
  const collected = artifact.creationValues?.preview;
  return (
    prototypeRecord(artifact)?.previewUrl ??
    (typeof collected === "string" ? collected : "")
  );
}

function hostedPreviewRow(
  artifact: GenericArtifact
): ArtifactDetailRowExtension {
  const previewUrl = prototypePreviewUrl(artifact);
  return {
    id: "hosted-preview",
    label: "Hosted preview",
    value: previewUrl ? (
      <a
        className="inline-flex items-center gap-1.5 text-primary hover:underline"
        href={previewUrl}
        rel="noreferrer"
        target="_blank"
      >
        Open preview
        <ExternalLinkIcon className="size-3.5" />
      </a>
    ) : (
      NO_PROTOTYPE_VALUE
    ),
  };
}

function artifactVersion(artifact: GenericArtifact): number {
  const collected = artifact.creationValues?.["prototype-version"];
  const version = Number.parseInt(
    typeof collected === "string" && collected
      ? collected
      : artifact.currentVersion,
    10
  );
  return Number.isFinite(version) ? version : 0;
}

/** Rendered where a prototype genuinely has no such value, not merely no fixture row. */
export const NO_PROTOTYPE_VALUE = "None";

/** Rendered where a prototype-derived value has no operand at all on this row. */
export const UNKNOWN_PROTOTYPE_VALUE = "Unknown";

function prototypeCommentTotal(artifacts: readonly GenericArtifact[]): string {
  let total = 0;
  for (const artifact of artifacts) {
    if (artifact.commentCount === undefined) {
      return UNKNOWN_PROTOTYPE_VALUE;
    }
    total += artifact.commentCount;
  }
  return total.toLocaleString();
}
