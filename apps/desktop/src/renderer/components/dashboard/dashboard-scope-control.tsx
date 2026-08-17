import { AnalyticsRangeToggle } from "@closedloop-ai/design-system/components/ui/analytics-range-toggle";
import { InsightsScope } from "@closedloop-ai/loops-api/insights";

const SCOPE_TOGGLE_OPTIONS: { label: string; value: InsightsScope }[] = [
  { label: "Me", value: InsightsScope.Me },
  { label: "Organization", value: InsightsScope.Org },
];

/**
 * The dashboard's Me / Organization scope toggle.
 *
 * ISS-5112: a guest has no organization, so `orgScopeAvailable` is false and
 * this would not render at all — which is exactly why they never discover that
 * an account buys them anything on this page. Guest mode shows it with
 * Organization present but gated, and `gated` holds the control on Organization
 * while the ask is on screen so the selection does not silently snap back.
 */
export function DashboardScopeControl({
  available,
  gated,
  scope,
  onValueChange,
}: {
  available: boolean;
  gated: boolean;
  scope: InsightsScope;
  onValueChange: (value: string) => void;
}) {
  if (!available) {
    return null;
  }
  return (
    <AnalyticsRangeToggle
      label="Scope"
      onValueChange={onValueChange}
      options={SCOPE_TOGGLE_OPTIONS}
      value={gated ? InsightsScope.Org : scope}
    />
  );
}
