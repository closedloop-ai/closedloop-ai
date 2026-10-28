import type { AnalyticsClient } from "./client";

/**
 * The one definition of "replay on" for flag-gated PostHog session replay on
 * the web surfaces (FEA-2400, ISS-10650; extended to marketing by ISS-12558
 * under PRD-790 Q-003). Each surface reads its own eligibility and calls these
 * from its own effect; the start/stop pair lives here so the surfaces cannot
 * drift on what they turn on.
 *
 * Start runs the masked replay configured by `./provider`'s
 * `POSTHOG_CLIENT_DEFAULTS` with dead-click autocapture; stop turns both off.
 * Sample rate, minimum duration, retention and volume are PostHog project
 * settings, so every surface calling these shares them.
 *
 * Opt-out is enforced inside posthog-js, in the copy `@posthog/next`
 * initializes (1.359.1): its recorder treats `consent.isOptedOut()` as
 * disabled (`session-recording.js` `_isRecordingEnabled`), and `capture()`
 * returns before sending once `is_capturing()` is false, so a withdrawal made
 * while a replay runs drops every later `$snapshot` batch.
 *
 * SDK calls are guarded so a PostHog failure can't take down the layout that
 * mounts the caller.
 */
export function startWebSessionReplay(posthog: AnalyticsClient): void {
  try {
    posthog.startSessionRecording();
    posthog.set_config({ capture_dead_clicks: true });
  } catch {
    // Telemetry must never affect app behavior.
  }
}

/** Stops what {@link startWebSessionReplay} started. */
export function stopWebSessionReplay(posthog: AnalyticsClient): void {
  try {
    posthog.stopSessionRecording();
    posthog.set_config({ capture_dead_clicks: false });
  } catch {
    // Telemetry must never affect app behavior.
  }
}
