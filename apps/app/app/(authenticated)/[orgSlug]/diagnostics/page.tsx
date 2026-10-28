import { DIAGNOSTICS_COMPLETE_SURFACE_FLAG_KEY } from "@repo/api/src/types/diagnostics-complete-surface-flag";
import type { Metadata } from "next";
import { FeatureFlagRouteGate } from "@/components/feature-flag-route-gate";
import { RouteChromeFallback } from "@/components/route-chrome-fallback";
import { Header } from "../../components/header";
import { WebDiagnosticsSurfaceHost } from "./components/diagnostics-surface-host";
import {
  DIAGNOSTICS_ROUTE_TITLE,
  WEB_DIAGNOSTICS_DESCRIPTION,
} from "./web-diagnostics-contract";

const DIAGNOSTICS_BREADCRUMBS = [{ label: DIAGNOSTICS_ROUTE_TITLE }];

/**
 * The `<meta name="description">` is THIS host's sentence, not the surface's
 * (tamsinb review). `DIAGNOSTICS_SURFACE_DESCRIPTION` names what a probe
 * reports, and web runs no probe — shipping it here would put the page's one
 * false claim in the place a search engine and a link preview read first.
 */
export const metadata: Metadata = {
  title: DIAGNOSTICS_ROUTE_TITLE,
  description: WEB_DIAGNOSTICS_DESCRIPTION,
};

/**
 * Web Diagnostics (ISS-10006, PRD-730 `wave-fs-3-desktop-to-web`).
 *
 * A perceivable new mount, so it is closed by default behind ONE PostHog key,
 * web-side, and not a desktop Labs toggle (operator directive 2026-08-30). The
 * key is REUSED rather than minted: `diagnostics-complete-surface` is already
 * "the single cross-surface key gating Diagnostics' move to complete-surface
 * ownership", and its own docstring names this host as a reader of it. A second
 * key would split one decision across two switches — and, because desktop
 * resolves the same per-user assignment, would also let the two shells drift.
 *
 * What the shared key means HERE is not what it means on desktop: desktop falls
 * back to a superseded body when the key reads off, and web has none to fall
 * back to, so off is a 404 (ISS-11114).
 *
 * No `<h1>` here: `DiagnosticsSurfaceV2` renders its own, and a second page
 * heading around it would put two names on one destination the shell already
 * labelled.
 */
export default function DiagnosticsPage() {
  return (
    <FeatureFlagRouteGate
      flag={DIAGNOSTICS_COMPLETE_SURFACE_FLAG_KEY}
      pending={<RouteChromeFallback breadcrumbs={DIAGNOSTICS_BREADCRUMBS} />}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <Header breadcrumbs={DIAGNOSTICS_BREADCRUMBS} />
        <div className="flex min-h-0 flex-1 flex-col overflow-auto p-4">
          <WebDiagnosticsSurfaceHost />
        </div>
      </div>
    </FeatureFlagRouteGate>
  );
}
