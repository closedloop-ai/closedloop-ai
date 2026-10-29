"use client";

import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import type {
  DetailedArtifact,
  ProjectTreeDetailsResponse,
} from "@repo/api/src/types/project-tree";
import { DropdownMenuItem } from "@repo/design-system/components/ui/dropdown-menu";
import { ArtifactListStatusMenu } from "../../artifacts/components/artifact-list-cells";
import type { RowEditHandlers } from "../../documents/components/table/row-edit-context";
import { documentRowFromArtifact } from "../../documents/lib/artifact-row-adapter";
import { resolveProjectArtifactsTruncationNote } from "../lib/project-artifacts-pagination";

/** Bounded pagination notice for a truncated project artifact read. */
export function ProjectArtifactListTruncationNotice({
  tree,
}: {
  tree: ProjectTreeDetailsResponse | undefined;
}) {
  return (
    <p className="px-4 py-2 text-muted-foreground text-xs" role="status">
      {resolveProjectArtifactsTruncationNote(tree, "top-level artifacts")}
    </p>
  );
}

/** Board status menu for a project artifact, with the existing source-managed fallback. */
export function ProjectArtifactBoardStatusMenu({
  artifact,
  editHandlers,
}: {
  artifact: DetailedArtifact | undefined;
  editHandlers: RowEditHandlers;
}) {
  const document = artifact && documentRowFromArtifact(artifact, null);
  return document ? (
    <ArtifactListStatusMenu
      document={document}
      editHandlers={editHandlers}
      surface={ArtifactStatusEditSurface.Board}
    />
  ) : (
    <DropdownMenuItem disabled>Status is source-managed</DropdownMenuItem>
  );
}
