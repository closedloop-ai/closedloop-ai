"use client";

import type { Document, DocumentType } from "@repo/api/src/types/document";
import { useDocuments } from "@repo/app/documents/hooks/use-documents";
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
  /**
   * When true, list documents of `documentType` org-wide (ignoring
   * `projectId`). Used for evergreen Documents (FEA-3951), which are long-term
   * org-level context and are not scoped to the FEAT/PRD's project.
   */
  orgWide?: boolean;
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
  orgWide = false,
}: Readonly<SelectDocumentDialogProps>) {
  const {
    data: artifacts = [],
    isLoading,
    isError,
  } = useDocuments(
    { type: documentType, projectId: orgWide ? undefined : projectId },
    { enabled: open && (orgWide || !!projectId) }
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
        <Command className="rounded-lg border" label="Search documents">
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>
              {resolveEmptyMessage({ isLoading, isError, emptyText })}
            </CommandEmpty>
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

// Distinguish a failed fetch from a genuinely empty list. `useDocuments` falls
// back to `[]` on error, so without this the picker would render `emptyText`
// ("No Documents found") on a network failure and lie about there being none.
function resolveEmptyMessage(input: {
  isLoading: boolean;
  isError: boolean;
  emptyText: string;
}): string {
  if (input.isLoading) {
    return "Loading...";
  }
  if (input.isError) {
    return "Couldn't load documents. Try again.";
  }
  return input.emptyText;
}
