"use client";

import type { ReactNode } from "react";
import type {
  ArtifactListHostRendering,
  ArtifactListShellController,
} from "../../shared/components/generic-artifact-surface/preview/components/artifact-list-shell-content";
import { ArtifactListToolbar } from "../../shared/components/generic-artifact-surface/preview/components/artifact-list-shell-sections";
import { useManualArtifactOrderingEnabled } from "../../shared/feature-flags/use-manual-artifact-ordering";

/** Mount the shared board while retaining the portable list's flag-off path. */
export function ProjectListLayout({
  board,
  controller,
  host,
  list,
}: Readonly<{
  board: ReactNode;
  controller: ArtifactListShellController;
  host: ArtifactListHostRendering;
  list: ReactNode;
}>) {
  const manualOrderingEnabled = useManualArtifactOrderingEnabled();
  if (!manualOrderingEnabled || controller.layout !== "board") {
    return list;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <ArtifactListToolbar controller={{ ...controller, host }} />
      {board}
    </div>
  );
}
