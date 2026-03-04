"use client";

import { type Artifact, ArtifactStatus } from "@repo/api/src/types/artifact";
import type { Priority } from "@repo/api/src/types/common";
import type { LinkedEntity } from "@repo/api/src/types/entity-link";
import { EntityType } from "@repo/api/src/types/entity-link";
import type { ExternalLink } from "@repo/api/src/types/external-link";
import { type Issue, IssueStatus } from "@repo/api/src/types/issue";
import { Badge } from "@repo/design-system/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import { Separator } from "@repo/design-system/components/ui/separator";
import { toast } from "@repo/design-system/components/ui/sonner";
import type { StatusIconStatus } from "@repo/design-system/components/ui/status-icon";
import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
import { cn } from "@repo/design-system/lib/utils";
import {
  ChevronDownIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  Unlink2Icon,
} from "lucide-react";
import { useState } from "react";
import { AssigneeAvatar } from "@/components/assignee-avatar";
import {
  useDeleteEntityLink,
  useLinkedEntities,
} from "@/hooks/queries/use-entity-links";
import {
  ARTIFACT_TYPE_BADGE_LABELS,
  ARTIFACT_TYPE_COLORS,
  ARTIFACT_TYPE_ICONS,
  EXTERNAL_LINK_TYPE_BADGE_LABELS,
  EXTERNAL_LINK_TYPE_COLORS,
  EXTERNAL_LINK_TYPE_ICONS,
  ISSUE_ICON,
} from "@/lib/project-constants";

type ContextTableProps = {
  issueId: string;
  separator?: boolean;
};

export function ContextTable({
  issueId,
  separator = false,
}: Readonly<ContextTableProps>) {
  const [isOpen, setIsOpen] = useState(true);
  const { data: linkedEntities = [] } = useLinkedEntities(
    issueId,
    EntityType.Issue
  );
  const deleteLink = useDeleteEntityLink();

  function handleUnlink(linkId: string) {
    deleteLink.mutate(linkId, {
      onSuccess: () => {
        toast.success("Item unlinked");
      },
    });
  }

  if (linkedEntities.length === 0) {
    return null;
  }

  return (
    <>
      {separator && <Separator className="mb-3" />}
      <Collapsible onOpenChange={setIsOpen} open={isOpen}>
        <div className="flex items-center border-b px-1 py-2">
          <CollapsibleTrigger className="flex flex-1 items-center gap-1">
            <span className="font-medium text-base">Context</span>
            <ChevronDownIcon
              className={cn(
                "h-4 w-4 text-muted-foreground transition-transform",
                !isOpen && "-rotate-90"
              )}
            />
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          <div className="flex flex-col">
            {linkedEntities.map((linked) => (
              <ContextRow
                key={linked.id}
                linked={linked}
                onUnlink={handleUnlink}
              />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </>
  );
}

const ARTIFACT_STATUS_TO_ICON: Record<ArtifactStatus, StatusIconStatus> = {
  [ArtifactStatus.Draft]: "todo",
  [ArtifactStatus.InReview]: "in-review",
  [ArtifactStatus.Approved]: "complete",
  [ArtifactStatus.Obsolete]: "wont-do",
  [ArtifactStatus.ReadyForReview]: "in-progress",
  [ArtifactStatus.Executed]: "complete",
};

const ISSUE_STATUS_TO_ICON: Record<IssueStatus, StatusIconStatus> = {
  [IssueStatus.NotStarted]: "todo",
  [IssueStatus.InProgress]: "in-progress",
  [IssueStatus.InReview]: "in-review",
  [IssueStatus.Completed]: "complete",
  [IssueStatus.Obsolete]: "wont-do",
};

type ContextRowProps = {
  linked: LinkedEntity;
  onUnlink: (linkId: string) => void;
};

function ContextRow({ linked, onUnlink }: ContextRowProps) {
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
    case EntityType.ExternalLink: {
      return (
        <ExternalLinkRow
          externalLink={resolved.entity}
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

function ArtifactRow({ artifact, linkId, onUnlink }: ArtifactRowProps) {
  const Icon = ARTIFACT_TYPE_ICONS[artifact.type];
  const badgeLabel = ARTIFACT_TYPE_BADGE_LABELS[artifact.type];
  const badgeColors = ARTIFACT_TYPE_COLORS[artifact.type];
  const statusIconStatus = ARTIFACT_STATUS_TO_ICON[artifact.status];

  return (
    <div className="flex items-center gap-4 border-b px-1 py-2">
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <div className="flex shrink-0 items-center p-1">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        <span className="truncate px-1 font-medium text-sm">
          {artifact.title}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2.5">
        <Badge
          className={cn("border-0", badgeColors.bg, badgeColors.text)}
          variant="outline"
        >
          {badgeLabel}
        </Badge>
        <AssigneeAvatar assignee={artifact.assignee} />
        <StatusIcon size={16} status={statusIconStatus} />
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

function IssueRow({ issue, linkId, onUnlink }: IssueRowProps) {
  const Icon = ISSUE_ICON;
  const statusIconStatus = ISSUE_STATUS_TO_ICON[issue.status];

  return (
    <div className="flex items-center gap-4 border-b px-1 py-2">
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <div className="flex shrink-0 items-center p-1">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        <span className="truncate px-1 font-medium text-sm">{issue.title}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2.5">
        <Badge
          className="border-0 bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300"
          variant="outline"
        >
          Feature
        </Badge>
        <PriorityIcon priority={issue.priority as Priority} />
        <AssigneeAvatar assignee={issue.assignee} />
        <StatusIcon size={16} status={statusIconStatus} />
        <OverflowMenu linkId={linkId} onUnlink={onUnlink} />
      </div>
    </div>
  );
}

type ExternalLinkRowProps = {
  externalLink: ExternalLink;
  linkId: string;
  onUnlink: (linkId: string) => void;
};

function ExternalLinkRow({
  externalLink,
  linkId,
  onUnlink,
}: ExternalLinkRowProps) {
  const Icon = EXTERNAL_LINK_TYPE_ICONS[externalLink.type];
  const badgeLabel = EXTERNAL_LINK_TYPE_BADGE_LABELS[externalLink.type];
  const badgeColors = EXTERNAL_LINK_TYPE_COLORS[externalLink.type];

  return (
    <div className="flex items-center gap-4 border-b px-1 py-2">
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <div className="flex shrink-0 items-center p-1">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        <a
          className="flex min-w-0 items-center gap-1 px-1 hover:underline"
          href={externalLink.externalUrl}
          rel="noopener noreferrer"
          target="_blank"
        >
          <span className="truncate font-medium text-sm">
            {externalLink.title}
          </span>
          <ExternalLinkIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
        </a>
      </div>
      <div className="flex shrink-0 items-center gap-2.5">
        {badgeLabel ? (
          <Badge
            className={cn("border-0", badgeColors?.bg, badgeColors?.text)}
            variant="outline"
          >
            {badgeLabel}
          </Badge>
        ) : null}
        <OverflowMenu linkId={linkId} onUnlink={onUnlink} />
      </div>
    </div>
  );
}

type OverflowMenuProps = {
  linkId: string;
  onUnlink: (linkId: string) => void;
};

function OverflowMenu({ linkId, onUnlink }: OverflowMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          type="button"
        >
          <EllipsisIcon className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onUnlink(linkId)}>
          <Unlink2Icon className="mr-2 h-4 w-4" />
          Unlink
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
