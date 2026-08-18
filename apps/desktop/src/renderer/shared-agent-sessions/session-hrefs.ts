import type { SessionHrefTarget } from "@repo/app/agents/lib/agent-component-session-adapter";
import { sessionDetailHref } from "../navigation/route-table";

/**
 * Builds the org-relative session-detail path shared components feed to the
 * navigation-port `Link`. The path is UNPREFIXED (`/sessions/...`): the desktop
 * port Link's click handler resolves it through the route table
 * (`matchRoute(parsePath(href))`, which only matches unprefixed paths), and the
 * adapter's own `toDesktopHashHref` renders the anchor's `href` hash-prefixed so
 * modifier/middle/right-click still land on a same-document hash. Mirrors the
 * FEA-4018 `agentDetailHref` pattern. Passing a `#`-prefixed href here would
 * make ordinary left-clicks a no-op (FEA-4051).
 */
export function desktopSessionDetailHref(item: SessionHrefTarget): string {
  return sessionDetailHref(item.id);
}
