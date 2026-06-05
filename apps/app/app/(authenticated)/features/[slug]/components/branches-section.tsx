"use client";

import {
  type GenerationStatus,
  isActiveGenerationStatus,
} from "@repo/api/src/types/artifact";
import type { LinkedEntity } from "@repo/api/src/types/entity-link";
import {
  EntityType,
  LinkDirection,
  LinkQueryMode,
} from "@repo/api/src/types/entity-link";
import { ExternalLinkType } from "@repo/api/src/types/external-link";
import { parsePullRequestMetadata } from "@repo/api/src/types/external-link-utils";
import { GitHubPRState } from "@repo/api/src/types/github";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { toast } from "@repo/design-system/components/ui/sonner";
import { GitBranchIcon, GitMergeIcon, PlayIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { GenerationStatusIndicator } from "@/components/generation-status-indicator";
import {
  useDeleteEntityLink,
  useLinkedEntities,
} from "@/hooks/queries/use-entity-links";
import { OverflowMenu } from "./overflow-menu";
import { SectionHeader } from "./section-header";
import { SelectPullRequestDialog } from "./select-pr-dialog";

type BranchesSectionProps = {
  featureId: string;
  projectId: string;
  planId: string | null;
  onStartBuild?: () => void;
  generationStatus?: GenerationStatus;
};

export function BranchesSection({
  featureId,
  projectId,
  planId,
  onStartBuild,
  generationStatus,
}: Readonly<BranchesSectionProps>) {
  const [showSelectPr, setShowSelectPr] = useState(false);
  const { data: linkedEntities = [] } = useLinkedEntities(
    featureId,
    EntityType.Feature,
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
    (linked) =>
      linked.resolvedEntity?.type === EntityType.ExternalLink &&
      linked.resolvedEntity.entity.type === ExternalLinkType.PullRequest
  );

  const hasBranches = branchLinks.length > 0;
  const isExecutingPlan =
    generationStatus?.command === "execute" &&
    isActiveGenerationStatus(generationStatus.status);

  return (
    <div className="bg-background">
      <SectionHeader title="Build">
        <Button
          onClick={() => setShowSelectPr(true)}
          size="icon-sm"
          variant="ghost"
        >
          <PlusIcon className="h-4 w-4" />
        </Button>
      </SectionHeader>
      {hasBranches ? (
        <div className="flex flex-col">
          {branchLinks.map((linked) => (
            <BranchRow
              key={linked.id}
              linked={linked}
              onUnlink={handleUnlink}
            />
          ))}
        </div>
      ) : (
        <div className="flex items-center py-3">
          <div className="flex flex-1 flex-col gap-4">
            <p className="text-base text-muted-foreground">
              No PR exists for this feature
            </p>
            <div className="flex gap-4">
              {planId ? (
                <>
                  <Button
                    disabled={isExecutingPlan}
                    onClick={onStartBuild}
                    size="sm"
                    variant="default"
                  >
                    Start Building
                    <PlayIcon className="h-4 w-4" />
                  </Button>
                  <Button
                    onClick={() => setShowSelectPr(true)}
                    size="sm"
                    variant="outline"
                  >
                    Select Existing PR
                  </Button>
                </>
              ) : (
                <Button disabled size="sm" variant="secondary">
                  Need approved plan to build
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
      {isExecutingPlan && (
        <div className="px-2 py-1">
          <GenerationStatusIndicator generationStatus={generationStatus} />
        </div>
      )}
      <SelectPullRequestDialog
        onOpenChange={setShowSelectPr}
        open={showSelectPr}
        planId={planId}
        projectId={projectId}
      />
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
  const prMeta = parsePullRequestMetadata(externalLink.metadata);

  return (
    <div className="flex items-center gap-4 px-2 py-1">
      <a
        className="flex min-w-0 flex-1 items-center gap-1 rounded-md hover:bg-accent"
        href={externalLink.externalUrl}
        rel="noopener noreferrer"
        target="_blank"
      >
        <div className="flex shrink-0 items-center p-1">
          <PrStateIcon state={prMeta?.state ?? null} />
        </div>
        <span className="truncate px-1 font-medium text-sm">
          {externalLink.title}
        </span>
      </a>
      <div className="flex h-9 shrink-0 items-center gap-2">
        <PrStateBadge state={prMeta?.state ?? null} />
        <OverflowMenu linkId={linked.id} onUnlink={onUnlink} />
      </div>
    </div>
  );
}

function PrStateIcon({ state }: Readonly<{ state: GitHubPRState | null }>) {
  if (state === GitHubPRState.Merged) {
    return <GitMergeIcon className="h-4 w-4 shrink-0 text-muted-foreground" />;
  }
  return <GitBranchIcon className="h-4 w-4 shrink-0 text-muted-foreground" />;
}

function PrStateBadge({ state }: Readonly<{ state: GitHubPRState | null }>) {
  if (state === GitHubPRState.Merged) {
    return (
      <Badge
        className="border-purple-200 bg-purple-50 text-purple-700 dark:border-purple-800 dark:bg-purple-950/30 dark:text-purple-300"
        variant="outline"
      >
        Merged
      </Badge>
    );
  }
  if (state === GitHubPRState.Closed) {
    return (
      <Badge
        className="border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300"
        variant="outline"
      >
        Closed
      </Badge>
    );
  }
  return (
    <Badge
      className="border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950/30 dark:text-green-300"
      variant="outline"
    >
      Open
    </Badge>
  );
}
