"use client";

import { ArtifactType } from "@repo/api/src/types/artifact";
import { EntityType, LinkType } from "@repo/api/src/types/entity-link";
import { FileCode2 } from "lucide-react";
import { useCreateEntityLink } from "@/hooks/queries/use-entity-links";
import { SelectArtifactDialog } from "./select-artifact-dialog";

type SelectPlanDialogProps = {
  featureId: string;
  projectId: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function SelectPlanDialog({
  featureId,
  projectId,
  open,
  onOpenChange,
}: Readonly<SelectPlanDialogProps>) {
  const createEntityLink = useCreateEntityLink();

  return (
    <SelectArtifactDialog
      artifactType={ArtifactType.ImplementationPlan}
      description="Choose an implementation plan to link to this feature."
      emptyText="No implementation plans found."
      icon={FileCode2}
      onOpenChange={onOpenChange}
      onSelect={(plan) => {
        createEntityLink.mutate(
          {
            sourceId: featureId,
            sourceType: EntityType.Feature,
            targetId: plan.id,
            targetType: EntityType.Artifact,
            linkType: LinkType.Produces,
          },
          { onSuccess: () => onOpenChange(false) }
        );
      }}
      open={open}
      projectId={projectId}
      searchPlaceholder="Search plans..."
      title="Select Existing Plan"
    />
  );
}
