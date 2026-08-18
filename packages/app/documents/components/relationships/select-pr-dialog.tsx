"use client";

import {
  ArtifactType,
  LinkDirection,
  LinkQueryMode,
  LinkType,
} from "@repo/api/src/types/artifact";
import {
  GitHubPRState,
  type GitHubPullRequestSummary,
} from "@repo/api/src/types/github";
import type {
  CreatePrArtifactInput,
  CreatePrArtifactResponse,
} from "@repo/api/src/types/pull-request-artifact-link";
import {
  buildLinkedPullRequestToast,
  LinkedPullRequestToastTone,
} from "@repo/app/documents/components/relationships/linked-pr-toast";
import {
  useCreateArtifactLink,
  useResolvedArtifactLinks,
} from "@repo/app/documents/hooks/use-artifact-links";
import {
  type TaggedPullRequest,
  useGitHubPullRequestsAcrossRepos,
} from "@repo/app/github/hooks/use-github-integration";
import { useResolvedJobRepos } from "@repo/app/loops/hooks/use-resolved-job-repos";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
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
import { useMutation } from "@tanstack/react-query";
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  GitBranchIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  LinkIcon,
  Loader2Icon,
  XCircleIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

type SelectPullRequestDialogProps = {
  documentId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  planId?: string | null;
  projectId: string;
};

// PR artifact creation posts to /artifact-links/pull-requests, which both
// creates the PR artifact and links it to the source document/project.
//
// ISS-4764: the request/response shape is owned by
// `@repo/api/src/types/pull-request-artifact-link` and imported, never
// re-declared. The hand-written copy that used to live here was structurally
// valid on its own, so `tsc` could not see it drift from the route's schema.
function useCreateBranchArtifact() {
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: CreatePrArtifactInput) =>
      apiClient.post<CreatePrArtifactResponse>(
        "/artifact-links/pull-requests",
        input
      ),
  });
}

export function SelectPullRequestDialog({
  documentId,
  open,
  onOpenChange,
  planId,
  projectId,
}: Readonly<SelectPullRequestDialogProps>) {
  const [isLinking, setIsLinking] = useState(false);
  const createBranchArtifact = useCreateBranchArtifact();
  const createArtifactLink = useCreateArtifactLink();
  // The PLAN owns the branch relationship link (planId first), matching how the
  // rest of the branch surface attributes work to the plan when one exists.
  const linkSourceId = planId ?? documentId ?? null;
  // ISS-4664: but the tags to propagate are the *implementing issue's* tags, so
  // the label source is the ISS document first (documentId), independent of the
  // relationship owner. Plan tags are a separate set; on the common
  // issue-with-plan flow, reading them here would miss the ISS tags the feature
  // is supposed to carry. Fall back to the plan only when there is no issue
  // document (e.g. a plan-only surface).
  const tagSourceArtifactId = documentId ?? planId ?? null;

  // Resolve the project's repos via the post-PLN-237 chain: project
  // override → single-team inheritance.
  const resolved = useResolvedJobRepos({
    projectId,
    enabled: open && !!projectId,
  });
  const repoId = resolved.primary?.id ?? null;
  const isResolvingRepo = resolved.isLoading;

  // Deduplicate primary + additional by repo id so we don't query the same
  // repo twice when it appears in both slots.
  const repos = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ id: string; fullName?: string }> = [];
    if (resolved.primary?.id) {
      seen.add(resolved.primary.id);
      out.push({
        id: resolved.primary.id,
        fullName: resolved.primary.fullName,
      });
    }
    for (const repo of resolved.additional) {
      if (repo.id && !seen.has(repo.id)) {
        seen.add(repo.id);
        out.push({ id: repo.id, fullName: repo.fullName });
      }
    }
    return out;
  }, [resolved.primary, resolved.additional]);

  const {
    pullRequests: allPullRequests,
    trackedBranchKeys,
    trackedUrls,
    isLoading: isLoadingPullRequests,
    failedRepoCount,
    hasMore: hasMorePullRequests,
    totalRepoCount,
    truncated: truncatedPullRequests,
    allFailed,
  } = useGitHubPullRequestsAcrossRepos(repos, projectId, { enabled: open });

  const { data: resolvedLinks = [], isLoading: isLoadingSourceResolvedLinks } =
    useResolvedArtifactLinks(linkSourceId ?? "", {
      direction: LinkDirection.Target,
      enabled: open && !!linkSourceId,
      linkType: LinkType.Produces,
      mode: LinkQueryMode.Direct,
    });

  const linkedUrls = useMemo(() => {
    const urls = new Set<string>();
    for (const link of resolvedLinks) {
      if (link.target.type !== ArtifactType.Branch) {
        continue;
      }
      if (link.target.branch?.currentPullRequest?.htmlUrl) {
        urls.add(link.target.branch.currentPullRequest.htmlUrl);
      }
      if (link.target.externalUrl) {
        urls.add(link.target.externalUrl);
      }
    }
    return urls;
  }, [resolvedLinks]);

  const visiblePullRequests = useMemo(
    () =>
      allPullRequests.filter((pr) => {
        const branchKey =
          pr.repoFullName === undefined
            ? null
            : `${pr.repoFullName}:${pr.headBranch}`;
        const isTracked = trackedUrls.has(pr.htmlUrl);
        const isTrackedBranch =
          branchKey !== null && trackedBranchKeys.has(branchKey);
        const isLinked = linkedUrls.has(pr.htmlUrl);
        return !(isTracked || isTrackedBranch) || isLinked;
      }),
    [allPullRequests, linkedUrls, trackedBranchKeys, trackedUrls]
  );

  async function handleSelect(pr: TaggedPullRequest) {
    if (
      !linkSourceId ||
      linkedUrls.has(pr.htmlUrl) ||
      trackedUrls.has(pr.htmlUrl) ||
      (pr.repoFullName !== undefined &&
        trackedBranchKeys.has(`${pr.repoFullName}:${pr.headBranch}`)) ||
      isLinking ||
      isLoadingSourceResolvedLinks
    ) {
      return;
    }

    setIsLinking(true);
    try {
      const pullRequestArtifact = await createBranchArtifact.mutateAsync({
        projectId,
        title: `PR #${pr.number}: ${pr.title}`,
        externalUrl: pr.htmlUrl,
        number: pr.number,
        githubId: pr.githubId,
        headBranch: pr.headBranch,
        baseBranch: pr.baseBranch,
        headSha: pr.headSha,
        state: pr.state,
        isDraft: pr.isDraft,
        closedAt: pr.closedAt,
        mergedAt: pr.mergedAt,
        mergeCommitSha: pr.mergeCommitSha,
        // Tags come from the implementing issue, not the plan that owns the
        // link (see tagSourceArtifactId above) — ISS-4664.
        sourceArtifactId: tagSourceArtifactId ?? undefined,
        // ISS-4759: ask the API to write the PRODUCES link inside the same
        // transaction as the branch upsert, so GitHub is never labelled against
        // a relationship this client failed to write afterwards.
        linkSourceArtifactId: linkSourceId,
      });

      // Only write the link here when the API did NOT. An API that predates
      // ISS-4759 ignores `linkSourceArtifactId` and echoes nothing back, so the
      // out-of-band write is still needed; a newer one already committed it
      // transactionally and repeating it would be a pointless round trip.
      if (pullRequestArtifact.linkedSourceArtifactId !== linkSourceId) {
        await createArtifactLink.mutateAsync({
          sourceId: linkSourceId,
          targetId: pullRequestArtifact.id,
          linkType: LinkType.Produces,
        });
      }

      showLinkedPullRequestToast(pr.number, pullRequestArtifact);
      onOpenChange(false);
    } finally {
      setIsLinking(false);
    }
  }

  if (open && !linkSourceId) {
    return (
      <Dialog onOpenChange={onOpenChange} open={open}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Select Existing PR</DialogTitle>
            <DialogDescription className="sr-only">
              Link an existing pull request
            </DialogDescription>
          </DialogHeader>
          <Alert variant="warning">
            <AlertCircleIcon />
            <AlertDescription>
              No document is available to link this pull request.
            </AlertDescription>
          </Alert>
        </DialogContent>
      </Dialog>
    );
  }

  // No repo configured — wait until the resolver finishes so we don't show
  // the "no repo" message during the initial load.
  if (open && !isResolvingRepo && !repoId) {
    return (
      <Dialog onOpenChange={onOpenChange} open={open}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Select Existing PR</DialogTitle>
            <DialogDescription className="sr-only">
              Link an existing pull request to this feature
            </DialogDescription>
          </DialogHeader>
          <Alert variant="warning">
            <AlertCircleIcon />
            <AlertDescription>
              No repository configured for this project. Configure a default
              repository in project settings to browse pull requests.
            </AlertDescription>
          </Alert>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Select Existing PR</DialogTitle>
          <DialogDescription>
            Tags on this feature are applied to the pull request as GitHub
            labels.
          </DialogDescription>
        </DialogHeader>
        {isLinking && (
          <div className="flex items-center justify-center gap-2 py-2">
            <Loader2Icon className="h-4 w-4 animate-spin text-muted-foreground" />
            <span className="text-muted-foreground text-sm">Linking PR...</span>
          </div>
        )}
        {isLoadingSourceResolvedLinks &&
          !isLinking &&
          (trackedUrls.size > 0 || trackedBranchKeys.size > 0) && (
            <div className="flex items-center justify-center gap-2 py-2">
              <Loader2Icon className="h-4 w-4 animate-spin text-muted-foreground" />
              <span className="text-muted-foreground text-sm">
                Checking existing PR links...
              </span>
            </div>
          )}
        {allFailed && (
          <Alert variant="destructive">
            <XCircleIcon />
            <AlertDescription>
              Failed to load pull requests from all repositories. Check your
              GitHub integration settings.
            </AlertDescription>
          </Alert>
        )}
        {!allFailed && failedRepoCount > 0 && (
          <Alert aria-live="polite" role="status" variant="warning">
            <AlertTriangleIcon />
            <AlertDescription>
              Could not load PRs from {failedRepoCount} of {totalRepoCount}{" "}
              repositories. Showing results from the remaining repositories.
            </AlertDescription>
          </Alert>
        )}
        {!allFailed && (hasMorePullRequests || truncatedPullRequests) && (
          <Alert aria-live="polite" role="status" variant="warning">
            <AlertTriangleIcon />
            <AlertDescription>
              Some older pull requests may be omitted from this bounded GitHub
              read.
            </AlertDescription>
          </Alert>
        )}
        {!allFailed && (
          <Command
            className="rounded-lg border"
            label="Search pull requests"
            shouldFilter
          >
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
                    isLinked || isLinking || isLoadingSourceResolvedLinks;
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
                      key={pr.htmlUrl}
                      // mutateAsync re-throws after the global onError toast;
                      // swallow so the fire-and-forget select can't reject.
                      onSelect={() => {
                        handleSelect(pr).catch(() => {
                          // already surfaced via the global mutation onError
                        });
                      }}
                      value={`#${pr.number} ${pr.title} ${pr.headBranch} ${pr.author} ${pr.repoFullName ?? ""}`}
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
                        {totalRepoCount > 1 && pr.repoFullName && (
                          <div className="flex items-center gap-2 text-muted-foreground text-xs">
                            <Badge
                              className="shrink-0 font-normal"
                              variant="outline"
                            >
                              {pr.repoFullName}
                            </Badge>
                          </div>
                        )}
                      </div>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        )}
      </DialogContent>
    </Dialog>
  );
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

/**
 * ISS-4764: route the link confirmation through the tone its outcome deserves.
 * Two of the outcomes `buildLinkedPullRequestToast` produces are failures, and
 * sending those out through `toast.success` told the user the labels were fine
 * when they were not — the same success/warning split `move-entity-dialog.tsx`
 * already uses for a partial batch move.
 */
function showLinkedPullRequestToast(
  prNumber: number,
  response: CreatePrArtifactResponse
): void {
  const { tone, message } = buildLinkedPullRequestToast(
    prNumber,
    response.labelSync
  );
  if (tone === LinkedPullRequestToastTone.Warning) {
    toast.warning(message);
    return;
  }
  toast.success(message);
}
