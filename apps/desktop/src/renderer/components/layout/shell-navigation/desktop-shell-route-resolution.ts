import {
  AGENTS_NAV_BADGE_MAX,
  AGENTS_NAV_COUNT_NOUN,
} from "@repo/app/agents/lib/agents-nav-count";
import { ShellNavigationRouteId } from "@repo/app/shared/lib/shell-navigation-contract";
import type { ShellNavigationRouteResolution } from "@repo/app/shell/v2/lib/shell-navigation-sections";
import {
  DESKTOP_SHELL_ROUTE_NAV_IDS,
  hrefForNavId,
  type NavId,
} from "../../../navigation/route-table";

/**
 * The desktop shell's answer to "what does this contract route resolve to".
 *
 * Kept free of the renderer runtime so `test/shell-route-matrix-coverage.test.ts`
 * can call it from the node lane instead of restating it (ISS-10934).
 */
export function resolveDesktopRoute(
  routeId: ShellNavigationRouteId,
  hiddenNavIds: readonly NavId[]
): ShellNavigationRouteResolution {
  const navId = DESKTOP_SHELL_ROUTE_NAV_IDS[routeId];
  if (navId === null) {
    return { href: null, offered: false };
  }
  const href = hrefForNavId(navId);
  const offered = !hiddenNavIds.includes(navId);
  if (routeId === ShellNavigationRouteId.Agents) {
    // The cap and the noun are the ones the count's hook and the legacy badge
    // read, so the two cannot disagree on how it reads or where it overflows.
    return {
      badgeMax: AGENTS_NAV_BADGE_MAX,
      countNoun: AGENTS_NAV_COUNT_NOUN,
      href,
      offered,
    };
  }
  return { href, offered };
}
