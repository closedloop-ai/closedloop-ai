/**
 * Surface-attributed analytics contract (FEA-1517, wired by ISS-8752).
 *
 * Shared components (`@repo/app`) render on more than one surface — the web
 * app and the desktop renderer. Feature-usage events carry a `surface`
 * attribute so adoption can be compared per surface. The React port that
 * emitters consume lives in `@repo/app/shared/observability/
 * surface-analytics-context`; this module holds only the wire-level values,
 * because they cross packages: `@repo/app` emits them, `apps/app` forwards
 * them to PostHog, `apps/desktop` relays them over IPC, and `apps/api`'s
 * desktop-analytics schema admits the desktop-relayed subset.
 *
 * Deliberately free of Zod, React, and PostHog imports: `"use client"`
 * emitters and the Vite-based desktop renderer import it, so it must stay a
 * lightweight constants module.
 */
import type { FeatureAssignmentDelivery } from "./feature-assignment-delivery.ts";
import type { OnboardingAnalyticsEvent } from "./onboarding-analytics.ts";

/** The surface a shared component rendered on. */
export const Surface = {
  Web: "web",
  Desktop: "desktop",
  Marketing: "marketing",
} as const;
export type Surface = (typeof Surface)[keyof typeof Surface];

/** Event names emitted by the surface-attributed analytics port. */
export const SurfaceAnalyticsEvent = {
  SharedComponentRendered: "shared_component_rendered",
  GridviewRolloutDecision: "gridview_rollout_decision",
  ProjectArtifactBoardObserved: "project_artifact_board_observed",
  /**
   * ISS-9531: Sessions v2 list success, failure and settle-time measures.
   * Exposure is the existing `shared_component_rendered` emit. Web only for
   * now: the desktop relay stays narrowed (see above).
   */
  SessionsListObserved: "sessions_list_observed",
  /**
   * Reserved (FEA-1517): no producer yet. The web adapter can emit it; the
   * desktop relay stays narrowed to approved surface events until an emission
   * point and desktop allowlist expansion are approved together.
   */
  OperatingModeSwitch: "operating_mode_switch",
  /**
   * Reserved (FEA-1517): no producer yet. The web adapter can emit it; the
   * desktop relay stays narrowed to approved surface events until an emission
   * point and desktop allowlist expansion are approved together.
   */
  DesktopMlpFeatureUsed: "desktop_mlp_feature_used",
} as const;
export type SurfaceAnalyticsEvent =
  (typeof SurfaceAnalyticsEvent)[keyof typeof SurfaceAnalyticsEvent];

/**
 * Values an analytics property may hold (no PII, no nested objects). The one
 * non-primitive is a string array, for the closed-enum list properties PRD-736
 * names (`steps_skipped`, `harnesses_detected`, and `account_mode` since
 * ISS-10913).
 */
export type AnalyticsPropertyValue =
  | string
  | number
  | boolean
  | null
  | readonly string[];

/** Free-form analytics properties an emitter accepts alongside its known fields. */
export type SurfaceAnalyticsProperties = Record<
  string,
  AnalyticsPropertyValue | undefined
>;

/**
 * Every event name the surface-analytics port can carry. The onboarding FTUE
 * catalog (PRD-736) rides the same port rather than a second transport; the
 * desktop renderer adapter still narrows to its own approved subset.
 */
export type SurfaceAnalyticsCaptureEvent =
  | SurfaceAnalyticsEvent
  | OnboardingAnalyticsEvent;

/**
 * The capture sink each shell injects. Matches the shape of the PostHog
 * client's `capture` (event name + properties) so the web adapter can forward
 * straight to `useAnalytics().capture`, while the desktop renderer forwards
 * over IPC to the main process's product-analytics transport.
 */
export type SurfaceAnalyticsCapture = (
  event: SurfaceAnalyticsCaptureEvent,
  properties: SurfaceAnalyticsProperties
) => void;

/**
 * Person-property setter a shell may inject beside `capture` (PRD-736:
 * `first_org_user` is set on the person at org-step resolution, not only
 * stamped on flow events). Optional per shell; the web adapter forwards to
 * PostHog, and a shell that injects none leaves the port a no-op.
 */
export type SurfaceAnalyticsPersonPropertySetter = (
  properties: Readonly<Record<string, string | number | boolean>>
) => void;

/**
 * The MLP-tracked shared components (ISS-8752). Each member is an explicit
 * measurement decision, not blanket instrumentation.
 */
export const SharedAnalyticsComponent = {
  /** Shared Sessions v2 list surface mounted by web and desktop. */
  SessionsListSurfaceV2: "sessions_list_surface_v2",
  /** Shared Branches v2 list surface mounted by web and desktop. */
  BranchesListSurfaceV2: "branches_list_surface_v2",
  AgentSessionDetailView: "agent_session_detail_view",
  BranchDetailPage: "branch_detail_page",
  /** Project-detail Artifact Board mounted on both web and Desktop. */
  ProjectArtifactBoard: "project_artifact_board",
} as const;
export type SharedAnalyticsComponent =
  (typeof SharedAnalyticsComponent)[keyof typeof SharedAnalyticsComponent];

/** Rollout decision states emitted by Grid Table v2 hosts. */
export const GridviewRolloutDecisionOutcome = {
  Enabled: "enabled",
  Disabled: "disabled",
  Unresolved: "unresolved",
} as const;
export type GridviewRolloutDecisionOutcome =
  (typeof GridviewRolloutDecisionOutcome)[keyof typeof GridviewRolloutDecisionOutcome];

/** Compatibility reason strings accepted from early rollout-decision emitters. */
export const GridviewRolloutDecisionReason = {
  FlagEnabled: "flag_enabled",
  FlagDisabled: "flag_disabled",
  AssignmentUnresolved: "assignment_unresolved",
} as const;
export type GridviewRolloutDecisionReason =
  (typeof GridviewRolloutDecisionReason)[keyof typeof GridviewRolloutDecisionReason];

/** Rollout decision reason values accepted by Grid Table v2 hosts. */
export type GridviewRolloutDecisionReasonValue =
  | FeatureAssignmentDelivery
  | GridviewRolloutDecisionReason;

/** Closed, cardinality-safe observations emitted by the Project Artifact Board. */
export const ProjectArtifactBoardAnalyticsSignal = {
  HostParity: "host_parity",
  LoadFailure: "load_failure",
  MoveConflict: "move_conflict",
  Performance: "performance",
  Reach: "reach",
  Rollback: "rollback",
} as const;
export type ProjectArtifactBoardAnalyticsSignal =
  (typeof ProjectArtifactBoardAnalyticsSignal)[keyof typeof ProjectArtifactBoardAnalyticsSignal];

export const ProjectArtifactBoardAnalyticsFailureKind = {
  Contract: "contract",
  Network: "network",
  Server: "server",
  Unknown: "unknown",
} as const;
export type ProjectArtifactBoardAnalyticsFailureKind =
  (typeof ProjectArtifactBoardAnalyticsFailureKind)[keyof typeof ProjectArtifactBoardAnalyticsFailureKind];

export const ProjectArtifactBoardAnalyticsLoadSource = {
  BoardRead: "board_read",
  DestinationRead: "destination_read",
} as const;
export type ProjectArtifactBoardAnalyticsLoadSource =
  (typeof ProjectArtifactBoardAnalyticsLoadSource)[keyof typeof ProjectArtifactBoardAnalyticsLoadSource];

export const ProjectArtifactBoardAnalyticsOutcome = {
  Failed: "failed",
  Succeeded: "succeeded",
} as const;
export type ProjectArtifactBoardAnalyticsOutcome =
  (typeof ProjectArtifactBoardAnalyticsOutcome)[keyof typeof ProjectArtifactBoardAnalyticsOutcome];

export const ProjectArtifactBoardHostAvailability = {
  Paired: "paired",
  WebOnly: "web_only",
} as const;
export type ProjectArtifactBoardHostAvailability =
  (typeof ProjectArtifactBoardHostAvailability)[keyof typeof ProjectArtifactBoardHostAvailability];

/** Closed, cardinality-safe observations emitted by the Sessions v2 list (ISS-9531). */
export const SessionsListAnalyticsSignal = {
  Loaded: "loaded",
  LoadFailure: "load_failure",
} as const;
export type SessionsListAnalyticsSignal =
  (typeof SessionsListAnalyticsSignal)[keyof typeof SessionsListAnalyticsSignal];
