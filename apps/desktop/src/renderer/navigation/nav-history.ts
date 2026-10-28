/**
 * @file Nav-history readers for the desktop shell.
 *
 * Extracted from `App.tsx` (ISS-10492) so that grandfathered file keeps
 * shrinking while the analysis-bar offset lands in it. Pure functions over the
 * renderer's own href history — no React, no DOM — so they are unit-testable
 * without mounting the shell.
 */

import { parsePath } from "@repo/navigation/href-store";
import {
  DEFAULT_NAV_ID,
  hrefForNavId,
  matchRoute,
  type NavId,
} from "./route-table";

export function lastNavIdFromHistory(history: readonly string[]): NavId {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const match = matchRoute(parsePath(history[i]));
    if (match?.kind === "nav") {
      return match.navId;
    }
  }
  return DEFAULT_NAV_ID;
}

/**
 * Most recent nav-route href in history — any section by default, or only
 * `onlyNavId`'s section when given. Falls back to `fallbackNavId`'s canonical
 * href when history has no match.
 */
export function lastNavHrefFromHistory(
  history: readonly string[],
  fallbackNavId: NavId,
  onlyNavId?: NavId
): string {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const href = history[i];
    const match = matchRoute(parsePath(href));
    if (
      match?.kind === "nav" &&
      (onlyNavId === undefined || match.navId === onlyNavId)
    ) {
      return href;
    }
  }
  return hrefForNavId(fallbackNavId);
}

/**
 * Last visited href of ONE SPECIFIC nav section, canonical when never visited.
 * Backs the branch/agent detail back targets: those always belong under their
 * own list (never the contextual nav), but a plain canonical href would drop
 * the list's query — its FEA-3560 facet params and page — so a detail visit
 * would return to an unfiltered list.
 */
export function lastHrefForNavId(
  history: readonly string[],
  navId: NavId
): string {
  return lastNavHrefFromHistory(history, navId, navId);
}
