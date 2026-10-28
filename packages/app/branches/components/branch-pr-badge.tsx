"use client";

import type { BranchPrState } from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import { Chip } from "@repo/design-system/components/ui/chip";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table";
import { GitPullRequestIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  BRANCH_PULL_REQUEST_UNCONFIRMED_EXPLANATION,
  BRANCH_PULL_REQUEST_UNCONFIRMED_LABEL,
} from "../lib/branch-outcome-copy";
import { isGithubPrUrl } from "../lib/branch-pr-url";

/**
 * Branch PR badge (Epic B / B3) — shared by the Branches list (B4) and the Epic
 * D detail panel. Composes the design-system `Chip`, lifecycle-colored by
 * `BranchPrState`; renders the empty-value affordance (never a fabricated chip)
 * when there is no linked PR. A domain component: it encodes branch PR-state, so
 * it lives in the feature slice, not `@repo/design-system`.
 *
 * ISS-8422: a PR NUMBER with no STATE is a third case, distinct from both a
 * lifecycle state and no PR at all — the row exists and links out, but nothing
 * has ever observed what the pull request is doing. It states that in words; see
 * {@link BRANCH_PULL_REQUEST_UNCONFIRMED_LABEL}.
 */
export type BranchPRBadgeProps = {
  prNumber: number | null;
  prTitle?: string | null;
  prState?: BranchPrState | null;
  prUrl?: string | null;
  repoShortName?: string | null;
};

// `BranchPrState` is OPEN | MERGED | CLOSED. No-PR rows render `GridEmptyValue`
// before this map is consulted; a present-but-unknown state falls back to muted.
const PR_STATE_VARIANT: Record<
  GitHubPRState,
  "info" | "success" | "destructive"
> = {
  [GitHubPRState.Open]: "info",
  [GitHubPRState.Merged]: "success",
  [GitHubPRState.Closed]: "destructive",
};

export function BranchPRBadge({
  prNumber,
  prTitle,
  prState,
  prUrl,
  repoShortName,
}: BranchPRBadgeProps): ReactNode {
  if (prNumber == null) {
    return <GridEmptyValue />;
  }

  // Muted is what an unconfirmed state gets AND what any unrecognized state
  // falls back to, so hue cannot be what separates them — the word below is.
  const unconfirmed = prState == null;
  const variant = prState ? PR_STATE_VARIANT[prState] : "muted";
  const label = repoShortName ? `${repoShortName}#${prNumber}` : `#${prNumber}`;
  const title = prTitle ?? label;
  // ISS-7362 owns the split below and ISS-8422's word rides on it. `aria-label`
  // REPLACES a content-derived name, so the `sr-only` tail inside `content` is
  // invisible to the linked arm and the sentence has to be stated here too. The
  // non-linked arm has no `aria-label` and reads the tail, so between them the
  // sentence is announced exactly once on either arm — both pinned in
  // `branch-cell-primitives.test.tsx`, one case each. It is deliberately NOT in
  // `title`: `title` becomes the accessible DESCRIPTION, which is read after the
  // name, and that double-announce is the ISS-7737 defect.
  const accessibleLabel = unconfirmed
    ? `${label} ${BRANCH_PULL_REQUEST_UNCONFIRMED_LABEL}, ${BRANCH_PULL_REQUEST_UNCONFIRMED_EXPLANATION}`
    : label;
  // ISS-7362: `truncate` eats the TAIL, and the number is the only part that
  // differs row to row — one span for the whole label clipped every cell to the
  // repo prefix, which is identical across a single-repo org. Only the prefix
  // may be elided; the number is a shrink-0 sibling, and the inner flex carries
  // no gap so the two halves stay one visual `repo#number` token. They are
  // separate flex items, though, which a name-from-content walk is free to join
  // with a space — so the link states the label itself rather than inheriting a
  // reading of the split.
  const content = (
    <>
      <GitPullRequestIcon className="size-3 shrink-0" />
      <span className="flex min-w-0 items-center">
        {repoShortName ? (
          <span className="truncate">{repoShortName}</span>
        ) : null}
        <span className="shrink-0">#{prNumber}</span>
      </span>
      {unconfirmed ? (
        <>
          {/* `min-w-0 truncate`, so a user-dragged narrow column ellipsizes the
              word instead of clipping it mid-glyph. It shrinks AFTER the repo
              prefix (which truncates first) and never before the number, which
              ISS-7362 pinned as `shrink-0`. */}
          <span className="min-w-0 truncate">
            {BRANCH_PULL_REQUEST_UNCONFIRMED_LABEL}
          </span>
          {/* The chip below is `relative` FOR THIS SPAN, and that is load-bearing
              rather than cosmetic. `sr-only` is `position: absolute`, so without
              a positioned ancestor its containing block is the shell's `<main>`
              — which a list's own `overflow-auto` scroll container is NOT an
              ancestor of in the containing-block chain, so the span is never
              clipped by it. It then sits at its static position, ~760px past a
              390px viewport, and extends the PAGE's scrollable width; that is
              the four-spec E2E overflow red that reverted #6382.

              `GridTableCell` is `relative` too, and the two are not redundant:
              that one covers every cell of every grid, including the next
              `sr-only` someone adds to a right-hand column, while this one
              covers THIS badge everywhere it renders outside a grid cell — the
              detail panel mounts it with no GridTableCell above it at all. */}
          <span className="sr-only">{`, ${BRANCH_PULL_REQUEST_UNCONFIRMED_EXPLANATION}`}</span>
        </>
      ) : null}
    </>
  );

  // Only link out for a canonical GitHub PR URL; anything else (off-domain,
  // `javascript:`/`data:`, malformed) renders the non-interactive chip below.
  if (isGithubPrUrl(prUrl)) {
    return (
      <Chip
        asChild
        className={CHIP_CLASS}
        interactive
        title={title}
        variant={variant}
      >
        <a
          aria-label={accessibleLabel}
          href={prUrl}
          rel="noreferrer"
          target="_blank"
        >
          {content}
        </a>
      </Chip>
    );
  }

  return (
    <Chip className={CHIP_CLASS} title={title} variant={variant}>
      {content}
    </Chip>
  );
}

/**
 * `relative` is the containing block the `sr-only` explanation needs so the
 * list's scroll container can clip it — see the comment beside that span.
 */
const CHIP_CLASS = "relative min-w-0 gap-1";
