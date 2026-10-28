"use client";

import type { ReactNode } from "react";
import { LinkPillCell } from "./details-design-cells";

/** What the Branch's Pull request row says about the selected pull request. */
export type DetailsPullRequest = {
  number: number;
  title: string;
  href: string | null;
  /**
   * The state chip: Open, Draft, In review, Merged... The Branch slice hands
   * in its own lifecycle chip (`LifecycleBadgeChip`); shared code cannot load
   * a feature slice.
   */
  state: ReactNode;
};

/**
 * ISS-12252: the Branch's Pull request row, the one composite cell ISS-12197
 * asks for (number, title, state, draft flag) that no shipped cell drew. Built
 * from shipped parts: the Details link pill for the number and the state chip
 * the host hands in (the Branch page's lifecycle chip, which says Draft for a
 * draft).
 */
export function PullRequestDetailsCell({
  pullRequest,
}: {
  pullRequest: DetailsPullRequest;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <LinkPillCell
        item={{ href: pullRequest.href, label: `#${pullRequest.number}` }}
      />
      <span className="min-w-0 truncate" title={pullRequest.title}>
        {pullRequest.title}
      </span>
      <span className="shrink-0">{pullRequest.state}</span>
    </span>
  );
}
