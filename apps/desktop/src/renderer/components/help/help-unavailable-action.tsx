import { ViewOnlineAction } from "@repo/app/help/components/help-view-online-action";
import type { ReactNode } from "react";
import { DEFAULT_DOCS_SITE_URL } from "../../../shared/docs-help-contract";
import { NavId } from "../../navigation/route-table";

/**
 * ISS-9731 (Marisol, 2026-09-13) — what Help contributes to the withdrawal panel
 * when its own gate is closed.
 *
 * THE PROBLEM THIS ANSWERS. A reader who typed `#/help` wanted documentation,
 * and the panel offered only "Go to Dashboard" — the one thing they did not ask
 * for. The docs site is genuinely reachable, so pointing at it is not the
 * ISS-8753 failure of naming an in-app control that no longer exists.
 *
 * WHY IT LIVES HERE, AND NOT IN THE PANEL. `LabsPageUnavailable` must never
 * branch on WHICH gate is closed — that branching is exactly what ISS-8753
 * removed. So the panel takes an OPTIONAL action and the CALLER supplies it,
 * and the knowledge of what Help owns lives with Help. Every other destination
 * passes nothing and renders exactly as it did before; Agents and Audit have no
 * online analogue to offer.
 *
 * Returns a NODE rather than taking the panel apart, so the shell hands it
 * straight through and nothing else has to know a docs site exists.
 */
export function helpUnavailableAction(pageId: NavId): ReactNode {
  if (pageId !== NavId.Help) {
    return null;
  }
  // The docs ROOT, not a page: the reader never reached a page to deep-link to.
  return <ViewOnlineAction docsSiteUrl={DEFAULT_DOCS_SITE_URL} />;
}
