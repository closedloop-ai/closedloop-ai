"use client";

import {
  type ArtifactLinkWithEndpoints,
  ArtifactSubtype,
  ArtifactType,
  LinkDirection,
  LinkType,
} from "@repo/api/src/types/artifact";
import { type Document, DocumentType } from "@repo/api/src/types/document";
import { ArtifactRow } from "@repo/app/documents/components/relationships/artifact-row";
import {
  useCreateArtifactLink,
  useDeleteArtifactLink,
  useResolvedArtifactLinks,
} from "@repo/app/documents/hooks/use-artifact-links";
import { useDocumentsByProject } from "@repo/app/documents/hooks/use-documents";
import { endpointToDocument } from "@repo/app/documents/lib/artifact-row-adapter";
import { DOCUMENT_TYPE_ICONS } from "@repo/app/projects/lib/project-constants";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@repo/design-system/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { SectionHeader } from "@repo/design-system/components/ui/section-header";
import { toast } from "@repo/design-system/components/ui/sonner";
import { FileTextIcon, LinkIcon } from "lucide-react";
import { useMemo, useState } from "react";

type PlanContextSectionProps = {
  planId: string;
  projectId: string | null | undefined;
};

export function PlanContextSection({
  planId,
  projectId,
}: Readonly<PlanContextSectionProps>) {
  const [isOpen, setIsOpen] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);

  const { data: resolvedLinks = [] } = useResolvedArtifactLinks(planId, {
    direction: LinkDirection.Source,
    linkType: LinkType.Produces,
  });

  const { data: projectDocuments = [] } = useDocumentsByProject(
    projectId ?? "",
    { enabled: !!projectId && pickerOpen }
  );

  const createLink = useCreateArtifactLink();
  const deleteLink = useDeleteArtifactLink();

  const parentLink = findParentSourceLink(resolvedLinks);
  // Render the parent from the already-resolved link endpoint (available on
  // load) rather than the `projectDocuments` fetch, which is gated on
  // `pickerOpen` and empty until the picker opens — otherwise the existing
  // link is invisible on initial load and users may link a duplicate.
  const parentDocument = parentLink
    ? endpointToDocument(parentLink.source)
    : null;

  const candidates = useMemo(
    () =>
      projectDocuments.filter(
        (doc) =>
          (doc.type === DocumentType.Feature ||
            doc.type === DocumentType.Prd) &&
          doc.id !== planId
      ),
    [projectDocuments, planId]
  );

  function handleLink(sourceId: string) {
    createLink.mutate(
      {
        sourceId,
        targetId: planId,
        linkType: LinkType.Produces,
      },
      {
        onSuccess: () => {
          setPickerOpen(false);
          toast.success("Context source linked");
        },
      }
    );
  }

  function handleUnlink(linkId: string) {
    deleteLink.mutate(linkId, {
      onSuccess: () => {
        toast.success("Context source unlinked");
      },
    });
  }

  return (
    <div className="bg-background">
      <SectionHeader
        isOpen={isOpen}
        onToggle={() => setIsOpen((prev) => !prev)}
        title="Context"
      />
      {isOpen && (
        <PlanContextBody
          candidates={candidates}
          onLink={handleLink}
          onUnlink={handleUnlink}
          parentDocument={parentDocument}
          parentLinkId={parentLink?.id ?? null}
          pickerOpen={pickerOpen}
          projectId={projectId}
          setPickerOpen={setPickerOpen}
        />
      )}
    </div>
  );
}

type PlanContextBodyProps = {
  candidates: Document[];
  onLink: (sourceId: string) => void;
  onUnlink: (linkId: string) => void;
  parentDocument: Document | null;
  parentLinkId: string | null;
  pickerOpen: boolean;
  projectId: string | null | undefined;
  setPickerOpen: (open: boolean) => void;
};

function PlanContextBody({
  candidates,
  onLink,
  onUnlink,
  parentDocument,
  parentLinkId,
  pickerOpen,
  projectId,
  setPickerOpen,
}: Readonly<PlanContextBodyProps>) {
  if (parentDocument) {
    return (
      <div className="flex flex-col border-t">
        <ArtifactRow
          artifact={parentDocument}
          linkId={parentLinkId}
          onDetach={onUnlink}
        />
      </div>
    );
  }

  if (!projectId) {
    return (
      <p className="py-3 text-base text-muted-foreground">
        No linked context source
      </p>
    );
  }

  return (
    <div className="flex items-center py-3">
      <div className="flex flex-1 flex-col gap-4">
        <p className="text-base text-muted-foreground">
          No linked context source
        </p>
        <Popover onOpenChange={setPickerOpen} open={pickerOpen}>
          <PopoverTrigger asChild>
            <Button
              className="w-fit justify-start gap-2"
              size="sm"
              variant="outline"
            >
              <LinkIcon className="h-4 w-4" />
              Link Context Source
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80 p-0">
            <Command label="Search issues and PRDs">
              <CommandInput placeholder="Search issues and PRDs..." />
              <CommandList>
                <CommandEmpty>No issues or PRDs found.</CommandEmpty>
                <CommandGroup>
                  {candidates.map((doc) => {
                    const Icon = DOCUMENT_TYPE_ICONS[doc.type] ?? FileTextIcon;
                    return (
                      <CommandItem
                        key={doc.id}
                        onSelect={() => onLink(doc.id)}
                        value={`${doc.title} ${doc.type}`}
                      >
                        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="truncate">{doc.title}</span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

function findParentSourceLink(
  resolvedLinks: ArtifactLinkWithEndpoints[]
): ArtifactLinkWithEndpoints | null {
  for (const link of resolvedLinks) {
    if (link.source.type !== ArtifactType.Document) {
      continue;
    }
    if (
      link.source.subtype === ArtifactSubtype.Feature ||
      link.source.subtype === ArtifactSubtype.Prd
    ) {
      return link;
    }
  }
  return null;
}
