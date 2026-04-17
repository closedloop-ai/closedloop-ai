"use client";

import type { Document, DocumentType } from "@repo/api/src/types/document";
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
import { useDocuments } from "@/hooks/queries/use-documents";

type SelectDocumentDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string | undefined;
  documentType: DocumentType;
  excludeIds?: Set<string>;
  title: string;
  description: string;
  searchPlaceholder: string;
  emptyText: string;
  icon: LucideIcon;
  onSelect: (artifact: Document) => void;
};

export function SelectDocumentDialog({
  open,
  onOpenChange,
  projectId,
  documentType,
  excludeIds,
  title,
  description,
  searchPlaceholder,
  emptyText,
  icon: Icon,
  onSelect,
}: Readonly<SelectDocumentDialogProps>) {
  const { data: artifacts = [], isLoading } = useDocuments(
    { type: documentType, projectId },
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
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
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
