"use client";

import { DocumentsView } from "@repo/app/documents/components/table/documents-view";
import { ProjectArtifactBoardSurface } from "@repo/app/projects/components/project-artifact-board-surface";
import type { ComponentProps } from "react";

type ProjectArtifactsViewProps = {
  boardProps: ComponentProps<typeof ProjectArtifactBoardSurface>;
  documentsViewProps: ComponentProps<typeof DocumentsView>;
  layout: "board" | "list";
};

/** Keep the route shell thin while the flag chooses one shared consumer. */
export function ProjectArtifactsView({
  boardProps,
  documentsViewProps,
  layout,
}: Readonly<ProjectArtifactsViewProps>) {
  if (layout === "board") {
    return <ProjectArtifactBoardSurface {...boardProps} />;
  }
  return <DocumentsView {...documentsViewProps} />;
}
