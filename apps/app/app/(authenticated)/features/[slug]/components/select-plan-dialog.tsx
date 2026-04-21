"use client";

import { DocumentType } from "@repo/api/src/types/document";
import { EntityType, LinkType } from "@repo/api/src/types/entity-link";
import { FileCode2 } from "lucide-react";
import { useCreateEntityLink } from "@/hooks/queries/use-entity-links";
import { SelectDocumentDialog } from "./select-document-dialog";

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
    <SelectDocumentDialog
      description="Choose an implementation plan to link to this feature."
      documentType={DocumentType.ImplementationPlan}
      emptyText="No implementation plans found."
      icon={FileCode2}
      onOpenChange={onOpenChange}
      onSelect={(plan) => {
        createEntityLink.mutate(
          {
            sourceId: featureId,
            sourceType: EntityType.Document,
            targetId: plan.id,
            targetType: EntityType.Document,
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
