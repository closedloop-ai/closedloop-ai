"use client";

import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { useBatchMoveArtifacts } from "@repo/app/documents/hooks/use-batch-move-artifacts";
import { useApiAdapterOptional } from "@repo/app/shared/api/provider";
import { CellText } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-design-cells";
// Cross-slice: the Tags cell in the same row owns the trigger box this control
// must match (packages/app AGENTS.md permits an explicit slice import).
import { INLINE_CELL_TRIGGER_CLASSES } from "@repo/app/tags/components/entity-tags-cell";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table-card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";
import { type QueryClient, QueryClientContext } from "@tanstack/react-query";
import { useContext, useMemo, useState } from "react";
import { useProjects } from "../hooks/use-projects";
import { ARTIFACT_PROJECT_FIELD_LABEL } from "../lib/project-field-labels";
import {
  type ProjectOption,
  ProjectSelectPopover,
} from "./project-select-popover";

/**
 * Where this control is mounted, which decides its box rather than its
 * behaviour — one field, one writer, three shapes (ISS-12454).
 *
 * `Details` is the original row and the default, so the two Details hosts keep
 * exactly what they shipped. The other two are grid tracks, where the Details
 * box is wrong in three ways at once: `INLINE_CELL_TRIGGER_CLASSES` carries
 * `shrink-0` and the Details bundle adds `w-auto`, so the trigger sizes to its
 * text and refuses to shrink — a long project name then paints out of its grid
 * area over the next column instead of ellipsising, because nothing between the
 * cell and the span constrains a width.
 */
export const ArtifactProjectPresentation = {
  Details: "details",
  /** A grid row's cell. */
  Cell: "cell",
  /** The card the list falls back to below its breakpoint, where touch is the input. */
  Card: "card",
} as const;
export type ArtifactProjectPresentation =
  (typeof ArtifactProjectPresentation)[keyof typeof ArtifactProjectPresentation];

/**
 * The trigger box per presentation. `Cell` and `Card` replace `w-auto` with
 * `min-w-0 max-w-full shrink`, which is what lets the picker's own `truncate`
 * span do its job; `Card` additionally keeps the Button's own height, because
 * `h-auto` collapses it to roughly a 20px line box and that is not a thumb
 * target on the surface where cards ARE the list.
 */
const TRIGGER_BOX: Readonly<Record<ArtifactProjectPresentation, string>> = {
  [ArtifactProjectPresentation.Details]: "h-auto w-auto px-1",
  [ArtifactProjectPresentation.Cell]: "h-auto min-w-0 max-w-full shrink px-1",
  [ArtifactProjectPresentation.Card]: "min-w-0 max-w-full shrink px-1",
};

/**
 * ISS-10995: the Details tab's Project row, for every artifact type that offers
 * one — Branches and Sessions both (operator ruling 2026-10-12). A picker
 * writing an id through the canonical mover `POST /artifact-links/batch-move`,
 * which is type-agnostic, so one field has one writer.
 *
 * Two shapes, as the priority twin has: a mount the host marked read-only, one
 * with no artifact id to write against, or one with no API port or query client
 * (Storybook, the mini-table suites) renders the name alone rather than a
 * picker it could never commit; otherwise the picker over the mutation. Only a
 * component can make that call, which is why this is not a host-level hook —
 * see `BranchPriorityValue`'s note in `branch-priority-cell.tsx`.
 */
export function ArtifactProjectValue({
  artifactId,
  extraQueryClients,
  presentation = ArtifactProjectPresentation.Details,
  projectId,
  projectName,
  readOnly = false,
  surface,
}: Readonly<{
  artifactId: string | null;
  /**
   * Clients the committed move must refresh besides the parent one, for a
   * surface whose rows a data source reads from its own
   * ({@link BranchProjectValue}). `useBatchMoveArtifacts` holds the refresh, so
   * it survives this row unmounting mid-flight; a callback here would not.
   */
  extraQueryClients?: readonly QueryClient[];
  /** Which box the trigger wears; see {@link ArtifactProjectPresentation}. */
  presentation?: ArtifactProjectPresentation;
  projectId: string | null;
  projectName: string | null;
  readOnly?: boolean;
  /** Explicit mutation provenance when presentation and edit surface differ. */
  surface?: ArtifactStatusEditSurface;
}>) {
  const hasApiPort = useApiAdapterOptional() !== null;
  const hasQueryClient = useContext(QueryClientContext) !== undefined;
  if (readOnly || artifactId === null || !(hasApiPort && hasQueryClient)) {
    return <ReadOnlyArtifactProject projectName={projectName} />;
  }
  return (
    <EditableArtifactProject
      artifactId={artifactId}
      extraQueryClients={extraQueryClients}
      presentation={presentation}
      projectId={projectId}
      projectName={projectName}
      surface={surface}
    />
  );
}

function ReadOnlyArtifactProject({
  projectName,
}: Readonly<{ projectName: string | null }>) {
  const name = projectName?.trim();
  return <CellText>{name ? name : <GridEmptyValue />}</CellText>;
}

function EditableArtifactProject({
  artifactId,
  extraQueryClients,
  presentation,
  projectId,
  projectName,
  surface,
}: Readonly<{
  artifactId: string;
  extraQueryClients?: readonly QueryClient[];
  presentation: ArtifactProjectPresentation;
  projectId: string | null;
  projectName: string | null;
  surface?: ArtifactStatusEditSurface;
}>) {
  const inGrid = presentation !== ArtifactProjectPresentation.Details;
  const [listAsked, setListAsked] = useState(false);
  const projects = useProjects(undefined, { enabled: listAsked });
  const move = useBatchMoveArtifacts(extraQueryClients);

  const options = useMemo<ProjectOption[]>(
    () =>
      (projects.data ?? []).map((project) => ({
        id: project.id,
        name: project.name,
        slug: project.slug,
      })),
    [projects.data]
  );

  const selected = resolveSelectedProject(options, projectId, projectName);

  const picker = (
    <ProjectSelectPopover
      // Clearing is accepted by `batch-move` since ISS-12858
      // (`targetProjectId: null`); offering it on this row is ISS-12859's
      // Details work and not yet decided for Sessions and Branches.
      allowClear={false}
      ariaLabel={ARTIFACT_PROJECT_FIELD_LABEL}
      className={cn(INLINE_CELL_TRIGGER_CLASSES, TRIGGER_BOX[presentation])}
      disabled={move.isPending}
      // A grid cell states the fact and is still a control: the dash, inside
      // the button, exactly as the Tags and Priority cells beside it do.
      emptyMark={inGrid ? <GridEmptyValue /> : undefined}
      isError={projects.isError}
      isLoading={projects.isLoading}
      leadingIcon={!inGrid}
      onOpenChange={(open) => {
        if (open) {
          setListAsked(true);
        }
      }}
      onSelect={(project) => {
        if (!project || project.id === projectId) {
          return;
        }
        move.mutate({
          artifactId,
          targetProjectId: project.id,
          // This row files THIS artifact. The downstream walk would carry
          // every session and document linked beneath it into the project
          // too, which nobody asked for from a one-field row.
          includeDownstream: false,
          // The optimistic guard the sibling rows send (`expectedPriority`,
          // `expectedName`): the project this row RENDERED, so a write made
          // against a stale read is refused server-side rather than winning.
          // The `project.id === projectId` check above cannot stand in for it
          // — it compares against the same cache, and desktop's Branch policy
          // has `refetchOnWindowFocus` off (Cosimo Corrigan, 2026-10-12).
          expectedProjectId: projectId,
          surface:
            surface ??
            (presentation === ArtifactProjectPresentation.Details
              ? ArtifactStatusEditSurface.Detail
              : ArtifactStatusEditSurface.InlineCell),
        });
      }}
      projects={options}
      value={selected}
      variant="ghost"
    />
  );
  if (!(inGrid && selected)) {
    return picker;
  }
  // The disclosure the retired chip carried, restored rather than dropped: the
  // track truncates a long name, and `aria-label` covers only the reader who is
  // not looking at it. The Repository cell one track away discloses the same way.
  // Wrapped rather than applied to the trigger, because the trigger is already
  // a Radix `asChild` popover trigger.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex min-w-0 max-w-full">{picker}</span>
      </TooltipTrigger>
      <TooltipContent>{selected.name}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The id is the last resort rather than `null`, which the picker would paint as
 * its "nothing chosen" placeholder — an artifact that HAS a project reading as
 * one that has none. The cloud reads join id and name off one row
 * (`canonical-projection.ts` for branches), so reaching that fallback needs the
 * list unloaded too.
 */
function resolveSelectedProject(
  options: readonly ProjectOption[],
  projectId: string | null,
  projectName: string | null
): ProjectOption | null {
  if (!projectId) {
    return null;
  }
  const loaded = options.find((option) => option.id === projectId);
  if (loaded) {
    return loaded;
  }
  return { id: projectId, name: projectName?.trim() || projectId, slug: null };
}
