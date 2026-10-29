import { app } from "electron";
import type { DesktopAuthStatus } from "../../shared/contracts.js";
import { DesktopAppOperatingMode } from "./app-otel-runtime-lifecycle.js";
import { resolveDesktopTelemetryEgressEnabled } from "./desktop-telemetry-egress.js";

/**
 * ISS-10503 (PRD-736 D5): the pre-auth reads the observability lane router
 * gates on. Auth status and operating mode come from the same owners the
 * session-sync identity adapter and the OTel lifecycle already read, so the
 * pre-auth gate cannot drift from them; `getNodeUuid` is the install's
 * node_uuid — the single-player PostHog person (decision #10), never aliased
 * and never `identify`-ed. The router takes the raw status (not a boolean)
 * because routing and latch rotation read DIFFERENT facts from it.
 *
 * `isPreAuthSendEnabled` is the FEA-2199 packaged-build egress policy applied
 * to this lane: the authenticated analytics lane is implicitly scoped by a
 * real session, but a pre-auth send is UNAUTHENTICATED egress to the default
 * (production) API origin, so an unpackaged dev/E2E/CI launch would mint junk
 * PostHog persons and fire real network calls inside guest e2e runs (which is
 * exactly how #7768's merge group failed twice). Same resolver, same
 * CLOSEDLOOP_DESKTOP_TELEMETRY_EGRESS override for deliberate testing.
 */
export function createPreAuthAnalyticsIdentityReads(sources: {
  getAuthStatus: () => DesktopAuthStatus;
  getNodeUuid: () => string;
  /** Lazy: the composition root builds this before the store fields exist. */
  getOperatingMode: () => DesktopAppOperatingMode;
}): {
  getAuthStatus: () => DesktopAuthStatus;
  getNodeUuid: () => string;
  isSinglePlayerInstall: () => boolean;
  isPreAuthSendEnabled: () => boolean;
} {
  // Resolved here (like the composition root's FEA-2199 wiring) rather than
  // injected, so the grandfathered app.ts carries no extra lines; the router
  // takes the injected boolean, which is where the gate is unit-tested.
  const preAuthSendEnabled = resolveDesktopTelemetryEgressEnabled({
    isPackaged: app.isPackaged,
    env: process.env,
  });
  return {
    getAuthStatus: sources.getAuthStatus,
    getNodeUuid: sources.getNodeUuid,
    isSinglePlayerInstall: () =>
      sources.getOperatingMode() === DesktopAppOperatingMode.SinglePlayer,
    isPreAuthSendEnabled: () => preAuthSendEnabled,
  };
}
