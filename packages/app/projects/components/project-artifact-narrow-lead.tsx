"use client";

import type { DetailedArtifact } from "@repo/api/src/types/project-tree";
import type { ReactNode } from "react";
import type { RowEditHandlers } from "../../documents/components/table/row-edit-context";
import { ArtifactStatusVariant } from "../../shared/lib/artifact-status-view-contract";
import { ProjectArtifactCell } from "./project-artifact-cells";

/** Keeps the status glyph intrinsic while the narrow project title wraps. */
export function ProjectArtifactNarrowLead({
  artifact,
  editHandlers,
  children,
}: {
  artifact: DetailedArtifact;
  editHandlers: RowEditHandlers;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <ProjectArtifactCell
        artifact={artifact}
        columnId="status"
        editHandlers={editHandlers}
        peopleLoading={false}
        relatedLoading={false}
        statusVariant={ArtifactStatusVariant.Icon}
      />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
