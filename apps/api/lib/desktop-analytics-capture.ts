import { analytics } from "@repo/analytics/server";
import type { DesktopAnalyticsCaptureInput } from "./desktop-analytics-handler";
import { assertDesktopAnalyticsCaptureConfigured } from "./desktop-analytics-sink-configured";

/**
 * Serverless-runtime capture sink: forwards one validated Desktop analytics
 * event to PostHog for the REST routes (`app/desktop/analytics/service.ts`
 * and its sign-in twin).
 *
 * Throws on an unconfigured PostHog client instead of enqueueing into the
 * no-op stub, so the handler answers `capture_failed` rather than a
 * `captured: true` for an event that was never captured (see
 * `desktop-analytics-sink-configured.ts`).
 */
export function captureDesktopAnalytics(
  input: DesktopAnalyticsCaptureInput
): void {
  assertDesktopAnalyticsCaptureConfigured();
  analytics.capture(input);
}

/**
 * ISS-10503 (PRD-736 D5, invariant 5): the server-emitted PostHog alias that
 * folds a pre-auth onboarding attempt's history into the authenticated person.
 * Only the handler — which alone knows the authoritative clerkUserId — calls
 * this; the client never asserts the merged identity. `node_uuid` is never
 * passed here (PRD-389 §8): the desktop presents an onboarding id only.
 */
export function aliasDesktopAnalytics(input: {
  distinctId: string;
  alias: string;
}): void {
  assertDesktopAnalyticsCaptureConfigured();
  analytics.alias(input);
}
