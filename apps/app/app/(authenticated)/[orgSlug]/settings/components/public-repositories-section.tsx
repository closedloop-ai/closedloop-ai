"use client";

import { GitHubRepositorySource } from "@repo/api/src/types/github";
import {
  useAddPublicRepository,
  useGitHubRepositories,
  useRemovePublicRepository,
} from "@repo/app/github/hooks/use-github-integration";
import { getErrorMessage } from "@repo/app/shared/api/api-error";
import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { GithubIcon, Loader2Icon, Trash2Icon } from "lucide-react";
import { type FormEvent, useState } from "react";

type PublicRepo = {
  id: string;
  fullName: string;
};

function PublicRepoList({
  isLoading,
  removingIds,
  onRemove,
  repos,
}: Readonly<{
  isLoading: boolean;
  removingIds: Set<string>;
  onRemove: (id: string) => void;
  repos: PublicRepo[];
}>) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <Loader2Icon className="h-4 w-4 animate-spin" />
        Loading repositories...
      </div>
    );
  }

  if (repos.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No public repositories added yet.
      </p>
    );
  }

  return (
    <ul className="space-y-1">
      {repos.map((repo) => (
        <li
          className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
          key={repo.id}
        >
          <div className="flex items-center gap-2 text-sm">
            <GithubIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
            <a
              className="text-foreground hover:underline"
              href={`https://github.com/${repo.fullName}`}
              rel="noopener noreferrer"
              target="_blank"
            >
              {repo.fullName}
            </a>
          </div>
          <Button
            disabled={removingIds.has(repo.id)}
            onClick={() => onRemove(repo.id)}
            size="sm"
            variant="ghost"
          >
            {removingIds.has(repo.id) ? (
              <Loader2Icon className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2Icon className="h-4 w-4" />
            )}
            <span className="sr-only">Remove {repo.fullName}</span>
          </Button>
        </li>
      ))}
    </ul>
  );
}

export function PublicRepositoriesSection() {
  const [url, setUrl] = useState("");
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set());
  const { data: repositories, isLoading } = useGitHubRepositories();
  const addMutation = useAddPublicRepository();
  const removeMutation = useRemovePublicRepository();

  const publicRepos =
    repositories?.filter(
      (repo) => repo.source === GitHubRepositorySource.Public
    ) ?? [];

  const handleAdd = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) {
      return;
    }
    addMutation.mutate(
      { url: trimmed },
      {
        onSuccess: () => {
          setUrl("");
        },
      }
    );
  };

  const handleRemove = (id: string) => {
    setRemovingIds((prev) => new Set(prev).add(id));
    removeMutation.mutate(id, {
      onSettled: () => {
        setRemovingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      },
    });
  };

  const addError = addMutation.error
    ? getErrorMessage(addMutation.error)
    : null;

  return (
    <div className="space-y-4">
      <div>
        <p className="font-medium text-sm">Public Repositories</p>
        <p className="text-muted-foreground text-sm">
          Add public GitHub repositories by URL. Accepts{" "}
          <code className="text-xs">https://github.com/owner/repo</code>,{" "}
          <code className="text-xs">github.com/owner/repo</code>, or{" "}
          <code className="text-xs">owner/repo</code>.
        </p>
      </div>

      <PublicRepoList
        isLoading={isLoading}
        onRemove={handleRemove}
        removingIds={removingIds}
        repos={publicRepos}
      />

      <form className="space-y-2" onSubmit={handleAdd}>
        <div className="flex gap-2">
          <Input
            aria-label="Repository URL"
            className="flex-1"
            disabled={addMutation.isPending}
            onChange={(e) => {
              setUrl(e.target.value);
              if (addMutation.isError) {
                addMutation.reset();
              }
            }}
            placeholder="owner/repo or https://github.com/owner/repo"
            value={url}
          />
          <Button disabled={!url.trim() || addMutation.isPending} type="submit">
            {addMutation.isPending ? (
              <>
                <Loader2Icon className="h-4 w-4 animate-spin" />
                Adding...
              </>
            ) : (
              "Add"
            )}
          </Button>
        </div>
        {addError ? (
          <p className="text-destructive text-sm">{addError}</p>
        ) : null}
      </form>
    </div>
  );
}
