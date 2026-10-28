"use client";

import { branchSlug } from "@repo/app/branches/components/prototype-preview/generic-adapter"; // Cross-slice: preview shell hosts the Branches preview (ISS-12938).
import { branchRows } from "@repo/app/branches/components/prototype-preview/mock"; // Cross-slice: preview shell hosts the Branches preview (ISS-12938).
import { ResponsiveReferenceList } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-custom-cells";
import { columnWidthBounds } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-model";
import type { ReferenceOption } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-related-sessions";
import type { ArtifactListColumnExtension } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-shells";
import {
  ArtifactStatus,
  type GenericArtifact,
} from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";
import { Chip } from "@repo/design-system/components/ui/chip";
import {
  ColumnAlignment,
  ColumnFieldKind,
} from "@repo/design-system/lib/column-registry";
import { cn } from "@repo/design-system/lib/utils";
import { AutonomyCell } from "../../../../../agents/components/sessions/web-master-legacy-preview/components/session-cells"; // Cross-slice: preview shell hosts the Sessions preview (ISS-12938).
import {
  AUTONOMY_TIER_CONFIG,
  autonomyTier,
  formatDuration,
  HARNESS_CONFIG,
  type SessionRow,
  sessionRows,
} from "../../../../../agents/components/sessions/web-master-legacy-preview/mock"; // Cross-slice: preview shell hosts the Sessions preview (ISS-12938).
import { ArtifactTypeIcons } from "../shared/artifact-icons";
import {
  sessionCostValues,
  stableIndex,
} from "./specialized-artifact-fixtures";
import type { SpecializedArtifactKind } from "./specialized-artifact-kinds";

export function columnsForKind(
  kind: SpecializedArtifactKind
): ArtifactListColumnExtension[] {
  if (kind === "sessions") {
    const sessionsById = new Map(sessionRows.map((row) => [row.id, row]));
    return [
      textColumn(
        "harness",
        "Harness",
        110,
        (artifact) =>
          HARNESS_CONFIG[
            sessionsById.get(artifact.id)?.harness ?? sessionRows[0]!.harness
          ].label,
        ColumnFieldKind.Choice
      ),
      textColumn(
        "model",
        "Model",
        150,
        (artifact) => sessionsById.get(artifact.id)?.model ?? "—",
        ColumnFieldKind.Choice
      ),
      autonomyColumn(sessionsById),
      relatedBranchesColumn(sessionsById),
      textColumn(
        "duration",
        "Duration",
        110,
        (artifact) =>
          formatDuration(sessionsById.get(artifact.id)?.durationMs ?? 0),
        // marisolashgrove review: this was declared `Custom` so the registry would
        // not refuse `groupable` on it. That routed around the guard instead of
        // answering it — a formatted span is near-unique per row, so grouping
        // by it gives one band per row, the exact broken table the policy
        // refuses `Text` and `Number` to prevent. The kind is now the honest
        // one and the column simply does not group.
        ColumnFieldKind.Text,
        false,
        { groupable: false }
      ),
      moneyColumn(
        "api-cost",
        "API cost",
        104,
        (artifact) => sessionCostValues(sessionsById.get(artifact.id)).api
      ),
      moneyColumn(
        "estimated-subscription-cost",
        "Estimated subscription cost",
        178,
        (artifact) =>
          sessionCostValues(sessionsById.get(artifact.id)).subscription
      ),
      moneyColumn(
        "total-estimated-cost",
        "Est. Total",
        150,
        (artifact) => sessionCostValues(sessionsById.get(artifact.id)).total,
        "Known API costs plus estimated subscription costs."
      ),
    ];
  }
  if (kind === "documents") {
    return [
      textColumn(
        "document-type",
        "Document type",
        140,
        (artifact) =>
          createdString(artifact, "document-type") ??
          (artifact.slug === "DOC-184" ? "PRD" : "Product brief"),
        ColumnFieldKind.Choice
      ),
      textColumn(
        "approval",
        "Approval",
        120,
        (artifact) =>
          createdString(artifact, "approval") ??
          (artifact.status === ArtifactStatus.Approved
            ? "Approved"
            : "Complete"),
        ColumnFieldKind.Choice
      ),
    ];
  }
  if (kind === "issues" || kind === "issues-v2") {
    return [
      textColumn(
        "priority",
        "Priority",
        100,
        (artifact) =>
          createdString(artifact, "priority") ??
          (artifact.slug === "FEA-2481" ? "P0" : "P1"),
        ColumnFieldKind.Choice
      ),
      textColumn(
        "sprint",
        "Sprint",
        130,
        (artifact) => createdString(artifact, "sprint") ?? "August strategic",
        ColumnFieldKind.Choice
      ),
      textColumn(
        "estimate",
        "Estimate",
        100,
        (artifact) => createdString(artifact, "estimate") ?? "8 points",
        ColumnFieldKind.Choice
      ),
      textColumn(
        "dependencies",
        "Dependencies",
        116,
        (artifact) => String(artifact.relationshipCount),
        // A count the host renders as text and groups by — `Number` refuses
        // groupable and `Text` cannot group either.
        ColumnFieldKind.Custom
      ),
    ];
  }
  if (kind === "agents") {
    return [
      textColumn(
        "harness",
        "Harness",
        110,
        (_, index) => (index % 2 ? "Codex" : "Claude"),
        ColumnFieldKind.Choice
      ),
      textColumn(
        "model",
        "Model",
        150,
        (_, index) => (index % 2 ? "gpt-5.5" : "claude-opus-4-8"),
        ColumnFieldKind.Choice
      ),
    ];
  }
  return [
    textColumn(
      "branch",
      "Branch",
      210,
      (_, index) => `prototype/concept-${index + 1}`,
      ColumnFieldKind.Reference
    ),
    textColumn(
      "preview",
      "Preview",
      110,
      () => "Available",
      ColumnFieldKind.Choice,
      true
    ),
  ];
}

function createdString(
  artifact: GenericArtifact,
  fieldId: string
): string | undefined {
  const value = artifact.creationValues?.[fieldId];
  return typeof value === "string" && value ? value : undefined;
}

function autonomyColumn(
  sessionsById: ReadonlyMap<string, SessionRow>
): ArtifactListColumnExtension {
  const labelFor = (artifact: GenericArtifact) => {
    const score = sessionsById.get(artifact.id)?.autonomy;
    return score == null
      ? "Unavailable"
      : AUTONOMY_TIER_CONFIG[autonomyTier(score)].label;
  };
  return {
    filterValues: (artifact) => [labelFor(artifact)],
    filterable: true,
    groupValue: labelFor,
    groupable: true,
    id: "autonomy",
    kind: ColumnFieldKind.Choice,
    label: "Autonomy",
    renderCell: (artifact) => (
      <AutonomyCell
        autonomy={sessionsById.get(artifact.id)?.autonomy ?? null}
      />
    ),
    sortable: true,
    sortValue: (artifact) => sessionsById.get(artifact.id)?.autonomy ?? -1,
    width: columnWidthBounds(116),
  };
}

function relatedBranchesColumn(
  sessionsById: ReadonlyMap<string, SessionRow>
): ArtifactListColumnExtension {
  const referencesFor = (artifact: GenericArtifact) =>
    sessionBranchReferences(sessionsById.get(artifact.id));
  return {
    filterValues: (artifact) =>
      referencesFor(artifact).map((reference) => reference.title),
    filterable: true,
    groupValue: (artifact) => referencesFor(artifact)[0]?.title ?? "None",
    groupable: true,
    id: "related-branches",
    kind: ColumnFieldKind.Reference,
    label: "Related branches",
    renderCell: (artifact) => {
      const references = referencesFor(artifact);
      return references.length > 0 ? (
        <ResponsiveReferenceList
          hrefForValue={(value) => {
            const branch = branchRows.find(
              (candidate) => candidate.id === value
            );
            return branch
              ? `/p/web-master/branches/${branch.id}?tab=artifact`
              : undefined;
          }}
          options={references}
          values={references.map((reference) => reference.id)}
        />
      ) : (
        <span className="text-muted-foreground">—</span>
      );
    },
    sortable: true,
    sortValue: (artifact) =>
      referencesFor(artifact)
        .map((reference) => reference.title)
        .join(" "),
    width: columnWidthBounds(260),
  };
}

function sessionBranchReferences(
  row: SessionRow | undefined
): ReferenceOption[] {
  if (!row) {
    return [];
  }
  const primaryByPullRequest = branchRows.find(
    (branch) => row.prNumber != null && branch.prNumber === row.prNumber
  );
  const branchNames = [
    row.branch ?? primaryByPullRequest?.branchName,
    ...(row.extraBranches ?? []),
  ].filter((branch): branch is string => Boolean(branch));
  return [...new Set(branchNames)].map((branchName, index) => {
    const branch =
      branchRows.find((candidate) => candidate.branchName === branchName) ??
      (index === 0 ? primaryByPullRequest : undefined);
    return {
      icon: ArtifactTypeIcons.Branch,
      id: branch?.id ?? `${row.id}-branch-${index + 1}`,
      slug: branch ? branchSlug(branch) : branchName,
      title: branchName,
    };
  });
}

function moneyColumn(
  id: string,
  label: string,
  width: number,
  value: (artifact: GenericArtifact) => number,
  tooltip?: string
): ArtifactListColumnExtension {
  return {
    // `Number`'s kind default would right-align headers the preserved baseline
    // renders start-aligned; re-aligning currency belongs to the design owner.
    align: ColumnAlignment.Start,
    filterRange: value,
    filterable: true,
    groupable: false,
    id,
    kind: ColumnFieldKind.Number,
    label,
    renderCell: (artifact) => (
      <span className="truncate font-mono text-sm tabular-nums">
        ${value(artifact).toFixed(2)}
      </span>
    ),
    sortable: true,
    sortValue: value,
    tooltip,
    width: columnWidthBounds(width),
  };
}

/**
 * `groupable` is an option rather than a constant because the registry refuses
 * the capability to kinds whose values are effectively unique per row —
 * grouping those yields one band per row, which is the broken table
 * `COLUMN_KIND_POLICY` exists to prevent. A column that should not group says
 * so here instead of being re-declared `Custom` to get past the guard.
 */
function textColumn(
  id: string,
  label: string,
  width: number,
  value: (artifact: GenericArtifact, index: number) => string,
  kind: ColumnFieldKind,
  chip = false,
  { groupable = true }: { groupable?: boolean } = {}
): ArtifactListColumnExtension {
  return {
    filterValues: (artifact) => [value(artifact, stableIndex(artifact))],
    filterable: true,
    ...(groupable
      ? {
          groupValue: (artifact: GenericArtifact) =>
            value(artifact, stableIndex(artifact)),
        }
      : {}),
    groupable,
    id,
    kind,
    label,
    renderCell: (artifact) => {
      const rendered = value(artifact, stableIndex(artifact));
      return chip ? (
        <Chip variant="info">{rendered}</Chip>
      ) : (
        <span className={cn("truncate text-sm")}>{rendered}</span>
      );
    },
    sortable: true,
    sortValue: (artifact) => value(artifact, stableIndex(artifact)),
    width: columnWidthBounds(width),
  };
}
