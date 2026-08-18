import { ROUTINES_FEATURE_FLAG_KEY } from "@repo/api/src/types/routines";
import type { Metadata } from "next";
import { FeatureFlagRouteGate } from "@/components/feature-flag-route-gate";
import { RouteChromeFallback } from "@/components/route-chrome-fallback";
import { Header } from "../../components/header";
import { RoutinesIndexView } from "./components/routines-index-view";

const ROUTINES_BREADCRUMBS = [{ label: "Routines" }];

export const metadata: Metadata = {
  title: "Routines",
  description: "Recurring agent routines that run on a schedule",
};

/**
 * Routines index (PRD-566 / FEA-4348; the renamed "Scheduled Tasks" feature).
 *
 * Route-level gate: Routines is not GA, so it stays hidden behind the PostHog
 * `routines` flag (default off) — belt-and-suspenders with the desktop
 * `routines` Labs setting. Deep-linking `/routines` with the flag off lands on
 * the in-shell "Page not found" recovery state (via `notFound()`), matching the
 * Insights route, and the nav destination carries the same gate so no dead link
 * surfaces. Routines are authored and run desktop-locally today, so the web
 * surface is a read-only pointer to the desktop app (see `RoutinesIndexView`).
 */
export default function RoutinesPage() {
  return (
    <FeatureFlagRouteGate
      flag={ROUTINES_FEATURE_FLAG_KEY}
      pending={<RouteChromeFallback breadcrumbs={ROUTINES_BREADCRUMBS} />}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <Header breadcrumbs={ROUTINES_BREADCRUMBS} />
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <RoutinesIndexView />
        </div>
      </div>
    </FeatureFlagRouteGate>
  );
}
