"use client";

import type { Artifact, ArtifactType } from "@repo/api/src/types/artifact";
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
import type { LucideIcon } from "lucide-react";
import { useMemo } from "react";
import { useArtifacts } from "@/hooks/queries/use-artifacts";

type SelectArtifactDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string | undefined;
  artifactType: ArtifactType;
  excludeIds?: Set<string>;
  title: string;
  description: string;
  searchPlaceholder: string;
  emptyText: string;
  icon: LucideIcon;
  onSelect: (artifact: Artifact) => void;
};

export function SelectArtifactDialog({
  open,
  onOpenChange,
  projectId,
  artifactType,
  excludeIds,
  title,
  description,
  searchPlaceholder,
  emptyText,
  icon: Icon,
  onSelect,
}: Readonly<SelectArtifactDialogProps>) {
  const { data: artifacts = [], isLoading } = useArtifacts(
    { type: artifactType, projectId },
    { enabled: open && !!projectId }
  );

  const availableArtifacts = useMemo(() => {
    if (!excludeIds || excludeIds.size === 0) {
      return artifacts;
    }
    return artifacts.filter((a) => !excludeIds.has(a.id));
  }, [artifacts, excludeIds]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-[450px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">
            {description}
          </DialogDescription>
        </DialogHeader>
        <Command className="rounded-lg border">
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{isLoading ? "Loading..." : emptyText}</CommandEmpty>
            <CommandGroup>
              {availableArtifacts.map((artifact) => (
                <CommandItem
                  key={artifact.id}
                  onSelect={() => onSelect(artifact)}
                  value={artifact.title}
                >
                  <Icon className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{artifact.title}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
