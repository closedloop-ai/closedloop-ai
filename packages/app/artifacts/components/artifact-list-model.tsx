"use client";

import {
  DocumentType,
  type DocumentWithProject,
} from "@repo/api/src/types/document";
import { documentCustomFieldCreationValues } from "@repo/app/documents/components/documents-prototype-custom-fields";
import { getDocumentTypeLabel } from "@repo/app/documents/lib/document-navigation";
import {
  DOCUMENTS_SUMMARY_CARD_INFO,
  DOCUMENTS_SUMMARY_CARD_LABELS,
  DocumentsSummaryCardId,
} from "@repo/app/documents/lib/documents-summary-cards";
import { genericArtifactStatusFromRaw } from "@repo/app/shared/components/generic-artifact-surface/generic-artifact-status";
import {
  type ArtifactListColumnExtension,
  columnWidthBounds,
} from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-model";
import {
  ArtifactKind,
  ArtifactStatus,
  type GenericArtifact,
} from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";
import { formatRelativeTimeOrFallback } from "@repo/app/shared/lib/date-utils";
import {
  getUserDisplayName,
  getUserInitials,
  UNASSIGNED_ASSIGNEE_LABEL,
} from "@repo/app/shared/lib/user-utils";
import { ColumnFieldKind } from "@repo/design-system/lib/column-registry";
import {
  isPriorityValue,
  priorityLabel,
  priorityRank,
} from "@repo/design-system/lib/priority-order";

export const DOCUMENTS_PROTOTYPE_COLUMNS = [
  "owner",
  "collaborators",
  "status",
  "relatedSessions",
  "comments",
  "updated",
  "currentVersion",
  "tags",
  "document-type",
] as const;

export const DOCUMENTS_PROTOTYPE_METRICS = [
  {
    key: "documents",
    label: "Documents",
    info: {
      what: "Matching documents",
      how: "Count of documents in the current view.",
    },
  },
  {
    key: "total-cost",
    label: "Est. Total",
    info: {
      what: "Known API costs plus estimated subscription costs",
      how: "Adds direct API charges to the API-equivalent estimate of subscription-based token usage from writing and revision sessions.",
    },
  },
  {
    key: "median-cost",
    label: "Median token cost",
    info: {
      what: "Typical document cost",
      how: "Median attributed cost per document.",
    },
  },
  {
    key: "metric-four",
    label:
      DOCUMENTS_SUMMARY_CARD_LABELS[DocumentsSummaryCardId.ProducedBySessions],
    info: DOCUMENTS_SUMMARY_CARD_INFO[
      DocumentsSummaryCardId.ProducedBySessions
    ],
  },
  {
    key: "metric-five",
    label:
      DOCUMENTS_SUMMARY_CARD_LABELS[DocumentsSummaryCardId.UpdatedInWindow],
    info: DOCUMENTS_SUMMARY_CARD_INFO[DocumentsSummaryCardId.UpdatedInWindow],
  },
] as const;

export const DOCUMENTS_UNAVAILABLE_COLUMN_CAPABILITIES = {
  comments: { filterable: false, sortable: false, groupable: false },
  relatedSessions: { filterable: false, sortable: false, groupable: false },
} as const;

export const DOCUMENTS_EXCLUDED_COLUMN_IDS: readonly string[] = [];

export function documentsPrototypeColumns(): ArtifactListColumnExtension[] {
  const label = (artifact: GenericArtifact) => {
    const value = artifact.creationValues?.["document-type"];
    return typeof value === "string" ? value : "";
  };
  return [
    {
      id: "document-type",
      label: "Type",
      kind: ColumnFieldKind.Choice,
      width: columnWidthBounds(140),
      sortable: true,
      filterable: true,
      groupable: true,
      sortValue: label,
      filterValues: (artifact) => [label(artifact)],
      groupValue: label,
      renderCell: (artifact) => label(artifact),
    },
  ];
}

export function documentToPrototypeListRow(
  document: DocumentWithProject,
  now: number
): GenericArtifact {
  const updatedAt = new Date(document.updatedAt).getTime();
  const createdAt = new Date(document.createdAt).getTime();
  return {
    id: document.id,
    slug: document.slug,
    title: document.title,
    summary: "",
    kind:
      document.type === DocumentType.Feature
        ? ArtifactKind.Issue
        : ArtifactKind.Document,
    status:
      genericArtifactStatusFromRaw(
        document.type === DocumentType.Feature
          ? ArtifactKind.Issue
          : ArtifactKind.Document,
        document.status
      ) ?? ArtifactStatus.Draft,
    statusRaw: document.status,
    ownerId: document.assigneeId,
    owner: document.assignee
      ? getUserDisplayName(document.assignee)
      : UNASSIGNED_ASSIGNEE_LABEL,
    ownerInitials: document.assignee
      ? getUserInitials(document.assignee.firstName, document.assignee.lastName)
      : "",
    repository: null,
    project: document.project?.name ?? null,
    tags: document.tags?.map((tag) => tag.name) ?? [],
    tagIds: document.tags?.map((tag) => tag.id) ?? [],
    currentVersion: String(document.latestVersion),
    updated: formatRelativeTimeOrFallback(document.updatedAt),
    creationValues: {
      ...documentCustomFieldCreationValues(document),
      "document-type": getDocumentTypeLabel(document.type),
      priority: document.priority,
      projectId: document.projectId,
    },
    updatedAgoMinutes: (now - updatedAt) / 60_000,
    createdAgoDays: (now - createdAt) / 86_400_000,
    // The preview shape carries fields the list API does not expose. Production
    // never reads these placeholders: host renderers withdraw their values and
    // capabilities, and summary values come from the population read below.
    collaborators: [],
    aiSpend: 0,
    timeToReadyMinutes: 0,
    outcomeScore: 0,
    activityCount: 0,
    relationshipCount: 0,
  };
}

export const ISSUES_PROTOTYPE_COLUMNS = [
  "owner",
  "collaborators",
  "status",
  "relatedSessions",
  "comments",
  "updated",
  "currentVersion",
  "tags",
  "priority",
] as const;

export const ISSUES_PROTOTYPE_METRICS = [
  {
    ...DOCUMENTS_PROTOTYPE_METRICS[0],
    key: "issues",
    label: "Issues",
    info: {
      what: "Matching issues",
      how: "Count of issues in the current view.",
    },
  },
  DOCUMENTS_PROTOTYPE_METRICS[1],
  DOCUMENTS_PROTOTYPE_METRICS[2],
  DOCUMENTS_PROTOTYPE_METRICS[3],
  DOCUMENTS_PROTOTYPE_METRICS[4],
] as const;

export function issuesPrototypeColumns(): ArtifactListColumnExtension[] {
  const priority = (artifact: GenericArtifact) => {
    const value = artifact.creationValues?.priority;
    return typeof value === "string" ? value : "";
  };
  return [
    {
      id: "project",
      label: "Project",
      kind: ColumnFieldKind.Choice,
      width: columnWidthBounds(180),
      sortable: true,
      filterable: true,
      groupable: true,
      sortValue: (artifact) => artifact.project ?? "",
      filterValues: (artifact) => {
        const id = artifact.creationValues?.projectId;
        return typeof id === "string" ? [id] : [];
      },
      groupValue: (artifact) => {
        const id = artifact.creationValues?.projectId;
        return typeof id === "string" ? id : "";
      },
      valueLabel: (value, artifacts) =>
        artifacts.find(
          (artifact) => artifact.creationValues?.projectId === value
        )?.project ?? value,
      renderCell: (artifact) => artifact.project,
    },
    {
      id: "priority",
      label: "Priority",
      kind: ColumnFieldKind.Choice,
      width: columnWidthBounds(140),
      sortable: true,
      filterable: true,
      groupable: true,
      sortValue: (artifact) => priorityRank(priority(artifact)),
      filterValues: (artifact) =>
        priority(artifact) ? [priority(artifact)] : [],
      groupValue: priority,
      valueLabel: displayPriority,
      renderCell: (artifact) => displayPriority(priority(artifact)),
    },
  ];
}

export function artifactMetricDefinitions(
  kind: typeof ArtifactKind.Document | typeof ArtifactKind.Issue
) {
  return kind === ArtifactKind.Issue
    ? ISSUES_PROTOTYPE_METRICS
    : DOCUMENTS_PROTOTYPE_METRICS;
}

function displayPriority(value: string): string {
  return isPriorityValue(value) ? priorityLabel(value) : value;
}

/** Maps production document sort keys to the shared artifact-list keys. */
export function prototypeSortColumn(column: string): string {
  if (column === "title") {
    return "name";
  }
  if (column === "assignee") {
    return "owner";
  }
  if (column === "type") {
    return "document-type";
  }
  return column;
}

/** Maps shared artifact-list sort keys back to production document keys. */
export function productionSortColumn(column: string): string {
  if (column === "name") {
    return "title";
  }
  if (column === "owner") {
    return "assignee";
  }
  if (column === "document-type") {
    return "type";
  }
  return column;
}
