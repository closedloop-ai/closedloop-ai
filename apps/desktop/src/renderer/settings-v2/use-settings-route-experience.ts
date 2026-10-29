import { parsePath } from "@repo/navigation/href-store";
import { useState } from "react";
import {
  DEFAULT_NAV_ID,
  hrefForNavId,
  matchRoute,
  NavId,
} from "../navigation/route-table";

/**
 * ISS-8370 D6 — how the desktop shell's routing state treats `#/settings`.
 *
 * Settings is not a page: it is the PRD-691 modal presented over the last nav
 * page, so the keep-alive map never mounts it and the sticky last-nav state
 * never records it. Dismissing it returns to the last non-Settings route the
 * shell saw — a nav page or a detail — which {@link useSettingsReturnHref}
 * tracks.
 */
export type SettingsRouteExperience = {
  /**
   * The nav id the shell's route-keyed state sees for this route: the matched
   * id, or `null` for `#/settings` — exactly what a detail route reports — so
   * the last-nav state, the scroll key, the docs anchor and the document title
   * all treat the modal as "still on the page underneath".
   */
  routeNavId: NavId | null;
};

export function useSettingsRouteExperience(
  requestedNavId: NavId | null
): SettingsRouteExperience {
  return {
    routeNavId: requestedNavId === NavId.Settings ? null : requestedNavId,
  };
}

/**
 * The nav page the body shows: the matched page, else the sticky last one. A
 * sticky `Settings` — inherited from a cold launch whose history holds only
 * `#/settings` — names no page, so the default nav stands in and the modal
 * opens over it.
 */
export function resolveVisibleNavId(
  route: SettingsRouteExperience,
  lastNavId: NavId
): NavId {
  if (route.routeNavId !== null) {
    return route.routeNavId;
  }
  return navIdBehindSettings(lastNavId);
}

/**
 * The keep-alive map with `#/settings` excluded: Settings is the modal, never a
 * kept-mounted empty hidden panel.
 */
export function resolveKeepAliveNavIds(
  visitedNavIds: readonly NavId[]
): readonly NavId[] {
  return visitedNavIds.filter((navId) => navId !== NavId.Settings);
}

function navIdBehindSettings(lastNavId: NavId): NavId {
  return lastNavId === NavId.Settings ? DEFAULT_NAV_ID : lastNavId;
}

/**
 * Where a dismissed modal lands when the link carried no `returnTo` (ISS-8370
 * D6; davetho on #6936): the last href of ANY route but Settings — a nav
 * page or a detail alike — so Settings opened from a session, branch or agent
 * detail returns to that detail rather than to its list. Keyed on the requested
 * route, not the experience: a Settings PAGE visit under legacy or pending must
 * never become a return target, or a later v2 close would loop back to
 * `#/settings`. Seeded from `history` when the app restores directly onto
 * `#/settings` (reload, cold launch); a history holding only Settings has no
 * page to return to, so the default nav stands in. Render-phase guarded update,
 * the derive-state pattern `App.tsx` uses for its sticky last-nav state.
 */
export function useSettingsReturnHref(
  requestedNavId: NavId | null,
  currentHref: string,
  history: readonly string[]
): string {
  const onSettings = requestedNavId === NavId.Settings;
  const [lastPageHref, setLastPageHref] = useState<string>(() =>
    onSettings ? lastPageHrefFromHistory(history) : currentHref
  );
  if (!onSettings && currentHref !== lastPageHref) {
    setLastPageHref(currentHref);
  }
  return lastPageHref;
}

function lastPageHrefFromHistory(history: readonly string[]): string {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const href = history[i];
    if (!isSettingsHref(href)) {
      return href;
    }
  }
  return hrefForNavId(DEFAULT_NAV_ID);
}

function isSettingsHref(href: string): boolean {
  const match = matchRoute(parsePath(href));
  return match?.kind === "nav" && match.navId === NavId.Settings;
}
