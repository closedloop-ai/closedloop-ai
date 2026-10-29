"use client";

import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import type { Priority } from "@repo/api/src/types/common";
import type { ArtifactPriorityEditSurface } from "@repo/api/src/types/priority-contract";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { ArtifactPriorityEditor } from "@repo/app/documents/components/artifact-priority/artifact-priority-editor";
import {
  ARTIFACT_PRIORITY_SUPPORT,
  ArtifactPrioritySurface,
  ArtifactPriorityVariant,
} from "@repo/app/shared/lib/artifact-priority-ownership";
// Cross-slice: the Tags cell in the same row owns the trigger box these two
// controls must match (packages/app AGENTS.md permits an explicit slice import).
import { INLINE_CELL_TRIGGER_CLASSES } from "@repo/app/tags/components/entity-tags-cell";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table";
import { QueryClientContext } from "@tanstack/react-query";
import { useContext } from "react";
import {
  AgentSessionCapability,
  agentSessionSourceSupports,
} from "../../data-source/agent-sessions-data-source";
import { useAgentSessionsDataSourceOptional } from "../../data-source/provider";
import { useUpdateSessionPriority } from "../../hooks/use-update-session-priority";

/**
 * ISS-10332 / PLN-2086 Milestone 2: the Sessions list's `Priority` cell — the
 * one champion control (`ArtifactPriorityEditor`) over this row's Session
 * artifact, mounted through the seam both Sessions hosts wire
 * (`renderSessionPriorityCell`) for the reason the Tags cell is a seam: it
 * WRITES, through the active data source, so the presentational table cannot
 * own it.
 *
 * The cell owns ONE decision: a row whose producer OMITTED `priority` (an older
 * API or Desktop build) renders the shared empty glyph and no control, because
 * that absence is "unknown to this peer", never "no priority", and a picker
 * over it would guard the write with a value nobody read. The grid answers it
 * with the glyph because a column cannot disappear; the Details tab answers it
 * by drawing no row. Everything after it is {@link SessionPriorityValue}.
 */
export function SessionPriorityCell({
  row,
}: Readonly<{ row: SessionTableRow }>) {
  if (row.priority === undefined) {
    return <GridEmptyValue />;
  }
  return (
    <SessionPriorityValue
      artifactId={row.id}
      priority={row.priority}
      surface={ArtifactStatusEditSurface.InlineCell}
      variant={ArtifactPriorityVariant.Label}
    />
  );
}

/**
 * The champion control over a priority the producer DID serve, shared by the
 * grid cell and the Details tab's row (ISS-10995) so this decision has one
 * implementation. The support declaration is read from
 * `ARTIFACT_PRIORITY_SUPPORT`, the single read site for whether the surface
 * carries priority and may clear it, so neither caller can grow a control the
 * contract does not grant.
 *
 * Two shapes: a mount the host marked read-only, or whose source cannot write
 * (no `updatePriority`, or no query client to settle the write in — a bare
 * table render, Storybook), renders the mark read-only without mounting a
 * mutation it could never commit; otherwise the editor, over the mutation.
 *
 * It must be a COMPONENT, not a hook the host calls, because that second shape
 * cannot be decided before {@link useUpdateSessionPriority} runs, and that hook
 * requires both a data source and a query client.
 */
export function SessionPriorityValue({
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
  const source = useAgentSessionsDataSourceOptional();
  const hasQueryClient = useContext(QueryClientContext) !== undefined;
  const canWrite =
    source !== null &&
    agentSessionSourceSupports(
      source,
      artifactId,
      AgentSessionCapability.UpdatePriority
    );
  if (readOnly || !(source?.updatePriority && canWrite && hasQueryClient)) {
    return <ReadOnlySessionPriority priority={priority} variant={variant} />;
  }
  return (
    <EditableSessionPriority
      artifactId={artifactId}
      priority={priority}
      surface={surface}
      variant={variant}
    />
  );
}

function ReadOnlySessionPriority({
  priority,
  variant,
}: Readonly<{ priority: Priority | null; variant: ArtifactPriorityVariant }>) {
  return (
    <ArtifactPriorityEditor
      priority={priority}
      readOnly
      support={ARTIFACT_PRIORITY_SUPPORT[ArtifactPrioritySurface.Session]}
      variant={variant}
    />
  );
}

function EditableSessionPriority({
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
  const mutation = useUpdateSessionPriority(surface);
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
      support={ARTIFACT_PRIORITY_SUPPORT[ArtifactPrioritySurface.Session]}
      variant={variant}
    />
  );
}

/**
 * The `renderPriority` seam value, so each host wires the same cell by name
 * instead of repeating the closure that builds it.
 */
export function renderSessionPriorityCell(row: SessionTableRow) {
  return <SessionPriorityCell row={row} />;
}
