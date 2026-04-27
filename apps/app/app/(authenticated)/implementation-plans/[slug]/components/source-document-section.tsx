"use client";

import {
  ArtifactType,
  LinkDirection,
  LinkType,
} from "@repo/api/src/types/artifact";
import {
  DocumentType,
  getRoutePrefixForType,
} from "@repo/api/src/types/document";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@repo/design-system/components/ui/command";
import { Label } from "@repo/design-system/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { FileTextIcon, LinkIcon, UnlinkIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { MetadataSection } from "@/components/document-editor/metadata-panel";
import {
  useCreateArtifactLink,
  useDeleteArtifactLink,
  useResolvedArtifactLinks,
} from "@/hooks/queries/use-artifact-links";
import { useDocumentsByProject } from "@/hooks/queries/use-documents";
import {
  DOCUMENT_TYPE_ICONS,
  DOCUMENT_TYPE_LABELS,
} from "@/lib/project-constants";

type SourceDocumentSectionProps = {
  documentId: string;
  projectId: string | undefined;
};

export function SourceDocumentSection({
  documentId,
  projectId,
}: SourceDocumentSectionProps) {
  const [isOpen, setIsOpen] = useState(false);

  const { data: resolvedSourceLinks = [] } = useResolvedArtifactLinks(
    documentId,
    {
      direction: LinkDirection.Source,
      linkType: LinkType.Produces,
    }
  );
  const createArtifactLink = useCreateArtifactLink();
  const deleteArtifactLink = useDeleteArtifactLink();

  const { data: projectArtifacts = [] } = useDocumentsByProject(
    projectId ?? "",
    { enabled: !!projectId }
  );

  const sourceLink = resolvedSourceLinks.find(
    (link) =>
      link.targetId === documentId && link.source.type === ArtifactType.Document
  );

  const sourceArtifact = useMemo(() => {
    if (!sourceLink) {
      return null;
    }
    return projectArtifacts.find((a) => a.id === sourceLink.source.id) ?? null;
  }, [sourceLink, projectArtifacts]);

  const sourceArtifactRoute = useMemo(() => {
    if (!sourceArtifact) {
      return null;
    }
    const routePrefix = getRoutePrefixForType(sourceArtifact.type);
    return routePrefix ? `/${routePrefix}/${sourceArtifact.slug}` : null;
  }, [sourceArtifact]);

  const parentCandidates = useMemo(
    () =>
      projectArtifacts.filter(
        (a) => a.type === DocumentType.Prd && a.id !== documentId
      ),
    [projectArtifacts, documentId]
  );

  const handleLinkSource = (sourceId: string) => {
    createArtifactLink.mutate({
      sourceId,
      targetId: documentId,
      linkType: LinkType.Produces,
    });
    setIsOpen(false);
  };

  const handleUnlinkSource = () => {
    if (sourceLink) {
      deleteArtifactLink.mutate(sourceLink.id);
    }
  };

  return (
    <MetadataSection>
      <Label className="text-muted-foreground text-xs">Source Artifact</Label>
      {sourceArtifact ? (
        <div className="flex items-center justify-between gap-2">
          <Link
            className="flex min-w-0 items-center gap-1.5 text-primary text-sm hover:underline"
            href={sourceArtifactRoute ?? "#"}
          >
            {(() => {
              const Icon =
                DOCUMENT_TYPE_ICONS[sourceArtifact.type] ?? FileTextIcon;
              return <Icon className="h-3.5 w-3.5 shrink-0" />;
            })()}
            <span className="truncate">{sourceArtifact.title}</span>
            <span className="shrink-0 text-muted-foreground text-xs">
              {DOCUMENT_TYPE_LABELS[sourceArtifact.type] ?? sourceArtifact.type}
            </span>
          </Link>
          <Button
            aria-label="Unlink source document"
            onClick={handleUnlinkSource}
            size="icon"
            variant="ghost"
          >
            <UnlinkIcon className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : (
        <Popover onOpenChange={setIsOpen} open={isOpen}>
          <PopoverTrigger asChild>
            <Button
              className="justify-start gap-2 text-muted-foreground"
              size="sm"
              variant="outline"
            >
              <LinkIcon className="h-3.5 w-3.5" />
              Link Source Artifact
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 p-0">
            <Command>
              <CommandInput placeholder="Search artifacts..." />
              <CommandList>
                <CommandEmpty>No artifacts found.</CommandEmpty>
                <CommandGroup>
                  {parentCandidates.map((doc) => {
                    const Icon = DOCUMENT_TYPE_ICONS[doc.type] ?? FileTextIcon;
                    return (
                      <CommandItem
                        key={doc.id}
                        onSelect={() => handleLinkSource(doc.id)}
                        value={`${doc.title} ${DOCUMENT_TYPE_LABELS[doc.type] ?? doc.type}`}
                      >
                        <Icon className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{doc.title}</span>
                        <span className="ml-auto shrink-0 text-muted-foreground text-xs">
                          {DOCUMENT_TYPE_LABELS[doc.type] ?? doc.type}
                        </span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      )}
    </MetadataSection>
  );
}
