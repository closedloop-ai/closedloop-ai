import { HELP_COMPLETE_SURFACE_FLAG_KEY } from "@repo/api/src/types/help-complete-surface-flag";
import { LABS_NAV_SECTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { Metadata } from "next";
import { FeatureFlagRouteGate } from "@/components/feature-flag-route-gate";
import { RouteChromeFallback } from "@/components/route-chrome-fallback";
import { env } from "@/env";
import { Header } from "../../components/header";
import { WebHelpSurfaceHost } from "./components/help-surface-host";

const HELP_BREADCRUMBS = [{ label: "Help" }];

export const metadata: Metadata = {
  title: "Help",
  description: "Product documentation, searchable from inside the app",
};

/**
 * Web Help (ISS-10006, PRD-730 `wave-fs-3-desktop-to-web`).
 *
 * A perceivable new mount, so it is closed by default behind ONE PostHog key,
 * web-side, and not a desktop Labs toggle (operator directive 2026-08-30). The
 * key is REUSED rather than minted: `help-complete-surface` is already "the
 * single cross-surface key gating Help's move to complete-surface ownership".
 *
 * `docsSiteUrl` is resolved HERE, on the server, from the deployment's own env.
 * It is the "view latest online" escape hatch every degraded Help state offers,
 * so a client guess at the docs host would send a reader on a stage deployment
 * to production docs. `NEXT_PUBLIC_DOCS_URL` is optional in the schema, so it
 * falls back to the web origin's `/docs` — the path `apps/web` serves the same
 * corpus from — rather than to an empty string, which would render a link to
 * this app's own root.
 *
 * TWO gates, in the order the nav declares them (tamsinb review). Help is a
 * LABS destination on web — `SHELL_NAVIGATION_ITEMS` gates the row on
 * `LABS_NAV_SECTION_FEATURE_FLAG_KEY` and then on the surface key — so the route
 * carries the container gate as well. Leaving this URL reachable while the Labs
 * nav is hidden would defeat that gate, which is the reason
 * `insights/lost-work/page.tsx` and `judges-analytics/page.tsx` both carry it.
 * Diagnostics needs no counterpart: it is an Account-group entry, gated on its
 * own key alone.
 *
 * No `<h1>`: `HelpSurfaceV2` renders its own.
 */
export default function HelpPage() {
  return (
    <FeatureFlagRouteGate
      flag={LABS_NAV_SECTION_FEATURE_FLAG_KEY}
      pending={<RouteChromeFallback breadcrumbs={HELP_BREADCRUMBS} />}
    >
      <FeatureFlagRouteGate
        flag={HELP_COMPLETE_SURFACE_FLAG_KEY}
        pending={<RouteChromeFallback breadcrumbs={HELP_BREADCRUMBS} />}
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <Header breadcrumbs={HELP_BREADCRUMBS} />
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <WebHelpSurfaceHost
              docsSiteUrl={
                env.NEXT_PUBLIC_DOCS_URL ?? `${env.NEXT_PUBLIC_WEB_URL}/docs`
              }
            />
          </div>
        </div>
      </FeatureFlagRouteGate>
    </FeatureFlagRouteGate>
  );
}
