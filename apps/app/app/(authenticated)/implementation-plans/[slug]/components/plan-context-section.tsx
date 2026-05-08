"use client";

import {
  type ArtifactLinkWithEndpoints,
  ArtifactSubtype,
  ArtifactType,
  LinkDirection,
  LinkType,
} from "@repo/api/src/types/artifact";
import { type Document, DocumentType } from "@repo/api/src/types/document";
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
import { toast } from "@repo/design-system/components/ui/sonner";
import { FileTextIcon, LinkIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { ArtifactRow } from "@/components/document-editor/relationships/artifact-row";
import { SectionHeader } from "@/components/document-editor/relationships/section-header";
import {
  useCreateArtifactLink,
  useDeleteArtifactLink,
  useResolvedArtifactLinks,
} from "@/hooks/queries/use-artifact-links";
import { useDocumentsByProject } from "@/hooks/queries/use-documents";
import { DOCUMENT_TYPE_ICONS } from "@/lib/project-constants";

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
  const parentDocument = parentLink
    ? findDocumentForLink(parentLink, projectDocuments)
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
            <Command>
              <CommandInput placeholder="Search features and PRDs..." />
              <CommandList>
                <CommandEmpty>No features or PRDs found.</CommandEmpty>
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

/**
 * Look up the full Document for a link's source endpoint inside the current
 * project's document list. Cross-project parents fall back to null because the
 * picker only loads docs from the active project; the section then falls back
 * to its empty state until the user navigates to the parent's project.
 */
function findDocumentForLink(
  link: ArtifactLinkWithEndpoints,
  projectDocuments: Document[]
): Document | null {
  return projectDocuments.find((doc) => doc.id === link.source.id) ?? null;
}
