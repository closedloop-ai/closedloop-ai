/**
 * @file app-otel-runtime-onboarding-discard.ts
 * @description ISS-12421: the record shape and payload builder for the
 * onboarding analytics discard diagnostic, kept beside `app-otel-runtime.ts`
 * like its import-health and onboarding siblings.
 *
 * The ISS-12420 readiness queue writes this record when it refuses to deliver a
 * buffered onboarding event. The authenticated lanes cannot carry it: a
 * sign-out, expiry or overflow discard can fire with no ready target at all,
 * and an `identity_changed` / `organization_mismatch` discard can fire while a
 * live target exists, but that target belongs to the new identity rather than
 * the one that queued the event. So it rides Pipe 1, the keyless OTLP lane,
 * under the de-identified Resource `relay-otlp-exporters.ts` applies to
 * {@link ONBOARDING_DISCARD_LOGGER_NAME}. The local `gatewayLog` record the
 * queue writes beside it is unchanged.
 */
import {
  type AppTelemetry,
  AppTelemetrySchema,
  OnboardingAnalyticsAction,
  type OnboardingAnalyticsDropReason,
  OnboardingAnalyticsOriginalEvent,
  OnboardingAnalyticsStep,
} from "@closedloop-ai/telemetry-contract/app";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { OnboardingAnalyticsEvent } from "@repo/api/src/types/onboarding-analytics";
import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";

/** Log-record name; Datadog queries key on `onboarding_analytics.action`. */
export const ONBOARDING_DISCARD_EVENT_NAME =
  "onboarding_analytics.event_dropped";
/** Instrumentation scope these records are emitted under. */
export const ONBOARDING_DISCARD_LOGGER_NAME =
  "closedloop-desktop-onboarding-discard";

/** One discarded onboarding event, as the readiness queue diagnosed it. */
export type DesktopOnboardingDiscardEventInput = {
  reason: OnboardingAnalyticsDropReason;
  originalEvent: string;
  step: string | null;
  flowId: string | null;
  queueAgeMs: number;
};

/** The name + validated attributes to emit for one discard record. */
export type DesktopOnboardingDiscardRecord = {
  name: string;
  attributes: AppTelemetry;
};

/**
 * Build the log-record payload for `input`.
 *
 * Only closed enums, the attempt UUID and the queue age can ship: the
 * `.strict()` parse rejects anything else, and the discarded event's
 * properties are not an input at all. An event name, step or attempt id the
 * contract does not know is omitted rather than guessed, as is a queue age
 * (carried as the canonical `duration_ms`) outside the contract's bound, so
 * one bad field cannot drop the reason with it.
 */
export function buildOnboardingDiscardRecord(
  input: DesktopOnboardingDiscardEventInput
): DesktopOnboardingDiscardRecord {
  const originalEvent = lookup(ORIGINAL_EVENT, input.originalEvent);
  const step = lookup(STEP, input.step);
  const { shape } = AppTelemetrySchema;
  const flowId = shape[TelemetryAttribute.OnboardingAnalyticsFlowId].safeParse(
    input.flowId ?? undefined
  );
  const queueAge = shape[TelemetryAttribute.DurationMs].safeParse(
    input.queueAgeMs
  );
  return {
    name: ONBOARDING_DISCARD_EVENT_NAME,
    attributes: AppTelemetrySchema.parse({
      [TelemetryAttribute.OnboardingAnalyticsAction]:
        OnboardingAnalyticsAction.EventDropped,
      [TelemetryAttribute.OnboardingAnalyticsReason]: input.reason,
      ...(originalEvent && {
        [TelemetryAttribute.OnboardingAnalyticsOriginalEvent]: originalEvent,
      }),
      ...(step && { [TelemetryAttribute.OnboardingAnalyticsStep]: step }),
      ...(flowId.data && {
        [TelemetryAttribute.OnboardingAnalyticsFlowId]: flowId.data,
      }),
      ...(queueAge.success && {
        [TelemetryAttribute.DurationMs]: queueAge.data,
      }),
    }),
  };
}

/** Exhaustive: a new onboarding event fails `tsc` here until it is mapped. */
const ORIGINAL_EVENT: Record<
  OnboardingAnalyticsEvent,
  OnboardingAnalyticsOriginalEvent
> = {
  [OnboardingAnalyticsEvent.FlowStarted]:
    OnboardingAnalyticsOriginalEvent.FlowStarted,
  [OnboardingAnalyticsEvent.StepViewed]:
    OnboardingAnalyticsOriginalEvent.StepViewed,
  [OnboardingAnalyticsEvent.StepCompleted]:
    OnboardingAnalyticsOriginalEvent.StepCompleted,
  [OnboardingAnalyticsEvent.StepFailed]:
    OnboardingAnalyticsOriginalEvent.StepFailed,
  [OnboardingAnalyticsEvent.StepSkipped]:
    OnboardingAnalyticsOriginalEvent.StepSkipped,
  [OnboardingAnalyticsEvent.StepBack]:
    OnboardingAnalyticsOriginalEvent.StepBack,
  [OnboardingAnalyticsEvent.CtaClicked]:
    OnboardingAnalyticsOriginalEvent.CtaClicked,
  [OnboardingAnalyticsEvent.FlowCompleted]:
    OnboardingAnalyticsOriginalEvent.FlowCompleted,
  [OnboardingAnalyticsEvent.TourStarted]:
    OnboardingAnalyticsOriginalEvent.TourStarted,
  [OnboardingAnalyticsEvent.TourStepViewed]:
    OnboardingAnalyticsOriginalEvent.TourStepViewed,
  [OnboardingAnalyticsEvent.TourCompleted]:
    OnboardingAnalyticsOriginalEvent.TourCompleted,
  [OnboardingAnalyticsEvent.TourSkipped]:
    OnboardingAnalyticsOriginalEvent.TourSkipped,
  [OnboardingAnalyticsEvent.ChecklistItemCompleted]:
    OnboardingAnalyticsOriginalEvent.ChecklistItemCompleted,
  [OnboardingAnalyticsEvent.ChecklistCompleted]:
    OnboardingAnalyticsOriginalEvent.ChecklistCompleted,
  [OnboardingAnalyticsEvent.PageViewed]:
    OnboardingAnalyticsOriginalEvent.PageViewed,
  [OnboardingAnalyticsEvent.ButtonClicked]:
    OnboardingAnalyticsOriginalEvent.ButtonClicked,
};

/** Same exhaustiveness guard for the onboarding phases. */
const STEP: Record<OnboardingPhase, OnboardingAnalyticsStep> = {
  [OnboardingPhase.Welcome]: OnboardingAnalyticsStep.Welcome,
  [OnboardingPhase.SessionDiscovery]: OnboardingAnalyticsStep.SessionDiscovery,
  [OnboardingPhase.Account]: OnboardingAnalyticsStep.Account,
  [OnboardingPhase.CreateOrganization]:
    OnboardingAnalyticsStep.CreateOrganization,
  [OnboardingPhase.ChooseOrganization]:
    OnboardingAnalyticsStep.ChooseOrganization,
  [OnboardingPhase.SyncPolicy]: OnboardingAnalyticsStep.SyncPolicy,
  [OnboardingPhase.InviteTeam]: OnboardingAnalyticsStep.InviteTeam,
  [OnboardingPhase.DownloadDesktop]: OnboardingAnalyticsStep.DownloadDesktop,
  [OnboardingPhase.ConnectGitHub]: OnboardingAnalyticsStep.ConnectGitHub,
  [OnboardingPhase.DashboardAvailable]:
    OnboardingAnalyticsStep.DashboardAvailable,
  [OnboardingPhase.DashboardTour]: OnboardingAnalyticsStep.DashboardTour,
  [OnboardingPhase.Ready]: OnboardingAnalyticsStep.Ready,
};

/** `Object.hasOwn` first, so a key like `constructor` cannot resolve. */
function lookup<T>(table: Record<string, T>, key: string | null): T | null {
  return key !== null && Object.hasOwn(table, key) ? table[key] : null;
}
