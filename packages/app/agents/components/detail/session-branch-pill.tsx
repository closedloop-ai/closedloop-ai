"use client";

import type { SessionBranch } from "@repo/api/src/types/agent-session";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { Link } from "@repo/navigation/link";
import { GitBranchIcon } from "lucide-react";

/**
 * ISS-8427: one branch in the session-detail Properties-pane "Branches" row,
 * shaped after the `PullRequestPill` beside it.
 *
 * Two branches, not the four `IssueLinkPill` carries. Both shells hand this row
 * a ROOT-RELATIVE href (web builds `/{org}/branches/{id}`, desktop builds its
 * own `branchDetailHref`), so there is no external-anchor fork; and the desktop
 * only supplies a builder once its source read has settled
 * (`branchLinkResolvable`), so there is no unresolved-reachability window to
 * render either.
 *
 * The accessible name is the branch NAME and nothing else — Radix wires the
 * tooltip as `aria-describedby`, so the visible text stays the name (WCAG 2.5.3
 * Label in Name). An `aria-label` here would REPLACE it, the trap
 * `property-values.tsx` already documents.
 */
export function SessionBranchPill({
  branch,
  href,
}: Readonly<{
  branch: Pick<SessionBranch, "name">;
  href: string | null;
}>) {
  const content = (
    <>
      <GitBranchIcon aria-hidden className="size-3.5" />
      <span className="mono">{branch.name}</span>
    </>
  );

  if (!href) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="sd3-result-pr sd3-branch-pill">{content}</span>
        </TooltipTrigger>
        <TooltipContent>{buildUnlinkedBranchTitle(branch.name)}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link className="sd3-result-pr sd3-branch-pill" href={href}>
          {content}
        </Link>
      </TooltipTrigger>
      <TooltipContent>{buildBranchTitle(branch.name)}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The linked pill's tooltip: the full branch name (the pill itself clips a long
 * one) plus where a click lands, which the visible text cannot say.
 */
export function buildBranchTitle(name: string): string {
  return `Branch ${name}. Opens the branch detail.`;
}

/**
 * The inert pill's tooltip: the branch's identity, and deliberately NO claim
 * about reachability.
 *
 * Visual QA raised that the desktop withholds the href builder while its auth
 * read is still settling (`branchLinkResolvable`), so a settled "nothing is
 * reachable" sentence could be asserted over a window in which the answer is not
 * yet known — the shape ISS-5366 fixed for the artifacts row inches away. The
 * row this replaced said nothing at all during that window, so naming the branch
 * and stopping is the statement that cannot be wrong in either state. Giving the
 * unresolved window its own rendering (the pane already has
 * `.sd3-result-pr-pending` and an `artifactHrefPending` prop) is the follow-up if
 * that window proves reachable.
 */
export function buildUnlinkedBranchTitle(name: string): string {
  return `Branch ${name}.`;
}
