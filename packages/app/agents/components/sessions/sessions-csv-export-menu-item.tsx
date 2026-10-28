"use client";

import type { AgentSessionQueryFilters } from "../../data-source/agent-sessions-data-source";
import { useSessionsCsvExport } from "../../hooks/use-sessions-csv-export";
import { SessionsExportMenuItem } from "./sessions-options-menu";

/**
 * FEA-4217 — the Options menu's Export CSV row, wired to a real download.
 *
 * A component rather than a hook the host calls, because {@link useSessionsCsvExport}
 * reaches `useApiClient`, which THROWS without an `AuthAdapterProvider` ancestor.
 * A host that owned that hook would run it on every mount of the Sessions view,
 * including desktop local mode and every test harness that mounts the view
 * without an auth provider — the "shared component newly calls a
 * provider-requiring hook unconditionally" break, which is exactly what happened
 * when this was threaded as an `onExportCsv` prop.
 *
 * Mounting the hook INSIDE the row makes the requirement match the reachability:
 * the row is rendered only where an export can actually be served, so the hook
 * runs only there too.
 */
export function SessionsCsvExportMenuItem({
  filters,
}: {
  filters: AgentSessionQueryFilters;
}) {
  const { exportCsv, exportFailure, isExporting } =
    useSessionsCsvExport(filters);
  return (
    <SessionsExportMenuItem
      failure={exportFailure}
      isExporting={isExporting}
      onExport={exportCsv}
    />
  );
}
