"use client";

import type { ImportPackZipResponse } from "@repo/api/src/types/distribution";

/**
 * Outcome line shared by the zip and repo import dialogs. Both import paths
 * return the same `ImportPackZipResponse`, so they report it through this one
 * component — a count the server reports can't be surfaced by one dialog and
 * silently dropped by the other (FEA-3263).
 */
export function ImportResultSummary({
  result,
}: {
  result: ImportPackZipResponse;
}) {
  return (
    <p className="text-sm">
      Imported {result.created} component{result.created === 1 ? "" : "s"}
      {result.skipped > 0 ? `, skipped ${result.skipped} already present` : ""}
      {result.invalid > 0
        ? `, dropped ${result.invalid} invalid (content over 1 MB or name too long)`
        : ""}
      .
    </p>
  );
}
