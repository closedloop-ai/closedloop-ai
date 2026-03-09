"use client";

import type { LinkedEntity } from "@repo/api/src/types/entity-link";
import {
  EntityType,
  LinkDirection,
  LinkQueryMode,
} from "@repo/api/src/types/entity-link";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { toast } from "@repo/design-system/components/ui/sonner";
import { cn } from "@repo/design-system/lib/utils";
import { GitBranchIcon, PlusIcon } from "lucide-react";
import {
  useDeleteEntityLink,
  useLinkedEntities,
} from "@/hooks/queries/use-entity-links";
import {
  EXTERNAL_LINK_TYPE_BADGE_LABELS,
  EXTERNAL_LINK_TYPE_COLORS,
} from "@/lib/project-constants";
import { OverflowMenu } from "./overflow-menu";
import { SectionHeader } from "./section-header";

type BranchesSectionProps = {
  issueId: string;
  onAdd?: () => void;
};

export function BranchesSection({
  issueId,
  onAdd,
}: Readonly<BranchesSectionProps>) {
  const { data: linkedEntities = [] } = useLinkedEntities(
    issueId,
    EntityType.Issue,
    { mode: LinkQueryMode.Tree, direction: LinkDirection.Target }
  );
  const deleteLink = useDeleteEntityLink();

  function handleUnlink(linkId: string) {
    deleteLink.mutate(linkId, {
      onSuccess: () => {
        toast.success("Branch unlinked");
      },
    });
  }

  // Filter to only external link entities (PRs, branches, etc.)
  const branchLinks = linkedEntities.filter(
    (linked) => linked.resolvedEntity?.type === EntityType.ExternalLink
  );

  return (
    <div className="overflow-hidden rounded-lg border bg-background">
      <SectionHeader title="Branches">
        {onAdd ? (
          <Button onClick={onAdd} size="sm" variant="outline">
            Add Branch
            <PlusIcon className="ml-1 h-4 w-4" />
          </Button>
        ) : null}
      </SectionHeader>
      {branchLinks.length > 0 ? (
        <div className="flex flex-col">
          {branchLinks.map((linked) => (
            <BranchRow
              key={linked.id}
              linked={linked}
              onUnlink={handleUnlink}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

type BranchRowProps = {
  linked: LinkedEntity;
  onUnlink: (linkId: string) => void;
};

function BranchRow({ linked, onUnlink }: Readonly<BranchRowProps>) {
  const resolved = linked.resolvedEntity;
  if (resolved?.type !== EntityType.ExternalLink) {
    return null;
  }

  const externalLink = resolved.entity;
  const badgeLabel = EXTERNAL_LINK_TYPE_BADGE_LABELS[externalLink.type];
  const badgeColors = EXTERNAL_LINK_TYPE_COLORS[externalLink.type];

  return (
    <div className="flex items-center gap-4 px-2 py-1">
      <a
        className="flex min-w-0 flex-1 items-center gap-1 rounded-md hover:bg-accent"
        href={externalLink.externalUrl}
        rel="noopener noreferrer"
        target="_blank"
      >
        <div className="flex shrink-0 items-center p-1">
          <GitBranchIcon className="h-4 w-4 text-muted-foreground" />
        </div>
        <span className="min-w-[60px] shrink-0 truncate font-medium text-muted-foreground text-xs">
          {badgeLabel}
        </span>
        <span className="truncate px-1 font-medium text-sm">
          {externalLink.title}
        </span>
      </a>
      <div className="flex h-9 shrink-0 items-center gap-2">
        {badgeLabel ? (
          <Badge
            className={cn(
              "border text-muted-foreground text-xs",
              badgeColors?.bg,
              badgeColors?.text
            )}
            variant="outline"
          >
            {badgeLabel}
          </Badge>
        ) : null}
        <OverflowMenu linkId={linked.id} onUnlink={onUnlink} />
      </div>
    </div>
  );
}
