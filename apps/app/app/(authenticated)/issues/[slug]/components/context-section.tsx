"use client";

import type { Artifact } from "@repo/api/src/types/artifact";
import type { LinkedEntity } from "@repo/api/src/types/entity-link";
import { EntityType, LinkDirection } from "@repo/api/src/types/entity-link";
import type { Issue } from "@repo/api/src/types/issue";
import { isDisplayableSlug } from "@repo/api/src/types/slug";
import { Button } from "@repo/design-system/components/ui/button";
import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import { toast } from "@repo/design-system/components/ui/sonner";
import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
import { PlusIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { AssigneeAvatar } from "@/components/assignee-avatar";
import {
  useDeleteEntityLink,
  useLinkedEntities,
} from "@/hooks/queries/use-entity-links";
import { getArtifactRoute, getIssueRoute } from "@/lib/artifact-navigation";
import {
  ARTIFACT_STATUS_TO_ICON,
  ARTIFACT_TYPE_BADGE_LABELS,
  ARTIFACT_TYPE_ICONS,
  ISSUE_ICON,
  ISSUE_STATUS_TO_ICON,
} from "@/lib/project-constants";
import { OverflowMenu } from "./overflow-menu";
import { SectionHeader } from "./section-header";
import { SelectContextDialog } from "./select-context-dialog";

type ContextSectionProps = {
  issueId: string;
  projectId: string | undefined;
};

export function ContextSection({
  issueId,
  projectId,
}: Readonly<ContextSectionProps>) {
  const [showAddDialog, setShowAddDialog] = useState(false);

  const { data: linkedEntities = [] } = useLinkedEntities(
    issueId,
    EntityType.Issue,
    { direction: LinkDirection.Source }
  );
  const deleteLink = useDeleteEntityLink();

  function handleUnlink(linkId: string) {
    deleteLink.mutate(linkId, {
      onSuccess: () => {
        toast.success("Item unlinked");
      },
    });
  }

  // Filter to only artifact and issue source links (not external links — those go in Branches)
  const contextLinks = linkedEntities.filter(
    (linked) =>
      linked.resolvedEntity &&
      linked.resolvedEntity.type !== EntityType.ExternalLink
  );

  // Collect IDs of already-linked artifacts so the dialog can exclude them
  const getLinkedArtifactIds = () => {
    const ids = new Set<string>();
    for (const linked of contextLinks) {
      if (linked.resolvedEntity?.type === EntityType.Artifact) {
        ids.add(linked.resolvedEntity.entity.id);
      }
    }
    return ids;
  };

  return (
    <>
      <div className="overflow-hidden rounded-lg border bg-background">
        <SectionHeader title="Context">
          <Button
            onClick={() => setShowAddDialog(true)}
            size="sm"
            variant="outline"
          >
            Add
            <PlusIcon className="ml-1 h-4 w-4" />
          </Button>
        </SectionHeader>
        {contextLinks.length > 0 ? (
          <div className="flex flex-col">
            {contextLinks.map((linked) => (
              <ContextRow
                key={linked.id}
                linked={linked}
                onUnlink={handleUnlink}
              />
            ))}
          </div>
        ) : null}
      </div>

      <SelectContextDialog
        excludeArtifactIds={getLinkedArtifactIds()}
        issueId={issueId}
        onOpenChange={setShowAddDialog}
        open={showAddDialog}
        projectId={projectId}
      />
    </>
  );
}

type ContextRowProps = {
  linked: LinkedEntity;
  onUnlink: (linkId: string) => void;
};

function ContextRow({ linked, onUnlink }: Readonly<ContextRowProps>) {
  const resolved = linked.resolvedEntity;
  if (!resolved) {
    return null;
  }

  switch (resolved.type) {
    case EntityType.Artifact: {
      return (
        <ArtifactRow
          artifact={resolved.entity}
          linkId={linked.id}
          onUnlink={onUnlink}
        />
      );
    }
    case EntityType.Issue: {
      return (
        <IssueRow
          issue={resolved.entity}
          linkId={linked.id}
          onUnlink={onUnlink}
        />
      );
    }
    default: {
      return null;
    }
  }
}

type ArtifactRowProps = {
  artifact: Artifact;
  linkId: string;
  onUnlink: (linkId: string) => void;
};

function ArtifactRow({
  artifact,
  linkId,
  onUnlink,
}: Readonly<ArtifactRowProps>) {
  const Icon = ARTIFACT_TYPE_ICONS[artifact.type];
  const badgeLabel = ARTIFACT_TYPE_BADGE_LABELS[artifact.type];
  const statusIconStatus = ARTIFACT_STATUS_TO_ICON[artifact.status];
  const route = getArtifactRoute(artifact);

  return (
    <div className="flex items-center px-2 py-1">
      <Link
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md hover:bg-accent"
        href={route ?? "#"}
      >
        <div className="flex shrink-0 items-center p-1">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        <span className="min-w-[60px] shrink-0 truncate font-medium text-muted-foreground text-xs">
          {isDisplayableSlug(artifact.slug) ? artifact.slug : badgeLabel}
        </span>
        <span className="truncate px-1 font-medium text-sm">
          {artifact.title}
        </span>
      </Link>
      <div className="flex h-9 shrink-0 items-center gap-2">
        <AssigneeAvatar assignee={artifact.assignee} />
        <StatusIcon size={20} status={statusIconStatus} />
        <OverflowMenu linkId={linkId} onUnlink={onUnlink} />
      </div>
    </div>
  );
}

type IssueRowProps = {
  issue: Issue;
  linkId: string;
  onUnlink: (linkId: string) => void;
};

function IssueRow({ issue, linkId, onUnlink }: Readonly<IssueRowProps>) {
  const Icon = ISSUE_ICON;
  const statusIconStatus = ISSUE_STATUS_TO_ICON[issue.status];
  const route = getIssueRoute(issue);

  return (
    <div className="flex items-center gap-4 px-2 py-1">
      <Link
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md hover:bg-accent"
        href={route}
      >
        <div className="flex shrink-0 items-center p-1">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        <span className="min-w-[60px] shrink-0 truncate font-medium text-muted-foreground text-xs">
          {isDisplayableSlug(issue.slug) ? issue.slug : "Feature"}
        </span>
        <span className="truncate px-1 font-medium text-sm">{issue.title}</span>
      </Link>
      <div className="flex h-9 shrink-0 items-center gap-2">
        <PriorityIcon priority={issue.priority} />
        <AssigneeAvatar assignee={issue.assignee} />
        <StatusIcon size={20} status={statusIconStatus} />
        <OverflowMenu linkId={linkId} onUnlink={onUnlink} />
      </div>
    </div>
  );
}
