import {
  BRANCH_DETAIL_TAB_PARAM,
  BranchDetailTabParam,
} from "@repo/api/src/types/notification-routes";
import { branchDetailHref } from "../navigation/route-table";

type BranchHrefItem = {
  id: string;
};

/**
 * Builds the org-relative branch-detail path shared components feed to the
 * navigation-port `Link`. The path is UNPREFIXED (`/branches/...`): the desktop
 * port Link's click handler resolves it through the route table
 * (`matchRoute(parsePath(href))`, which only matches unprefixed paths), and the
 * adapter's own `toDesktopHashHref` renders the anchor's `href` hash-prefixed so
 * modifier/middle/right-click still land on a same-document hash. Mirrors the
 * FEA-4018 `agentDetailHref` pattern and `desktopSessionDetailHref`. Passing a
 * `#`-prefixed href here would make ordinary left-clicks a no-op (FEA-4051).
 */
export function desktopBranchDetailHref(item: BranchHrefItem): string {
  return branchDetailHref(item.id);
}

/**
 * FEA-4259: the Linked Sessions count's href — the same UNPREFIXED branch-detail
 * path as `desktopBranchDetailHref`, but with `?tab=sessions-timeline` so the
 * detail opens on the Sessions & timeline tab. Built off `branchDetailHref(id)`
 * (not `getNotificationEntityPath`) so the branch id is `encodeURIComponent`-ed
 * the same way the Name link is: desktop branch ids come out of `encodeBranchId`
 * already percent-encoded (`owner%2Fweb::feature`) and the desktop route decodes
 * each path segment once, so an un-encoded segment would decode to an id we never
 * issued and land on the not-found detail state. `matchRoute(parsePath(href))`
 * strips the query, so the route still resolves to the branch-detail view, and
 * the desktop adapter surfaces the query through `useSearchParamsValue` so the
 * view can seed its initial tab. The tab literal comes from the notification-route
 * SSOT so it can't drift from the value the detail route reads.
 */
export function desktopBranchSessionsHref(item: BranchHrefItem): string {
  return `${branchDetailHref(item.id)}?${BRANCH_DETAIL_TAB_PARAM}=${BranchDetailTabParam.SessionsTimeline}`;
}
