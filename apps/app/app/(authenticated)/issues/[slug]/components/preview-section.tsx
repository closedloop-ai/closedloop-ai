"use client";

import {
  EntityType,
  LinkDirection,
  LinkQueryMode,
} from "@repo/api/src/types/entity-link";
import { ExternalLinkType } from "@repo/api/src/types/external-link";
import { ExternalLinkIcon } from "lucide-react";
import { useLinkedEntities } from "@/hooks/queries/use-entity-links";
import { SectionHeader } from "./section-header";

type PreviewSectionProps = {
  issueId: string;
};

export function PreviewSection({ issueId }: Readonly<PreviewSectionProps>) {
  const { data: linkedEntities = [] } = useLinkedEntities(
    issueId,
    EntityType.Issue,
    { mode: LinkQueryMode.Tree, direction: LinkDirection.Target }
  );

  const previewLinks = linkedEntities.filter(
    (linked) =>
      linked.resolvedEntity?.type === EntityType.ExternalLink &&
      linked.resolvedEntity.entity.type === ExternalLinkType.PreviewDeployment
  );

  return (
    <div className="bg-background">
      <SectionHeader title="Preview" />
      {previewLinks.length > 0 ? (
        <div className="flex flex-col">
          {previewLinks.map((linked) => {
            if (linked.resolvedEntity?.type !== EntityType.ExternalLink) {
              return null;
            }
            const externalLink = linked.resolvedEntity.entity;
            return (
              <a
                className="flex items-center gap-2 rounded-md px-2 py-2 hover:bg-accent"
                href={externalLink.externalUrl}
                key={linked.id}
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
            );
          })}
        </div>
      ) : (
        <p className="py-3 text-base text-muted-foreground">
          No preview deployments
        </p>
      )}
    </div>
  );
}
