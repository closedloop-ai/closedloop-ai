"use client";

import type { BranchPrState } from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import { BranchChangesBar } from "@repo/app/branches/components/branch-changes-bar";
// Feature slice -> branches slice: the card shows a branch with the Branches
// list's own PR badge, checks value and changes bar.
import {
  type BranchChecksRollup,
  BranchChecksStatusValue,
} from "@repo/app/branches/components/branch-checks-status-value";
import { BranchPRBadge } from "@repo/app/branches/components/branch-pr-badge";
import { BRANCH_PULL_REQUEST_UNCONFIRMED_LABEL } from "@repo/app/branches/lib/branch-outcome-copy";
import { Chip } from "@repo/design-system/components/ui/chip";
import { GitBranchIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * ISS-12580 (DI-10): the Branch section of an issue's canvas, below the
 * Sub-issues and above the Activity summary (Ottilie, 2026-10-21, ISS-12576).
 *
 * - A preview, kept minimal: it lets someone decide whether to open the
 *   branch, and the branch name opens the shipped Branch screen, which has
 *   everything else. It shows only fields whose source is clear: merge
 *   status, test checks and lines changed (Ottilie, 2026-10-21).
 * - A branch reads its state from its pull request: no pull request yet is In
 *   progress, an open one In review, then Merged or Closed without merge. A
 *   pull request nobody has observed (a number, no state) is Unconfirmed, the
 *   word BranchPRBadge says beside it (ISS-8422).
 * - The description (every status update, or only the latest?) and the
 *   branch's Storybook preview wait on their source and import rules, so the
 *   card says "Data pending" for both.
 * - Sessions, documents and other links are not here: Sessions has its own
 *   tab, and related artifacts are on the Details tab (Ottilie, 2026-10-21).
 * - `showSources` labels every field with where its data comes from, for
 *   engineering.
 */

export const LinkedWorkBranchState = {
  InProgress: "in-progress",
  InReview: "in-review",
  Merged: "merged",
  ClosedWithoutMerge: "closed-without-merge",
  Unconfirmed: "unconfirmed",
} as const;
export type LinkedWorkBranchState =
  (typeof LinkedWorkBranchState)[keyof typeof LinkedWorkBranchState];

/** The state words, from DI-10's list of card states. */
export const LINKED_WORK_BRANCH_STATE_LABELS: Readonly<
  Record<LinkedWorkBranchState, string>
> = {
  [LinkedWorkBranchState.InProgress]: "In progress",
  [LinkedWorkBranchState.InReview]: "In review",
  [LinkedWorkBranchState.Merged]: "Merged",
  [LinkedWorkBranchState.ClosedWithoutMerge]: "Closed without merge",
  [LinkedWorkBranchState.Unconfirmed]: BRANCH_PULL_REQUEST_UNCONFIRMED_LABEL,
};

const BRANCH_STATE_VARIANT: Readonly<
  Record<LinkedWorkBranchState, "muted" | "info" | "success" | "destructive">
> = {
  [LinkedWorkBranchState.InProgress]: "muted",
  [LinkedWorkBranchState.InReview]: "info",
  [LinkedWorkBranchState.Merged]: "success",
  [LinkedWorkBranchState.ClosedWithoutMerge]: "destructive",
  [LinkedWorkBranchState.Unconfirmed]: "muted",
};

/**
 * A branch's state, read from its pull request's. A pull request with no
 * state is Unconfirmed, not In progress, matching BranchPRBadge's
 * `prState == null` beside a number.
 */
export function linkedWorkBranchState(
  pullRequest: { state: BranchPrState | null } | null
): LinkedWorkBranchState {
  if (pullRequest === null) {
    return LinkedWorkBranchState.InProgress;
  }
  switch (pullRequest.state) {
    case GitHubPRState.Open:
      return LinkedWorkBranchState.InReview;
    case GitHubPRState.Merged:
      return LinkedWorkBranchState.Merged;
    case GitHubPRState.Closed:
      return LinkedWorkBranchState.ClosedWithoutMerge;
    default:
      return LinkedWorkBranchState.Unconfirmed;
  }
}

/**
 * Where each field of the card reads its data, as the Branches list and the
 * Branch screen read it (`BranchRow`, packages/api/src/types/branch.ts).
 */
export const LINKED_WORK_FIELD_SOURCES = {
  name: "BranchRow.branchName; opens the Branch screen",
  state: "BranchRow.prState + mergedAt (GitHub pull_request webhook)",
  subIssue: "Artifact link: the branch implements a sub-issue",
  pullRequest: "BranchRow.prNumber, prTitle, prUrl",
  checks:
    "BranchRow.checksStatus, checksPassed, checksTotal (GitHub check_run webhook)",
  changes:
    "BranchRow.additions, deletions (branch file cache, else the PR's diff stats; FEA-4268)",
  description: "No source yet: every status update, or only the latest?",
  storybookPreview: "No source yet: no artifact type for Storybook builds",
} as const;

export type LinkedWorkBranch = BranchChecksRollup & {
  key: string;
  name: string;
  /** The branch record; `null` when it cannot be opened. */
  href: string | null;
  repoShortName: string | null;
  /** The sub-issue the branch implements, when it is not this issue. */
  subIssue?: { slug: string; href: string | null } | null;
  pullRequest: {
    number: number;
    title: string | null;
    state: BranchPrState | null;
    url: string | null;
  } | null;
  additions: number | null;
  deletions: number | null;
};

export function LinkedWorkCard({
  branches,
  showSources = false,
}: Readonly<{
  /** The branches that implement the issue or one of its sub-issues. */
  branches: readonly LinkedWorkBranch[];
  /** Labels every field with its data source, for engineering. */
  showSources?: boolean;
}>) {
  return (
    <div className="flex flex-col gap-3">
      {branches.length === 0 ? (
        <p className="flex items-center gap-2 rounded-lg border border-dashed p-4 text-muted-foreground text-sm">
          <GitBranchIcon aria-hidden="true" className="size-4" />
          No branch yet
        </p>
      ) : (
        <ul aria-label="Branches" className="flex flex-col gap-3">
          {branches.map((branch) => (
            <li key={branch.key}>
              <LinkedWorkBranchRow branch={branch} showSources={showSources} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** "Data pending", the words the stories use for a field with no source yet. */
export const LINKED_WORK_DATA_PENDING = "Data pending";

function LinkedWorkBranchRow({
  branch,
  showSources,
}: Readonly<{ branch: LinkedWorkBranch; showSources: boolean }>) {
  const state = linkedWorkBranchState(branch.pullRequest);
  return (
    <article
      aria-label={branch.name}
      className="flex flex-col gap-2 rounded-lg border bg-card p-4"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <GitBranchIcon
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
        />
        <Sourced show={showSources} source={LINKED_WORK_FIELD_SOURCES.name}>
          {branch.href ? (
            <a
              className="min-w-0 truncate font-mono hover:underline"
              href={branch.href}
            >
              {branch.name}
            </a>
          ) : (
            <span className="min-w-0 truncate font-mono">{branch.name}</span>
          )}
        </Sourced>
        <Sourced show={showSources} source={LINKED_WORK_FIELD_SOURCES.state}>
          <Chip size="sm" variant={BRANCH_STATE_VARIANT[state]}>
            {LINKED_WORK_BRANCH_STATE_LABELS[state]}
          </Chip>
        </Sourced>
        {branch.subIssue ? (
          <Sourced
            show={showSources}
            source={LINKED_WORK_FIELD_SOURCES.subIssue}
          >
            <span className="text-muted-foreground text-xs">
              on{" "}
              {branch.subIssue.href ? (
                <a
                  className="font-mono hover:underline"
                  href={branch.subIssue.href}
                >
                  {branch.subIssue.slug}
                </a>
              ) : (
                <span className="font-mono">{branch.subIssue.slug}</span>
              )}
            </span>
          </Sourced>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        {branch.pullRequest ? (
          <Sourced
            show={showSources}
            source={LINKED_WORK_FIELD_SOURCES.pullRequest}
          >
            <BranchPRBadge
              prNumber={branch.pullRequest.number}
              prState={branch.pullRequest.state}
              prTitle={branch.pullRequest.title}
              prUrl={branch.pullRequest.url}
              repoShortName={branch.repoShortName}
            />
          </Sourced>
        ) : null}
        <Sourced show={showSources} source={LINKED_WORK_FIELD_SOURCES.checks}>
          <BranchChecksStatusValue
            checksPassed={branch.checksPassed}
            checksStatus={branch.checksStatus}
            checksTotal={branch.checksTotal}
          />
        </Sourced>
        <Sourced show={showSources} source={LINKED_WORK_FIELD_SOURCES.changes}>
          <span className="block w-28">
            <BranchChangesBar
              additions={branch.additions}
              deletions={branch.deletions}
            />
          </span>
        </Sourced>
      </div>
      <dl className="flex flex-wrap gap-x-4 gap-y-1 border-t pt-2 text-xs">
        <PendingField
          label="Description"
          show={showSources}
          source={LINKED_WORK_FIELD_SOURCES.description}
        />
        <PendingField
          label="Storybook preview"
          show={showSources}
          source={LINKED_WORK_FIELD_SOURCES.storybookPreview}
        />
      </dl>
    </article>
  );
}

/** A field on hold until its source is known (Ottilie, 2026-10-21). */
function PendingField({
  label,
  show,
  source,
}: Readonly<{ label: string; show: boolean; source: string }>) {
  return (
    <Sourced show={show} source={source}>
      <div className="flex items-center gap-1.5">
        <dt className="text-muted-foreground">{label}</dt>
        <dd className="rounded border border-dashed px-1.5 text-muted-foreground">
          {LINKED_WORK_DATA_PENDING}
        </dd>
      </div>
    </Sourced>
  );
}

/** A field, with its data source under it when `show` is on. */
function Sourced({
  children,
  show,
  source,
}: Readonly<{ children: ReactNode; show: boolean; source: string }>) {
  if (!show) {
    return children;
  }
  return (
    <span className="inline-flex min-w-0 flex-col items-start gap-0.5">
      {children}
      <code className="font-mono text-[11px] text-muted-foreground">
        {source}
      </code>
    </span>
  );
}
