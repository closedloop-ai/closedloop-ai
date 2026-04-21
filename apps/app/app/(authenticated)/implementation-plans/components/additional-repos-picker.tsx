"use client";

import type { AdditionalRepoRef } from "@repo/api/src/types/loop";
import { MAX_ADDITIONAL_REPOS } from "@repo/api/src/types/loop";
import { Button } from "@repo/design-system/components/ui/button";
import { PlusIcon, TrashIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { RepoBranchSelector } from "./repo-branch-selector";

// Internal type — repoId is needed for Select value binding but is not part of AdditionalRepoRef
type AdditionalRepoRow = {
  id: string;
  repoId: string;
  fullName: string;
  branch: string;
};

type RepoRowFieldsProps = {
  row: AdditionalRepoRow;
  index: number;
  targetRepo: string;
  error?: string;
  onRepoChange: (id: string, repoId: string, fullName: string) => void;
  onRepoIdResolve: (id: string, repoId: string) => void;
  onBranchChange: (id: string, branch: string) => void;
  onRemove: (id: string) => void;
};

// Each row is its own component so each can call useGitHubBranches (Rules of Hooks)
function RepoRowFields({
  row,
  index,
  targetRepo,
  error,
  onRepoChange,
  onRepoIdResolve,
  onBranchChange,
  onRemove,
}: RepoRowFieldsProps) {
  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div className="flex items-center justify-between">
        <span className="font-medium text-sm">Repository {index + 1}</span>
        <Button
          aria-label="Remove repository"
          onClick={() => onRemove(row.id)}
          size="sm"
          type="button"
          variant="ghost"
        >
          <TrashIcon className="h-4 w-4" />
        </Button>
      </div>

      <RepoBranchSelector
        branchLabel="Branch"
        excludeRepo={targetRepo}
        onBranchChange={(branch) => onBranchChange(row.id, branch)}
        onRepoChange={(repoId, fullName) =>
          onRepoChange(row.id, repoId, fullName)
        }
        onSeedRepoResolved={(repoId) => onRepoIdResolve(row.id, repoId)}
        repoLabel="Repository"
        seedFullName={row.fullName}
        selectedBranch={row.branch}
        selectedRepoId={row.repoId}
      />

      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}

type AdditionalReposPickerProps = {
  // Used as seed state on mount only — subsequent changes are not synced.
  // Parent state is kept in sync via onChange.
  initialValue: AdditionalRepoRef[];
  // onChange receives only fully-specified rows (fullName AND branch set).
  // Placeholder/in-progress rows are kept in internal state and never leak upstream.
  onChange: (repos: AdditionalRepoRef[]) => void;
  // Fires whenever the picker gains or loses an incomplete row, so parents
  // can disable submit while the user is still filling rows in.
  onIncompleteChange?: (hasIncomplete: boolean) => void;
  targetRepo: string;
};

export function AdditionalReposPicker({
  initialValue,
  onChange,
  onIncompleteChange,
  targetRepo,
}: AdditionalReposPickerProps) {
  // Internal rows include repoId for Select binding; projected to AdditionalRepoRef[] for parent
  const [rows, setRows] = useState<AdditionalRepoRow[]>(() =>
    initialValue.map((ref) => ({
      id: crypto.randomUUID(),
      repoId: "",
      fullName: ref.fullName,
      branch: ref.branch,
    }))
  );

  // Compute per-row validation errors (keyed by row.id)
  const rowErrors = useMemo<Record<string, string>>(() => {
    const errors: Record<string, string> = {};
    const seenFullNames: string[] = [];

    for (const row of rows) {
      if (!row.fullName) {
        seenFullNames.push("");
        continue;
      }

      const lowerName = row.fullName.toLowerCase();

      if (lowerName === targetRepo?.toLowerCase()) {
        errors[row.id] =
          "Cannot use the primary repository as an additional repository";
      } else if (seenFullNames.includes(lowerName)) {
        errors[row.id] = "Duplicate repository";
      }

      seenFullNames.push(lowerName);
    }

    return errors;
  }, [rows, targetRepo]);

  const handleRepoChange = (id: string, repoId: string, fullName: string) => {
    const next = rows.map((r) =>
      r.id === id ? { ...r, repoId, fullName, branch: "" } : r
    );
    setRows(next);
    projectToParent(next, onChange, onIncompleteChange);
  };

  // Resolves repoId without resetting branch — used when reconciling initialValue rows.
  // Note: only updates internal state (repoId is not part of AdditionalRepoRef); no onChange.
  const handleRepoIdResolve = (id: string, repoId: string) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, repoId } : r)));
  };

  const handleBranchChange = (id: string, branch: string) => {
    const next = rows.map((r) => (r.id === id ? { ...r, branch } : r));
    setRows(next);
    projectToParent(next, onChange, onIncompleteChange);
  };

  const handleRemove = (id: string) => {
    const next = rows.filter((r) => r.id !== id);
    setRows(next);
    projectToParent(next, onChange, onIncompleteChange);
  };

  const handleAdd = () => {
    if (rows.length >= MAX_ADDITIONAL_REPOS) {
      return;
    }
    const next = [
      ...rows,
      { id: crypto.randomUUID(), repoId: "", fullName: "", branch: "" },
    ];
    setRows(next);
    projectToParent(next, onChange, onIncompleteChange);
  };

  return (
    <div className="space-y-3">
      {rows.map((row, index) => (
        <RepoRowFields
          error={rowErrors[row.id]}
          index={index}
          key={row.id}
          onBranchChange={handleBranchChange}
          onRemove={handleRemove}
          onRepoChange={handleRepoChange}
          onRepoIdResolve={handleRepoIdResolve}
          row={row}
          targetRepo={targetRepo}
        />
      ))}

      {rows.length < MAX_ADDITIONAL_REPOS && (
        <Button
          className="w-full"
          onClick={handleAdd}
          size="sm"
          type="button"
          variant="outline"
        >
          <PlusIcon className="h-4 w-4" />
          Add Repository
        </Button>
      )}

      {rows.length >= MAX_ADDITIONAL_REPOS && (
        <p className="text-muted-foreground text-xs">
          Maximum of {MAX_ADDITIONAL_REPOS} additional repositories reached.
        </p>
      )}
    </div>
  );
}

function isRowComplete(row: AdditionalRepoRow): boolean {
  return row.fullName.length > 0 && row.branch.length > 0;
}

// Project AdditionalRepoRow[] → AdditionalRepoRef[] (omit id and repoId).
// Placeholder rows (missing fullName or branch) are filtered out so parents
// never see an invalid { fullName: "", branch: "" } payload in their state.
// Incompleteness is reported separately via onIncompleteChange so parents
// can disable submit while the user is still filling rows in.
function projectToParent(
  rows: AdditionalRepoRow[],
  onChange: (repos: AdditionalRepoRef[]) => void,
  onIncompleteChange?: (hasIncomplete: boolean) => void
) {
  const completeRows = rows.filter(isRowComplete);
  onChange(completeRows.map(({ fullName, branch }) => ({ fullName, branch })));
  onIncompleteChange?.(completeRows.length !== rows.length);
}
