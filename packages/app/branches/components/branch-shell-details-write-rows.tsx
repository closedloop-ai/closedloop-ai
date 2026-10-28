"use client";

import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import type { BranchPageDetail } from "@repo/api/src/types/branch";
import {
  ArtifactTagAvailability,
  TagEntityType,
} from "@repo/api/src/types/tag";
import { ARTIFACT_PROJECT_FIELD_LABEL } from "@repo/app/projects/lib/project-field-labels";
import {
  type DetailsField,
  DetailsFieldId,
} from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-design-model";
import { ArtifactPriorityVariant } from "@repo/app/shared/lib/artifact-priority-ownership";
import { selfSavingField } from "@repo/app/shared/lib/details-field-constructors";
import { PRIORITY_COLUMN_LABEL } from "@repo/app/shared/lib/priority-constants";
import { EntityTagsCell } from "@repo/app/tags/components/entity-tags-cell";
import type { QueryClient } from "@tanstack/react-query";
import { BranchPriorityValue } from "./branch-priority-cell";
import { BranchProjectValue } from "./branch-project-value";

/** Branch's half of ISS-10995's writes; see the Session module's note. */

/**
 * The id the PRIORITY write keys on. `artifactId` is optional on a
 * version-skewed read, and the row id is the artifact id when it is absent —
 * the resolution `BranchPriorityCell` already makes. The tags write does NOT
 * share it; see {@link branchTagsRow}.
 */
function branchArtifactId(detail: BranchPageDetail): string {
  return detail.artifactId ?? detail.id;
}

/**
 * Priority is editable, and a source that does not carry it — Desktop
 * single-user mode (`shared-branches-api.ts`) — draws no row rather than a dash
 * reading as "this branch has none" (operator ruling 2026-10-09). `undefined`
 * is that absence; `null` is a branch with no priority, which still draws.
 */
export function branchPriorityRow(
  detail: BranchPageDetail
): readonly DetailsField<DetailsFieldId>[] {
  const priority = detail.priority;
  if (priority === undefined) {
    return [];
  }
  return [
    selfSavingField(DetailsFieldId.Priority, PRIORITY_COLUMN_LABEL, {
      kind: "self-saving",
      empty: false,
      render: (editable) => (
        <BranchPriorityValue
          artifactId={branchArtifactId(detail)}
          priority={priority}
          readOnly={!editable}
          surface={ArtifactStatusEditSurface.Detail}
          variant={ArtifactPriorityVariant.DetailField}
        />
      ),
    }),
  ];
}

/**
 * Project is editable on Branches and on Sessions alike (operator ruling
 * 2026-10-12), and what a user files here survives: `upsertBranchArtifact`'s
 * update arm fills `projectId` only on a branch that has none, so no later push
 * re-parents it.
 *
 * `undefined` is Desktop single-user mode, which projects neither `projectId`
 * nor `projectName`, and draws no row (ruling 2026-10-09). `null` is a branch
 * filed into no project, which still draws — that row is where one is set.
 *
 * The write target is `artifactId` ALONE, never {@link branchArtifactId}'s
 * fallback, for the reason {@link branchTagsRow} states: `BranchPageDetail.id`
 * is `encodeBranchId(…)` on a producer that omits `artifactId`, and
 * `batch-move` takes an artifact UUID. {@link BranchProjectValue} withholds the
 * picker when it is absent.
 */
export function branchProjectRow(
  detail: BranchPageDetail
): readonly DetailsField<DetailsFieldId>[] {
  const projectId = detail.projectId;
  if (projectId === undefined) {
    return [];
  }
  return [
    selfSavingField(DetailsFieldId.Project, ARTIFACT_PROJECT_FIELD_LABEL, {
      kind: "self-saving",
      // Never empty: an unfiled branch is what the control exists to file, and
      // the empty-row rule would otherwise drop the row once a viewer is locked
      // out of it — the same reason an unset Owning project must not vanish
      // (`isDetailsFieldDrawn`, PR #8555 review).
      empty: false,
      render: (editable) => (
        <BranchProjectValue
          artifactId={detail.artifactId ?? null}
          projectId={projectId}
          projectName={detail.projectName ?? null}
          readOnly={!editable}
        />
      ),
    }),
  ];
}

/**
 * Availability and the array are read TOGETHER. The row this replaced mapped
 * `detail.tags ?? []`, so a relation the producer never loaded rendered as an
 * empty picker — "this branch has no tags", a read nobody made.
 *
 * The write target is `artifactId` ALONE, never {@link branchArtifactId}'s
 * fallback, which the grid cell (`approved-branches-grid-adapter.tsx`) refuses
 * for the same reason: `BranchPageDetail.id` is `encodeBranchId(…)` on a
 * producer that omits `artifactId`, and that composite is not an entity id
 * `POST /entity-tags` can write against. `null` withholds the picker and keeps
 * the chips, as it does in the grid. Priority keeps the fallback — its route
 * takes the row id the Branches grid already sends.
 *
 * `maxVisible` is the whole array for the reason the Session row states: the
 * default of 2 is a grid cap, and the row this replaced wrapped every tag.
 */
/**
 * `queryClient` is the Branch-owned client the caller resolved — desktop
 * injects one (`useBranchesQueryContext`), distinct from the ambient client
 * the tag mutations default to (ISS-12452). This is a plain helper, not a
 * component, so it cannot resolve the client itself; the caller does.
 */
export function branchTagsRow(
  detail: BranchPageDetail,
  queryClient?: QueryClient
): readonly DetailsField<DetailsFieldId>[] {
  const tags = detail.tags;
  if (
    tags === undefined ||
    detail.tagAvailability !== ArtifactTagAvailability.Available
  ) {
    return [];
  }
  return [
    selfSavingField(DetailsFieldId.Tags, "Tags", {
      kind: "self-saving",
      empty: tags.length === 0,
      fill: true,
      render: (editable) => (
        <EntityTagsCell
          canApply={editable && (detail.tagPermissions?.canApply ?? false)}
          canRemove={editable && (detail.tagPermissions?.canRemove ?? false)}
          editLabel={`Edit tags for ${detail.branchName}`}
          entityId={detail.artifactId ?? null}
          entityType={TagEntityType.Artifact}
          maxVisible={tags.length}
          queryClient={queryClient}
          surface={ArtifactStatusEditSurface.Detail}
          tags={tags}
        />
      ),
    }),
  ];
}
