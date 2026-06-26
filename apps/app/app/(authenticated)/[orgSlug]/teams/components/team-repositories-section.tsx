"use client";

import type { GitHubRepository } from "@repo/api/src/types/github";
import { useGitHubRepositories } from "@repo/app/github/hooks/use-github-integration";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@repo/design-system/components/ui/alert-dialog";
import { Button } from "@repo/design-system/components/ui/button";
import { Checkbox } from "@repo/design-system/components/ui/checkbox";
import { Label } from "@repo/design-system/components/ui/label";
import {
  RadioGroup,
  RadioGroupItem,
} from "@repo/design-system/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { LoaderIcon, PlusIcon, StarIcon, TrashIcon } from "lucide-react";
import { useMemo, useState } from "react";
import type { TeamModalState, TeamRepositoryDraft } from "./use-team-modal";

type TeamRepositoriesSectionProps = {
  state: TeamModalState;
  enabled: boolean;
};

export function TeamRepositoriesSection({
  state,
  enabled,
}: TeamRepositoriesSectionProps) {
  const {
    isCurrentUserTeamAdmin: isAdmin,
    loadingConfiguredRepos,
    repoDrafts,
    stageAddRepo,
    stageRemoveRepo,
    stageSetPrimary,
    stageToggleDefault,
  } = state;

  const { data: orgRepos = [], isLoading: loadingOrgRepos } =
    useGitHubRepositories({ enabled: enabled && isAdmin });

  const [selectedRepoId, setSelectedRepoId] = useState("");
  const [primaryConfirmTarget, setPrimaryConfirmTarget] =
    useState<TeamRepositoryDraft | null>(null);

  const drafts = repoDrafts ?? [];

  const availableRepos = useMemo(() => {
    const stagedIds = new Set(drafts.map((d) => d.installationRepositoryId));
    return orgRepos.filter((r) => !stagedIds.has(r.id));
  }, [drafts, orgRepos]);

  const primaryDraftId = drafts.find((d) => d.isPrimary)?.draftId ?? "";

  const handleAdd = () => {
    if (!selectedRepoId) {
      return;
    }
    const repo = orgRepos.find((r) => r.id === selectedRepoId);
    if (!repo) {
      return;
    }
    stageAddRepo(repo);
    setSelectedRepoId("");
  };

  const handleToggleDefault = (draft: TeamRepositoryDraft, next: boolean) => {
    // Un-defaulting a primary clears primary too — confirm before applying.
    if (!next && draft.isPrimary) {
      setPrimaryConfirmTarget(draft);
      return;
    }
    stageToggleDefault(draft.draftId, next);
  };

  const handleConfirmUnDefaultPrimary = () => {
    if (!primaryConfirmTarget) {
      return;
    }
    stageToggleDefault(primaryConfirmTarget.draftId, false);
    setPrimaryConfirmTarget(null);
  };

  const showCenteredArea = loadingConfiguredRepos || drafts.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <Label>Repositories</Label>
      <p className="text-muted-foreground text-xs">
        Curate which org repositories this team works with. Mark some as
        selected by default for new jobs, and pick exactly one as the team's
        primary. Changes apply when you save.
      </p>

      {isAdmin ? (
        <div className="flex gap-2">
          <Select onValueChange={setSelectedRepoId} value={selectedRepoId}>
            <SelectTrigger className="flex-1">
              <SelectValue placeholder="Select a repository to add..." />
            </SelectTrigger>
            <SelectContent>
              <RepoSelectContent
                loading={loadingOrgRepos}
                repos={availableRepos}
              />
            </SelectContent>
          </Select>
          <Button
            aria-label="Add repository"
            disabled={!selectedRepoId || repoDrafts === null}
            onClick={handleAdd}
            size="icon"
            type="button"
            variant="outline"
          >
            <PlusIcon className="h-4 w-4" />
          </Button>
        </div>
      ) : null}

      <div
        className={`min-h-0 flex-1 overflow-y-auto ${
          showCenteredArea ? "flex items-center justify-center" : ""
        }`}
      >
        {loadingConfiguredRepos ? (
          <LoaderIcon className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : (
          <DraftRepoList
            drafts={drafts}
            isAdmin={isAdmin}
            onRemove={(d) => stageRemoveRepo(d.draftId)}
            onSetPrimary={stageSetPrimary}
            onToggleDefault={handleToggleDefault}
            primaryDraftId={primaryDraftId}
          />
        )}
      </div>

      <AlertDialog
        onOpenChange={(open) => {
          if (!open) {
            setPrimaryConfirmTarget(null);
          }
        }}
        open={primaryConfirmTarget !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove primary repository?</AlertDialogTitle>
            <AlertDialogDescription>
              {primaryConfirmTarget
                ? `${primaryConfirmTarget.repository.fullName} is the team's primary repository. Un-checking "selected by default" will also clear its primary designation. The team will have no primary until you pick a new one.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmUnDefaultPrimary}>
              Remove from defaults
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

type RepoSelectContentProps = {
  loading: boolean;
  repos: GitHubRepository[];
};

function RepoSelectContent({ loading, repos }: RepoSelectContentProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center p-2">
        <LoaderIcon className="h-4 w-4 animate-spin" />
      </div>
    );
  }
  if (repos.length === 0) {
    return (
      <div className="p-2 text-center text-muted-foreground text-sm">
        No additional repositories available
      </div>
    );
  }
  return (
    <>
      {repos.map((repo) => (
        <SelectItem key={repo.id} value={repo.id}>
          {repo.fullName}
        </SelectItem>
      ))}
    </>
  );
}

type DraftRepoListProps = {
  drafts: TeamRepositoryDraft[];
  isAdmin: boolean;
  onRemove: (draft: TeamRepositoryDraft) => void;
  onSetPrimary: (draftId: string) => void;
  onToggleDefault: (draft: TeamRepositoryDraft, next: boolean) => void;
  primaryDraftId: string;
};

function DraftRepoList({
  drafts,
  isAdmin,
  onRemove,
  onSetPrimary,
  onToggleDefault,
  primaryDraftId,
}: DraftRepoListProps) {
  if (drafts.length === 0) {
    return (
      <p className="text-center text-muted-foreground text-sm">
        No repositories configured. {isAdmin ? "Add one above." : ""}
      </p>
    );
  }
  return (
    <RadioGroup
      className="space-y-2"
      disabled={!isAdmin}
      onValueChange={onSetPrimary}
      value={primaryDraftId}
    >
      {drafts.map((draft) => (
        <DraftRepoRow
          draft={draft}
          isAdmin={isAdmin}
          key={draft.draftId}
          onRemove={onRemove}
          onToggleDefault={onToggleDefault}
        />
      ))}
    </RadioGroup>
  );
}

type DraftRepoRowProps = {
  draft: TeamRepositoryDraft;
  isAdmin: boolean;
  onRemove: (draft: TeamRepositoryDraft) => void;
  onToggleDefault: (draft: TeamRepositoryDraft, next: boolean) => void;
};

function DraftRepoRow({
  draft,
  isAdmin,
  onRemove,
  onToggleDefault,
}: DraftRepoRowProps) {
  const defaultId = `team-repo-default-${draft.draftId}`;
  const primaryId = `team-repo-primary-${draft.draftId}`;
  return (
    <div
      className={`flex items-center justify-between rounded-md border p-2 ${
        draft.isPrimary ? "border-primary/40 bg-primary/5" : ""
      }`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex items-center gap-1.5">
          <Checkbox
            checked={draft.isDefaultSelected}
            disabled={!isAdmin}
            id={defaultId}
            onCheckedChange={(checked) =>
              onToggleDefault(draft, checked === true)
            }
          />
          <Label className="text-muted-foreground text-xs" htmlFor={defaultId}>
            Default
          </Label>
        </div>
        <div className="flex items-center gap-1.5">
          <RadioGroupItem id={primaryId} value={draft.draftId} />
          <Label className="text-muted-foreground text-xs" htmlFor={primaryId}>
            Primary
          </Label>
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          {draft.isPrimary ? (
            <StarIcon className="h-3.5 w-3.5 fill-primary text-primary" />
          ) : null}
          <span
            className={`truncate text-sm ${draft.isPrimary ? "font-semibold" : ""}`}
          >
            {draft.repository.fullName}
          </span>
        </div>
      </div>
      {isAdmin ? (
        <Button
          aria-label="Remove repository"
          className="h-7 w-7 text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => onRemove(draft)}
          size="icon"
          type="button"
          variant="ghost"
        >
          <TrashIcon className="h-3.5 w-3.5" />
        </Button>
      ) : null}
    </div>
  );
}
