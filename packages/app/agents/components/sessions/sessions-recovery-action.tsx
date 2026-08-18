"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Link } from "@repo/navigation/link";
import type { MouseEvent, ReactNode } from "react";
import { isModifiedClick } from "../../../shared/lib/modified-click";

/**
 * ISS-4534: the single honest recovery affordance for the errored Sessions-list
 * empty state, shared by the web `/sessions` page and the desktop `SessionsView`.
 *
 * The prior round shipped a "Go to Sessions" button beside Retry, but reviewers
 * (wongk, and the design critics) landed on three problems that this component
 * resolves together:
 *
 * - **The label lied.** It rendered inside the Sessions list, on the Sessions
 *   page/view — offering to take the user somewhere they already stood. What it
 *   actually does is clear the filters and re-run the read, so it now says
 *   exactly that ("Clear filters and reload"), matching the sibling filtered-empty
 *   state's "Clear filters" wording.
 * - **It was a superset of Retry.** Clear-filters-and-reload already re-issues the
 *   read, so a separate Retry beside it was a second button that did a subset of
 *   the first. This is now the single primary action of the errored card; hosts no
 *   longer also render a standalone Retry there.
 * - **A modified click destroyed scope.** The old onClick cleared filters on EVERY
 *   click, so a Cmd/Ctrl-click that opened the clean URL in a new tab also wiped
 *   the filters in the current tab. The side effect is now gated behind
 *   {@link isModifiedClick}, so a modified/non-primary click only lets the browser
 *   open `href` and leaves the current tab's scope alone.
 *
 * `onClearFilters` must reset the host's filter state to defaults (facet, date,
 * search, page). The reload is driven by the query-key change that reset produces
 * — NOT a `refetch()` on the pre-clear key, which would re-run the failing narrowed
 * scope the user is escaping. `href` is the clean Sessions list root so a middle/
 * modified click still opens a working list in a new tab.
 */
export function SessionsRecoveryAction({
  href,
  onClearFilters,
}: {
  href: string;
  onClearFilters: () => void;
}): ReactNode {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    // wongk: a Cmd/Ctrl/Shift/Alt or non-primary click is the browser's to open
    // in a new tab/window — do not touch the current tab's filter scope.
    if (isModifiedClick(event)) {
      return;
    }
    onClearFilters();
  };

  return (
    <Button asChild size="sm">
      {/* `replace`: the host's clear-filters already replaces the current list-URL
          entry and this Link resolves to that same clean root, so replacing avoids
          a redundant duplicate-location history push on a plain click. */}
      <Link href={href} onClick={handleClick} replace>
        Clear filters and reload
      </Link>
    </Button>
  );
}
