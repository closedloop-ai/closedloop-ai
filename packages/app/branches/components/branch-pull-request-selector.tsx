"use client";

import type {
  BranchAssociatedPullRequest,
  BranchAssociatedPullRequestCollection,
  BranchSelectedPullRequestIdentity,
} from "@repo/api/src/types/branch-associated-pull-request";
import {
  BranchAssociatedPullRequestCompletenessState,
  BranchAssociatedPullRequestSelectionReason,
  isUnobservedPullRequest,
} from "@repo/api/src/types/branch-associated-pull-request";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import {
  BRANCH_PULL_REQUEST_DRAFT_LABEL,
  BRANCH_PULL_REQUEST_HISTORY_UNAVAILABLE,
  BRANCH_PULL_REQUEST_UNCONFIRMED_LABEL,
  BRANCH_PULL_REQUEST_UNCONFIRMED_SELECTED,
} from "../lib/branch-outcome-copy";

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
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const description = collectionDescription(collection, selected);

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
  // ISS-8422: an unobserved row still reports the `OPEN` it read off its column
  // default, so this label would confidently say "Open" about a pull request
  // nobody has looked at. The flag is the only signal that separates them.
  if (isUnobservedPullRequest(pullRequest)) {
    return BRANCH_PULL_REQUEST_UNCONFIRMED_LABEL;
  }
  if (pullRequest.state === GitHubPRState.Open && pullRequest.isDraft) {
    return BRANCH_PULL_REQUEST_DRAFT_LABEL;
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
  collection: BranchAssociatedPullRequestCollection | undefined,
  selected: BranchAssociatedPullRequest | null
): string | null {
  if (!collection) {
    return BRANCH_PULL_REQUEST_HISTORY_UNAVAILABLE;
  }
  // ISS-8422 — the SELECTED ITEM's own flag, not the collection's reason, and
  // BEFORE the Complete early-return. Two things make the reason alone wrong.
  // `selectionReason` describes why the CONTRACT chose a default, so it answers
  // `Explicit` the moment a reader picks a pull request themselves
  // (`branch-detail-selected-pull-request.ts` sets exactly that) — which hides
  // this sentence precisely when the reader has selected the unobserved one. And
  // in a multi-PR collection whose default is observed, `Unobserved` is never the
  // reason at all, so selecting an unobserved sibling said nothing either.
  // Early, because an unobserved selection adds no completeness reason (adding
  // one degraded an org-wide KPI through `pullRequestCoverageComplete`), so this
  // collection reports Complete and would return null with the caveat unsaid.
  if (isUnobservedPullRequest(selected)) {
    return BRANCH_PULL_REQUEST_UNCONFIRMED_SELECTED;
  }
  // The collection-level reason still answers for a contract that reports an
  // unobserved default whose item this client cannot resolve — `selectedId`
  // naming a row absent from `items`, which no producer should emit and none of
  // them is prevented from emitting.
  if (
    collection.selectionReason ===
    BranchAssociatedPullRequestSelectionReason.Unobserved
  ) {
    return BRANCH_PULL_REQUEST_UNCONFIRMED_SELECTED;
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
    return BRANCH_PULL_REQUEST_HISTORY_UNAVAILABLE;
  }
  if (
    collection.selectionReason ===
    BranchAssociatedPullRequestSelectionReason.Ambiguous
  ) {
    return "Multiple pull requests are active. Choose one to view its details.";
  }
  return "Some pull request history couldn't be verified. Choose from the pull requests shown here.";
}
