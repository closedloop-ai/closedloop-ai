"use client";

import type { GenericArtifactListShellProps } from "./artifact-list-model";
import {
  type ArtifactListHostRendering,
  ArtifactListShellContent,
  type ArtifactListShellController,
} from "./artifact-list-shell-content";
import { useGenericArtifactListController } from "./artifact-list-shell-controller";
import { GenericArtifactDetailShell as RedesignedGenericArtifactDetailShell } from "./generic-artifact-detail-shell";

export type {
  ArtifactListColumnExtension,
  ArtifactListSummaryMetric,
} from "./artifact-list-model";
export type {
  ArtifactCanvasState,
  ArtifactShellAction,
  ArtifactShellPresentation,
  DetailTab,
  GenericArtifactDetailShellProps,
} from "./generic-artifact-detail-shell";

export const GenericArtifactDetailShell = RedesignedGenericArtifactDetailShell;

export function GenericArtifactListShell(props: GenericArtifactListShellProps) {
  return (
    <ArtifactListShellContent {...useGenericArtifactListController(props)} />
  );
}

/** Production hosts supply data/action adapters instead of sandbox mutations. */
export function GenericArtifactListView({
  controller,
  host,
}: {
  controller: ArtifactListShellController;
  host: ArtifactListHostRendering;
}) {
  return <ArtifactListShellContent {...controller} host={host} />;
}
