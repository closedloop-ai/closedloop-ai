"use client";

import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@repo/design-system/components/ui/dropdown-menu";
import { DownloadIcon } from "lucide-react";
import { SessionsExportFailure } from "../../hooks/use-sessions-csv-export";

/** The export row's four states. Copy proposed, not decided (FEA-4217). */
export const SESSIONS_EXPORT_CSV_LABEL = "Export CSV";
export const SESSIONS_EXPORT_CSV_PENDING_LABEL = "Exporting…";
export const SESSIONS_EXPORT_CSV_FAILED_LABEL = "Export failed, try again";
/**
 * A failure another click cannot fix — the team scope was denied, or the query
 * was rejected. It must NOT say "try again": that sends a reader who lacks
 * access at an action that can never succeed.
 */
export const SESSIONS_EXPORT_CSV_UNAVAILABLE_LABEL =
  "Export unavailable for this view";

/**
 * The Options menu's export row: a separator plus one item that names its own
 * state.
 *
 * Presentational — the caller owns the fetch. Exported so the desktop and web
 * hosts render ONE row rather than each composing a separator, an icon and a
 * label of its own.
 */
export function SessionsExportMenuItem({
  failure,
  isExporting,
  onExport,
}: {
  failure?: SessionsExportFailure | null;
  isExporting?: boolean;
  onExport: () => void;
}) {
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        disabled={isExporting}
        onSelect={(event) => {
          // The menu must NOT close, for the same reason the switch rows above
          // prevent it: this row reports its own progress and its own failure,
          // and `DropdownMenuContent` unmounts its children on close. Without
          // this, "Exporting…" and both failure sentences render into a row
          // that is already gone, and a failed export is a click that does
          // nothing, forever, with nothing on screen to say so.
          event.preventDefault();
          onExport();
        }}
      >
        <DownloadIcon />
        {resolveExportLabel(isExporting, failure)}
      </DropdownMenuItem>
    </>
  );
}

/**
 * What the export row says right now.
 *
 * The failure is stated in the row's own TEXT, not in colour or an icon swap: a
 * reader who cannot tell red from grey still has to learn that nothing was
 * downloaded (WCAG 1.4.1), and the row is the only place they are looking.
 */
function resolveExportLabel(
  isExporting: boolean | undefined,
  failure: SessionsExportFailure | null | undefined
): string {
  if (isExporting) {
    return SESSIONS_EXPORT_CSV_PENDING_LABEL;
  }
  if (failure === SessionsExportFailure.Permanent) {
    return SESSIONS_EXPORT_CSV_UNAVAILABLE_LABEL;
  }
  if (failure === SessionsExportFailure.Retryable) {
    return SESSIONS_EXPORT_CSV_FAILED_LABEL;
  }
  return SESSIONS_EXPORT_CSV_LABEL;
}
