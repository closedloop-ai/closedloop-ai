"use client";

import { GridInteractionContract } from "@repo/design-system/components/ui/grid-interaction-contract";
import type { GenericArtifactListShellProps } from "./artifact-list-model";
import { GenericArtifactListShell } from "./artifact-shells";

export type GridInteractionArtifactListSurfaceProps =
  GenericArtifactListShellProps;

/** Applies the canonical pointer and hover contract to the shared artifact list. */
export function GridInteractionArtifactListSurface(
  props: GridInteractionArtifactListSurfaceProps
) {
  return (
    <GridInteractionContract>
      <GenericArtifactListShell {...props} />
    </GridInteractionContract>
  );
}
