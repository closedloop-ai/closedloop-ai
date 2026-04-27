"use client";

import {
  type ArtifactLinkWithEndpoints,
  ArtifactType,
  LinkDirection,
  LinkQueryMode,
} from "@repo/api/src/types/artifact";
import { Badge } from "@repo/design-system/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import { toast } from "@repo/design-system/components/ui/sonner";
import { ChevronDownIcon, ChevronUpIcon, ExternalLinkIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  useDeleteArtifactLink,
  useResolvedArtifactLinks,
} from "@/hooks/queries/use-artifact-links";
import { formatDateTime } from "@/lib/date-utils";
import { OverflowMenu } from "./overflow-menu";
import { SectionHeader } from "./section-header";

type PreviewSectionProps = {
  documentId: string;
};

export function PreviewSection({ documentId }: Readonly<PreviewSectionProps>) {
  const { data: resolvedLinks = [] } = useResolvedArtifactLinks(documentId, {
    mode: LinkQueryMode.Tree,
    direction: LinkDirection.Target,
  });

  const deleteLink = useDeleteArtifactLink();

  function handleUnlink(linkId: string) {
    deleteLink.mutate(linkId, {
      onSuccess: () => {
        toast.success("Deployment unlinked");
      },
    });
  }

  const previewLinks = useMemo(
    () =>
      resolvedLinks
        .filter((link) => link.target.type === ArtifactType.Deployment)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    [resolvedLinks]
  );

  const deployGroups = useMemo(
    () => groupDeployLinksByTimestamp(previewLinks),
    [previewLinks]
  );
  const [isOpen, setIsOpen] = useState(true);
  const [openGroupIds, setOpenGroupIds] = useState<string[]>(() =>
    deployGroups[0] ? [deployGroups[0].id] : []
  );
  const previousFirstGroupIdRef = useRef<string | undefined>(
    deployGroups[0]?.id
  );

  useEffect(() => {
    const firstGroupId = deployGroups[0]?.id;
    if (firstGroupId === previousFirstGroupIdRef.current) {
      return;
    }
    previousFirstGroupIdRef.current = firstGroupId;
    setOpenGroupIds(firstGroupId ? [firstGroupId] : []);
  }, [deployGroups]);

  function handleGroupOpenChange(groupId: string, isGroupOpen: boolean) {
    if (isGroupOpen) {
      setOpenGroupIds((previousOpenGroups) =>
        previousOpenGroups.includes(groupId)
          ? previousOpenGroups
          : [...previousOpenGroups, groupId]
      );
      return;
    }

    setOpenGroupIds((previousOpenGroups) =>
      previousOpenGroups.filter((openGroupId) => openGroupId !== groupId)
    );
  }

  return (
    <div className="bg-background">
      <SectionHeader
        isOpen={isOpen}
        onToggle={() => setIsOpen((prev) => !prev)}
        title="Deploy"
      />
      {isOpen && (
        <DeployBody
          deployGroups={deployGroups}
          onGroupOpenChange={handleGroupOpenChange}
          onUnlink={handleUnlink}
          openGroupIds={openGroupIds}
        />
      )}
    </div>
  );
}

type DeployBodyProps = {
  deployGroups: DeployGroup[];
  openGroupIds: string[];
  onGroupOpenChange: (groupId: string, isGroupOpen: boolean) => void;
  onUnlink: (linkId: string) => void;
};

function DeployBody({
  deployGroups,
  openGroupIds,
  onGroupOpenChange,
  onUnlink,
}: Readonly<DeployBodyProps>) {
  if (deployGroups.length === 0) {
    return (
      <p className="py-3 text-base text-muted-foreground">No deployments</p>
    );
  }
  return (
    <div className="flex flex-col">
      {deployGroups.map((deployGroup) => {
        const isGroupOpen = openGroupIds.includes(deployGroup.id);
        return (
          <Collapsible
            key={deployGroup.id}
            onOpenChange={(nextOpenState) =>
              onGroupOpenChange(deployGroup.id, nextOpenState)
            }
            open={isGroupOpen}
          >
            <CollapsibleTrigger className="flex w-full items-center justify-between px-2 py-2 text-left text-sm hover:bg-accent/50">
              <div className="flex items-center gap-2">
                <span className="font-medium">
                  {formatDateTime(deployGroup.timestamp)}
                </span>
                <Badge variant="secondary">{deployGroup.links.length}</Badge>
              </div>
              {isGroupOpen ? (
                <ChevronUpIcon className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronDownIcon className="h-4 w-4 text-muted-foreground" />
              )}
            </CollapsibleTrigger>
            <CollapsibleContent>
              {deployGroup.links.map((link) => (
                <DeployRow key={link.id} link={link} onUnlink={onUnlink} />
              ))}
            </CollapsibleContent>
          </Collapsible>
        );
      })}
    </div>
  );
}

type DeployRowProps = {
  link: ArtifactLinkWithEndpoints;
  onUnlink: (linkId: string) => void;
};

function DeployRow({ link, onUnlink }: Readonly<DeployRowProps>) {
  const deployEndpoint = link.target;
  if (deployEndpoint.type !== ArtifactType.Deployment) {
    return null;
  }

  if (!deployEndpoint.externalUrl) {
    return (
      <div className="flex items-center gap-2 px-2 py-2 text-muted-foreground">
        <ExternalLinkIcon className="h-4 w-4 shrink-0" />
        <span className="truncate font-medium text-sm">
          {deployEndpoint.name}
        </span>
        <span className="shrink-0 text-xs">Deploying...</span>
        <OverflowMenu linkId={link.id} onUnlink={onUnlink} />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 px-2 py-2">
      <a
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md hover:bg-accent"
        href={deployEndpoint.externalUrl}
        rel="noopener noreferrer"
        target="_blank"
      >
        <ExternalLinkIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium text-sm">
          {deployEndpoint.name}
        </span>
        <span className="truncate text-muted-foreground text-xs">
          {deployEndpoint.externalUrl}
        </span>
      </a>
      <OverflowMenu linkId={link.id} onUnlink={onUnlink} />
    </div>
  );
}

type DeployGroup = {
  id: string;
  timestamp: Date;
  links: ArtifactLinkWithEndpoints[];
};

function groupDeployLinksByTimestamp(
  sortedLinks: ArtifactLinkWithEndpoints[]
): DeployGroup[] {
  const groups: DeployGroup[] = [];

  for (const link of sortedLinks) {
    const currentGroup = groups.at(-1);

    if (!currentGroup) {
      groups.push(createDeployGroup(link, 0));
      continue;
    }

    const groupTimestampMs = currentGroup.timestamp.getTime();
    const linkTimestampMs = link.createdAt.getTime();
    const isWithinTimeWindow =
      Math.abs(groupTimestampMs - linkTimestampMs) <= DEPLOY_GROUP_WINDOW_MS;

    if (isWithinTimeWindow) {
      currentGroup.links.push(link);
      continue;
    }

    groups.push(createDeployGroup(link, groups.length));
  }

  return groups;
}

function createDeployGroup(
  link: ArtifactLinkWithEndpoints,
  index: number
): DeployGroup {
  return {
    id: `${link.createdAt.toISOString()}-${index}`,
    timestamp: link.createdAt,
    links: [link],
  };
}

const DEPLOY_GROUP_WINDOW_MS = 10 * 60 * 1000;
