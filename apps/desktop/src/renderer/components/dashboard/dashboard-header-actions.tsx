import { DashboardRefreshingIndicator } from "@repo/app/insights/components/overview/dashboard-refreshing";
import { DateRangeFilter } from "@repo/app/shared/components/date-range-filter";
import type { DateRange } from "@repo/app/shared/lib/format-utils";
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import type { InsightsScope } from "@closedloop-ai/loops-api/insights";
import { CompassIcon } from "lucide-react";
import { DashboardCutoverStatus } from "./dashboard-cutover-status";
import { DashboardReadSourceBadge } from "./dashboard-read-source-badge";
import { DashboardScopeControl } from "./dashboard-scope-control";
import { GuestSignUpButton } from "./guest-sign-up-button";

/**
 * The dashboard's page title row — read source, refresh state, range, scope,
 * scan status, Tour, and the guest sign-up offer.
 *
 * Extracted from `FirstLaunchDashboard`, which sits on the cognitive-complexity
 * ceiling: this row is pure presentation over props its owner already holds,
 * and every control added to it was costing that component another branch.
 */
export function DashboardHeaderActions({
  analyzing,
  dateRange,
  gated,
  onDateRangeChange,
  onScopeChange,
  onReplayTour,
  refreshing,
  scope,
  scopeAvailable,
  sessionsTotal,
}: {
  analyzing: boolean;
  dateRange: DateRange;
  gated: boolean;
  onDateRangeChange: (value: DateRange) => void;
  onScopeChange: (value: string) => void;
  onReplayTour: () => void;
  refreshing: boolean;
  scope: InsightsScope;
  scopeAvailable: boolean;
  /** ISS-6002: `null` when the count is not yet known — see {@link ScanStatus}. */
  sessionsTotal: number | null;
}) {
  return (
    <>
      <DashboardReadSourceBadge />
      {/* FEA-4020: the single dashboard-wide "Refreshing" indicator — one
          range/scope change refetches every widget, so it reads as one header
          indicator rather than a spinner on every row. */}
      <DashboardRefreshingIndicator refreshing={refreshing} />
      <DateRangeFilter onChange={onDateRangeChange} value={dateRange} />
      <DashboardScopeControl
        available={scopeAvailable}
        gated={gated}
        onValueChange={onScopeChange}
        scope={scope}
      />
      <ScanStatus analyzing={analyzing} sessionsTotal={sessionsTotal} />
      {/* ISS-5477: same row, same shape as ScanStatus — the upload drain gets
          the visible treatment the scan already has, so the hold is not
          hover-only. Stands down while the scan is talking. */}
      <DashboardCutoverStatus analyzing={analyzing} />
      <span data-tour-btn>
        <Button onClick={onReplayTour} size="sm" type="button" variant="ghost">
          <CompassIcon className="size-4" />
          Tour
        </Button>
      </span>
      {/* Last, so the one filled button on the row reads as the row's
          conclusion rather than competing with the controls before it.

          Stood down while the org gate is up. The header deliberately stays
          live behind that card so nobody is trapped, but the card carries its
          own "Create account" — leaving this one there put two
          identically-labelled primaries on screen for one decision, and they do
          not even lead to the same place (this one opens the generic offer; the
          card's goes straight into the flow). The ask on screen owns the ask. */}
      {gated ? null : <GuestSignUpButton />}
    </>
  );
}

function ScanStatus({
  analyzing,
  sessionsTotal,
}: {
  analyzing: boolean;
  /**
   * ISS-6002: `null` means the count is not known yet — the session read has not
   * settled, or the local store has not proven it can serve rows. Rendering the
   * `?? 0` fallback here announced "· 0 sessions" on a store holding 1,014 of
   * them, so an unknown count omits the clause rather than claiming a zero.
   */
  sessionsTotal: number | null;
}) {
  if (!analyzing) {
    return null;
  }
  return (
    <span
      aria-live="polite"
      className="inline-flex items-center gap-2 font-mono text-[var(--muted-foreground)] text-xs"
      role="status"
    >
      <span
        className="size-1.5 rounded-full bg-[var(--ai,var(--primary))]"
        style={{ animation: "ob-pulse 1.1s ease-in-out infinite" }}
      />
      Analyzing locally
      {/* Session count refetches (~2.5s) while analyzing; keep it out of the
          live region so only the static "Analyzing locally" is announced. */}
      {sessionsTotal === null ? null : (
        <span aria-hidden="true">
          {" "}
          · {sessionsTotal.toLocaleString()} sessions
        </span>
      )}
    </span>
  );
}
