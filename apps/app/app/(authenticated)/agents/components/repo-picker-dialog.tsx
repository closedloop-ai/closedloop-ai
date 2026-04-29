"use client";

import type { GitHubRepository } from "@repo/api/src/types/github";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { Checkbox } from "@repo/design-system/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { Input } from "@repo/design-system/components/ui/input";
import { Loader2Icon, SearchIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";
import {
  useGitHubIntegrationStatus,
  useGitHubRepositories,
} from "@/hooks/queries/use-github-integration";
import { sortRepositoriesByActivity } from "@/lib/sort-utils";

type RepoPickerDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (repos: Array<{ fullName: string }>) => void;
};

export function RepoPickerDialog({
  open,
  onOpenChange,
  onSubmit,
}: RepoPickerDialogProps) {
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const { data: githubStatus } = useGitHubIntegrationStatus();
  const { data: repositories, isLoading } = useGitHubRepositories({
    enabled: open && githubStatus?.connected === true,
  });

  const sortedRepos = useMemo(
    () => (repositories ? sortRepositoriesByActivity(repositories) : []),
    [repositories]
  );

  const filteredRepos = useMemo(() => {
    if (!search.trim()) {
      return sortedRepos;
    }
    const term = search.toLowerCase();
    return sortedRepos.filter((repo) =>
      repo.fullName.toLowerCase().includes(term)
    );
  }, [sortedRepos, search]);

  const selectedRepos = useMemo(
    () => sortedRepos.filter((r) => selectedIds.has(r.id)),
    [sortedRepos, selectedIds]
  );

  const toggleRepo = (repo: GitHubRepository) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(repo.id)) {
        next.delete(repo.id);
      } else {
        next.add(repo.id);
      }
      return next;
    });
  };

  const selectAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const r of filteredRepos) {
        next.add(r.id);
      }
      return next;
    });
  };

  const removeSelected = (repoId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(repoId);
      return next;
    });
  };

  const handleSubmit = () => {
    const repos = selectedRepos.map((r) => ({ fullName: r.fullName }));
    onSubmit(repos);
    handleClose();
  };

  const handleClose = () => {
    setSearch("");
    setSelectedIds(new Set());
    onOpenChange(false);
  };

  return (
    <Dialog onOpenChange={handleClose} open={open}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Select repositories to scan</DialogTitle>
          <DialogDescription>
            Choose which repositories to scan for generating agents.
          </DialogDescription>
        </DialogHeader>

        {selectedRepos.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {selectedRepos.map((repo) => (
              <Badge className="gap-1 pr-1" key={repo.id} variant="secondary">
                {repo.fullName}
                <button
                  className="ml-0.5 rounded-sm hover:bg-muted"
                  onClick={() => removeSelected(repo.id)}
                  type="button"
                >
                  <XIcon className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}

        <div className="relative">
          <SearchIcon className="absolute top-2.5 left-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-8"
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search repositories..."
            value={search}
          />
        </div>

        <div className="flex items-center justify-between">
          <span className="text-muted-foreground text-sm">
            {selectedIds.size} selected
          </span>
          <Button
            disabled={filteredRepos.length === 0}
            onClick={selectAll}
            size="sm"
            variant="ghost"
          >
            Select All
          </Button>
        </div>

        <RepoList
          filteredRepos={filteredRepos}
          isLoading={isLoading}
          search={search}
          selectedIds={selectedIds}
          toggleRepo={toggleRepo}
        />

        <DialogFooter>
          <Button onClick={handleClose} variant="outline">
            Cancel
          </Button>
          <Button disabled={selectedIds.size === 0} onClick={handleSubmit}>
            Generate Agents
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RepoList({
  isLoading,
  filteredRepos,
  search,
  selectedIds,
  toggleRepo,
}: Readonly<{
  isLoading: boolean;
  filteredRepos: GitHubRepository[];
  search: string;
  selectedIds: Set<string>;
  toggleRepo: (repo: GitHubRepository) => void;
}>) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center rounded-md border py-8">
        <Loader2Icon className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (filteredRepos.length === 0) {
    return (
      <div className="rounded-md border py-8 text-center text-muted-foreground text-sm">
        {search
          ? "No repositories match your search."
          : "No repositories found."}
      </div>
    );
  }

  return (
    <div className="max-h-64 overflow-y-auto rounded-md border">
      <ul className="divide-y">
        {filteredRepos.map((repo) => {
          const checkboxId = `repo-${repo.id}`;
          return (
            <li key={repo.id}>
              <label
                className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-muted/50"
                htmlFor={checkboxId}
              >
                <Checkbox
                  checked={selectedIds.has(repo.id)}
                  id={checkboxId}
                  onCheckedChange={() => toggleRepo(repo)}
                />
                <div className="min-w-0 flex-1">
                  <span className="text-sm">{repo.fullName}</span>
                  {repo.private && (
                    <Badge className="ml-2" variant="outline">
                      Private
                    </Badge>
                  )}
                </div>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
