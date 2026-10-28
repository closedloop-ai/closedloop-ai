"use client";

import type { BrowserSessionPageCoverage } from "../../../../devices/lib/browser-session-display";
import { BrowserSessionPageCompleteness } from "../../../../devices/lib/browser-session-display";

/**
 * How much of the user's session set is on screen — three members, three
 * renders (PLN-1915 Step 3).
 *
 * `Unknown` is NOT `Complete`. It means the provider's total could not be
 * reconciled with the page in hand, so the panel says that rather than
 * implying these rows are everything; collapsing the two is the exact
 * false-completeness `BrowserSessionPageCompleteness` was introduced to
 * prevent, and a boolean here would have no room to say it.
 *
 * The `data-browser-session-page` attribute carries the classification so a
 * test fails when the MEANING changes rather than when the wording does.
 */
export function BrowserSessionPageCoverageNote({
  coverage,
}: Readonly<{ coverage: BrowserSessionPageCoverage }>) {
  return (
    <p
      className="text-muted-foreground text-xs"
      data-browser-session-page={coverage.completeness}
    >
      {describeCoverage(coverage)}
    </p>
  );
}

function describeCoverage(coverage: BrowserSessionPageCoverage): string {
  if (coverage.completeness === BrowserSessionPageCompleteness.Complete) {
    return `Showing all ${coverage.shownCount} active sessions.`;
  }
  if (coverage.completeness === BrowserSessionPageCompleteness.Truncated) {
    // `totalCount` is non-null on every Truncated coverage by construction; the
    // fallback exists only so a wrong number can never be printed if that ever
    // stops holding.
    return `Showing ${coverage.shownCount} of ${coverage.totalCount ?? coverage.shownCount} active sessions.`;
  }
  return `Showing ${coverage.shownCount} active sessions. We couldn't confirm whether that is all of them.`;
}
