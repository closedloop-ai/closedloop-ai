import { z } from "zod";
import {
  AppBootFailureKind,
  AppBootFailureOutcome,
} from "./app-boot-failure-kind";
import { AppExceptionOrigin } from "./app-exception-origin";
import { TelemetryAttribute } from "./src/attributes";
import { TelemetryHarnessName } from "./src/resource";
import {
  boundedText,
  TELEMETRY_UUID_PATTERN,
  TelemetryDurationMsMax,
  TelemetryTextMaxLength,
} from "./src/schema-primitives";

/**
 * ISS-5103: closed, low-cardinality set of sqlite import record-group labels for
 * the `import.group_label` attribute. The SSOT for the values (precedent:
 * `SyncReason` in `sync.ts`): the `runGroup` labels the desktop write-core
 * passes at its call sites, plus `unknown` — the version-skew fallback a newer
 * desktop maps an unrecognized label to, so cardinality stays capped when
 * write-core gains a group before this contract learns it. A desktop-side guard
 * test asserts set equality against the write-core call sites, so the two cannot
 * drift silently.
 *
 * ISS-8758 RETIRED three of them — `link_snapshot_before`, `link_snapshot_after`
 * and `sync_watermark` — by folding the link fingerprint into each writing
 * phase's own transaction and the watermark bump into the transaction that
 * commits the change it describes. They stay HERE because an older desktop build
 * still emits them and this closed set is what validates it; the guard test
 * carves them out of its call-site comparison rather than dropping them.
 *
 * It ADDS `pr_link_teardown_watermark`, the one bump that cannot share a
 * transaction with its change because that change committed in an earlier,
 * already-closed group (see the ISS-8758 comment on that call site). Additive, so
 * an older collector maps it to `unknown` rather than rejecting the record.
 */
export const ImportGroupLabel = {
  Events: "events",
  TokenUsage: "token_usage",
  TokenEvents: "token_events",
  ActivitySegments: "activity_segments",
  LinkSnapshotBefore: "link_snapshot_before",
  ArtifactLinks: "artifact_links",
  PullRequests: "pull_requests",
  PrLinkTeardownWatermark: "pr_link_teardown_watermark",
  SegmentWorkItemRefs: "segment_work_item_refs",
  ComponentInvocations: "component_invocations",
  LinkSnapshotAfter: "link_snapshot_after",
  SyncWatermark: "sync_watermark",
  AnalyticsRollup: "analytics_rollup",
  RevisionSeal: "revision_seal",
  Unknown: "unknown",
} as const;

/** Literal union of `import.group_label` values. */
export type ImportGroupLabel =
  (typeof ImportGroupLabel)[keyof typeof ImportGroupLabel];

/**
 * ISS-5103: discriminator values for desktop import-health events.
 *
 * ISS-6116 adds the two backfill-side records, which are HARNESS-scoped where
 * `pass` and `group_failed` are INSTALL-scoped. That is why they are separate
 * records rather than fields on `pass`: folding a per-harness value into a
 * per-install record would either sum the five harnesses away or ship five
 * `pass` records a window, and the one-per-tick reading is what makes an absent
 * `pass` mean "the process stopped reporting".
 *
 * They exist because the install-scoped counters cannot see a wedged backfill:
 * a source whose import never completes writes no session row, so nothing
 * reaches the DATA_REVISION_IMPORT_PENDING sentinel to be counted, and its
 * groups never fail — they are merely slow.
 *
 * - `sources_remaining` — the backfill denominator, every settled window, with
 *   an explicit value including zero, so a flat-lining series is a trend rather
 *   than a threshold guess. Omitted, never zeroed, where no population was
 *   measured.
 * - `harness_not_advancing` — a running pass (not suspended, not settled) that
 *   has completed no source for longer than the collector's own no-progress
 *   window, or a frozen source scan. One window is not an alert — a single
 *   source may still be inside its sanctioned bounded parse/import window — so
 *   the monitor is count-of-breaches shaped across consecutive windows and
 *   distinct installs.
 *
 * ISS-8600 adds three more harness-scoped values, all OCCURRENCES rather than
 * window tallies: they name a moment a harness stopped delivering, and there is
 * no rate to summarize, so deferring them to the next 5-minute tick would blunt
 * the very liveness signal they exist to buy.
 */
export const ImportHealthEvent = {
  GroupFailed: "group_failed",
  Pass: "pass",
  SourcesRemaining: "sources_remaining",
  HarnessNotAdvancing: "harness_not_advancing",
  /** ISS-6336: one collector ingest-failure reason's count for a window. */
  IngestFailed: "ingest_failed",
  /**
   * ISS-8600: this harness's fast re-attach loop gave up, so live delivery is
   * now catch-up-poll only — 30 minutes on Desktop. The retry threshold is a
   * fixed constant, so the record's EXISTENCE is the whole signal and no
   * attempt count rides with it; a constant shipped as an attribute would read
   * as a measurement.
   *
   * Narrower than exhaustion: emitted only for a harness whose live delivery
   * EXISTED and is gone — a root that held a watch and lost it, or an installed
   * root whose watch could not be armed at all. A harness whose roots never
   * existed reports nothing, because every collector is registered and enabled
   * by default, so exhaustion on its own is dominated by the tools the user
   * never installed.
   */
  WatchLost: "watch_lost",
  /**
   * ISS-8600: an OpenCode materialize pass ended without producing fresh
   * projections — the worker exited, errored, threw, or answered
   * unintelligibly.
   */
  MaterializeFailed: "materialize_failed",
  /**
   * ISS-8600: the same, but the worker outran `materializeTimeoutMs`. SPLIT
   * from {@link ImportHealthEvent.MaterializeFailed} rather than folded into
   * it: a pass that is too slow on a large store and a pass that is broken want
   * different responses, and one value covering both cannot tell them apart.
   *
   * There is deliberately NO value for a materialize pass cancelled by a
   * deliberate teardown. `stop()` settles the in-flight pass through the same
   * rejection path a genuine failure takes, so a set that could name a cancel
   * would invite a producer to emit one — and a clean quit with a pass in
   * flight would then raise a failure on every desktop shutdown. A teardown is
   * not a failure and reports nothing at all.
   */
  MaterializeTimedOut: "materialize_timed_out",
} as const;

/** Literal union of `import.event` values. */
export type ImportHealthEvent =
  (typeof ImportHealthEvent)[keyof typeof ImportHealthEvent];

/**
 * ISS-6334: which authentication stage failed, for the desktop auth-failure
 * signal that rides the UNAUTHENTICATED relay pipe (PRD-650 issue 1). This is
 * the discriminator — `auth.reason` narrows within it.
 */
export const AuthOutcome = {
  /** The cloud refused `desktop.hello`; the install can never pair. */
  PairingRejected: "pairing_rejected",
  /** A desktop session refresh failed, so the access token cannot be renewed. */
  TokenRefreshFailed: "token_refresh_failed",
  /** An authenticated write lane got HTTP 401 and dropped its payload. */
  TokenRejected: "token_rejected",
  /**
   * The browser sign-in code-for-token exchange failed; no credential exists.
   * Before ISS-11394, installed builds also emit this for sign-ups; absence
   * of SignUpExchangeFailed does not mean no sign-ups failed.
   */
  SignInExchangeFailed: "sign_in_exchange_failed",
  /** ISS-11394: an exchange failed after the callback reported account creation. */
  SignUpExchangeFailed: "sign_up_exchange_failed",
  /**
   * ISS-11394: the run ended with no usable redirect — it could not start, the
   * browser could not open, no callback came back, or the callback was
   * unusable (`auth.reason` says which); no code exchange was attempted.
   */
  SignInRedirectFailed: "sign_in_redirect_failed",
  /** ISS-11394: a redirect failure on a run started with sign-up framing. */
  SignUpRedirectFailed: "sign_up_redirect_failed",
} as const;

/** Literal union of `auth.outcome` values. */
export type AuthOutcome = (typeof AuthOutcome)[keyof typeof AuthOutcome];

/**
 * ISS-6334: the closed cause set for `auth.reason`.
 *
 * This attribute rides a pipe that accepts input from an UNAUTHENTICATED
 * caller, so the set is deliberately closed and enum-only: no free text, no
 * server-supplied string, no error message, and nothing derived from a
 * credential, a filesystem path, or a user identifier. Producers map an
 * unrecognized or version-skewed input to {@link AuthReason.Unknown} rather
 * than passing it through, which keeps cardinality capped and is also what
 * makes an older desktop safe against a newer cloud's reason vocabulary.
 */
export const AuthReason = {
  // `desktop.hello.nack` reasons (ISS-6126 / `DesktopHelloNackReason`).
  ComputeTargetRegisterFailed: "compute_target_register_failed",
  ComputeTargetUpdateFailed: "compute_target_update_failed",
  OnlineStateUpdateFailed: "online_state_update_failed",
  PendingCommandsLookupFailed: "pending_commands_lookup_failed",
  CloudInternalError: "cloud_internal_error",
  /** The cloud closed the handshake without sending any nack at all. */
  NoRejectionReason: "no_rejection_reason",
  // Relay-level credential outcomes observed before `desktop.hello` is answered.
  /** The relay refused the API key on connect (auth-shaped `connect_error`). */
  RelayRejectedCredential: "relay_rejected_credential",
  /**
   * A stored credential exists but the install cannot read it back — an
   * unavailable keystore, a failed decrypt, or a corrupt/incomplete record.
   * Covers both carriers: the `sk_live_*` API key and the desktop session
   * record. Distinct from having no credential at all, which is the ordinary
   * signed-out state and is never reported.
   */
  CredentialUnreadable: "credential_unreadable",
  // Desktop session endpoint errors (`DesktopSessionRequestError`).
  PopUnavailable: "pop_unavailable",
  PopRejected: "pop_rejected",
  AlreadyUsed: "already_used",
  OrgRequired: "org_required",
  CredentialInvalid: "credential_invalid",
  BadRequest: "bad_request",
  ServerUnavailable: "server_unavailable",
  NetworkUnreachable: "network_unreachable",
  /**
   * ISS-11345: the browser sign-in's redeem succeeded, but the account it
   * belongs to could not be read back (`GET /desktop/identity` failed, or named
   * a different account), so the session was revoked without being adopted.
   */
  IdentityReadFailed: "identity_read_failed",
  // An authenticated write lane's token was rejected with HTTP 401.
  AccessTokenRejected: "access_token_rejected",
  // ISS-11394: why a browser sign-in ended without a usable callback.
  /** Pre-open setup failed (device descriptor, PKCE, or loopback listener). */
  SignInStartFailed: "sign_in_start_failed",
  /** The system browser could not be opened. */
  BrowserOpenFailed: "browser_open_failed",
  /** No loopback callback arrived before the timeout. */
  RedirectTimeout: "redirect_timeout",
  /** A callback arrived with the wrong `state` or no `code`. */
  CallbackInvalid: "callback_invalid",
  /** Absent, malformed, or unrecognized input — the generic fallback. */
  Unknown: "unknown",
} as const;

/** Literal union of `auth.reason` values. */
export type AuthReason = (typeof AuthReason)[keyof typeof AuthReason];

/**
 * ISS-6340: the steps of the desktop onboarding flow, as a closed set.
 *
 * The current desktop build emits only `Setup`, from main, when the onboarding
 * local-state sweep gets a malformed reply; ISS-10855 deleted the renderer lane
 * that emitted the rest. The other values stay because already-installed desktop
 * builds still emit them, and dropping one would fail their records rather than
 * count them.
 */
export const OnboardingStep = {
  Auth: "auth",
  Setup: "setup",
  Done: "done",
} as const;

/** Literal union of `onboarding.step` values. */
export type OnboardingStep =
  (typeof OnboardingStep)[keyof typeof OnboardingStep];

/**
 * ISS-6340: discriminator values for desktop onboarding lifecycle records.
 *
 * `Abandoned` is deliberately the fact of non-completion and nothing more — the
 * step the user stopped on, with no dwell time. A duration precise enough to say
 * how long one person hesitated is a profile of that person, and PRD-650 needs
 * only the rate.
 */
export const OnboardingEvent = {
  StepReached: "step_reached",
  Failed: "failed",
  Abandoned: "abandoned",
  ConsentRecorded: "consent_recorded",
} as const;

/** Literal union of `onboarding.event` values. */
export type OnboardingEvent =
  (typeof OnboardingEvent)[keyof typeof OnboardingEvent];

/**
 * ISS-6340: the data-sync level chosen at the onboarding consent step.
 *
 * Mirrors `DataSyncLevel` (`@repo/api/src/types/data-sync-level`), which this
 * package cannot import, plus `unknown` as the version-skew fallback — the
 * desktop maps an unrecognized level to it rather than letting the `.strict()`
 * parse below reject and silently drop the WHOLE record. `off` IS the decline;
 * there is no separate "declined" event.
 */
export const OnboardingConsentLevel = {
  Off: "off",
  Metadata: "metadata",
  Redacted: "redacted",
  Full: "full",
  Unknown: "unknown",
} as const;

/** Literal union of `onboarding.consent_level` values. */
export type OnboardingConsentLevel =
  (typeof OnboardingConsentLevel)[keyof typeof OnboardingConsentLevel];

/**
 * ISS-12421: discriminator for the onboarding analytics discard diagnostic the
 * desktop's ISS-12420 readiness queue writes when it refuses to deliver a
 * buffered onboarding event.
 */
export const OnboardingAnalyticsAction = {
  EventDropped: "event_dropped",
} as const;

/** Literal union of `onboarding_analytics.action` values. */
export type OnboardingAnalyticsAction =
  (typeof OnboardingAnalyticsAction)[keyof typeof OnboardingAnalyticsAction];

/** ISS-12420: why the readiness queue discarded a buffered onboarding event. */
export const OnboardingAnalyticsDropReason = {
  UserSignedOut: "user_signed_out",
  IdentityChanged: "identity_changed",
  OrganizationMismatch: "organization_mismatch",
  QueueExpired: "queue_expired",
  QueueOverflow: "queue_overflow",
} as const;

/** Literal union of `onboarding_analytics.reason` values. */
export type OnboardingAnalyticsDropReason =
  (typeof OnboardingAnalyticsDropReason)[keyof typeof OnboardingAnalyticsDropReason];

/**
 * ISS-12421: the onboarding analytics event names the readiness queue buffers.
 * Mirrors `OnboardingAnalyticsEvent` (`@repo/api/src/types/onboarding-analytics`),
 * which this package cannot import; the desktop maps it through an exhaustive
 * `Record`, so a new event fails `tsc` there until it is added here.
 */
export const OnboardingAnalyticsOriginalEvent = {
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

/** Literal union of `onboarding_analytics.original_event` values. */
export type OnboardingAnalyticsOriginalEvent =
  (typeof OnboardingAnalyticsOriginalEvent)[keyof typeof OnboardingAnalyticsOriginalEvent];

/**
 * ISS-12421: the onboarding phase a discarded event described. Mirrors
 * `OnboardingPhase` (`@repo/api/src/types/onboarding-phase`) under the same
 * exhaustive-`Record` guard as {@link OnboardingAnalyticsOriginalEvent}.
 */
export const OnboardingAnalyticsStep = {
  Welcome: "welcome",
  SessionDiscovery: "session_discovery",
  Account: "account",
  CreateOrganization: "create_organization",
  ChooseOrganization: "choose_organization",
  SyncPolicy: "sync_policy",
  InviteTeam: "invite_team",
  DownloadDesktop: "download_desktop",
  ConnectGitHub: "connect_github",
  DashboardAvailable: "dashboard_available",
  DashboardTour: "dashboard_tour",
  Ready: "ready",
} as const;

/** Literal union of `onboarding_analytics.step` values. */
export type OnboardingAnalyticsStep =
  (typeof OnboardingAnalyticsStep)[keyof typeof OnboardingAnalyticsStep];

/**
 * ISS-6335: closed set of steady-state import outcomes for `import.outcome`,
 * carried on every `pass` record so a reader can tell the four apart:
 *
 * - `imported` — at least one session import completed in the window. It wins
 *   over the two below: an install that is advancing is advancing, and the
 *   counts on the same record say how much is still outstanding. Read
 *   `import.outcome` together with `import.sessions_pending_revision`, never
 *   alone.
 * - `empty` — no import was offered or completed, and nothing is known to be
 *   stuck at the pending-revision sentinel. A healthy install with no harness
 *   sessions.
 * - `wedged` — work exists and none of it advanced: sessions were offered and
 *   none completed, or rows sat at the sentinel across a full tick. The same
 *   condition ISS-6116 names from the backfill side (`harness_not_advancing`).
 *   A single window is not an alert — one long import can straddle a tick
 *   boundary — so the monitor is consecutive-window shaped.
 * - `error` — the window could not be summarized at all (the sentinel sample or
 *   an emit seam threw). `import.sessions_pending_revision` is OMITTED on these
 *   records rather than reported as zero, because it was never computed.
 *
 * The absence of any record is therefore a statement about the PROCESS, not
 * about the import: a reporting install always ships one per tick.
 */
export const ImportOutcome = {
  Imported: "imported",
  Empty: "empty",
  Wedged: "wedged",
  Error: "error",
} as const;

/** Literal union of `import.outcome` values. */
export type ImportOutcome = (typeof ImportOutcome)[keyof typeof ImportOutcome];

export const ImportIngestFailure = {
  SourceParseThrew: "source_parse_threw",
  SourceParseTimedOut: "source_parse_timed_out",
  SessionParseDegraded: "session_parse_degraded",
  SessionParseUnreadable: "session_parse_unreadable",
  SessionRecordsUnrouted: "session_records_unrouted",
  SessionPayloadClamped: "session_payload_clamped",
} as const;

/** Literal union of `import.ingest_failure` values. */
export type ImportIngestFailure =
  (typeof ImportIngestFailure)[keyof typeof ImportIngestFailure];

/**
 * ISS-12036: WHERE a `session_parse_degraded` / `session_parse_unreadable`
 * session lost its lines.
 *
 * A session's `malformedLines` is the sum of three independent files — its own
 * transcript, each folded child (a Claude subagent sidecar, a Codex
 * `workflow-*.jsonl` journal), and each folded descendant rollout (a Codex
 * fork/resume child merged into its root). The reason counter said a session
 * lost content; nothing said which writer lost it, so ISS-12036 could not tell a
 * corrupting harness from a corrupting fold. The per-site line counts are on
 * `NormalizedParseQuality`; this is the dimension they are reported through.
 *
 * `Multiple` exists because the attribute is ONE value on a record the reason is
 * counted once on. Splitting a two-site session into two records would double
 * the reason's count, which measures SESSIONS that lost content — so a session
 * corrupted in two places says so, and a reader goes to the session's own
 * counts for the split. There is no `unknown` member: a producer that cannot
 * attribute omits the attribute, which is also what a desktop predating this
 * sends.
 */
export const ImportParseDegradedSite = {
  MainTranscript: "main_transcript",
  FoldedChild: "folded_child",
  FoldedDescendant: "folded_descendant",
  Multiple: "multiple",
} as const;

/** Literal union of `import.parse_degraded_site` values. */
export type ImportParseDegradedSite =
  (typeof ImportParseDegradedSite)[keyof typeof ImportParseDegradedSite];

/**
 * ISS-7247: the desktop update lifecycle transitions, ordered along the happy
 * path. Both terminal values are deliberately POST-restart — the process
 * initiating a restart cannot observe whether the new binary came up, so the
 * producer persists the expectation across the boundary and emits one of the two
 * on the far side, exactly once per attempt.
 */
export const UpdateEvent = {
  Check: "check",
  /**
   * NOT folded into `download_failed`, though electron-updater routes both
   * through one `error` channel: an installation that cannot reach the feed is a
   * different fleet problem from one whose download keeps dying.
   */
  CheckFailed: "check_failed",
  Available: "available",
  DownloadStarted: "download_started",
  DownloadSucceeded: "download_succeeded",
  DownloadFailed: "download_failed",
  /**
   * Offered but unstageable on this machine (read-only/translocated mount).
   * Distinct from `download_failed`, which was ATTEMPTED and may be transient:
   * nothing is tried here until a human moves the app.
   */
  InstallBlocked: "install_blocked",
  InstallStarted: "install_started",
  RestartInitiated: "restart_initiated",
  RestartedOnNewVersion: "restarted_on_new_version",
  RestartFailed: "restart_failed",
} as const;

/** Literal union of `update.event` values. */
export type UpdateEvent = (typeof UpdateEvent)[keyof typeof UpdateEvent];

/**
 * ISS-7247: why an update attempt failed, on the FOUR events that carry it —
 * `check_failed`, `download_failed`, `install_blocked`, and `restart_failed`.
 * A failure population built from the download and restart events alone
 * silently drops every unreachable-feed and unstageable-install failure in the
 * fleet.
 *
 * The first four are classified locally from the updater's message on
 * `check_failed` and `download_failed`, so the message — which can carry a path
 * — never reaches this keyless lane; `permission` additionally arrives with no
 * message at all, hardcoded on `install_blocked` (below). The next three are
 * post-restart verdicts only the far-side reconciler can reach, and arrive on
 * `restart_failed`.
 * `unknown` is the fallback, and what a version-skewed reader should map an
 * unrecognized value to.
 *
 * `permission` is the one overloaded arm, and it reaches THREE of those four
 * events, not two. {@link UpdateEvent} is the ONLY discriminator between its two
 * meanings: `install_blocked` hardcodes it for a PERMANENT condition
 * (read-only/translocated mount, nothing retried until a human moves the app),
 * while on BOTH `check_failed` and `download_failed` it is a transient
 * EACCES/EPERM that the one shared classifier read out of the updater's message.
 * A transient-permission population narrowed to `download_failed` alone
 * therefore drops its entire check-path half.
 */
export const UpdateFailureReason = {
  DownloadError: "download_error",
  Signature: "signature",
  Permission: "permission",
  Disk: "disk",
  VersionUnchanged: "version_unchanged",
  CrashOnBoot: "crash_on_boot",
  UnexpectedVersion: "unexpected_version",
  Unknown: "unknown",
} as const;

/** Literal union of `update.failure_reason` values. */
export type UpdateFailureReason =
  (typeof UpdateFailureReason)[keyof typeof UpdateFailureReason];

/**
 * ISS-7249: which user-facing "we could not show you the thing you asked for"
 * treatment rendered, as a closed set naming the surface AND the treatment.
 *
 * The value is a developer-authored identifier for a rendered state, never
 * anything derived from a record: there is no arm here that could carry a
 * session id, a name, a path, or a message.
 */
export const DeadEndTreatment = {
  SessionsListStalled: "sessions_list_stalled",
  SessionsListUnavailable: "sessions_list_unavailable",
  SessionsListEmpty: "sessions_list_empty",
  SessionDetailStalled: "session_detail_stalled",
  SessionDetailNotFound: "session_detail_not_found",
  SessionDetailUnavailable: "session_detail_unavailable",
  BranchesListUnavailable: "branches_list_unavailable",
  BranchesListEmpty: "branches_list_empty",
  Unknown: "unknown",
} as const;

/** Literal union of `dead_end.treatment` values. */
export type DeadEndTreatment =
  (typeof DeadEndTreatment)[keyof typeof DeadEndTreatment];

/**
 * ISS-7249: which record in a dead end's lifecycle this is.
 *
 * `rendered` fires once per render-with-cause, not once per re-render, so the
 * count is of dead ends a user hit rather than of React commits. `retry_settled`
 * carries {@link DeadEndRetryOutcome} and is what makes "does retry actually
 * work" answerable — a `retry_attempted` with no settled sibling is itself the
 * signal that a retry never resolved.
 */
export const DeadEndPhase = {
  Rendered: "rendered",
  RetryAttempted: "retry_attempted",
  RetrySettled: "retry_settled",
} as const;

/** Literal union of `dead_end.phase` values. */
export type DeadEndPhase = (typeof DeadEndPhase)[keyof typeof DeadEndPhase];

/**
 * ISS-7249: the five distinct no-data states, which must stay distinct here
 * exactly as they must in the UI.
 *
 * A session still syncing is not a session that does not exist, and neither is a
 * 500. Collapsing any two of these produces a number nobody can act on — that
 * collapse IS the defect this attribute exists to close, so a single `dead_end`
 * counter would reproduce it in telemetry form.
 *
 * - `loading` — the read is still in flight, past the threshold at which the
 *   surface stops pretending this is normal.
 * - `unavailable` — the read failed or the source is not serving. Never an
 *   all-clear: this state says nothing about whether the thing exists.
 * - `not_applicable` — rows exist, the active scope excludes all of them.
 * - `unknown` — the read settled with no row and no error. We genuinely cannot
 *   say which of the others it is, and saying so is the honest answer.
 * - `true_zero` — established absence. The only one of the five that is not a
 *   failure, and therefore the one a dead-end rate must exclude.
 */
export const DeadEndState = {
  Loading: "loading",
  Unavailable: "unavailable",
  NotApplicable: "not_applicable",
  Unknown: "unknown",
  TrueZero: "true_zero",
} as const;

/** Literal union of `dead_end.state` values. */
export type DeadEndState = (typeof DeadEndState)[keyof typeof DeadEndState];

/**
 * ISS-7249: why the surface reached its state — what the producer actually
 * established, as against what the user sees.
 *
 * `unclassified` is deliberate and is not a bug bucket: a settled read with no
 * row and no error carries no evidence for any of the others, and naming one
 * anyway would be the fabrication the whole ticket is about.
 */
export const DeadEndReason = {
  NotYetSynced: "not_yet_synced",
  Absent: "absent",
  FetchFailed: "fetch_failed",
  PermissionDenied: "permission_denied",
  LoadingThresholdExceeded: "loading_threshold_exceeded",
  FilteredOut: "filtered_out",
  Unclassified: "unclassified",
} as const;

/** Literal union of `dead_end.reason` values. */
export type DeadEndReason = (typeof DeadEndReason)[keyof typeof DeadEndReason];

/**
 * ISS-7249: what the read a retry kicked off actually did.
 *
 * `still_dead_end` rather than `failed`: the retry itself completed, and what it
 * produced was another dead end — whose own state and reason ride the same
 * record, so a retry that turns a stall into a 404 is legible as that.
 */
export const DeadEndRetryOutcome = {
  Recovered: "recovered",
  StillDeadEnd: "still_dead_end",
} as const;

/** Literal union of `dead_end.retry_outcome` values. */
export type DeadEndRetryOutcome =
  (typeof DeadEndRetryOutcome)[keyof typeof DeadEndRetryOutcome];

/**
 * ISS-7249: ceiling on the reported retry count.
 *
 * A user who has pressed Retry more than this many times against one dead end
 * has told us everything the number can tell us, and the tail is a cardinality
 * risk rather than a signal. The producer clamps to it, so the attribute never
 * carries an unbounded value a wedged renderer could grow forever.
 */
export const DEAD_END_RETRY_ATTEMPT_MAX = 32;

/**
 * ISS-6313: which record of one routine execution's lifecycle this is.
 *
 * `Scheduled` and `Started` are separate because a routine that is enqueued and
 * never picked up is a different failure from one that runs and fails, and a
 * terminal-only counter cannot tell them apart. `StepSettled` is per step;
 * `Settled` is the execution's own terminal record.
 */
export const RoutineEvent = {
  Scheduled: "scheduled",
  Started: "started",
  StepSettled: "step_settled",
  Settled: "settled",
} as const;

/** Literal union of `routine.event` values. */
export type RoutineEvent = (typeof RoutineEvent)[keyof typeof RoutineEvent];

/**
 * ISS-6313: what started this execution.
 *
 * `Unknown` is a member rather than an omission so a version-skewed producer
 * whose trigger this contract has not learned yet degrades to a recorded safe
 * default and stays countable, instead of dropping the attribute and silently
 * inflating the buckets that remain.
 */
export const RoutineTrigger = {
  Schedule: "schedule",
  Manual: "manual",
  Webhook: "webhook",
  Api: "api",
  Unknown: "unknown",
} as const;

/** Literal union of `routine.trigger` values. */
export type RoutineTrigger =
  (typeof RoutineTrigger)[keyof typeof RoutineTrigger];

/**
 * ISS-6313: how an execution ended — the lowercase projection of the TERMINAL
 * members of the platform's shipped `RoutineRunStatus`
 * (`@repo/api/src/types/routine`, backed by the Prisma enum and cached on
 * `Routine.lastStatus`), plus `Unknown`.
 *
 * Spelled as literals here for the same reason {@link SyncReason} in `sync.ts`
 * is: this is a leaf package and cannot import `@repo/api`. It is NOT a second
 * vocabulary — `Skipped` and `Timeout` exist because the shipped status set has
 * them, and a telemetry-only synonym for a persisted status is the SSOT drift
 * this repo keeps paying for. The producer owes a drift-guard test holding this
 * set equal to `RoutineRunStatus`'s terminal members, the arrangement
 * `ImportGroupLabel` and `SyncLane` already have.
 *
 * `Pending` and `Running` are deliberately absent: they are non-terminal, and
 * this attribute answers how a run ENDED. A run still in flight has no outcome
 * and omits the attribute rather than reporting a running state as one.
 */
export const RoutineOutcome = {
  Success: "success",
  Failed: "failed",
  Skipped: "skipped",
  Timeout: "timeout",
  Canceled: "canceled",
  Unknown: "unknown",
} as const;

/** Literal union of `routine.outcome` values. */
export type RoutineOutcome =
  (typeof RoutineOutcome)[keyof typeof RoutineOutcome];

/**
 * ISS-6313: why an execution did not succeed, as a closed set.
 *
 * Carries no error text — the raw message stays on the auth-gated diagnostics
 * lane, exactly as {@link UpdateFailureReason} does.
 */
export const RoutineFailureReason = {
  StepError: "step_error",
  PermissionDenied: "permission_denied",
  Timeout: "timeout",
  DependencyUnavailable: "dependency_unavailable",
  CanceledByUser: "canceled_by_user",
  Unknown: "unknown",
} as const;

/** Literal union of `routine.failure_reason` values. */
export type RoutineFailureReason =
  (typeof RoutineFailureReason)[keyof typeof RoutineFailureReason];

/**
 * ISS-6313: ceiling on the reported step position.
 *
 * A routine deeper than this has told us everything the position can tell us,
 * and the tail is a cardinality risk rather than a signal. Producers MUST clamp
 * to this ceiling: the schema does not clamp, it REJECTS, so an over-ceiling
 * value fails validation and drops the whole record.
 */
export const ROUTINE_STEP_INDEX_MAX = 512;

/**
 * ISS-6313: which audit-trail record this is.
 *
 * `ExportFailed` is carried explicitly because an audit trail that silently
 * stops exporting is indistinguishable from one with nothing to export unless
 * the failure has a record of its own.
 */
export const AuditEvent = {
  EntryRecorded: "entry_recorded",
  EntryExported: "entry_exported",
  ExportFailed: "export_failed",
} as const;

/** Literal union of `audit.event` values. */
export type AuditEvent = (typeof AuditEvent)[keyof typeof AuditEvent];

/**
 * ISS-6313: what KIND of actor an audited action came from.
 *
 * The same three tokens the audit ledger persists as `AuditActorType`
 * (`@repo/api/src/types/audit`, written to `audit_entries.actor_type`), plus
 * `Unknown`. `user` is spelled `user` and not `human` on purpose: those values
 * are hashed into the ledger's chain and are add-never-rename, so a telemetry
 * respelling of the same concept would make a record and the entry it describes
 * unjoinable — and two of three members agreeing is exactly what makes a third
 * that does not the dangerous one. Literals rather than an import for the leaf-
 * package reason above; the producer owes the drift-guard test.
 *
 * Deliberately a kind and never an identity — no user id, email, or display
 * name has a home in this group, so the human-in-the-loop ratio is measurable
 * without the keyless lane ever learning who acted.
 */
export const AuditActorKind = {
  User: "user",
  Agent: "agent",
  System: "system",
  Unknown: "unknown",
} as const;

/** Literal union of `audit.actor_kind` values. */
export type AuditActorKind =
  (typeof AuditActorKind)[keyof typeof AuditActorKind];

/**
 * ISS-6313: how a review gate resolved.
 *
 * `AutoApproved` is separate from `Approved` because collapsing them reports an
 * ungoverned auto-approval as human oversight; `Expired` is separate from
 * `Rejected` because nobody decided it.
 *
 * `Unknown` is the version-skew landing spot, for the same reason the other
 * non-discriminator members of this group carry one. `AppTelemetrySchema` is
 * `.strict()`, so a decision this contract has not learned yet does not drop the
 * ATTRIBUTE — it fails the parse and drops the WHOLE audit record, and re-drops
 * it on every retry. A governance record that vanishes is the worst thing this
 * group can do, so a newer producer maps an unrecognized decision here and the
 * record still lands and stays countable. Unlike {@link AuditEvent}, this is not
 * a discriminator: `audit.decision` describes a record, it does not identify
 * which record it is, so a catch-all member costs no legibility.
 */
export const AuditDecision = {
  Approved: "approved",
  Rejected: "rejected",
  AutoApproved: "auto_approved",
  Escalated: "escalated",
  Expired: "expired",
  Unknown: "unknown",
} as const;

/** Literal union of `audit.decision` values. */
export type AuditDecision = (typeof AuditDecision)[keyof typeof AuditDecision];

/**
 * ISS-9082: what the Agent Monitor's local capture runtime says about ITSELF,
 * carried on the lifecycle heartbeat.
 *
 * The set is the desktop's own `AgentMonitorRuntimeStatusKind` (ISS-4714). It is
 * declared here rather than imported because a published contract package cannot
 * depend on `apps/desktop`; the producer's input field is typed with THIS union,
 * so a desktop member this contract has not learned fails `tsc` at the emit site
 * rather than failing `.strict()` in production — which, on this schema, would
 * drop the whole heartbeat and re-drop it every interval.
 *
 * No `unknown` member, unlike {@link AuditDecision}: the producer is the same
 * repo as this file and cannot widen without failing the compile above, so a
 * catch-all would only make a bug spellable.
 */
export const AgentMonitorRuntimeStatusKind = {
  Ready: "ready",
  Starting: "starting",
  Failed: "failed",
} as const;

/** Literal union of `app.agent_monitor.runtime_status` values. */
export type AgentMonitorRuntimeStatusKind =
  (typeof AgentMonitorRuntimeStatusKind)[keyof typeof AgentMonitorRuntimeStatusKind];

/** Strict app attribute schema for fleet identity, lifecycle, and exception metadata. */
export const AppTelemetrySchema = z
  .object({
    [TelemetryAttribute.AppInstallationId]: boundedText(
      TelemetryTextMaxLength.AppInstallationId
    ).optional(),
    [TelemetryAttribute.AppOrganizationId]: boundedText(
      TelemetryTextMaxLength.AppOrganizationId
    ).optional(),
    [TelemetryAttribute.DeploymentEnvironmentName]: boundedText(
      TelemetryTextMaxLength.DeploymentEnvironmentName
    ).optional(),
    [TelemetryAttribute.ExceptionType]: boundedText(
      TelemetryTextMaxLength.ExceptionType
    ).optional(),
    [TelemetryAttribute.ExceptionMessage]: boundedText(
      TelemetryTextMaxLength.ExceptionMessage
    ).optional(),
    [TelemetryAttribute.ExceptionStacktrace]: boundedText(
      TelemetryTextMaxLength.ExceptionStacktrace
    ).optional(),
    [TelemetryAttribute.AppExceptionOrigin]: z
      .enum([
        AppExceptionOrigin.PreInit,
        AppExceptionOrigin.Main,
        AppExceptionOrigin.Renderer,
      ])
      .optional(),
    // ISS-8907. Optional and additive like every group below: an installed
    // desktop that predates it sends no kind, and its ABSENCE is the statement
    // that the producer is older — never `unknown`, which a newer producer
    // reserves for a failure it classified and could not name.
    [TelemetryAttribute.AppBootFailureKind]: z
      .enum(AppBootFailureKind)
      .optional(),
    // ISS-9259. Optional for the same version-skew reason, and the reason is
    // sharper here: an installed build that predates this emits a RECOVERED
    // store-open timeout with no outcome at all, so a consumer that read absence
    // as `failed` would count a healthy install as a dead one — which is the
    // defect this attribute exists to close, reintroduced one layer down.
    [TelemetryAttribute.AppBootFailureOutcome]: z
      .enum(AppBootFailureOutcome)
      .optional(),
    [TelemetryAttribute.AppOperatingMode]: z
      .enum(["single_player", "multiplayer"])
      .optional(),
    [TelemetryAttribute.AppLifecycleEvent]: z
      .enum(["start", "heartbeat", "shutdown"])
      .optional(),
    // ISS-9082: optional and omitted rather than defaulted — an older desktop
    // never sends it, and a build that has one must not be read as "starting".
    [TelemetryAttribute.AppAgentMonitorRuntimeStatus]: z
      .enum(AgentMonitorRuntimeStatusKind)
      .optional(),
    // ISS-11866 (R4): exports the keyless relay transport declined, per cause,
    // and the exports the relay accepted (`sent`), CUMULATIVE since the process
    // started. A later heartbeat therefore still
    // reports drops whose own interval's heartbeat was itself dropped; a value
    // lower than the install's previous one marks a restart. Omitted, never
    // zeroed, by a build with no relay transport and by an older desktop.
    [TelemetryAttribute.AppTelemetryExportDroppedOversizeCount]: z
      .number()
      .int()
      .min(0)
      .optional(),
    [TelemetryAttribute.AppTelemetryExportDroppedNoSessionCount]: z
      .number()
      .int()
      .min(0)
      .optional(),
    [TelemetryAttribute.AppTelemetryExportDroppedRateLimitedCount]: z
      .number()
      .int()
      .min(0)
      .optional(),
    [TelemetryAttribute.AppTelemetryExportDroppedCollectorUnavailableCount]: z
      .number()
      .int()
      .min(0)
      .optional(),
    [TelemetryAttribute.AppTelemetryExportDroppedInvalidCount]: z
      .number()
      .int()
      .min(0)
      .optional(),
    [TelemetryAttribute.AppTelemetryExportSentCount]: z
      .number()
      .int()
      .min(0)
      .optional(),
    // ISS-5103 desktop import-health counters. All optional and additive: an
    // older desktop simply never sends them, and an older collector allowlist
    // shipped alongside this change keeps redaction in sync.
    [TelemetryAttribute.ImportEvent]: z.enum(ImportHealthEvent).optional(),
    // ISS-6335: optional so a version-skewed desktop that predates the outcome
    // still validates — a missing `import.outcome` means "an older producer",
    // not "no outcome".
    [TelemetryAttribute.ImportOutcome]: z.enum(ImportOutcome).optional(),
    [TelemetryAttribute.ImportGroupLabel]: z.enum(ImportGroupLabel).optional(),
    [TelemetryAttribute.ImportGroupFailedCount]: z
      .number()
      .int()
      .min(0)
      .optional(),
    [TelemetryAttribute.ImportSessionsIncomplete]: z
      .number()
      .int()
      .min(0)
      .optional(),
    [TelemetryAttribute.ImportSessionsPendingRevision]: z
      .number()
      .int()
      .min(0)
      .optional(),
    // ISS-6116 harness-scoped backfill health. `harness.name` is the resource
    // schema's existing closed set, reused rather than duplicated so a sixth
    // harness cannot reach one schema and not the other.
    [TelemetryAttribute.HarnessName]: z.enum(TelemetryHarnessName).optional(),
    [TelemetryAttribute.ImportSourcesRemaining]: z
      .number()
      .int()
      .min(0)
      .optional(),
    // ISS-6336 collector ingest-failure counters. Optional for the same
    // version-skew reason as the fields above: a desktop that predates them
    // sends neither, and absence means "an older producer", not "nothing failed".
    [TelemetryAttribute.ImportIngestFailure]: z
      .enum(ImportIngestFailure)
      .optional(),
    [TelemetryAttribute.ImportIngestFailedCount]: z
      .number()
      .int()
      .min(0)
      .optional(),
    // ISS-12036: the fold site a degraded/unreadable session lost its lines at.
    // Optional for the version-skew reason above AND because it is unattributable
    // for a session whose parse-quality carries no per-site counts — omitted
    // rather than shipped as a guess.
    [TelemetryAttribute.ImportParseDegradedSite]: z
      .enum(ImportParseDegradedSite)
      .optional(),
    // GAUGES, not window tallies. Optional for version skew like everything
    // above, but a REPORTING desktop always sends them — including at zero,
    // which is a real reported value and not an omission.
    [TelemetryAttribute.ImportSourcesQuarantinedParse]: z
      .number()
      .int()
      .min(0)
      .optional(),
    [TelemetryAttribute.ImportSourcesQuarantinedImport]: z
      .number()
      .int()
      .min(0)
      .optional(),
    // ISS-6334 desktop auth/pairing failure signal. Optional and additive: an
    // older desktop never sends them. Enum-only by construction — this schema
    // is `.strict()`, so it is also the point that stops a regression from
    // attaching a token, a path, or an identifier to an auth event.
    [TelemetryAttribute.AuthOutcome]: z.enum(AuthOutcome).optional(),
    [TelemetryAttribute.AuthReason]: z.enum(AuthReason).optional(),
    // ISS-6340 desktop onboarding lifecycle. Closed enums only — no identity,
    // no free text, no path can reach the wire through this schema. Optional
    // and additive: an older desktop never sends them, and an older collector
    // allow-list simply strips them server-side (ISS-6974).
    [TelemetryAttribute.OnboardingStep]: z.enum(OnboardingStep).optional(),
    [TelemetryAttribute.OnboardingEvent]: z.enum(OnboardingEvent).optional(),
    [TelemetryAttribute.OnboardingConsentLevel]: z
      .enum(OnboardingConsentLevel)
      .optional(),
    // ISS-12421 onboarding analytics discard diagnostics. Closed enums plus the
    // UUID-shaped attempt id PRD-793 approves for these records; the discarded
    // event's properties, account, node and device ids have no field here.
    [TelemetryAttribute.OnboardingAnalyticsAction]: z
      .enum(OnboardingAnalyticsAction)
      .optional(),
    [TelemetryAttribute.OnboardingAnalyticsReason]: z
      .enum(OnboardingAnalyticsDropReason)
      .optional(),
    [TelemetryAttribute.OnboardingAnalyticsOriginalEvent]: z
      .enum(OnboardingAnalyticsOriginalEvent)
      .optional(),
    [TelemetryAttribute.OnboardingAnalyticsStep]: z
      .enum(OnboardingAnalyticsStep)
      .optional(),
    [TelemetryAttribute.OnboardingAnalyticsFlowId]: z
      .string()
      .regex(TELEMETRY_UUID_PATTERN)
      .optional(),
    // ISS-7247/ISS-7225. Optional and additive like every group above: an older
    // desktop never sends them, and an older collector allow-list strips them
    // server-side rather than rejecting.
    [TelemetryAttribute.UpdateEvent]: z.enum(UpdateEvent).optional(),
    [TelemetryAttribute.UpdateFromVersion]: boundedText(
      TelemetryTextMaxLength.UpdateVersion
    ).optional(),
    [TelemetryAttribute.UpdateToVersion]: boundedText(
      TelemetryTextMaxLength.UpdateVersion
    ).optional(),
    [TelemetryAttribute.UpdateFailureReason]: z
      .enum(UpdateFailureReason)
      .optional(),
    [TelemetryAttribute.UpdateBootAttempts]: z.number().int().min(1).optional(),
    [TelemetryAttribute.UpdateCurrentVersionAgeDays]: z
      .number()
      .int()
      .min(0)
      .optional(),
    // ISS-7249 desktop dead-end treatments. Closed enums and bounded counts
    // only — there is no field here that can carry a session id, a name, a
    // path, or a message, so the payload is a PII boundary by construction
    // rather than by sanitizing. Optional and additive: an older desktop never
    // sends them, and an older collector allow-list strips them server-side.
    [TelemetryAttribute.DeadEndTreatment]: z.enum(DeadEndTreatment).optional(),
    [TelemetryAttribute.DeadEndPhase]: z.enum(DeadEndPhase).optional(),
    [TelemetryAttribute.DeadEndState]: z.enum(DeadEndState).optional(),
    [TelemetryAttribute.DeadEndReason]: z.enum(DeadEndReason).optional(),
    [TelemetryAttribute.DeadEndRetryOffered]: z.boolean().optional(),
    [TelemetryAttribute.DeadEndRetryAttempt]: z
      .number()
      .int()
      .min(0)
      .max(DEAD_END_RETRY_ATTEMPT_MAX)
      .optional(),
    [TelemetryAttribute.DeadEndRetryOutcome]: z
      .enum(DeadEndRetryOutcome)
      .optional(),
    // ISS-7249: the status a failed read came back with, on `fetch_failed` and
    // `permission_denied` records. Omitted — never zero — when no response was
    // ever received, so a client-side deadline is not reported as a server
    // answer. Bounded to real HTTP status codes.
    [TelemetryAttribute.HttpResponseStatusCode]: z
      .number()
      .int()
      .min(100)
      .max(599)
      .optional(),
    // ISS-6313 (PRD-648 D-17) routine execution and audit trail. Closed enums,
    // a bounded position, and a UUID-shaped id only — there is no field here
    // that can carry a routine name, a prompt, a path, or an actor identity, so
    // the group is a privacy boundary by construction rather than by
    // sanitizing. Optional and additive: a producer that predates a member
    // never sends it, and a collector running the previous allow-list strips
    // the whole group server-side rather than rejecting the batch.
    [TelemetryAttribute.RoutineId]: z
      .string()
      .regex(TELEMETRY_UUID_PATTERN)
      .optional(),
    [TelemetryAttribute.RoutineEvent]: z.enum(RoutineEvent).optional(),
    [TelemetryAttribute.RoutineTrigger]: z.enum(RoutineTrigger).optional(),
    [TelemetryAttribute.RoutineOutcome]: z.enum(RoutineOutcome).optional(),
    // Present only on non-success records, so its absence is itself the
    // statement that nothing failed.
    [TelemetryAttribute.RoutineFailureReason]: z
      .enum(RoutineFailureReason)
      .optional(),
    [TelemetryAttribute.RoutineStepIndex]: z
      .number()
      .int()
      .min(0)
      .max(ROUTINE_STEP_INDEX_MAX)
      .optional(),
    // How long the execution or step took. The canonical `duration_ms` rather
    // than a `routine.*` twin of it — a second name for an elapsed millisecond
    // count is the SSOT drift this package keeps paying for.
    [TelemetryAttribute.DurationMs]: z
      .number()
      .int()
      .min(0)
      .max(TelemetryDurationMsMax)
      .optional(),
    [TelemetryAttribute.AuditEvent]: z.enum(AuditEvent).optional(),
    [TelemetryAttribute.AuditActorKind]: z.enum(AuditActorKind).optional(),
    [TelemetryAttribute.AuditDecision]: z.enum(AuditDecision).optional(),
  })
  .strict();

/** Parsed app telemetry attribute shape. */
export type AppTelemetry = z.infer<typeof AppTelemetrySchema>;
