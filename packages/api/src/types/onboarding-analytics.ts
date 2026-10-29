/**
 * @file onboarding-analytics.ts
 * @description Canonical FTUE product-analytics taxonomy (PRD-736, ISS-10499).
 * The single source of truth for onboarding event names, property keys, and
 * closed value enums, imported by web, the desktop renderer/main, and the API
 * schema. Values only — no Zod, no React, no PostHog — so bundle-sensitive
 * `"use client"` consumers and the desktop renderer can import constants
 * without pulling in a parser.
 *
 * Identity invariants (PRD-736 §Identity, decisions #10–#13):
 * - The onboarding distinct id (= `flow_id`) is ALIAS-ONLY: it is aliased to
 *   the authenticated user at account establishment and is never `identify`-ed
 *   as its own person.
 * - `node_uuid` (the per-install id, = `device_id`) is never aliased and never
 *   `identify`-ed to a user.
 * - Neither id may appear in logs. Relay/handler `log.*` calls must not
 *   include them.
 */

import { DataSyncLevel } from "./data-sync-level.ts";

/**
 * ISS-10503 (PRD-736 D5, decision #12): the load-bearing injection control for
 * the pre-auth relay mode. Both client-supplied distinct ids — the onboarding
 * id and `node_uuid` — must be well-formed v4 UUIDs; the API schema rejects
 * anything else, so no client can inject an arbitrary distinct id into
 * PostHog. Canonical here so the desktop store, the lane router, and the API
 * schema validate with one pattern.
 */
export const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidV4(value: unknown): value is string {
  return typeof value === "string" && UUID_V4_PATTERN.test(value);
}

/** Event names. Generic events + a discriminating property, never per-instance names. */
export const OnboardingAnalyticsEvent = {
  FlowStarted: "onboarding_flow_started",
  StepViewed: "onboarding_step_viewed",
  StepCompleted: "onboarding_step_completed",
  StepFailed: "onboarding_step_failed",
  StepSkipped: "onboarding_step_skipped",
  StepBack: "onboarding_step_back",
  CtaClicked: "onboarding_cta_clicked",
  FlowCompleted: "onboarding_flow_completed",
  TourStarted: "onboarding_tour_started",
  TourStepViewed: "onboarding_tour_step_viewed",
  TourCompleted: "onboarding_tour_completed",
  TourSkipped: "onboarding_tour_skipped",
  ChecklistItemCompleted: "onboarding_checklist_item_completed",
  ChecklistCompleted: "onboarding_checklist_completed",
  PageViewed: "page_viewed",
  ButtonClicked: "button_clicked",
} as const;
export type OnboardingAnalyticsEvent =
  (typeof OnboardingAnalyticsEvent)[keyof typeof OnboardingAnalyticsEvent];

/** Property keys stamped on onboarding events (PRD-736 §Event catalog). */
export const OnboardingAnalyticsProperty = {
  Surface: "surface",
  FlowId: "flow_id",
  FirstOrgUser: "first_org_user",
  StepIndex: "step_index",
  Step: "step",
  FromStep: "from_step",
  EntryPoint: "entry_point",
  SkipAvailable: "skip_available",
  /** Reserved for the desktop emitters (ISS-10502): the install's node_uuid join key. */
  DeviceId: "device_id",
  DurationSeconds: "duration_seconds",
  StepsSkipped: "steps_skipped",
  CtaId: "cta_id",
  /** Reserved for the desktop main-process emitters (ISS-10502): session_discovery outcome. */
  SessionsFoundCount: "sessions_found_count",
  /** Reserved for the desktop main-process emitters (ISS-10502): session_discovery outcome. */
  HarnessesDetectedCount: "harnesses_detected_count",
  /** Reserved for the desktop main-process emitters (ISS-10502): session_discovery outcome. */
  HarnessesDetected: "harnesses_detected",
  AccountProvider: "account_provider",
  /** Desktop only (ISS-10913): web observes no external auth return to report. */
  AccountMode: "account_mode",
  FailureReason: "failure_reason",
  OrgMembership: "org_membership",
  /** Reserved for the desktop main-process emitters (ISS-10502): sync_policy outcome. */
  SyncPolicyChoice: "sync_policy_choice",
  InvitesSentCount: "invites_sent_count",
  DownloadClicked: "download_clicked",
  GitHubConnected: "github_connected",
  TourSource: "tour_source",
  TourStepId: "tour_step_id",
  TourStepIndex: "tour_step_index",
  TourStepsViewedCount: "tour_steps_viewed_count",
  AtTourStepIndex: "at_tour_step_index",
  AtTourStepId: "at_tour_step_id",
  ItemId: "item_id",
  ItemsCompletedCount: "items_completed_count",
  PageName: "page_name",
  ButtonName: "button_name",
  SyncChoiceSelected: "sync_choice_selected",
  OwnAnalyzedSessionsVolume: "own_analyzed_sessions_volume",
  OrgAnalyzedSessionsVolume: "org_analyzed_sessions_volume",
} as const;
export type OnboardingAnalyticsProperty =
  (typeof OnboardingAnalyticsProperty)[keyof typeof OnboardingAnalyticsProperty];

/**
 * Closed `page_name` vocabulary. Values mirror existing code identifiers for
 * the same surfaces (`session_detail` ↔ `agent_session_detail_view`), never
 * URLs. Instrumenting a new page is one enum line here (plus the desktop relay
 * property-value allowlist), never a new event name.
 */
export const OnboardingAnalyticsPageName = {
  Dashboard: "dashboard",
  Sessions: "sessions",
  Branches: "branches",
  SessionDetail: "session_detail",
  Settings: "settings",
  BranchDetail: "branch_detail",
  Agents: "agents",
  AgentDetail: "agent_detail",
  Packs: "packs",
  PackDetail: "pack_detail",
  Insights: "insights",
  Plans: "plans",
  Approvals: "approvals",
  Requests: "requests",
  Diagnostics: "diagnostics",
  Help: "help",
  Inbox: "inbox",
  Issues: "issues",
  IssueDetail: "issue_detail",
  Documents: "documents",
  DocumentDetail: "document_detail",
  PrdDetail: "prd_detail",
  ImplementationPlanDetail: "implementation_plan_detail",
  MyTasks: "my_tasks",
  Search: "search",
  Projects: "projects",
  ProjectDetail: "project_detail",
  ArchivedProjects: "archived_projects",
  UserDetail: "user_detail",
  Build: "build",
  JudgesAnalytics: "judges_analytics",
  JudgeMetric: "judge_metric",
  LostWork: "lost_work",
  TokenOpsWaste: "token_ops_waste",
  Catalog: "catalog",
  Onboarding: "onboarding",
  SignIn: "sign_in",
  SignUp: "sign_up",
  SsoCallback: "sso_callback",
  GitHubConnect: "github_connect",
  DesktopConnect: "desktop_connect",
  DesktopAuthorize: "desktop_authorize",
  Landing: "landing",
  Pricing: "pricing",
  Blog: "blog",
  BlogPost: "blog_post",
  Community: "community",
  Resources: "resources",
  PrivacyPolicy: "privacy_policy",
  Terms: "terms",
  Docs: "docs",
  NotFound: "not_found",
} as const;
export type OnboardingAnalyticsPageName =
  (typeof OnboardingAnalyticsPageName)[keyof typeof OnboardingAnalyticsPageName];

/**
 * Closed `cta_id` vocabulary for `onboarding_cta_clicked` — the funnel controls
 * the FSM has no transition for (PRD-736 decision #14). Adding a control is one
 * enum line, never a new event.
 */
export const OnboardingCtaId = {
  AuthGitHub: "auth_github",
  AuthGoogle: "auth_google",
  AuthEmail: "auth_email",
  SignIn: "sign_in",
  SignOut: "sign_out",
  PrivacyPolicy: "privacy_policy",
  Terms: "terms",
  TourBack: "tour_back",
  GettingStartedInvite: "getting_started_invite",
} as const;
export type OnboardingCtaId =
  (typeof OnboardingCtaId)[keyof typeof OnboardingCtaId];

/** How the flow was entered, on `onboarding_flow_started`. */
export const OnboardingEntryPoint = {
  FreshInstall: "fresh_install",
  WebSignup: "web_signup",
  InviteLink: "invite_link",
} as const;
export type OnboardingEntryPoint =
  (typeof OnboardingEntryPoint)[keyof typeof OnboardingEntryPoint];

/**
 * Tri-state `first_org_user` context value. A string enum, not a boolean,
 * because `unknown` must stay representable: it is the value until the org
 * step resolves, and for the whole life of a single-player install.
 */
export const FirstOrgUserValue = {
  True: "true",
  False: "false",
  Unknown: "unknown",
} as const;
export type FirstOrgUserValue =
  (typeof FirstOrgUserValue)[keyof typeof FirstOrgUserValue];

/**
 * `account_mode` on desktop account completion and pre-auth failure events
 * is a NON-EMPTY set of observed auth facts. `created` describes what this
 * attempt did; `signed_in`/`logged_out` describe the resulting session state.
 * On `onboarding_step_failed[account]`, `creation_unconfirmed` (browser opened)
 * and `creation_unattempted` (browser never opened) stand alone, without a
 * session-state member. `unknown` is the fallback when no reliable outcome
 * can be determined and is never combined with a known value.
 *
 * The live emitter is the DESKTOP funnel (ISS-10913):
 * `DesktopGuidedOnboardingDialogHost` folds the main process's
 * {@link OnboardingAccountOutcome} — carried additively on the loopback auth
 * callback and mirrored onto the renderer auth state — through
 * {@link onboardingAccountModesForOutcome}, and the funnel stamps the result
 * beside `account_provider`. Never derived from `DesktopAuthFraming`: that is
 * the DOOR the user chose, and an existing account can walk through the
 * sign-up door. The web guided dialog observes no external auth return, so it
 * supplies no outcome and the property stays off web's account completion.
 */
export const OnboardingAccountMode = {
  /** This auth attempt created a new account. */
  Created: "created",
  /** The resulting state has an authenticated session. */
  SignedIn: "signed_in",
  /** The resulting state has no authenticated session. */
  LoggedOut: "logged_out",
  /** Browser opened, but the unauthenticated run observed no creation. ISS-11127. */
  CreationUnconfirmed: "creation_unconfirmed",
  /** The run ended before the browser opened. ISS-11127. */
  CreationUnattempted: "creation_unattempted",
  /** No reliable outcome/state value could be determined. */
  Unknown: "unknown",
} as const;
export type OnboardingAccountMode =
  (typeof OnboardingAccountMode)[keyof typeof OnboardingAccountMode];

/**
 * The `account_mode` VALUE as the wire carries it: a NON-EMPTY set, encoded as
 * a non-empty tuple so the emptiness the property exists to forbid is a
 * typecheck rather than a convention.
 *
 * `readonly OnboardingAccountMode[]` admits `[]`, and the funnel's emit check
 * is `=== undefined` — so an empty array rides straight through and PostHog
 * receives `account_mode: []`, exactly as ambiguous as the absent property the
 * `unknown` member was added to eliminate. No caller can produce one today
 * (they are all fed by {@link ACCOUNT_MODES_BY_OUTCOME}, which has no empty
 * entry), but nothing stopped the next one until this type did
 * (marisolashgrove on #7793).
 */
export type OnboardingAccountModes = readonly [
  OnboardingAccountMode,
  ...OnboardingAccountMode[],
];

/**
 * The evaluated outcome of one desktop auth return, as the desktop main
 * process composes it and the renderer auth state carries it (ISS-10913).
 *
 * One closed string rather than two booleans because it crosses a
 * version-skewed process boundary: an installed gateway that predates this
 * field omits it entirely, and {@link onboardingAccountModesForOutcome} folds
 * that absence to `["unknown"]` rather than guessing from the status a
 * pre-ISS-10913 payload does still carry.
 */
export const OnboardingAccountOutcome = {
  /** The return created a new account and left an authenticated session. */
  CreatedSignedIn: "created_signed_in",
  /** The return created a new account but left no authenticated session. */
  CreatedLoggedOut: "created_logged_out",
  /** The evaluated state has an authenticated session; no creation observed. */
  SignedIn: "signed_in",
  /** The evaluated state explicitly has no authenticated account. */
  LoggedOut: "logged_out",
  /** No auth return has been evaluated, or it carried no usable evidence. */
  Unknown: "unknown",
} as const;
export type OnboardingAccountOutcome =
  (typeof OnboardingAccountOutcome)[keyof typeof OnboardingAccountOutcome];

/**
 * The one fold from an evaluated outcome to the emitted `account_mode` set.
 * Exhaustive by construction, so a new outcome fails typecheck here until it
 * declares its values; every entry is non-empty, unique, and ordered `created`
 * before the session fact, which is the wire contract.
 */
const ACCOUNT_MODES_BY_OUTCOME: Record<
  OnboardingAccountOutcome,
  OnboardingAccountModes
> = {
  [OnboardingAccountOutcome.CreatedSignedIn]: [
    OnboardingAccountMode.Created,
    OnboardingAccountMode.SignedIn,
  ],
  [OnboardingAccountOutcome.CreatedLoggedOut]: [
    OnboardingAccountMode.Created,
    OnboardingAccountMode.LoggedOut,
  ],
  [OnboardingAccountOutcome.SignedIn]: [OnboardingAccountMode.SignedIn],
  [OnboardingAccountOutcome.LoggedOut]: [OnboardingAccountMode.LoggedOut],
  [OnboardingAccountOutcome.Unknown]: [OnboardingAccountMode.Unknown],
};

/**
 * Fold an evaluated auth outcome into the `account_mode` set. An ABSENT
 * outcome — the additive field a version-skewed desktop gateway never sends —
 * folds to `["unknown"]`, which is the whole reason the property is a set with
 * an explicit unknown rather than a value that can go missing.
 *
 * The LOOKUP RESULT is defaulted too, not just the argument. The value crosses
 * the desktop gateway→renderer boundary with no runtime parse, so the type does
 * not constrain it there: a NEWER or malformed producer can hand this an
 * outcome string this build has never heard of. `?? Unknown` alone does not
 * catch that — the string is neither null nor undefined, so it indexes the
 * record to `undefined`, and the emitter then OMITS `account_mode` entirely,
 * which is exactly the ambiguity this property exists to remove (whitlockk on
 * #7793). An unrecognized outcome is an unknown one; it reports as such.
 */
export function onboardingAccountModesForOutcome(
  outcome: OnboardingAccountOutcome | null | undefined
): OnboardingAccountModes {
  return (
    ACCOUNT_MODES_BY_OUTCOME[outcome ?? OnboardingAccountOutcome.Unknown] ??
    ACCOUNT_MODES_BY_OUTCOME[OnboardingAccountOutcome.Unknown]
  );
}

/**
 * `sync_policy_choice` outcome on `onboarding_step_completed[sync_policy]`
 * (desktop only; ISS-10502 D4). PRD-736's event catalog names three values
 * (`full_transcripts` | `metadata_only` | `off`); the shipped sync consent has
 * a FOURTH level, `redacted` ({@link DataSyncLevel}), added after the catalog
 * was written. It maps 1:1 as `redacted_transcripts` rather than folding into
 * a neighbour — folding would report a choice the user did not make.
 */
export const OnboardingSyncPolicyChoice = {
  FullTranscripts: "full_transcripts",
  RedactedTranscripts: "redacted_transcripts",
  MetadataOnly: "metadata_only",
  Off: "off",
} as const;
export type OnboardingSyncPolicyChoice =
  (typeof OnboardingSyncPolicyChoice)[keyof typeof OnboardingSyncPolicyChoice];

/**
 * The one mapping from the consent store's {@link DataSyncLevel} to the wire
 * `sync_policy_choice`. Exhaustive by construction: a new sync level fails
 * typecheck here until it is given a wire value.
 */
const SYNC_POLICY_CHOICE_BY_LEVEL: Record<
  DataSyncLevel,
  OnboardingSyncPolicyChoice
> = {
  [DataSyncLevel.Full]: OnboardingSyncPolicyChoice.FullTranscripts,
  [DataSyncLevel.Redacted]: OnboardingSyncPolicyChoice.RedactedTranscripts,
  [DataSyncLevel.Metadata]: OnboardingSyncPolicyChoice.MetadataOnly,
  [DataSyncLevel.Off]: OnboardingSyncPolicyChoice.Off,
};

export function syncPolicyChoiceForDataSyncLevel(
  level: DataSyncLevel
): OnboardingSyncPolicyChoice {
  return SYNC_POLICY_CHOICE_BY_LEVEL[level];
}

/**
 * `org_membership` outcome on the org steps. Resolves `first_org_user` for all
 * subsequent events: `created` → `"true"`, `joined` → `"false"`.
 */
export const OrgMembershipOutcome = {
  Created: "created",
  Joined: "joined",
} as const;
export type OrgMembershipOutcome =
  (typeof OrgMembershipOutcome)[keyof typeof OrgMembershipOutcome];

/** `tour_source` on the dashboard-tour events. */
export const OnboardingTourSource = {
  Onboarding: "onboarding",
  WebTeammateData: "web_teammate_data",
} as const;
export type OnboardingTourSource =
  (typeof OnboardingTourSource)[keyof typeof OnboardingTourSource];

/**
 * Session-volume buckets — a FROZEN contract (PRD-736 decision #2). These edges
 * are never re-edged: changing them fragments every historical breakdown (a
 * `1-49` era and a `1-9` era cannot be charted together), and the `0` bucket
 * standing alone is the activation boundary. New thresholds get a new
 * property, never new edges here.
 */
export const SessionVolumeBucket = {
  Zero: "0",
  OneToNine: "1-9",
  TenToNinetyNine: "10-99",
  HundredPlus: "100+",
} as const;
export type SessionVolumeBucket =
  (typeof SessionVolumeBucket)[keyof typeof SessionVolumeBucket];

export const UnknownSessionVolume = "unknown" as const;

/**
 * Fold a session count into the frozen buckets, or `null` for a count that
 * cannot be a measured session count (negative, non-finite, fractional). A
 * `null` means "unknown" — callers omit the property rather than emitting a
 * fabricated `"0"`, because `"0"` is the activation boundary and must only
 * ever mean a measured zero.
 */
export function bucketSessionVolume(count: number): SessionVolumeBucket | null {
  if (!Number.isInteger(count) || count < 0) {
    return null;
  }
  if (count === 0) {
    return SessionVolumeBucket.Zero;
  }
  if (count <= 9) {
    return SessionVolumeBucket.OneToNine;
  }
  if (count <= 99) {
    return SessionVolumeBucket.TenToNinetyNine;
  }
  return SessionVolumeBucket.HundredPlus;
}

/** Closed analytics vocabulary; internal failures are mapped by desktop (ISS-11127). */
export const OnboardingFailureReason = {
  Unavailable: "unavailable",
  AlreadyInProgress: "already_in_progress",
  StartFailed: "start_failed",
  OpenFailed: "open_failed",
  RedirectTimeout: "redirect_timeout",
  StateMismatch: "state_mismatch",
  Expired: "expired",
  Cancelled: "cancelled",
  ExchangeFailed: "exchange_failed",
} as const;
export type OnboardingFailureReason =
  (typeof OnboardingFailureReason)[keyof typeof OnboardingFailureReason];

const FAILED_ACCOUNT_MODES_BY_OUTCOME: Record<
  OnboardingAccountOutcome,
  (browserOpened: boolean) => OnboardingAccountModes | null
> = {
  [OnboardingAccountOutcome.CreatedSignedIn]: () => null,
  [OnboardingAccountOutcome.SignedIn]: () => null,
  [OnboardingAccountOutcome.CreatedLoggedOut]: () =>
    onboardingAccountModesForOutcome(OnboardingAccountOutcome.CreatedLoggedOut),
  [OnboardingAccountOutcome.LoggedOut]: (browserOpened) =>
    browserOpened
      ? [OnboardingAccountMode.CreationUnconfirmed]
      : [OnboardingAccountMode.CreationUnattempted],
  [OnboardingAccountOutcome.Unknown]: () => [OnboardingAccountMode.Unknown],
};

/**
 * Fold an auth outcome into modes for a pre-auth sign-in failure (ISS-11127).
 * Returns null for authenticated outcomes: callers must skip the entire
 * onboarding_step_failed event, not emit it with account_mode omitted.
 * Failures downstream of successful authentication are outside this event's
 * scope. Absent or unrecognized outcomes retain the non-empty unknown mode.
 */
export function onboardingFailedAccountModesForOutcome(
  outcome: OnboardingAccountOutcome | null | undefined,
  browserOpened: boolean
): OnboardingAccountModes | null {
  const key = outcome ?? OnboardingAccountOutcome.Unknown;
  if (!Object.hasOwn(FAILED_ACCOUNT_MODES_BY_OUTCOME, key)) {
    return [OnboardingAccountMode.Unknown];
  }
  return FAILED_ACCOUNT_MODES_BY_OUTCOME[key](browserOpened);
}

/** ISS-12228: a sync selection was present but could not be recognized. */
export const UnknownSyncChoice = "unknown" as const;
