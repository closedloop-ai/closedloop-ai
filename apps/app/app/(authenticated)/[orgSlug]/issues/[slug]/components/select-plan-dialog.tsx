"use client";

import { LinkType } from "@repo/api/src/types/artifact";
import { DocumentType } from "@repo/api/src/types/document";
import { useCreateArtifactLink } from "@repo/app/documents/hooks/use-artifact-links";
import { FileCode2 } from "lucide-react";
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
  const createArtifactLink = useCreateArtifactLink();

  return (
    <SelectDocumentDialog
      description="Choose an implementation plan to link to this feature."
      documentType={DocumentType.ImplementationPlan}
      emptyText="No implementation plans found."
      icon={FileCode2}
      onOpenChange={onOpenChange}
      onSelect={(plan) => {
        createArtifactLink.mutate(
          {
            sourceId: featureId,
            targetId: plan.id,
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
