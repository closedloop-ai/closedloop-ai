"use client";

import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import type { Priority } from "@repo/api/src/types/common";
import type { ArtifactPriorityEditSurface } from "@repo/api/src/types/priority-contract";
import { ArtifactPriorityEditor } from "@repo/app/documents/components/artifact-priority/artifact-priority-editor";
import {
  ARTIFACT_PRIORITY_SUPPORT,
  ArtifactPrioritySurface,
  ArtifactPriorityVariant,
} from "@repo/app/shared/lib/artifact-priority-ownership";
// Cross-slice: the Tags cell in the same row owns the trigger box these two
// controls must match (packages/app AGENTS.md permits an explicit slice import).
import { INLINE_CELL_TRIGGER_CLASSES } from "@repo/app/tags/components/entity-tags-cell";
import { QueryClientContext } from "@tanstack/react-query";
import { useContext } from "react";
import { useBranchesDataSourceOptional } from "../data-source/provider";
import { useUpdateBranchPriority } from "../hooks/use-update-branch-priority";
import type { BranchRow } from "../lib/branch-row";
import { BranchUnavailableValue } from "./branch-unavailable-value";

/**
 * ISS-10332 / PLN-2086 Milestone 2: the Branches list's `Priority` cell — the
 * one champion control (`ArtifactPriorityEditor`) over this row's Branch
 * artifact, writing through the active data source (`useUpdateBranchPriority`).
 *
 * The cell owns ONE decision: a row whose producer OMITTED `priority` (an older
 * API or Desktop build) renders the sibling cells' `BranchUnavailableValue` and
 * no control, because that absence is "unknown to this peer", never "no
 * priority". The grid answers it with that value because a column cannot
 * disappear; the Details tab answers it by drawing no row. Everything after it
 * is {@link BranchPriorityValue}.
 */
export function BranchPriorityCell({
  item,
  readOnly,
}: Readonly<{ item: BranchRow; readOnly: boolean }>) {
  if (item.priority === undefined) {
    return <BranchUnavailableValue />;
  }
  return (
    <BranchPriorityValue
      artifactId={item.artifactId ?? item.id}
      priority={item.priority}
      readOnly={readOnly}
      surface={ArtifactStatusEditSurface.InlineCell}
      variant={ArtifactPriorityVariant.Label}
    />
  );
}

/**
 * The champion control over a priority the producer DID serve, shared by the
 * grid cell and the Details tab's row (ISS-10995). The support declaration is
 * read from `ARTIFACT_PRIORITY_SUPPORT`, the single read site for whether the
 * surface carries priority and may clear it.
 *
 * Two shapes: a mount the host marked read-only (an offline desktop, like the
 * tag picker), or whose source cannot write (no `updatePriority`, or no query
 * client to settle the write in), renders the mark read-only without mounting a
 * mutation it could never commit; otherwise the editor, over the mutation,
 * keyed on the cloud artifact id. See the Session twin
 * (`SessionPriorityValue`) for why this is a component, not a hook.
 */
export function BranchPriorityValue({
  artifactId,
  priority,
  readOnly = false,
  surface,
  variant,
}: Readonly<{
  artifactId: string;
  priority: Priority | null;
  readOnly?: boolean;
  surface: ArtifactPriorityEditSurface;
  variant: ArtifactPriorityVariant;
}>) {
  const source = useBranchesDataSourceOptional();
  const hasQueryClient = useContext(QueryClientContext) !== undefined;
  if (readOnly || !(source?.updatePriority && hasQueryClient)) {
    return <ReadOnlyBranchPriority priority={priority} variant={variant} />;
  }
  return (
    <EditableBranchPriority
      artifactId={artifactId}
      priority={priority}
      surface={surface}
      variant={variant}
    />
  );
}

function ReadOnlyBranchPriority({
  priority,
  variant,
}: Readonly<{ priority: Priority | null; variant: ArtifactPriorityVariant }>) {
  return (
    <ArtifactPriorityEditor
      priority={priority}
      readOnly
      support={ARTIFACT_PRIORITY_SUPPORT[ArtifactPrioritySurface.Branch]}
      variant={variant}
    />
  );
}

function EditableBranchPriority({
  artifactId,
  priority,
  surface,
  variant,
}: Readonly<{
  artifactId: string;
  priority: Priority | null;
  surface: ArtifactPriorityEditSurface;
  variant: ArtifactPriorityVariant;
}>) {
  const mutation = useUpdateBranchPriority(surface);
  return (
    <ArtifactPriorityEditor
      className={INLINE_CELL_TRIGGER_CLASSES}
      mutationActivity={
        mutation.isPending && mutation.variables?.artifactId === artifactId
      }
      onSelect={(next) =>
        mutation.mutate({
          artifactId,
          priority: next,
          expectedPriority: priority,
        })
      }
      priority={priority}
      support={ARTIFACT_PRIORITY_SUPPORT[ArtifactPrioritySurface.Branch]}
      variant={variant}
    />
  );
}
