/**
 * @file onboarding-discard-telemetry.ts
 * @description ISS-12421: carries the ISS-12420 readiness queue's discard
 * diagnostics onto the desktop OTel runtime. Bound once by the composition root,
 * like `genAiRequestTelemetry`, so the queue needs no new constructor option.
 * Before the bind, and whenever the runtime is not started, a report is a
 * no-op; the queue's local `gatewayLog` record is written either way.
 */
import type { DesktopOtelRuntime } from "./app-otel-runtime.js";
import type { DesktopOnboardingDiscardEventInput } from "./app-otel-runtime-onboarding-discard.js";

type OnboardingDiscardSink = Pick<
  DesktopOtelRuntime,
  "emitOnboardingDiscardEvent"
>;

export type OnboardingDiscardTelemetry = {
  bindRuntime: (runtime: OnboardingDiscardSink | null) => void;
  report: (input: DesktopOnboardingDiscardEventInput) => void;
};

export function createOnboardingDiscardTelemetry(): OnboardingDiscardTelemetry {
  let runtime: OnboardingDiscardSink | null = null;
  return {
    bindRuntime(next) {
      runtime = next;
    },
    report(input) {
      runtime?.emitOnboardingDiscardEvent(input);
    },
  };
}

export const onboardingDiscardTelemetry = createOnboardingDiscardTelemetry();
