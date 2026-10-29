import { SessionsCsvExportMenuItem } from "@repo/app/agents/components/sessions/sessions-csv-export-menu-item";
import type { AgentSessionQueryFilters } from "@repo/app/agents/data-source/agent-sessions-data-source";
import { type ReactNode, useMemo } from "react";

/**
 * FEA-4217: the Options menu's export row for this surface, or nothing.
 *
 * Its own module rather than a ternary at the call site: `SessionsView` sits at
 * the cognitive-complexity and file-length ceilings, and one more inline branch
 * there fails both gates. Same extraction its siblings `sessions-render-model.ts`
 * and `sessions-summary-comparison.ts` already made.
 *
 * The decision: `GET /agent-sessions/export` is a CLOUD read served by `apps/api`
 * and authenticated on a bearer token. A local-mode or signed-out desktop has
 * neither, so the menu shows no export row rather than one guaranteed to fail —
 * an offered action that cannot work is worse than one that is not offered.
 *
 * `isViewReady` is the third term (whitlockk review). The saved view restores in a
 * post-mount effect, so on the commits before it lands the window and facets
 * below are still the module defaults — the same reason `SessionsView` holds its
 * reads closed on that signal. An export taken in that window would be a file
 * for a range the table was never showing, named as the reader's view.
 *
 * Returning the ELEMENT (not a handler) is load-bearing: the row owns the
 * `useApiClient` call, which throws without an auth provider, so not rendering
 * the row is also what stops that hook running on a surface that has none.
 */
export function useSessionsExportItem({
  endDate,
  facetQuery,
  isAuthenticated,
  isCloudMode,
  isViewReady,
  startDate,
}: {
  endDate?: string;
  facetQuery: AgentSessionQueryFilters;
  isAuthenticated: boolean;
  isCloudMode: boolean;
  isViewReady: boolean;
  startDate?: string;
}): ReactNode {
  // The scope the CSV describes: the SAME facet/window query the page read
  // carries, minus the usage-only comparison opt-in the export route's strict
  // schema would reject. Memoized so the row's own `exportCsv` callback keeps a
  // stable identity across renders, matching the web host's `listFilters`.
  const filters = useMemo(
    () => ({ ...facetQuery, endDate, startDate }),
    [facetQuery, endDate, startDate]
  );
  return isCloudMode && isAuthenticated && isViewReady ? (
    <SessionsCsvExportMenuItem filters={filters} />
  ) : null;
}
