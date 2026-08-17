import { analytics } from "@repo/analytics/server";
import type { DesktopAnalyticsCaptureInput } from "./desktop-analytics-handler";

/**
 * Serverless-runtime capture sink: forwards one validated Desktop analytics
 * event to PostHog. Shared by the serverless entry points — the relay
 * socket-event dispatcher (`app/internal/relay/socket-event/service.ts`) and
 * the FEA-3425 REST twin (`app/desktop/analytics/service.ts`) — so capture
 * behavior cannot drift between transports.
 *
 * Deliberately NOT in `desktop-analytics-handler.ts`: the handler is
 * runtime-neutral and is also imported by the long-lived direct-connect socket
 * server (`lib/desktop-gateway-socket-server.ts`), which owns its own
 * `nodeAnalytics`-backed sink — analytics runtime selection stays with each
 * owning entrypoint.
 */
export function captureDesktopAnalytics(
  input: DesktopAnalyticsCaptureInput
): void {
  analytics.capture(input);
}
