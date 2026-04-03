"use client";

import {
  EntityType,
  LinkDirection,
  type LinkedEntity,
  LinkQueryMode,
} from "@repo/api/src/types/entity-link";
import { ExternalLinkType } from "@repo/api/src/types/external-link";
import { parseDeploymentMetadata } from "@repo/api/src/types/external-link-utils";
import { Badge } from "@repo/design-system/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import { toast } from "@repo/design-system/components/ui/sonner";
import { ChevronDownIcon, ChevronUpIcon, ExternalLinkIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  useDeleteEntityLink,
  useLinkedEntities,
} from "@/hooks/queries/use-entity-links";
import { formatDateTime } from "@/lib/date-utils";
import { OverflowMenu } from "./overflow-menu";
import { SectionHeader } from "./section-header";

type PreviewSectionProps = {
  featureId: string;
};

export function PreviewSection({ featureId }: Readonly<PreviewSectionProps>) {
  const { data: linkedEntities = [] } = useLinkedEntities(
    featureId,
    EntityType.Feature,
    { mode: LinkQueryMode.Tree, direction: LinkDirection.Target }
  );

  const deleteLink = useDeleteEntityLink();

  function handleUnlink(linkId: string) {
    deleteLink.mutate(linkId, {
      onSuccess: () => {
        toast.success("Deployment unlinked");
      },
    });
  }

  const previewLinks = useMemo(
    () =>
      linkedEntities
        .filter(
          (linked) =>
            linked.resolvedEntity?.type === EntityType.ExternalLink &&
            linked.resolvedEntity.entity.type ===
              ExternalLinkType.PreviewDeployment
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    [linkedEntities]
  );

  const deployGroups = useMemo(
    () => groupDeployLinksByTimestamp(previewLinks),
    [previewLinks]
  );
  const [openGroupIds, setOpenGroupIds] = useState<string[]>(() =>
    deployGroups[0] ? [deployGroups[0].id] : []
  );

  useEffect(() => {
    setOpenGroupIds(deployGroups[0] ? [deployGroups[0].id] : []);
  }, [deployGroups]);

  function handleGroupOpenChange(groupId: string, isOpen: boolean) {
    if (isOpen) {
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
      <SectionHeader title="Deploy" />
      {deployGroups.length > 0 ? (
        <div className="flex flex-col">
          {deployGroups.map((deployGroup) => {
            const isOpen = openGroupIds.includes(deployGroup.id);

            return (
              <Collapsible
                key={deployGroup.id}
                onOpenChange={(nextOpenState) =>
                  handleGroupOpenChange(deployGroup.id, nextOpenState)
                }
                open={isOpen}
              >
                <CollapsibleTrigger className="flex w-full items-center justify-between px-2 py-2 text-left text-sm hover:bg-accent/50">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">
                      {formatDateTime(deployGroup.timestamp)}
                    </span>
                    <Badge variant="secondary">
                      {deployGroup.links.length}
                    </Badge>
                  </div>
                  {isOpen ? (
                    <ChevronUpIcon className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronDownIcon className="h-4 w-4 text-muted-foreground" />
                  )}
                </CollapsibleTrigger>
                <CollapsibleContent>
                  {deployGroup.links.map((linked) => {
                    // Already filtered to ExternalLink by previewLinks
                    const resolved = linked.resolvedEntity as Extract<
                      typeof linked.resolvedEntity,
                      { type: "EXTERNAL_LINK" }
                    >;
                    const externalLink = resolved.entity;
                    const deployMeta = parseDeploymentMetadata(
                      externalLink.metadata
                    );
                    if (!externalLink.externalUrl) {
                      return (
                        <div
                          className="flex items-center gap-2 px-2 py-2 text-muted-foreground"
                          key={linked.id}
                        >
                          <ExternalLinkIcon className="h-4 w-4 shrink-0" />
                          <span className="truncate font-medium text-sm">
                            {externalLink.title}
                          </span>
                          {deployMeta?.environment ? (
                            <Badge className="shrink-0" variant="outline">
                              {deployMeta.environment}
                            </Badge>
                          ) : (
                            <span className="shrink-0 text-xs">
                              Deploying...
                            </span>
                          )}
                          <OverflowMenu
                            linkId={linked.id}
                            onUnlink={handleUnlink}
                          />
                        </div>
                      );
                    }
                    return (
                      <div
                        className="flex items-center gap-2 px-2 py-2"
                        key={linked.id}
                      >
                        <a
                          className="flex min-w-0 flex-1 items-center gap-2 rounded-md hover:bg-accent"
                          href={externalLink.externalUrl}
                          rel="noopener noreferrer"
                          target="_blank"
                        >
                          <ExternalLinkIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="truncate font-medium text-sm">
                            {externalLink.title}
                          </span>
                          <span className="truncate text-muted-foreground text-xs">
                            {externalLink.externalUrl}
                          </span>
                        </a>
                        {deployMeta?.environment ? (
                          <Badge className="shrink-0" variant="outline">
                            {deployMeta.environment}
                          </Badge>
                        ) : null}
                        <OverflowMenu
                          linkId={linked.id}
                          onUnlink={handleUnlink}
                        />
                      </div>
                    );
                  })}
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </div>
      ) : (
        <p className="py-3 text-base text-muted-foreground">No deployments</p>
      )}
    </div>
  );
}

type DeployGroup = {
  id: string;
  timestamp: Date;
  links: LinkedEntity[];
};

function groupDeployLinksByTimestamp(
  sortedLinks: LinkedEntity[]
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

function createDeployGroup(link: LinkedEntity, index: number): DeployGroup {
  return {
    id: `${link.createdAt.toISOString()}-${index}`,
    timestamp: link.createdAt,
    links: [link],
  };
}

const DEPLOY_GROUP_WINDOW_MS = 60 * 1000;
