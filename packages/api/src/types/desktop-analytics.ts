import { z } from "zod";
import type { JsonValue } from "./common";
import {
  OnboardingAnalyticsEvent,
  OnboardingAnalyticsProperty,
} from "./onboarding-analytics.ts";
import { SurfaceAnalyticsEvent } from "./surface-analytics.ts";

export const DESKTOP_ANALYTICS_SOCKET_EVENT = "desktop.analytics" as const;

/**
 * Maximum length (UTF-16 code units) the cloud accepts for any single string
 * property value. The server schema rejects the entire event when a value
 * exceeds this, so Desktop clamps each string to this length before sending.
 * Shared here so the sender-side clamp and the server-side cap stay in lockstep.
 */
export const DESKTOP_ANALYTICS_STRING_MAX_LENGTH = 512;

/**
 * ISS-7704: `FeatureDisabled` and `AnalyticsUnavailable` are distinct on
 * purpose. `FeatureDisabled` means PostHog ANSWERED and the answer was off for
 * this `clerkUserId` — a verdict that stays true until the rollout changes.
 * `AnalyticsUnavailable` means PostHog did not answer at all, which says
 * nothing about the rollout and must not be read as one.
 *
 * PRD-736 P1 retired the `desktop-server-analytics-relay` flag, so the current
 * server emits NEITHER of those two reasons. Both members stay for one release
 * as version-skew compatibility surface (Cross-Repo Compatibility rule): a new
 * desktop build can meet a pre-P1 API deployment mid-rollout, and the desktop
 * lane's coded 403/503 handling dispatches on them.
 */
export const DesktopAnalyticsAckReason = {
  FeatureDisabled: "feature_disabled",
  AnalyticsUnavailable: "analytics_unavailable",
  RateLimited: "rate_limited",
  ValidationFailed: "validation_failed",
  CaptureFailed: "capture_failed",
} as const;

export type DesktopAnalyticsAckReason =
  (typeof DesktopAnalyticsAckReason)[keyof typeof DesktopAnalyticsAckReason];

export type DesktopAnalyticsAck =
  /**
   * `aliased` (ISS-10503): outcome of the alias handshake, set only when the
   * payload presented an onboarding id AND an alias sink exists on the
   * transport — `true` = the alias reached PostHog, `false` = it failed and
   * the client should re-present the id. Absent otherwise.
   */
  | { accepted: true; aliased?: boolean }
  | { accepted: false; reason: DesktopAnalyticsAckReason };

/**
 * Wire admission of the FTUE onboarding catalog (ISS-10502 D1). Keys-covered
 * guard: `satisfies Record<keyof typeof OnboardingAnalyticsEvent, …>` makes a
 * NEW member of the canonical catalog fail typecheck here until it is
 * deliberately admitted to (or excluded from) the desktop wire — the relay
 * rejects unknown names with a whole-payload refusal, so an unadmitted event
 * would otherwise be dropped silently in production.
 */
const ONBOARDING_WIRE_EVENTS = {
  FlowStarted: OnboardingAnalyticsEvent.FlowStarted,
  StepViewed: OnboardingAnalyticsEvent.StepViewed,
  StepCompleted: OnboardingAnalyticsEvent.StepCompleted,
  StepFailed: OnboardingAnalyticsEvent.StepFailed,
  StepSkipped: OnboardingAnalyticsEvent.StepSkipped,
  StepBack: OnboardingAnalyticsEvent.StepBack,
  CtaClicked: OnboardingAnalyticsEvent.CtaClicked,
  FlowCompleted: OnboardingAnalyticsEvent.FlowCompleted,
  TourStarted: OnboardingAnalyticsEvent.TourStarted,
  TourStepViewed: OnboardingAnalyticsEvent.TourStepViewed,
  TourCompleted: OnboardingAnalyticsEvent.TourCompleted,
  TourSkipped: OnboardingAnalyticsEvent.TourSkipped,
  ChecklistItemCompleted: OnboardingAnalyticsEvent.ChecklistItemCompleted,
  ChecklistCompleted: OnboardingAnalyticsEvent.ChecklistCompleted,
  PageViewed: OnboardingAnalyticsEvent.PageViewed,
  ButtonClicked: OnboardingAnalyticsEvent.ButtonClicked,
} as const satisfies Record<
  keyof typeof OnboardingAnalyticsEvent,
  OnboardingAnalyticsEvent
>;

export const DesktopAnalyticsEventName = {
  AgentSessionSyncBatchFailed: "agent_session_sync_batch_failed",
  CommandInitiated: "command_initiated",
  CommandStarted: "command_started",
  CommandCompleted: "command_completed",
  CommandFailed: "command_failed",
  ApprovalRequested: "approval_requested",
  ApprovalResolved: "approval_resolved",
  DesktopConnectionEstablished: "desktop_connection_established",
  DesktopReconnectionResumed: "desktop_reconnection_resumed",
  DesktopConnectionDegraded: "desktop_connection_degraded",
  DesktopConnectionLost: "desktop_connection_lost",
  DesktopPopUnavailable: "desktop_pop_unavailable",
  PluginUpdateAttempted: "plugin_update_attempted",
  PluginUpdateSucceeded: "plugin_update_succeeded",
  PluginUpdateFailed: "plugin_update_failed",
  SandboxBlockedOperation: "sandbox_blocked_operation",
  HealthcheckFailureDetected: "healthcheck.failure_detected",
  HealthcheckFailurePersistent: "healthcheck.failure_persistent",
  HealthcheckRecovered: "healthcheck.recovered",
  // ISS-8752: the desktop-relayed subset of the surface-attributed analytics
  // port. The name is owned by SurfaceAnalyticsEvent (one declaration, so the
  // renderer emitter and this wire contract cannot drift).
  SharedComponentRendered: SurfaceAnalyticsEvent.SharedComponentRendered,
  GridviewRolloutDecision: SurfaceAnalyticsEvent.GridviewRolloutDecision,
  // ISS-10502 (PRD-736 D1): the FTUE onboarding catalog, admitted through the
  // keys-covered guard above so the names are owned by one declaration.
  ...ONBOARDING_WIRE_EVENTS,
} as const;

export type DesktopAnalyticsEventName =
  (typeof DesktopAnalyticsEventName)[keyof typeof DesktopAnalyticsEventName];

export type DesktopAnalyticsPayload = {
  event: DesktopAnalyticsEventName;
  properties: Record<string, JsonValue>;
  occurredAt: string;
  /**
   * ISS-10503 (PRD-736 D5): the client-supplied distinct id, envelope-level
   * (never a property — the property-level identity keys stay forbidden). On
   * an UNAUTHENTICATED request it is required and becomes the PostHog person:
   * the attempt-scoped onboarding id, or `node_uuid` for a single-player
   * install. On an AUTHENTICATED request it is the alias trigger: the first
   * such call after account establishment carries the onboarding id once, and
   * the handler emits `alias(onboarding id → clerkUserId)`; capture identity
   * stays the server-resolved clerkUserId. Always a well-formed v4 UUID
   * (decision #12); omitted, never null, when absent.
   */
  distinctId?: string;
};

/**
 * ISS-10503 (PRD-736 D5): server-stamped `desktop_attribution_model` values —
 * which identity model attributed a desktop-relayed capture. `GatewayOwner` is
 * the authenticated lane (person = clerkUserId); `PreAuthDistinctId` is the
 * pre-auth mode (person = the client-supplied onboarding id or node_uuid).
 */
export const DesktopAnalyticsAttributionModel = {
  GatewayOwner: "gateway_owner",
  PreAuthDistinctId: "preauth_distinct_id",
} as const;

export type DesktopAnalyticsAttributionModel =
  (typeof DesktopAnalyticsAttributionModel)[keyof typeof DesktopAnalyticsAttributionModel];

/**
 * FEA-3425: success payload of `POST /desktop/analytics`. Not `.strict()`:
 * Desktop and API deploy independently and are version-skewed, so an additive
 * server field must degrade gracefully (ignored) rather than fail parsing and
 * silently drop the whole capture on a skewed client.
 */
export const desktopAnalyticsCaptureResponseValidator = z.object({
  captured: z.literal(true),
  /**
   * ISS-10503 (PR #7768 review): whether the alias handshake this request
   * carried actually reached PostHog — the capture ack alone must not clear
   * the desktop's pending-alias latch, because the handler survives an alias
   * failure and still captures. Present only when the request presented an
   * onboarding id; absent from a pre-P #7768 API, which also never aliases,
   * so a client that keeps re-presenting against it is correct.
   */
  aliased: z.boolean().optional(),
});
export type DesktopAnalyticsCaptureResponse = z.infer<
  typeof desktopAnalyticsCaptureResponseValidator
>;

/**
 * FEA-3425: full `ApiResult` envelope of `POST /desktop/analytics`. The success
 * arm is not `.strict()` (see {@link desktopAnalyticsCaptureResponseValidator})
 * so additive server fields degrade gracefully; the error arm stays
 * `.passthrough()` so the `code` metadata survives.
 */
export const desktopAnalyticsCaptureApiResultValidator = z.union([
  z.object({
    success: z.literal(true),
    data: desktopAnalyticsCaptureResponseValidator,
  }),
  z
    .object({
      success: z.literal(false),
      error: z.string(),
    })
    .passthrough(),
]);

export type DesktopAnalyticsCaptureApiResult = z.infer<
  typeof desktopAnalyticsCaptureApiResultValidator
>;

/**
 * Wire admission of the FTUE onboarding property keys (ISS-10502 D1),
 * including `device_id` — the product↔ops join key stamped on every
 * desktop-relayed event (PRD-736 decision #11). Same keys-covered guard as
 * {@link ONBOARDING_WIRE_EVENTS}: a new canonical property fails typecheck
 * here until deliberately admitted, so the relay can never silently reject
 * whole events over a key nobody placed.
 */
const ONBOARDING_WIRE_PROPERTY_KEYS = {
  Surface: OnboardingAnalyticsProperty.Surface,
  FlowId: OnboardingAnalyticsProperty.FlowId,
  FirstOrgUser: OnboardingAnalyticsProperty.FirstOrgUser,
  StepIndex: OnboardingAnalyticsProperty.StepIndex,
  Step: OnboardingAnalyticsProperty.Step,
  FromStep: OnboardingAnalyticsProperty.FromStep,
  EntryPoint: OnboardingAnalyticsProperty.EntryPoint,
  SkipAvailable: OnboardingAnalyticsProperty.SkipAvailable,
  DeviceId: OnboardingAnalyticsProperty.DeviceId,
  DurationSeconds: OnboardingAnalyticsProperty.DurationSeconds,
  StepsSkipped: OnboardingAnalyticsProperty.StepsSkipped,
  CtaId: OnboardingAnalyticsProperty.CtaId,
  SessionsFoundCount: OnboardingAnalyticsProperty.SessionsFoundCount,
  HarnessesDetectedCount: OnboardingAnalyticsProperty.HarnessesDetectedCount,
  HarnessesDetected: OnboardingAnalyticsProperty.HarnessesDetected,
  AccountProvider: OnboardingAnalyticsProperty.AccountProvider,
  AccountMode: OnboardingAnalyticsProperty.AccountMode,
  FailureReason: OnboardingAnalyticsProperty.FailureReason,
  OrgMembership: OnboardingAnalyticsProperty.OrgMembership,
  SyncPolicyChoice: OnboardingAnalyticsProperty.SyncPolicyChoice,
  InvitesSentCount: OnboardingAnalyticsProperty.InvitesSentCount,
  DownloadClicked: OnboardingAnalyticsProperty.DownloadClicked,
  GitHubConnected: OnboardingAnalyticsProperty.GitHubConnected,
  TourSource: OnboardingAnalyticsProperty.TourSource,
  TourStepId: OnboardingAnalyticsProperty.TourStepId,
  TourStepIndex: OnboardingAnalyticsProperty.TourStepIndex,
  TourStepsViewedCount: OnboardingAnalyticsProperty.TourStepsViewedCount,
  AtTourStepIndex: OnboardingAnalyticsProperty.AtTourStepIndex,
  AtTourStepId: OnboardingAnalyticsProperty.AtTourStepId,
  ItemId: OnboardingAnalyticsProperty.ItemId,
  ItemsCompletedCount: OnboardingAnalyticsProperty.ItemsCompletedCount,
  PageName: OnboardingAnalyticsProperty.PageName,
  ButtonName: OnboardingAnalyticsProperty.ButtonName,
  SyncChoiceSelected: OnboardingAnalyticsProperty.SyncChoiceSelected,
  OwnAnalyzedSessionsVolume:
    OnboardingAnalyticsProperty.OwnAnalyzedSessionsVolume,
  OrgAnalyzedSessionsVolume:
    OnboardingAnalyticsProperty.OrgAnalyzedSessionsVolume,
} as const satisfies Record<
  keyof typeof OnboardingAnalyticsProperty,
  OnboardingAnalyticsProperty
>;

/**
 * Whether each canonical onboarding property carries a string ARRAY on the
 * wire (PRD-736: the closed-enum list properties); everything else is
 * primitive-valued. An exhaustive `Record`, not a bare set of the array
 * members (marisolashgrove on #7748; root AGENTS.md "side inventory of a union"):
 * a new canonical property fails `tsc` HERE until it declares its shape, so a
 * future list property cannot silently land primitive-only — where its arrays
 * would be dropped at the sanitizer and refused at the relay with no reason
 * anyone would see.
 */
const ONBOARDING_PROPERTY_CARRIES_ARRAY: Record<
  OnboardingAnalyticsProperty,
  boolean
> = {
  [OnboardingAnalyticsProperty.Surface]: false,
  [OnboardingAnalyticsProperty.FlowId]: false,
  [OnboardingAnalyticsProperty.FirstOrgUser]: false,
  [OnboardingAnalyticsProperty.StepIndex]: false,
  [OnboardingAnalyticsProperty.Step]: false,
  [OnboardingAnalyticsProperty.FromStep]: false,
  [OnboardingAnalyticsProperty.EntryPoint]: false,
  [OnboardingAnalyticsProperty.SkipAvailable]: false,
  [OnboardingAnalyticsProperty.DeviceId]: false,
  [OnboardingAnalyticsProperty.DurationSeconds]: false,
  [OnboardingAnalyticsProperty.StepsSkipped]: true,
  [OnboardingAnalyticsProperty.CtaId]: false,
  [OnboardingAnalyticsProperty.SessionsFoundCount]: false,
  [OnboardingAnalyticsProperty.HarnessesDetectedCount]: false,
  [OnboardingAnalyticsProperty.HarnessesDetected]: true,
  [OnboardingAnalyticsProperty.AccountProvider]: false,
  // ISS-10913: array-valued. Declared `false` while the property was RESERVED,
  // which is only correct while nothing emits it — and all THREE readers of
  // this record treat the declaration as the whole contract (whitlockk on #7815):
  // the desktop sanitizer and the renderer-event IPC guard
  // (`apps/desktop/src/main/ipc/surface-analytics-ipc.ts`) both DROP an array
  // on a scalar-declared key, and the cloud API's per-key schema
  // (`apps/api/lib/desktop-analytics-schema.ts`) `z.NEVER`s the WHOLE event on
  // a shape mismatch in either direction. So this line has to land and DEPLOY
  // before any producer exists, not alongside the first one; the emitter
  // follows separately (tamsinb on #7793).
  [OnboardingAnalyticsProperty.AccountMode]: true,
  [OnboardingAnalyticsProperty.FailureReason]: false,
  [OnboardingAnalyticsProperty.OrgMembership]: false,
  [OnboardingAnalyticsProperty.SyncPolicyChoice]: false,
  [OnboardingAnalyticsProperty.InvitesSentCount]: false,
  [OnboardingAnalyticsProperty.DownloadClicked]: false,
  [OnboardingAnalyticsProperty.GitHubConnected]: false,
  [OnboardingAnalyticsProperty.TourSource]: false,
  [OnboardingAnalyticsProperty.TourStepId]: false,
  [OnboardingAnalyticsProperty.TourStepIndex]: false,
  [OnboardingAnalyticsProperty.TourStepsViewedCount]: false,
  [OnboardingAnalyticsProperty.AtTourStepIndex]: false,
  [OnboardingAnalyticsProperty.AtTourStepId]: false,
  [OnboardingAnalyticsProperty.ItemId]: false,
  [OnboardingAnalyticsProperty.ItemsCompletedCount]: false,
  [OnboardingAnalyticsProperty.PageName]: false,
  [OnboardingAnalyticsProperty.ButtonName]: false,
  [OnboardingAnalyticsProperty.SyncChoiceSelected]: false,
  [OnboardingAnalyticsProperty.OwnAnalyzedSessionsVolume]: false,
  [OnboardingAnalyticsProperty.OrgAnalyzedSessionsVolume]: false,
};

/**
 * The ONLY property keys whose wire value is a string ARRAY — DERIVED from the
 * exhaustive record above, never hand-listed. The relay schema, the renderer
 * IPC guard, and the desktop sanitizer all read this set so the three
 * boundaries cannot drift on which keys carry arrays. Elements are validated
 * as bounded strings, not enum members, on purpose: the vocabularies are
 * closed at the EMITTERS, and a server-side membership check would reject the
 * whole event from a newer desktop that knows a value this API predates
 * (cross-repo version skew, whole-payload `z.NEVER`).
 */
export const DESKTOP_ANALYTICS_ARRAY_PROPERTY_KEYS: ReadonlySet<string> =
  new Set(
    Object.entries(ONBOARDING_PROPERTY_CARRIES_ARRAY)
      .filter(([, carriesArray]) => carriesArray)
      .map(([key]) => key)
  );

/** Max elements the wire accepts in an array-valued property. */
export const DESKTOP_ANALYTICS_ARRAY_MAX_ITEMS = 24;

/**
 * Max length of ONE array element — deliberately far below
 * {@link DESKTOP_ANALYTICS_STRING_MAX_LENGTH}, so the two caps COMPOSE with
 * the relay's whole-payload byte ceiling (marisolashgrove on #7748): at the
 * scalar cap, the THREE fully-clamped 24-element arrays alone (~36 KiB) would
 * blow the 8 KiB `properties_too_large` gate and cost the entire event. At 64,
 * all three together stay ~4.8 KiB — still under the gate, which is the check
 * that has to be re-done every time a key joins the set (tamsinb on #7815). The values are closed-vocabulary slugs
 * (phase names, harness ids), for which 64 is already generous.
 */
export const DESKTOP_ANALYTICS_ARRAY_ELEMENT_MAX_LENGTH = 64;

/** Property names admitted by the Desktop product-analytics wire contract. */
export const DesktopAnalyticsPropertyKey = {
  CheckId: "check_id",
  CommandId: "command_id",
  Component: "component",
  DesktopClientVersion: "desktop_client_version",
  DurationMs: "duration_ms",
  Environment: "environment",
  Error: "error",
  ErrorClass: "error_class",
  ErrorCode: "error_code",
  FoundElsewhere: "found_elsewhere",
  LatencyMs: "latency_ms",
  OperationClass: "operation_class",
  OperationType: "operation_type",
  Outcome: "outcome",
  PayloadBytes: "payload_bytes",
  Platform: "platform",
  PluginCount: "plugin_count",
  PeakRequestConcurrency: "peak_request_concurrency",
  Reason: "reason",
  RequestCount: "request_count",
  RowCount: "row_count",
  HydratedRowCount: "hydrated_row_count",
  ReplayCommandCount: "replay_command_count",
  SessionCount: "session_count",
  Shell: "shell",
  SyncMode: "sync_mode",
  TimeToResolveMs: "time_to_resolve_ms",
  Version: "version",
  // ISS-10502 (PRD-736 D1): the FTUE onboarding property keys, admitted
  // through the keys-covered guard above. `Surface` — previously declared here
  // as a literal — now arrives solely through this spread, same value.
  ...ONBOARDING_WIRE_PROPERTY_KEYS,
} as const;
export type DesktopAnalyticsPropertyKey =
  (typeof DesktopAnalyticsPropertyKey)[keyof typeof DesktopAnalyticsPropertyKey];
