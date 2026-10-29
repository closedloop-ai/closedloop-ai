/**
 * @file app-otel-runtime-onboarding.ts
 * @description ISS-6340: the record shape and payload builder for desktop
 * onboarding lifecycle events, kept beside `app-otel-runtime.ts` rather than
 * inside it (the same split as `app-otel-runtime-import-health.ts` and
 * `app-otel-runtime-lifecycle.ts`). The runtime keeps only the started-state
 * guard, the emit call, and the swallow.
 *
 * These ride Pipe 1 — the UNAUTHENTICATED keyless relay — which is the whole
 * point of the issue. Onboarding is substantially pre-auth, so the auth-gated
 * `Observability.emitTelemetry` lane (which carries the five existing
 * `onboarding.popup_*` events) drops exactly the records that would explain a
 * stuck or abandoned onboarding.
 */
import {
  type AppTelemetry,
  AppTelemetrySchema,
  type OnboardingConsentLevel,
  OnboardingEvent,
  type OnboardingStep,
} from "@closedloop-ai/telemetry-contract/app";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";

/** Log-record name carried by every onboarding lifecycle record. */
export const ONBOARDING_EVENT_NAME = "onboarding.lifecycle";
/** Instrumentation scope these records are emitted under. */
export const ONBOARDING_LOGGER_NAME = "closedloop-desktop-onboarding";

/**
 * One desktop onboarding lifecycle record: which step, what happened there, and
 * — on a consent decision only — which level was chosen. Closed enums only;
 * there is no field here that can carry an identifier, an email, an org, a path,
 * or a dwell time.
 */
export type DesktopOnboardingEventInput = {
  step: OnboardingStep;
  event: OnboardingEvent;
  consentLevel?: OnboardingConsentLevel;
};

/** The name + validated attributes to emit for one onboarding record. */
export type DesktopOnboardingRecord = {
  name: string;
  attributes: AppTelemetry;
};

/**
 * Build the log-record payload for `input`.
 *
 * The `.strict()` closed-world parse is the enforcement point, exactly as it is
 * for import health: only the three `onboarding.*` enums can ship, so a
 * regression that tried to attach an account id or an error message throws here
 * rather than leaking it. Throwing is intended — the caller swallows, per the
 * desktop exporter-boundary rule.
 *
 * `consentLevel` is attached only to a consent decision. Omitted — never
 * serialized as `null` — on every other event, so the attribute's presence is
 * itself the signal that a choice was recorded.
 */
export function buildOnboardingRecord(
  input: DesktopOnboardingEventInput
): DesktopOnboardingRecord {
  const consentAttributes =
    input.event === OnboardingEvent.ConsentRecorded && input.consentLevel
      ? { [TelemetryAttribute.OnboardingConsentLevel]: input.consentLevel }
      : {};
  return {
    name: ONBOARDING_EVENT_NAME,
    attributes: AppTelemetrySchema.parse({
      [TelemetryAttribute.OnboardingStep]: input.step,
      [TelemetryAttribute.OnboardingEvent]: input.event,
      ...consentAttributes,
    }),
  };
}
