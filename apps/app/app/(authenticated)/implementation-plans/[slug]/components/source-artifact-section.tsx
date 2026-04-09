"use client";

import {
  ArtifactType,
  getRoutePrefixForType,
} from "@repo/api/src/types/artifact";
import {
  EntityType,
  LinkDirection,
  LinkType,
} from "@repo/api/src/types/entity-link";
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
import { MetadataSection } from "@/components/artifact-editor/metadata-panel";
import { useArtifactsByProject } from "@/hooks/queries/use-artifacts";
import {
  useCreateEntityLink,
  useDeleteEntityLink,
  useLinkedEntities,
} from "@/hooks/queries/use-entity-links";
import {
  ARTIFACT_TYPE_ICONS,
  ARTIFACT_TYPE_LABELS,
} from "@/lib/project-constants";

type SourceArtifactSectionProps = {
  artifactId: string;
  projectId: string | undefined;
};

export function SourceArtifactSection({
  artifactId,
  projectId,
}: SourceArtifactSectionProps) {
  const [isOpen, setIsOpen] = useState(false);

  const { data: sourceLinkedEntities = [] } = useLinkedEntities(
    artifactId,
    EntityType.Artifact,
    {
      direction: LinkDirection.Source,
      linkType: LinkType.Produces,
    }
  );
  const createEntityLink = useCreateEntityLink();
  const deleteEntityLink = useDeleteEntityLink();

  const { data: projectArtifacts = [] } = useArtifactsByProject(
    projectId ?? "",
    { enabled: !!projectId }
  );

  const sourceLinkedEntity = sourceLinkedEntities.find(
    (linked) => linked.resolvedEntity?.type === EntityType.Artifact
  );

  const sourceArtifact =
    sourceLinkedEntity?.resolvedEntity?.type === EntityType.Artifact
      ? sourceLinkedEntity.resolvedEntity.entity
      : null;

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
        (a) => a.type === ArtifactType.Prd && a.id !== artifactId
      ),
    [projectArtifacts, artifactId]
  );

  const handleLinkSource = (sourceId: string) => {
    createEntityLink.mutate({
      sourceId,
      sourceType: EntityType.Artifact,
      targetId: artifactId,
      targetType: EntityType.Artifact,
      linkType: LinkType.Produces,
    });
    setIsOpen(false);
  };

  const handleUnlinkSource = () => {
    if (sourceLinkedEntity) {
      deleteEntityLink.mutate(sourceLinkedEntity.id);
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
                ARTIFACT_TYPE_ICONS[sourceArtifact.type] ?? FileTextIcon;
              return <Icon className="h-3.5 w-3.5 shrink-0" />;
            })()}
            <span className="truncate">{sourceArtifact.title}</span>
            <span className="shrink-0 text-muted-foreground text-xs">
              {ARTIFACT_TYPE_LABELS[sourceArtifact.type] ?? sourceArtifact.type}
            </span>
          </Link>
          <Button
            aria-label="Unlink source artifact"
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
                  {parentCandidates.map((artifact) => {
                    const Icon =
                      ARTIFACT_TYPE_ICONS[artifact.type] ?? FileTextIcon;
                    return (
                      <CommandItem
                        key={artifact.id}
                        onSelect={() => handleLinkSource(artifact.id)}
                        value={`${artifact.title} ${ARTIFACT_TYPE_LABELS[artifact.type] ?? artifact.type}`}
                      >
                        <Icon className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{artifact.title}</span>
                        <span className="ml-auto shrink-0 text-muted-foreground text-xs">
                          {ARTIFACT_TYPE_LABELS[artifact.type] ?? artifact.type}
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
