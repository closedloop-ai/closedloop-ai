/**
 * @file onboarding-guided.ts
 * @description The wire contract for the server-owned guided onboarding run
 * (ISS-8375): the snapshot a host reads, and the transition command it posts.
 *
 * A new sibling rather than an addition to `onboarding.ts`, which carries the
 * v1 checklist contract and is imported by bundle-sensitive clients: this
 * module pulls in Zod, and growing `onboarding.ts` would put the parser in
 * their bundle for a contract they never touch.
 */

import { z } from "zod";
import {
  OnboardingEvent,
  type OnboardingEventInput,
} from "./onboarding-events.ts";
import {
  OnboardingRestoreOutcome,
  type PersistedOnboardingState,
  persistedOnboardingStateSchema,
  readableOnboardingStateSchema,
} from "./onboarding-persistence.ts";
import {
  AccountProvider,
  AccountStatus,
  KnownFlag,
  type OnboardingContext,
  OnboardingHost,
  OrganizationMembership,
  PendingOnboardingStep,
} from "./onboarding-phase.ts";

/**
 * The guard inputs the server can honestly measure, which is every member of
 * {@link OnboardingContext} except four.
 *
 * `host` is omitted because the server does not derive it — it is the caller's
 * own surface, echoed back from the request rather than looked up, and a server
 * that guessed would answer for the wrong one on a user who runs both.
 *
 * `analysisStarted` is omitted because the server cannot see it. It is desktop-
 * local analyzer state owned by ISS-8376's IPC contract, and it gates the
 * Session Discovery Continue button. A server-side `false` would be
 * indistinguishable from a measured "analysis has not begun" and would hold the
 * user on a screen over a fact this process never observed; the desktop host
 * merges its own value in.
 *
 * `syncConsentRecorded` is omitted for the same reason: it is desktop-local
 * sync-policy consent, read through the host/preload bridge and scoped to the
 * active desktop org before the client merges it into the completion context.
 *
 * `organizationActive` is the session's own active organization, which every
 * request that reaches the server is already scoped to, so a server field would
 * be `Yes` on every snapshot. The client states it from the session it acts in.
 */
export type ServerOnboardingContext = Omit<
  OnboardingContext,
  "host" | "analysisStarted" | "syncConsentRecorded" | "organizationActive"
>;

/**
 * The endpoint paths for this contract, named here because THREE processes now
 * agree on them: the client that posts, the API route that serves, and the
 * desktop main process, whose non-GET IPC allowlist must name the transition
 * path exactly or the write never reaches the network (ISS-11249).
 */
export const GUIDED_ONBOARDING_SNAPSHOT_PATH = "/onboarding/guided/snapshot";
export const GUIDED_ONBOARDING_TRANSITION_PATH =
  "/onboarding/guided/transition";

/** The full read of a user's guided onboarding run within one organization. */
export type GuidedOnboardingSnapshot = {
  /**
   * `null` before the first accepted transition. A GET never creates the row,
   * so a first-run read is reported as absent rather than materialized.
   */
  attemptId: string | null;
  /** Compare-and-swap token to echo on the next transition. `0` when absent. */
  revision: number;
  /**
   * The variant this run STARTED in, or `null` when no run exists yet. Resume
   * reads it so a mid-flight assignment change cannot swap the tree underneath
   * a user who is halfway through.
   */
  experienceVariant: string | null;
  state: PersistedOnboardingState;
  /** Why {@link state} is what it is — see {@link OnboardingRestoreOutcome}. */
  restoreOutcome: OnboardingRestoreOutcome;
  context: ServerOnboardingContext;
  /**
   * The host the stored run was started on, or omitted when there is no run
   * (or a server that predates this field answered). Additive and optional on
   * the wire: an older client ignores it, and an older server leaves it out.
   * `state` is always resolved against the READING host, so this is the only
   * field that says another shell owns the run.
   */
  startedOnHost?: OnboardingHost;
};

const onboardingHostSchema: z.ZodType<OnboardingHost> = z.enum(
  Object.values(OnboardingHost) as [OnboardingHost, ...OnboardingHost[]]
);

/** Query contract for `GET /onboarding/guided/snapshot`. */
export const guidedOnboardingSnapshotQuerySchema = z
  .object({ host: onboardingHostSchema })
  .strict();

export type GuidedOnboardingSnapshotQuery = z.infer<
  typeof guidedOnboardingSnapshotQuerySchema
>;

/**
 * The events that carry no payload beyond their type — the third arm of
 * {@link OnboardingEventInput}, named here so the parser and the union cannot
 * disagree about which events those are.
 */
type BareOnboardingEvent = Exclude<
  OnboardingEvent,
  | typeof OnboardingEvent.AccountEstablished
  | typeof OnboardingEvent.ResumePendingStep
>;

/**
 * Exhaustive over {@link BareOnboardingEvent}, so a new bare
 * {@link OnboardingEvent} fails `tsc` here. A hand-written list of "the bare
 * ones" would widen to `string`, silently leave the new member out of the
 * parser, and reject a transition the machine can take — with a 400 that reads
 * as a client bug.
 */
const BARE_EVENT_TYPES: Record<BareOnboardingEvent, true> = {
  [OnboardingEvent.Start]: true,
  [OnboardingEvent.ContinueFromDiscovery]: true,
  [OnboardingEvent.SkipAccount]: true,
  [OnboardingEvent.OrganizationReady]: true,
  [OnboardingEvent.ContinueFromSyncPolicy]: true,
  [OnboardingEvent.SendInvitations]: true,
  [OnboardingEvent.SkipInvitations]: true,
  [OnboardingEvent.DownloadDesktopApp]: true,
  [OnboardingEvent.SkipDownload]: true,
  [OnboardingEvent.ConnectGitHub]: true,
  [OnboardingEvent.SkipGitHub]: true,
  [OnboardingEvent.DashboardEntered]: true,
  [OnboardingEvent.FinishTour]: true,
  [OnboardingEvent.DeferTour]: true,
  [OnboardingEvent.Back]: true,
};

const BARE_EVENTS = Object.keys(BARE_EVENT_TYPES) as [
  BareOnboardingEvent,
  ...BareOnboardingEvent[],
];

/**
 * Annotated with the dispatchable union rather than inferred, so a schema that
 * admitted an event shape the machine cannot take would fail `tsc` here instead
 * of persisting a command no host can replay.
 */
const onboardingEventInputSchema: z.ZodType<OnboardingEventInput> = z.union([
  z
    .object({
      type: z.literal(OnboardingEvent.AccountEstablished),
      provider: z.enum(
        Object.values(AccountProvider) as [
          AccountProvider,
          ...AccountProvider[],
        ]
      ),
    })
    .strict(),
  z
    .object({
      type: z.literal(OnboardingEvent.ResumePendingStep),
      step: z.enum(
        Object.values(PendingOnboardingStep) as [
          PendingOnboardingStep,
          ...PendingOnboardingStep[],
        ]
      ),
    })
    .strict(),
  z.object({ type: z.enum(BARE_EVENTS) }).strict(),
]);

/**
 * An experience variant is an assignment key, not free text. Bounded so a
 * client cannot park an unbounded string in a column every snapshot returns.
 */
const EXPERIENCE_VARIANT_MAX_LENGTH = 64;

/** The largest value `onboarding_attempts.revision` can hold (`INTEGER`). */
export const ONBOARDING_REVISION_COLUMN_MAX = 2_147_483_647;

/**
 * The largest revision a command may carry — one BELOW the column's ceiling.
 *
 * Bounded at the TOP as well as the bottom because the value reaches Prisma
 * twice, and the two bounds are not the same number. It goes into the
 * compare-and-swap `where` verbatim, so an unbounded one is rejected for the
 * column type and turns a malformed command into a 500. But the swap also
 * WRITES `revision + 1`, so accepting the column's own maximum overflows on the
 * write instead of the read — a correctly versioned command, 500ing at the very
 * last revision the run could reach. Deriving this from the column maximum
 * keeps the two facts from drifting apart.
 *
 * A run cannot plausibly reach two billion transitions, so exhaustion is
 * answered as the client error it would have to be rather than given a
 * recovery path no reachable run can need.
 */
export const GUIDED_ONBOARDING_MAX_REVISION =
  ONBOARDING_REVISION_COLUMN_MAX - 1;

/**
 * Body contract for `POST /onboarding/guided/transition`.
 *
 * `.strict()` at both levels: an unknown key is a client this build does not
 * understand, and admitting it would persist a half-understood run under a
 * revision the client then treats as accepted.
 */
export const guidedOnboardingTransitionRequestSchema = z
  .object({
    /** Client-minted, stable across retries. Makes a redelivery a no-op. */
    commandId: z.uuid(),
    host: onboardingHostSchema,
    /** Persisted on create only, so resuming cannot switch trees. */
    experienceVariant: z.string().min(1).max(EXPERIENCE_VARIANT_MAX_LENGTH),
    /** The revision this command was composed against. */
    revision: z.int().min(0).max(GUIDED_ONBOARDING_MAX_REVISION),
    event: onboardingEventInputSchema,
    /** The state the client's machine produced. Parsed by the shared schema. */
    state: persistedOnboardingStateSchema,
  })
  .strict();

export type GuidedOnboardingTransitionRequest = z.infer<
  typeof guidedOnboardingTransitionRequestSchema
>;

/**
 * The `error` string on the 409 a stale transition receives. The body's `data`
 * is the current {@link GuidedOnboardingTransitionResponse}, so the client
 * reconciles from the response it already has rather than retrying blind.
 */
export const GUIDED_ONBOARDING_STALE_REVISION_ERROR = "stale_revision";

/**
 * The `error` string on the 400 a transition receives when the state it carries
 * is well-typed but describes a run the machine cannot produce — `Ready` with
 * an empty history, a history that skips an edge, a phase this host never
 * draws. Nothing is persisted, so this response carries no `data`.
 */
export const GUIDED_ONBOARDING_UNREACHABLE_STATE_ERROR = "unreachable_state";

/**
 * The body of a `POST /onboarding/guided/transition` response, on the 200 and
 * inside the 409's `data` alike.
 *
 * `null` means the transition SETTLED — durably, on a 200 — and the server then
 * failed to compose the snapshot that describes the result. It is not a
 * snapshot whose fields are false: it says nothing was measured, so a client
 * that receives one re-reads through `GET /onboarding/guided/snapshot` rather
 * than treating any guard input as answered. Additive: a client written against
 * the non-null shape only has to learn that one value.
 */
export type GuidedOnboardingTransitionResponse =
  GuidedOnboardingSnapshot | null;

const ORGANIZATION_MEMBERSHIP_VALUES = Object.values(
  OrganizationMembership
) as [OrganizationMembership, ...OrganizationMembership[]];
const ACCOUNT_STATUS_VALUES = Object.values(AccountStatus) as [
  AccountStatus,
  ...AccountStatus[],
];
const ACCOUNT_PROVIDER_VALUES = Object.values(AccountProvider) as [
  AccountProvider,
  ...AccountProvider[],
];
const KNOWN_FLAG_VALUES = Object.values(KnownFlag) as [
  KnownFlag,
  ...KnownFlag[],
];
const RESTORE_OUTCOME_VALUES = Object.values(OnboardingRestoreOutcome) as [
  OnboardingRestoreOutcome,
  ...OnboardingRestoreOutcome[],
];

const serverOnboardingContextSchema = z.object({
  membership: z.enum(ORGANIZATION_MEMBERSHIP_VALUES),
  accountStatus: z.enum(ACCOUNT_STATUS_VALUES),
  accountProvider: z.enum(ACCOUNT_PROVIDER_VALUES).nullable(),
  githubConnected: z.boolean(),
  githubDataConnectionStatusMeasured: z.preprocess(
    (value) => (value === true ? true : undefined),
    z.literal(true).optional()
  ),
  desktopAppDownloaded: z.boolean(),
  organizationHasSyncedSessionData: z.enum(KNOWN_FLAG_VALUES),
  teamInvited: z.boolean(),
  tourCompleted: z.boolean(),
});

/**
 * Compile-time proof the context parser covers every guard input the server
 * measures. A field added to {@link ServerOnboardingContext} without teaching
 * this schema fails `tsc` here rather than reaching a client as `undefined`
 * through a parse that quietly dropped it.
 */
const _serverContextKeysCovered: Record<
  keyof ServerOnboardingContext,
  z.ZodTypeAny
> = serverOnboardingContextSchema.shape;

/**
 * Reader-side parser for {@link GuidedOnboardingSnapshot}, for a client that
 * must not treat an unread body as an answered guard input.
 *
 * NOT `.strict()`, unlike the request schemas above, and the direction is why.
 * Those parse a CLIENT this build may not understand, where an unknown key means
 * a half-understood command it must refuse. This parses a SERVER that may
 * already be a deploy ahead, where an unknown key is a field this build simply
 * does not read yet — rejecting the whole snapshot over it would take the
 * surface dark on an ordinary rolling deploy.
 *
 * `state` takes that same direction through {@link readableOnboardingStateSchema}
 * rather than the strict schema the transition endpoint and the storage restore
 * parse with. A nested `.strict()` is enforced whatever the leniency above it,
 * so reusing the strict one here would have put the refusal one level down and
 * left the paragraph above describing a guarantee this reader did not give: the
 * first additive field on `PersistedOnboardingState` would fail the WHOLE
 * snapshot for every browser still on the previous bundle. Both are built from
 * one shape, so the three boundaries still agree on which KEYS exist — they
 * differ only in what an unknown one means.
 */
export const guidedOnboardingSnapshotSchema = z.object({
  attemptId: z.string().nullable(),
  revision: z.int().min(0).max(ONBOARDING_REVISION_COLUMN_MAX),
  experienceVariant: z.string().nullable(),
  state: readableOnboardingStateSchema,
  restoreOutcome: z.enum(RESTORE_OUTCOME_VALUES),
  context: serverOnboardingContextSchema,
  // A host value this build does not know reads as "not stated" rather than
  // failing the whole snapshot, for the deploy-ahead reason above.
  startedOnHost: onboardingHostSchema.optional().catch(undefined),
}) satisfies z.ZodType<GuidedOnboardingSnapshot>;

/** The snapshot half of the same guard {@link _serverContextKeysCovered} gives its context. */
const _snapshotKeysCovered: Record<
  keyof GuidedOnboardingSnapshot,
  z.ZodTypeAny
> = guidedOnboardingSnapshotSchema.shape;
