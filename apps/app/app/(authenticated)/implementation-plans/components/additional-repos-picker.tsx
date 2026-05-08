"use client";

import type { AdditionalRepoRef } from "@repo/api/src/types/loop";
import { MAX_ADDITIONAL_REPOS } from "@repo/api/src/types/loop";
import { Button } from "@repo/design-system/components/ui/button";
import { PlusIcon, TrashIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
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
  onSeedResolutionFailed: (id: string) => void;
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
  onSeedResolutionFailed,
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
        onSeedResolutionFailed={() => onSeedResolutionFailed(row.id)}
        repoLabel="Repository"
        seedFullName={row.fullName}
        selectedBranch={row.branch}
        selectedRepoId={row.repoId}
      />

      {error && (
        <p aria-live="polite" className="text-destructive text-xs">
          {error}
        </p>
      )}
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

  const [unavailableRowIds, setUnavailableRowIds] = useState<Set<string>>(
    new Set()
  );

  // Report initial incomplete state once on mount. Parents that seed the
  // picker with placeholder rows (e.g. inherited repos missing branch) would
  // otherwise see hasIncomplete=false until the user interacts, leaving submit
  // buttons enabled for invalid form state. `unavailableRowIds` is empty at
  // mount (initial state), so it doesn't enter the calculation here — the
  // seed-resolution path reports its own update via handleSeedResolutionFailed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only on purpose
  useEffect(() => {
    onIncompleteChange?.(rows.some((r) => !isRowComplete(r)));
  }, []);

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

      if (unavailableRowIds.has(row.id)) {
        errors[row.id] = "Repository unavailable";
      } else if (lowerName === targetRepo?.toLowerCase()) {
        errors[row.id] =
          "Cannot use the primary repository as an additional repository";
      } else if (seenFullNames.includes(lowerName)) {
        errors[row.id] = "Duplicate repository";
      }

      seenFullNames.push(lowerName);
    }

    return errors;
  }, [rows, targetRepo, unavailableRowIds]);

  const handleRepoChange = (id: string, repoId: string, fullName: string) => {
    const next = rows.map((r) =>
      r.id === id ? { ...r, repoId, fullName, branch: "" } : r
    );
    setRows(next);
    projectToParent(next, onChange, onIncompleteChange, unavailableRowIds);
  };

  // Resolves repoId without resetting branch — used when reconciling initialValue rows.
  // Note: only updates internal state (repoId is not part of AdditionalRepoRef); no onChange.
  const handleRepoIdResolve = (id: string, repoId: string) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, repoId } : r)));
  };

  const handleBranchChange = (id: string, branch: string) => {
    const next = rows.map((r) => (r.id === id ? { ...r, branch } : r));
    setRows(next);
    projectToParent(next, onChange, onIncompleteChange, unavailableRowIds);
  };

  const handleSeedResolutionFailed = useCallback(
    (id: string) => {
      // Early-return when this row is already known unavailable. Without this
      // guard, RepoBranchSelector's seed-resolution effect re-fires on every
      // re-render (the inline arrow passed as onSeedResolutionFailed gets a
      // fresh identity each render), which would otherwise produce an infinite
      // update loop on rows whose seeded fullName cannot be matched.
      if (unavailableRowIds.has(id)) {
        return;
      }
      setUnavailableRowIds((prev) =>
        prev.has(id) ? prev : new Set([...prev, id])
      );
      // Treat unavailable rows as incomplete so the parent disables submit.
      // Pass the new set explicitly to avoid stale closure on unavailableRowIds.
      projectToParent(
        rows,
        onChange,
        onIncompleteChange,
        new Set([...unavailableRowIds, id])
      );
    },
    [rows, onChange, onIncompleteChange, unavailableRowIds]
  );

  const handleRemove = (id: string) => {
    const next = rows.filter((r) => r.id !== id);
    setRows(next);
    setUnavailableRowIds((prev) => {
      const s = new Set(prev);
      s.delete(id);
      return s;
    });
    const nextUnavailable = new Set(unavailableRowIds);
    nextUnavailable.delete(id);
    projectToParent(next, onChange, onIncompleteChange, nextUnavailable);
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
    projectToParent(next, onChange, onIncompleteChange, unavailableRowIds);
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
          onSeedResolutionFailed={handleSeedResolutionFailed}
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
// Rows in unavailableRowIds are treated as incomplete so unavailable repos
// cannot sneak through to the parent onChange payload or unblock submit.
function projectToParent(
  rows: AdditionalRepoRow[],
  onChange: (repos: AdditionalRepoRef[]) => void,
  onIncompleteChange?: (hasIncomplete: boolean) => void,
  unavailableRowIds: Set<string> = new Set()
) {
  const completeRows = rows.filter(
    (r) => isRowComplete(r) && !unavailableRowIds.has(r.id)
  );
  onChange(completeRows.map(({ fullName, branch }) => ({ fullName, branch })));
  onIncompleteChange?.(completeRows.length !== rows.length);
}
