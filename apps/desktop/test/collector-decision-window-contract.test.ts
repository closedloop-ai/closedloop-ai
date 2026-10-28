import { CollectorTailSamplingPolicy } from "@closedloop-ai/telemetry-contract/collector-tail-sampling-policy";
import { describe, expect, it } from "vitest";
import { DESKTOP_ACTIVITY_ROOT_MAX_AGE_MS } from "../src/main/telemetry/app-otel-runtime.js";

/**
 * The collector's `decision_wait` is derived from this app's activity-window
 * cap, and only this package can see both halves — `packages/telemetry-contract`
 * is published and cannot depend on `apps/desktop`, so the relationship lives
 * there as a comment and is pinned here (ISS-9254).
 *
 * Without this, raising `DESKTOP_ACTIVITY_ROOT_MAX_AGE_MS` silently invalidates
 * the window: the sampler would start voting before a full activity window had
 * closed, and the accepted 14.9%-of-roots residual would grow with nothing red.
 */
const EXPORT_SLACK_MS = 10_000;

describe("collector decision window vs the desktop activity-window cap", () => {
  it("buffers a full activity window plus export slack", () => {
    const decisionWindowMs =
      CollectorTailSamplingPolicy.decisionWaitSeconds * 1000;
    expect(decisionWindowMs).toBeGreaterThan(DESKTOP_ACTIVITY_ROOT_MAX_AGE_MS);
    expect(decisionWindowMs - DESKTOP_ACTIVITY_ROOT_MAX_AGE_MS).toBe(
      EXPORT_SLACK_MS
    );
  });

  it("leaves keep-slow inside the window it can actually accumulate", () => {
    // A root that outlives the window is voted on before it arrives, so the
    // buffered timestamp span is bounded by the window; a threshold at or above
    // it would leave keep-slow permanently silent on this producer.
    expect(
      CollectorTailSamplingPolicy.slowTraceLatencyThresholdMs
    ).toBeLessThan(CollectorTailSamplingPolicy.decisionWaitSeconds * 1000);
    // And below the activity-window cap itself, so a window that closes at its
    // cap is still caught when its last spans arrive late.
    expect(
      CollectorTailSamplingPolicy.slowTraceLatencyThresholdMs
    ).toBeLessThan(DESKTOP_ACTIVITY_ROOT_MAX_AGE_MS);
  });
});
