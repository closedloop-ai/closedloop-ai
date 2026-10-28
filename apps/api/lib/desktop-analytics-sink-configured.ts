import { keys } from "@repo/analytics/keys";

/**
 * `@repo/analytics/node` returns a silent no-op stub when
 * `NEXT_PUBLIC_POSTHOG_KEY` is unset, so "captured" through it means the event
 * was swallowed. Evaluated once at module load, like the stub decision itself.
 *
 * Imports only the env schema, never a client, so it stays runtime-neutral;
 * the serverless capture sink (`desktop-analytics-capture.ts`, behind
 * `server-only`) calls it.
 */
const CAPTURE_SINK_CONFIGURED = Boolean(keys().NEXT_PUBLIC_POSTHOG_KEY);

/**
 * Refuses an unconfigured PostHog sink. Before PRD-736 P1 the retired relay
 * flag's unanswered lookup surfaced this deployment state as
 * `analytics_unavailable`; the flag read is gone, so the sink is the only
 * place left that can tell the truth about it (Handling Bad Data: never emit
 * a plausible-but-wrong value). The handler maps the throw to the still-live
 * `capture_failed` rather than acking `accepted: true` for an event the no-op
 * stub swallowed.
 */
export function assertDesktopAnalyticsCaptureConfigured(): void {
  if (!CAPTURE_SINK_CONFIGURED) {
    throw new Error(
      "PostHog capture sink is not configured (NEXT_PUBLIC_POSTHOG_KEY unset)"
    );
  }
}
