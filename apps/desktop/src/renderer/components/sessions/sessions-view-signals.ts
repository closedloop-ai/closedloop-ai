import { resolveSessionsNonWindowFiltersActive } from "@repo/app/agents/components/sessions/sessions-list-surface-model";
import { useHasConnectedAgent } from "@repo/app/agents/hooks/use-has-connected-agent";
import {
  type SessionsOutsideWindowProbe,
  useSessionsOutsideWindow,
} from "@repo/app/agents/hooks/use-sessions-outside-window";
import type { SessionCustomDateWindow } from "@repo/app/agents/lib/session-custom-date-window";
import type { SessionFacetFilters } from "@repo/app/agents/lib/session-filter-adapter";
import type { DateRange } from "@repo/app/shared/lib/format-utils";

/**
 * Read-state signals `SessionsView` derives before it can decide what to
 * render, lifted out of that view (ISS-9619; ISS-11913 added the third).
 *
 * They live here because `SessionsView.tsx` is at the 1,000-line ceiling and
 * these are the pieces that separate cleanly: none touches the view's state or
 * its URL writers — each answers one question from its arguments. The view
 * keeps the composition; this module keeps the answers.
 */

/**
 * PRD-536 §5: resolve the empty-state onboarding signal for the desktop
 * Sessions view. Cloud mode consults the org-scoped compute-target probe; local
 * mode is always "connected" (the local monitor is the agent) and never fires
 * the authenticated cloud read.
 */
export function useDesktopHasConnectedAgent(
  isCloudMode: boolean
): boolean | undefined {
  const hasConnectedAgentQuery = useHasConnectedAgent({ enabled: isCloudMode });
  return isCloudMode ? hasConnectedAgentQuery.data : true;
}

/**
 * Has a real (non-placeholder) list actually arrived? A placeholder page is the
 * PREVIOUS scope's rows, so treating it as data is what lets the table describe
 * a scope the reader already left.
 */
export function hasCurrentListData({
  isPlaceholderData,
  list,
}: {
  isPlaceholderData: boolean;
  list?: { items: readonly unknown[] };
}): boolean {
  return !isPlaceholderData && list !== undefined;
}

/**
 * ISS-11913: the unwindowed probe for this view's scope. Desktop carries no
 * owner scope, so search and the facets are the only narrowers besides the
 * window.
 */
export function useDesktopSessionsOutsideWindow({
  customDateWindow,
  dateRange,
  facetFilters,
  hasSettledListData,
  knownTotal,
  search,
}: {
  customDateWindow: SessionCustomDateWindow | null;
  dateRange: DateRange;
  facetFilters: SessionFacetFilters;
  hasSettledListData: boolean;
  knownTotal: number | undefined;
  search: string | undefined;
}): SessionsOutsideWindowProbe {
  return useSessionsOutsideWindow({
    customWindowActive: customDateWindow !== null,
    dateRange,
    isListSettledEmpty: hasSettledListData && knownTotal === 0,
    otherFiltersActive: resolveSessionsNonWindowFiltersActive({
      facets: facetFilters,
      isServerDriven: true,
      scopeUserId: null,
      search: search ?? "",
    }),
  });
}
