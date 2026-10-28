"use client";

import { DocumentsIndexState } from "@repo/app/documents/lib/documents-index-state";
import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { FileTextIcon, SearchXIcon, TriangleAlertIcon } from "lucide-react";

/**
 * The zero-row surfaces of the org-level Documents index, in one place.
 *
 * Both flag arms of the index render THIS (ISS-8940): the states each arm can
 * reach differ, but what any given state says does not, so a copy edit cannot
 * land on one arm and miss the other. That duplication is the exact failure
 * `branches-empty-state.tsx` was extracted to fix, and this follows the same
 * `packages/app/<slice>/components/*-empty-state.tsx` pattern its siblings use.
 *
 * Loading is deliberately NOT a member here. An unsettled read is not an empty
 * state, and giving it one is how a zero starts meaning "still loading".
 */
export type DocumentsIndexEmptyStateProps = {
  /**
   * Which zero-row state to render. Only the three states that show no rows are
   * accepted; the populated, stale, and loading states render the table.
   */
  state:
    | typeof DocumentsIndexState.FirstUseEmpty
    | typeof DocumentsIndexState.NoResults
    | typeof DocumentsIndexState.BlockingError
    | typeof DocumentsIndexState.StaleNoResults;
  /** Retry the failed read. Wired to the two failure states' only action. */
  onRetry: () => void;
  noun?: "documents" | "issues";
};

export function DocumentsIndexEmptyState({
  state,
  onRetry,
  noun = "documents",
}: Readonly<DocumentsIndexEmptyStateProps>) {
  if (state === DocumentsIndexState.BlockingError) {
    return (
      <div className="p-4">
        <EmptyState
          action={
            <Button onClick={onRetry} variant="outline">
              Try again
            </Button>
          }
          description={`We couldn't load your ${noun}. Check your connection and try again.`}
          icon={TriangleAlertIcon}
          title={`Couldn't load ${noun}`}
        />
      </div>
    );
  }

  if (state === DocumentsIndexState.StaleNoResults) {
    // Both facts, one screen. The search is why nothing is listed, so the
    // search leads; the failed refresh is why the reader should not conclude
    // their documents are gone, so it is said rather than implied — and the
    // retry stays reachable, because this is the only state that would
    // otherwise strand a reader with a broken read and no way to re-run it.
    return (
      <div className="p-4">
        <EmptyState
          action={
            <Button onClick={onRetry} variant="outline">
              Try again
            </Button>
          }
          description={`These are the ${noun} that loaded before the refresh failed, and none of them match this search.`}
          icon={SearchXIcon}
          title={`No ${noun} match your search`}
        />
      </div>
    );
  }

  if (state === DocumentsIndexState.NoResults) {
    // Claims no population, because this read cannot know one (ISS-9762): once
    // the server applies the term, an org with hundreds that matched none and
    // an org with none at all arrive as the same zero rows, and a term persists
    // for 7 days, so the second reader lands here on an ordinary page load. The
    // search IS known to be what emptied the view, so that is what this names —
    // the shape the sibling Branches no-match copy already uses.
    return (
      <div className="p-4">
        <EmptyState
          description={`No ${noun} match your search. Try another term, or clear it.`}
          icon={SearchXIcon}
          title={`No ${noun} match your search`}
        />
      </div>
    );
  }

  return (
    <div className="p-4">
      <EmptyState
        description={
          noun === "issues"
            ? undefined
            : "Create one with New Document above. Documents your agent sessions produce show up here too."
        }
        icon={FileTextIcon}
        title={`No ${noun} yet`}
      />
    </div>
  );
}
