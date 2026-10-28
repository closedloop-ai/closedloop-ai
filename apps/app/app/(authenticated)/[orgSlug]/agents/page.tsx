import { AGENTS_NAV_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { Metadata } from "next";
import { FeatureFlagRouteGate } from "@/components/feature-flag-route-gate";
import { RouteChromeFallback } from "@/components/route-chrome-fallback";
import { Header } from "../../components/header";
import { AgentsListHost } from "./components/agents-list-host";

const AGENTS_BREADCRUMBS = [{ label: "Agents" }];

export const metadata: Metadata = {
  title: "Agents",
  description: "Manage AI agents for your organization",
};

/**
 * Agents index (ISS-5041 / ISS-7835).
 *
 * Route-level gate, not just a hidden nav item: with the flag off, deep-linking
 * `/agents` lands on the in-shell "Page not found" recovery state via
 * `notFound()`, matching Insights. Gating only the nav would leave
 * the surface reachable by URL, which is what "they gate, not 404-by-accident"
 * rules out.
 */
export default function AgentsPage() {
  return (
    <FeatureFlagRouteGate
      flag={AGENTS_NAV_FEATURE_FLAG_KEY}
      pending={<RouteChromeFallback breadcrumbs={AGENTS_BREADCRUMBS} />}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <Header breadcrumbs={AGENTS_BREADCRUMBS} />
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <AgentsListHost />
        </div>
      </div>
    </FeatureFlagRouteGate>
  );
}
