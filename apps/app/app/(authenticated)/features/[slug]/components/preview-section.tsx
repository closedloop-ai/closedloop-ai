"use client";

import {
  EntityType,
  LinkDirection,
  LinkQueryMode,
} from "@repo/api/src/types/entity-link";
import { ExternalLinkType } from "@repo/api/src/types/external-link";
import { parseDeploymentMetadata } from "@repo/api/src/types/external-link-utils";
import { Badge } from "@repo/design-system/components/ui/badge";
import { toast } from "@repo/design-system/components/ui/sonner";
import { ExternalLinkIcon } from "lucide-react";
import {
  useDeleteEntityLink,
  useLinkedEntities,
} from "@/hooks/queries/use-entity-links";
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

  const previewLinks = linkedEntities
    .filter(
      (linked) =>
        linked.resolvedEntity?.type === EntityType.ExternalLink &&
        linked.resolvedEntity.entity.type === ExternalLinkType.PreviewDeployment
    )
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  return (
    <div className="bg-background">
      <SectionHeader title="Deploy" />
      {previewLinks.length > 0 ? (
        <div className="flex flex-col">
          {previewLinks.map((linked) => {
            if (linked.resolvedEntity?.type !== EntityType.ExternalLink) {
              return null;
            }
            const externalLink = linked.resolvedEntity.entity;
            const deployMeta = parseDeploymentMetadata(externalLink.metadata);
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
                    <span className="shrink-0 text-xs">Deploying...</span>
                  )}
                  <OverflowMenu linkId={linked.id} onUnlink={handleUnlink} />
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
                <OverflowMenu linkId={linked.id} onUnlink={handleUnlink} />
              </div>
            );
          })}
        </div>
      ) : (
        <p className="py-3 text-base text-muted-foreground">No deployments</p>
      )}
    </div>
  );
}
