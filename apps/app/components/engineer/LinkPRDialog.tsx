"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { cn } from "@repo/design-system/lib/utils";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  FolderGit2,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Loader2,
  User,
} from "lucide-react";
import { useState } from "react";
import { type PRListItem, prListOptions } from "@/lib/engineer/queries/git";
import { reposOptions } from "@/lib/engineer/queries/repos";
import type { ConfiguredRepo } from "@/types/repos";

type LinkPRDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ticketId: string;
  onLinked: (prUrl: string, prNumber: number, repoPath: string) => void;
};

type Step = "repo" | "pr";

export function LinkPRDialog({
  open,
  onOpenChange,
  ticketId,
  onLinked,
}: Readonly<LinkPRDialogProps>) {
  const [step, setStep] = useState<Step>("repo");
  const [selectedRepo, setSelectedRepo] = useState<ConfiguredRepo | null>(null);
  const [prState, setPrState] = useState<"open" | "merged">("open");

  // Fetch repos
  const { data: reposData, isLoading: isLoadingRepos } = useQuery({
    ...reposOptions(),
    enabled: open,
  });

  // Fetch PRs for selected repo
  const { data: prData, isLoading: isLoadingPRs } = useQuery({
    ...prListOptions(selectedRepo?.path || "", prState),
    enabled: open && step === "pr" && !!selectedRepo,
  });

  const handleSelectRepo = (repo: ConfiguredRepo) => {
    setSelectedRepo(repo);
    setPrState("open");
    setStep("pr");
  };

  const handleSelectPR = (pr: PRListItem) => {
    if (!selectedRepo) {
      return;
    }
    onLinked(pr.url, pr.number, selectedRepo.path);
    handleClose();
  };

  const handleBack = () => {
    setStep("repo");
    setSelectedRepo(null);
  };

  const handleClose = () => {
    setStep("repo");
    setSelectedRepo(null);
    setPrState("open");
    onOpenChange(false);
  };

  const prs = prData?.prs || [];

  return (
    <Dialog onOpenChange={handleClose} open={open}>
      <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {step === "pr" && (
              <Button
                className="size-7 p-0"
                onClick={handleBack}
                size="sm"
                variant="ghost"
              >
                <ArrowLeft className="size-4" />
              </Button>
            )}
            <GitPullRequest className="size-5" />
            {step === "repo" ? "Link PR" : "Select PR"}
          </DialogTitle>
          <DialogDescription>
            {step === "repo"
              ? `Link an existing pull request to ${ticketId}`
              : `Select a PR from ${selectedRepo?.name}`}
          </DialogDescription>
        </DialogHeader>

        {step === "repo" && (
          <RepoStep
            isLoading={isLoadingRepos}
            onSelect={handleSelectRepo}
            repos={reposData?.repos || []}
          />
        )}

        {step === "pr" && selectedRepo && (
          <PRStep
            isLoading={isLoadingPRs}
            onSelect={handleSelectPR}
            onStateChange={setPrState}
            prState={prState}
            prs={prs}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

export function RepoStep({
  repos,
  isLoading,
  onSelect,
}: Readonly<{
  repos: ConfiguredRepo[];
  isLoading: boolean;
  onSelect: (repo: ConfiguredRepo) => void;
}>) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (repos.length === 0) {
    return (
      <div className="py-8 text-center text-muted-foreground text-sm">
        No repositories configured. Add one in Settings.
      </div>
    );
  }

  return (
    <div className="flex max-h-[50vh] flex-col gap-1 overflow-y-auto">
      {repos.map((repo) => (
        <button
          className={cn(
            "flex items-center gap-3 rounded-lg px-3 py-2.5 text-left outline-none",
            "cursor-pointer transition-colors hover:bg-muted/50"
          )}
          key={repo.path}
          onClick={() => onSelect(repo)}
          type="button"
        >
          <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium text-sm">{repo.name}</div>
            <div className="truncate text-muted-foreground text-xs">
              {repo.path}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

export function PRStep({
  prs,
  isLoading,
  prState,
  onStateChange,
  onSelect,
}: Readonly<{
  prs: PRListItem[];
  isLoading: boolean;
  prState: "open" | "merged";
  onStateChange: (state: "open" | "merged") => void;
  onSelect: (pr: PRListItem) => void;
}>) {
  return (
    <div className="flex min-h-0 flex-col gap-3">
      {/* State toggle */}
      <div className="flex shrink-0 gap-1 rounded-lg bg-muted p-1">
        <button
          className={cn(
            "flex-1 cursor-pointer rounded-md px-3 py-1.5 font-medium text-xs transition-colors",
            prState === "open"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
          onClick={() => onStateChange("open")}
          type="button"
        >
          Open
        </button>
        <button
          className={cn(
            "flex-1 cursor-pointer rounded-md px-3 py-1.5 font-medium text-xs transition-colors",
            prState === "merged"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
          onClick={() => onStateChange("merged")}
          type="button"
        >
          Merged
        </button>
      </div>

      {/* PR list */}
      <div className="flex max-h-[50vh] flex-col divide-y divide-border/50 overflow-y-auto">
        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {!isLoading && prs.length === 0 && (
          <div className="py-8 text-center text-muted-foreground text-sm">
            No {prState} pull requests found.
          </div>
        )}

        {!isLoading &&
          prs.map((pr) => (
            <button
              className={cn(
                "flex items-start gap-3 px-3 py-3 text-left",
                "cursor-pointer transition-colors hover:bg-muted/50"
              )}
              key={pr.number}
              onClick={() => onSelect(pr)}
              type="button"
            >
              {prState === "merged" ? (
                <GitMerge className="mt-0.5 size-4 shrink-0 text-violet-500" />
              ) : (
                <GitPullRequest className="mt-0.5 size-4 shrink-0 text-emerald-500" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70">
                    #{pr.number}
                  </span>
                  <span className="truncate font-medium text-sm">
                    {pr.title}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-3 text-[11px] text-muted-foreground">
                  <span className="flex shrink-0 items-center gap-1">
                    <User className="size-3" />
                    {pr.author}
                  </span>
                  <span className="flex min-w-0 items-center gap-1">
                    <GitBranch className="size-3 shrink-0" />
                    <span className="truncate font-mono">{pr.headRefName}</span>
                  </span>
                </div>
              </div>
            </button>
          ))}
      </div>
    </div>
  );
}
