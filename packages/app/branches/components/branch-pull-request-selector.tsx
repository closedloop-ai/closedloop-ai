"use client";

import type {
  BranchAssociatedPullRequest,
  BranchAssociatedPullRequestCollection,
  BranchSelectedPullRequestIdentity,
} from "@repo/api/src/types/branch-associated-pull-request";
import {
  BranchAssociatedPullRequestCompletenessState,
  BranchAssociatedPullRequestSelectionReason,
} from "@repo/api/src/types/branch-associated-pull-request";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";

const SELECTOR_DESCRIPTION_ID = "branch-pull-request-selector-description";

export type BranchPullRequestSelectorProps = {
  collection?: BranchAssociatedPullRequestCollection;
  disabled?: boolean;
  onChange: (identity: BranchSelectedPullRequestIdentity) => void;
  selectedId: string | null;
};

/** Persistent repository-qualified selector for every PR-owned detail panel. */
export function BranchPullRequestSelector({
  collection,
  disabled = false,
  onChange,
  selectedId,
}: BranchPullRequestSelectorProps) {
  const items = collection?.items ?? [];
  const description = collectionDescription(collection);

  return (
    <section
      aria-labelledby="branch-pull-request-selector-label"
      className="mt-5"
    >
      <span
        className="mb-1.5 block font-medium text-sm"
        id="branch-pull-request-selector-label"
      >
        Pull request
      </span>
      <Select
        disabled={disabled || items.length === 0}
        onValueChange={(id) => {
          const selected = items.find((item) => item.id === id);
          if (selected) {
            onChange(identityFor(selected));
          }
        }}
        value={selectedId ?? undefined}
      >
        <SelectTrigger
          aria-describedby={description ? SELECTOR_DESCRIPTION_ID : undefined}
          aria-label="Pull request"
          className="w-full"
        >
          <SelectValue placeholder="Select a pull request" />
        </SelectTrigger>
        <SelectContent align="start">
          {items.map((item) => (
            <SelectItem key={item.id} value={item.id}>
              <span className="min-w-0 truncate">
                <span className="font-mono">#{item.number}</span>
                {item.title ? ` ${item.title}` : ""}
                <span className="text-muted-foreground text-xs">
                  {` · ${item.repositoryFullName}`}
                </span>
              </span>
              <span className="shrink-0 text-muted-foreground text-xs">
                {lifecycleLabel(item)}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {description ? (
        <p
          aria-live="polite"
          className="mt-1.5 text-muted-foreground text-xs"
          id={SELECTOR_DESCRIPTION_ID}
        >
          {description}
        </p>
      ) : null}
    </section>
  );
}

function identityFor(
  pullRequest: BranchAssociatedPullRequest
): BranchSelectedPullRequestIdentity {
  return {
    repositoryFullName: pullRequest.repositoryFullName,
    pullRequestNumber: pullRequest.number,
  };
}

function lifecycleLabel(pullRequest: BranchAssociatedPullRequest): string {
  if (pullRequest.state === GitHubPRState.Open && pullRequest.isDraft) {
    return "Draft";
  }
  if (pullRequest.state === GitHubPRState.Open) {
    return "Open";
  }
  if (pullRequest.state === GitHubPRState.Merged) {
    return "Merged";
  }
  return "Closed";
}

function collectionDescription(
  collection?: BranchAssociatedPullRequestCollection
): string | null {
  if (!collection) {
    return "Pull request history isn't available yet.";
  }
  if (
    collection.completeness.state ===
    BranchAssociatedPullRequestCompletenessState.Complete
  ) {
    return null;
  }
  if (
    collection.completeness.state ===
    BranchAssociatedPullRequestCompletenessState.Unavailable
  ) {
    return "Pull request history isn't available yet.";
  }
  if (
    collection.selectionReason ===
    BranchAssociatedPullRequestSelectionReason.Ambiguous
  ) {
    return "Multiple pull requests are active. Choose one to view its details.";
  }
  return "Some pull request history couldn't be verified. Choose from the pull requests shown here.";
}
