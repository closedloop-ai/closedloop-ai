import { useDocumentTitle } from "@repo/app/shared/hooks/use-document-title";
import { NavId } from "./route-table";

/**
 * ISS-5574: the desktop renderer's browser/window tab title for the Sessions and
 * Branches surfaces.
 *
 * One seam for all four routes rather than a call in each view: `App.tsx`
 * already resolves the active `navId`, the live detail ids, and the published
 * detail name for the Topbar breadcrumb, so the title is derived from exactly the
 * inputs the breadcrumb uses and the two cannot drift. It calls the same shared
 * `useDocumentTitle` the web pages call, so both surfaces format the title by one
 * rule.
 *
 * Returns a title only for the four ISS-5574 routes. Every other desktop surface
 * keeps the entry HTML's title, which is the pre-change behavior — this change
 * does not silently retitle the rest of the app.
 */
export function useDesktopDocumentTitle(input: {
  enabled: boolean;
  routeNavId: NavId | null;
  detailSessionId: string | null;
  detailBranchId: string | null;
  detailTitle: string | null;
}): void {
  useDocumentTitle(input.enabled ? resolveDesktopDocumentTitle(input) : null);
}

/**
 * The title for the current route, or `null` for a surface this change does not
 * own.
 *
 * A detail route falls back to its generic kind while the record is unresolved —
 * loading, not found, or genuinely nameless. That is the honest answer at every
 * moment: it names the kind of page rather than inventing a name, and it matches
 * the fallback the breadcrumb renders for the same state.
 *
 * Detail ids are checked FIRST because a detail route keeps its section's nav id
 * in the shell: on `/sessions/:id` the highlighted tab is still Sessions, and
 * titling that tab "Sessions" would leave every open session tab identical — the
 * exact defect.
 *
 * The list arm resolves off `routeNavId` — the nav id of the route ACTUALLY
 * matched — never `App.tsx`'s sticky `navId` (`routeNavId ?? lastNavId`). A
 * non-nav route that this change does not own borrows the sticky id: on
 * `#/agents/<slug>` `matchRoute` returns kind `agent-detail`, `routeNavId` is
 * null, and on a relaunch or bookmark straight into it `lastNavIdFromHistory`
 * finds no nav entry and returns `DEFAULT_NAV_ID` — Sessions. Reading the sticky
 * id here would title an agent detail window "Sessions" while its breadcrumb
 * read "Agents / <name>". `routeNavId` is null for every kind but `nav`, so the
 * whole class (agent detail today, any detail kind added later) returns null.
 */
export function resolveDesktopDocumentTitle(input: {
  routeNavId: NavId | null;
  detailSessionId: string | null;
  detailBranchId: string | null;
  detailTitle: string | null;
}): string | null {
  if (input.detailSessionId) {
    return input.detailTitle ?? "Session";
  }
  if (input.detailBranchId) {
    return input.detailTitle ?? "Branch";
  }
  if (input.routeNavId === NavId.Sessions) {
    return "Sessions";
  }
  if (input.routeNavId === NavId.Branches) {
    return "Branches";
  }
  return null;
}
