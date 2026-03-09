"use client";

import { ArtifactType } from "@repo/api/src/types/artifact";
import { EntityType, LinkType } from "@repo/api/src/types/entity-link";
import { FileTextIcon } from "lucide-react";
import { useCreateEntityLink } from "@/hooks/queries/use-entity-links";
import { SelectArtifactDialog } from "./select-artifact-dialog";

type SelectContextDialogProps = {
  issueId: string;
  projectId: string | undefined;
  excludeArtifactIds: Set<string>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function SelectContextDialog({
  issueId,
  projectId,
  excludeArtifactIds,
  open,
  onOpenChange,
}: Readonly<SelectContextDialogProps>) {
  const createEntityLink = useCreateEntityLink();

  return (
    <SelectArtifactDialog
      artifactType={ArtifactType.Prd}
      description="Choose a PRD to link as context for this feature."
      emptyText="No PRDs found."
      excludeIds={excludeArtifactIds}
      icon={FileTextIcon}
      onOpenChange={onOpenChange}
      onSelect={(prd) => {
        createEntityLink.mutate(
          {
            sourceId: prd.id,
            sourceType: EntityType.Artifact,
            targetId: issueId,
            targetType: EntityType.Issue,
            linkType: LinkType.RelatesTo,
          },
          { onSuccess: () => onOpenChange(false) }
        );
      }}
      open={open}
      projectId={projectId}
      searchPlaceholder="Search PRDs..."
      title="Add Context"
    />
  );
}
