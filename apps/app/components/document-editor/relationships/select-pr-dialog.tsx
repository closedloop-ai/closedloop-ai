"use client";

import {
  EntityType,
  LinkDirection,
  type LinkedEntity,
  LinkQueryMode,
  LinkType,
} from "@repo/api/src/types/entity-link";
import {
  ExternalLinkType,
  type PullRequestMetadata,
} from "@repo/api/src/types/external-link";
import {
  GitHubPRState,
  type GitHubPullRequestSummary,
} from "@repo/api/src/types/github";
import { getProjectSettings } from "@repo/api/src/types/project";
import { Badge } from "@repo/design-system/components/ui/badge";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@repo/design-system/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { toast } from "@repo/design-system/components/ui/sonner";
import { cn } from "@repo/design-system/lib/utils";
import {
  AlertCircleIcon,
  GitBranchIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  LinkIcon,
  Loader2Icon,
  XCircleIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  useCreateEntityLink,
  useLinkedEntities,
} from "@/hooks/queries/use-entity-links";
import { useCreateExternalLink } from "@/hooks/queries/use-external-links";
import { useGitHubPullRequests } from "@/hooks/queries/use-github-integration";
import { useProject } from "@/hooks/queries/use-projects";

type SelectPullRequestDialogProps = {
  documentId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  planId?: string | null;
  projectId: string;
};

export function SelectPullRequestDialog({
  documentId,
  open,
  onOpenChange,
  planId,
  projectId,
}: Readonly<SelectPullRequestDialogProps>) {
  const [isLinking, setIsLinking] = useState(false);
  const { data: project } = useProject(projectId, { enabled: !!projectId });
  const createExternalLink = useCreateExternalLink();
  const createEntityLink = useCreateEntityLink();
  const linkSource = useMemo(() => {
    if (planId) {
      return {
        id: planId,
        type: EntityType.Document,
      };
    }

    if (documentId) {
      return {
        id: documentId,
        type: EntityType.Document,
      };
    }

    return null;
  }, [documentId, planId]);

  const repoId = useMemo(() => {
    if (!project?.settings) {
      return null;
    }
    const settings = getProjectSettings(project.settings);
    return settings.defaultRepository?.repoId ?? null;
  }, [project?.settings]);

  const { data, isLoading: isLoadingPullRequests } = useGitHubPullRequests(
    repoId ?? "",
    projectId,
    {
      enabled: open && !!repoId,
    }
  );

  const {
    data: linkedEntities = [],
    isLoading: isLoadingSourceLinkedEntities,
  } = useLinkedEntities(
    linkSource?.id ?? "",
    linkSource?.type ?? EntityType.Document,
    {
      direction: LinkDirection.Target,
      enabled: open && !!linkSource,
      linkType: LinkType.Produces,
      mode: LinkQueryMode.Direct,
    }
  );

  const pullRequests = data?.pullRequests ?? [];
  const trackedUrls = useMemo(
    () => new Set(data?.trackedPrUrls ?? []),
    [data?.trackedPrUrls]
  );
  const linkedUrls = useMemo(
    () => getLinkedPullRequestUrls(linkedEntities),
    [linkedEntities]
  );
  const visiblePullRequests = useMemo(
    () =>
      pullRequests.filter((pr) => {
        const isTracked = trackedUrls.has(pr.htmlUrl);
        return !isTracked || linkedUrls.has(pr.htmlUrl);
      }),
    [linkedUrls, pullRequests, trackedUrls]
  );

  async function handleSelect(pr: GitHubPullRequestSummary) {
    if (
      !linkSource ||
      linkedUrls.has(pr.htmlUrl) ||
      trackedUrls.has(pr.htmlUrl) ||
      isLinking ||
      isLoadingSourceLinkedEntities
    ) {
      return;
    }

    setIsLinking(true);
    try {
      const externalLink = await createExternalLink.mutateAsync({
        projectId,
        documentId: planId ?? undefined,
        type: ExternalLinkType.PullRequest,
        title: `PR #${pr.number}: ${pr.title}`,
        externalUrl: pr.htmlUrl,
        metadata: {
          number: pr.number,
          githubId: pr.githubId,
          headBranch: pr.headBranch,
          baseBranch: pr.baseBranch,
          state: pr.state,
        } satisfies PullRequestMetadata,
      });

      await createEntityLink.mutateAsync({
        sourceId: linkSource.id,
        sourceType: linkSource.type,
        targetId: externalLink.id,
        targetType: EntityType.ExternalLink,
        linkType: LinkType.Produces,
      });

      toast.success(`Linked PR #${pr.number}`);
      onOpenChange(false);
    } finally {
      setIsLinking(false);
    }
  }

  if (open && !linkSource) {
    return (
      <Dialog onOpenChange={onOpenChange} open={open}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Select Existing PR</DialogTitle>
            <DialogDescription className="sr-only">
              Link an existing pull request
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/20">
            <AlertCircleIcon className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-500" />
            <p className="text-amber-900 text-sm dark:text-amber-200">
              No document is available to link this pull request.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // No repo configured
  if (open && project && !repoId) {
    return (
      <Dialog onOpenChange={onOpenChange} open={open}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Select Existing PR</DialogTitle>
            <DialogDescription className="sr-only">
              Link an existing pull request to this feature
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/20">
            <AlertCircleIcon className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-500" />
            <p className="text-amber-900 text-sm dark:text-amber-200">
              No repository configured for this project. Configure a default
              repository in project settings to browse pull requests.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Select Existing PR</DialogTitle>
          <DialogDescription className="sr-only">
            Link an existing pull request to this feature
          </DialogDescription>
        </DialogHeader>
        {isLinking && (
          <div className="flex items-center justify-center gap-2 py-2">
            <Loader2Icon className="h-4 w-4 animate-spin text-muted-foreground" />
            <span className="text-muted-foreground text-sm">Linking PR...</span>
          </div>
        )}
        {isLoadingSourceLinkedEntities &&
          !isLinking &&
          trackedUrls.size > 0 && (
            <div className="flex items-center justify-center gap-2 py-2">
              <Loader2Icon className="h-4 w-4 animate-spin text-muted-foreground" />
              <span className="text-muted-foreground text-sm">
                Checking existing PR links...
              </span>
            </div>
          )}
        <Command className="rounded-lg border" shouldFilter>
          <CommandInput placeholder="Search pull requests..." />
          <CommandList className="max-h-[400px]">
            <CommandEmpty>
              {isLoadingPullRequests
                ? "Loading pull requests..."
                : "No pull requests found."}
            </CommandEmpty>
            <CommandGroup>
              {visiblePullRequests.map((pr) => {
                const isLinked = linkedUrls.has(pr.htmlUrl);
                const isDisabled =
                  isLinked || isLinking || isLoadingSourceLinkedEntities;
                let linkStateBadge: React.ReactNode = null;

                if (isLinked) {
                  linkStateBadge = (
                    <Badge className="shrink-0" variant="secondary">
                      <LinkIcon className="mr-1 h-3 w-3" />
                      Linked
                    </Badge>
                  );
                }

                return (
                  <CommandItem
                    disabled={isDisabled}
                    key={pr.number}
                    onSelect={() => handleSelect(pr)}
                    value={`#${pr.number} ${pr.title} ${pr.headBranch} ${pr.author}`}
                  >
                    <PrStateIcon pr={pr} />
                    <div className="ml-2 flex min-w-0 flex-1 flex-col gap-0.5">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium text-sm">
                          #{pr.number} {pr.title}
                        </span>
                        {linkStateBadge}
                      </div>
                      <div className="flex items-center gap-2 text-muted-foreground text-xs">
                        <GitBranchIcon className="h-3 w-3" />
                        <span className="truncate">{pr.headBranch}</span>
                        <span>by {pr.author}</span>
                        <PrStateBadge pr={pr} />
                      </div>
                    </div>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function getLinkedPullRequestUrls(linkedEntities: LinkedEntity[] = []) {
  const linkedUrls = new Set<string>();

  for (const linked of linkedEntities) {
    if (linked.resolvedEntity?.type !== EntityType.ExternalLink) {
      continue;
    }

    const externalLink = linked.resolvedEntity.entity;
    if (
      externalLink.type === ExternalLinkType.PullRequest &&
      externalLink.externalUrl
    ) {
      linkedUrls.add(externalLink.externalUrl);
    }
  }

  return linkedUrls;
}

function PrStateIcon({ pr }: Readonly<{ pr: GitHubPullRequestSummary }>) {
  if (pr.state === GitHubPRState.Merged) {
    return <GitMergeIcon className="h-4 w-4 shrink-0 text-purple-500" />;
  }
  if (pr.state === GitHubPRState.Closed) {
    return <XCircleIcon className="h-4 w-4 shrink-0 text-red-500" />;
  }
  return (
    <GitPullRequestIcon
      className={cn(
        "h-4 w-4 shrink-0",
        pr.isDraft ? "text-muted-foreground" : "text-green-500"
      )}
    />
  );
}

function PrStateBadge({ pr }: Readonly<{ pr: GitHubPullRequestSummary }>) {
  if (pr.state === GitHubPRState.Merged) {
    return (
      <Badge
        className="border-purple-200 bg-purple-50 text-purple-700 dark:border-purple-800 dark:bg-purple-950/30 dark:text-purple-300"
        variant="outline"
      >
        Merged
      </Badge>
    );
  }
  if (pr.state === GitHubPRState.Closed) {
    return (
      <Badge
        className="border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300"
        variant="outline"
      >
        Closed
      </Badge>
    );
  }
  if (pr.isDraft) {
    return <Badge variant="outline">Draft</Badge>;
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
