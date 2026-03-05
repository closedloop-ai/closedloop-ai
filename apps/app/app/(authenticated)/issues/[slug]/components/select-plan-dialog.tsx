"use client";

import { ArtifactType } from "@repo/api/src/types/artifact";
import { EntityType, LinkType } from "@repo/api/src/types/entity-link";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@repo/design-system/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { FileCode2 } from "lucide-react";
import { useArtifacts } from "@/hooks/queries/use-artifacts";
import { useCreateEntityLink } from "@/hooks/queries/use-entity-links";

type SelectPlanDialogProps = {
  issueId: string;
  projectId: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function SelectPlanDialog({
  issueId,
  projectId,
  open,
  onOpenChange,
}: SelectPlanDialogProps) {
  const { data: plans = [], isLoading } = useArtifacts(
    { type: ArtifactType.ImplementationPlan, projectId },
    { enabled: open && !!projectId }
  );

  const createEntityLink = useCreateEntityLink();

  const handleSelect = (planId: string) => {
    createEntityLink.mutate(
      {
        sourceId: issueId,
        sourceType: EntityType.Issue,
        targetId: planId,
        targetType: EntityType.Artifact,
        linkType: LinkType.Produces,
      },
      { onSuccess: () => onOpenChange(false) }
    );
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-[450px]">
        <DialogHeader>
          <DialogTitle>Select Existing Plan</DialogTitle>
          <DialogDescription className="sr-only">
            Choose an implementation plan to link to this feature.
          </DialogDescription>
        </DialogHeader>
        <Command className="rounded-lg border">
          <CommandInput placeholder="Search plans..." />
          <CommandList>
            <CommandEmpty>
              {isLoading
                ? "Loading plans..."
                : "No implementation plans found."}
            </CommandEmpty>
            <CommandGroup>
              {plans.map((plan) => (
                <CommandItem
                  key={plan.id}
                  onSelect={() => handleSelect(plan.id)}
                  value={plan.title}
                >
                  <FileCode2 className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{plan.title}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
