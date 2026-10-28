/**
 * @file snapshot-service.ts
 * @description The server's read of a guided onboarding run (ISS-8375): the
 * persisted machine state plus every guard input the server can honestly
 * measure. An account that has already finished onboarding reports a settled
 * run instead of the machine's first-run default — see
 * {@link settledOnboardingState}.
 *
 * **A snapshot is all-or-nothing.** If a producer fails, this throws and the
 * route returns an error. It must never answer with a field defaulted to
 * `false`, because a `false` here is indistinguishable from a measured negative
 * and each one either grants or denies a gate: a defaulted `githubConnected`
 * re-asks a user to connect an account they already connected, a defaulted
 * `teamInvited` re-asks for invitations already sent.
 *
 * TWO PRODUCERS ARE EXEMPT, for opposite reasons.
 * `organizationHasSyncedSessionData` carries its own {@link KnownFlag.Unknown}
 * all the way to the guard, so an unread answer stays unread rather than
 * becoming a measured negative. The `web-guided-onboarding-required-phases`
 * gate read (ISS-11073) is a ROLLOUT decision rather than a guard input: it is
 * never reported in the context, and a defaulted `false` is exactly the pre-flag
 * behaviour — so failing closed on it is correct where defaulting a guard input
 * would not be. (It is classified a RESTRICTION, because withholding it lets a
 * reader past blocking phases; that classification governs suppression, not this
 * unanswered-read default.)
 */

import type { JsonObject } from "@repo/api/src/types/common";
import type { OnboardingState } from "@repo/api/src/types/onboarding";
import type {
  GuidedOnboardingSnapshot,
  ServerOnboardingContext,
} from "@repo/api/src/types/onboarding-guided";
import {
  OnboardingRestoreOutcome,
  type OnboardingRestoreResult,
  restoreOnboardingState,
  serializeOnboardingState,
} from "@repo/api/src/types/onboarding-persistence";
import {
  AccountProvider,
  AccountStatus,
  isBlockingPhase,
  KnownFlag,
  OnboardingHost,
  type OnboardingMachineState,
  OnboardingPhase,
  OrganizationMembership,
} from "@repo/api/src/types/onboarding-phase";
import { withDb } from "@repo/database";
import { organizationHasSyncedSessionData } from "@/app/agent-sessions/organization-synced-session-data";
import { resolveGitHubDataConnectionStatus } from "@/app/integrations/github/data-connection-status";
import { clerkService } from "@/lib/auth/clerk-service";
import {
  connectedGitHubInstallationWhere,
  getOnboardingState,
  isOnboardingGitHubConnected,
  isOnboardingWizardCompleted,
  isOnboardingWizardRecorded,
  ownDesktopComputeTargetWhere,
} from "../service";
import {
  guidedOnboardingAttemptStore,
  type OnboardingAttemptRecord,
} from "./attempt-store";
import { resolveGuidedRequiredPhases } from "./required-phases-gate";

/** Clerk namespaces an OAuth provider as `oauth_<provider>`. */
const CLERK_OAUTH_PREFIX = "oauth_";

/**
 * When guided onboarding could first record a completion — the
 * `20260902144605_iss8375_onboarding_attempts` migration. An organization
 * created at or after this could have been recorded; see
 * {@link hasFinishedOnboarding}.
 */
const GUIDED_ONBOARDING_SHIPPED_AT = new Date("2026-09-02T14:46:05.000Z");

/**
 * Search rank when a user has linked more than one Clerk OAuth provider.
 *
 * The record is exhaustive over `AccountProvider` so adding a provider must
 * explicitly choose whether Clerk OAuth can infer it. GitHub leads deliberately:
 * it identifies the linked GitHub account for provider-based legacy branches.
 * The modern Web branch separately checks whether an installation or personal
 * registry row makes GitHub data available; provider identity alone cannot
 * answer that question.
 */
const CLERK_OAUTH_ACCOUNT_PROVIDER_RANK: Record<
  AccountProvider,
  number | null
> = {
  [AccountProvider.Email]: null,
  [AccountProvider.GitHub]: 0,
  [AccountProvider.Google]: 1,
};

const CLERK_OAUTH_ACCOUNT_PROVIDER_PRIORITY = Object.values(AccountProvider)
  .map((provider) => ({
    provider,
    rank: CLERK_OAUTH_ACCOUNT_PROVIDER_RANK[provider],
  }))
  .filter(
    (entry): entry is { provider: AccountProvider; rank: number } =>
      entry.rank !== null
  )
  .sort((left, right) => left.rank - right.rank)
  .map(({ provider }) => provider);

export type GuidedSnapshotInput = {
  organizationId: string;
  userId: string;
  clerkUserId: string;
  /** The caller's surface. Echoed, never derived; see `ServerOnboardingContext`. */
  host: OnboardingHost;
};

export const guidedOnboardingSnapshotService = {
  /**
   * Read the caller's run. A GET never writes: with no row this reports
   * `attemptId: null`, `revision: 0` and
   * {@link OnboardingRestoreOutcome.Absent}. The first accepted transition
   * creates the row. `restoreOutcome` describes the STORED payload, so it stays
   * `Absent` for an already-onboarded account even though the reported state is
   * the settled run rather than a fresh one.
   */
  async getSnapshot(
    request: GuidedSnapshotInput
  ): Promise<GuidedOnboardingSnapshot> {
    const { organizationId, userId, clerkUserId, host } = request;

    // A fixed-width fan-out, not one over a variable-length array, so the
    // bounded-fan-out rule does not apply and this must not become one.
    const [
      attempt,
      activeUserCount,
      githubInstallation,
      githubDataConnection,
      desktopComputeTarget,
      syncedSessionData,
      organization,
      clerkProviders,
      teamCount,
      projectCount,
      requiredPhasesEnabled,
    ] = await Promise.all([
      guidedOnboardingAttemptStore.find(organizationId, userId),
      withDb((db) =>
        db.user.count({ where: { organizationId, active: true } })
      ),
      withDb((db) =>
        db.gitHubInstallation.findFirst({
          where: connectedGitHubInstallationWhere(organizationId),
          select: { id: true },
        })
      ),
      withDb((db) =>
        // `hasActiveInstallation: false` SKIPS the resolver's own ACTIVE
        // installation read rather than answering it wrongly. The sibling
        // `githubInstallation` read above is strictly WIDER (it admits
        // SUSPENDED too) and `isOnboardingGitHubConnected` ORs the two, so the
        // App term is already carried; letting the resolver re-run it would put
        // a second installation query in this fan-out on every snapshot, and
        // every transition response composes one.
        resolveGitHubDataConnectionStatus(db, {
          hasActiveInstallation: false,
          organizationId,
          userId,
        })
      ),
      withDb((db) =>
        db.computeTarget.findFirst({
          where: ownDesktopComputeTargetWhere(organizationId, userId),
          select: { id: true },
        })
      ),
      organizationHasSyncedSessionData(organizationId),
      withDb((db) =>
        db.organization.findUnique({
          where: { id: organizationId },
          select: { createdAt: true, settings: true },
        })
      ),
      clerkService.getUserExternalAccountProviders(clerkUserId),
      withDb((db) => db.team.count({ where: { organizationId } })),
      withDb((db) => db.project.count({ where: { organizationId } })),
      resolveGuidedRequiredPhases({ userId, clerkUserId }),
    ]);

    const settings = (organization?.settings as JsonObject) ?? {};
    const restored = restoreOnboardingState(attempt?.state ?? null, host);
    // Only a run that would REOPEN the takeover is folded, and only when it is
    // not mid-resume. Every transition response is composed through here
    // (`composeSnapshot`), so a wider fold silently rewrites live runs: it
    // would close the dialog `ResumePendingStep` just opened and re-offer the
    // same step forever, and it would swallow the `DashboardAvailable` a
    // finished resumed step reports, costing the host the `onDashboardAvailable`
    // handoff the machine still owes.
    const state =
      isBlockingPhase(restored.state.phase) &&
      !restored.state.resuming &&
      hasFinishedOnboarding({
        guidedRunCompleted: attempt?.completedAt != null,
        membership: resolveMembership(activeUserCount),
        organizationCreatedAt: organization?.createdAt ?? null,
        organizationHasSyncedSessionData: syncedSessionData,
        projectCount,
        requiredPhasesEnabled,
        state: getOnboardingState(settings),
        teamCount,
      })
        ? foldForFinishedOrganization(restored, attempt)
        : restored.state;

    const reportedState = requiredPhasesEnabled
      ? foldEstablishedOrganizationStep(state)
      : state;
    const startedOnHost = storedOnboardingHost(attempt);

    return {
      ...(startedOnHost ? { startedOnHost } : {}),
      attemptId: attempt?.id ?? null,
      revision: attempt?.revision ?? 0,
      experienceVariant: attempt?.experienceVariant ?? null,
      state: serializeOnboardingState(reportedState),
      restoreOutcome: restored.outcome,
      context: buildServerContext({
        attempt,
        accountProvider: restored.state.accountProvider,
        activeUserCount,
        // ADDITIVE, and that is the whole of ISS-11246. The step's own control
        // opens a PERSONAL Clerk OAuth link and never the org App install —
        // that stays an admin action reached from Settings
        // (`github-connect-action.ts`) — so an installation-only predicate is a
        // completion test the offered action cannot pass: the deferred-step
        // card offers "Connect GitHub" exactly when there is no installation,
        // the user authorizes, no installation appears, and the card offers it
        // again forever. This is the same additive question the step, Insights
        // and the Sessions strip already ask through
        // `resolveGitHubDataConnectionStatus`, so it removes a second
        // definition rather than inventing one.
        //
        // The installation term is kept beside it because the two queries do
        // not agree on status: `connectedGitHubInstallationWhere` admits
        // SUSPENDED, the data-connection read admits only ACTIVE. Dropping it
        // would NARROW a suspended-installation org from connected to not.
        githubConnected: isOnboardingGitHubConnected({
          githubDataConnected: githubDataConnection.connected,
          hasConnectedInstallation: githubInstallation !== null,
        }),
        desktopComputeTargetExists: desktopComputeTarget !== null,
        syncedSessionData,
        settings,
        clerkProviders,
      }),
    };
  },
};

/**
 * The provider a Clerk external account names, or `null` when it is one this
 * product has no Clerk OAuth vocabulary for. Email is a transition-event value,
 * not a provider inferred from Clerk's OAuth account list.
 */
function toAccountProvider(clerkProvider: string): AccountProvider | null {
  const bare = clerkProvider.startsWith(CLERK_OAUTH_PREFIX)
    ? clerkProvider.slice(CLERK_OAUTH_PREFIX.length)
    : clerkProvider;
  return (
    CLERK_OAUTH_ACCOUNT_PROVIDER_PRIORITY.find(
      (provider) => provider === bare
    ) ?? null
  );
}

/** The highest-priority provider linked to the account, or `null` for none. */
function resolveAccountProvider(
  clerkProviders: readonly string[]
): AccountProvider | null {
  const linked = new Set(
    clerkProviders
      .map(toAccountProvider)
      .filter((provider): provider is AccountProvider => provider !== null)
  );
  return (
    CLERK_OAUTH_ACCOUNT_PROVIDER_PRIORITY.find((provider) =>
      linked.has(provider)
    ) ?? null
  );
}

type ServerContextInputs = {
  attempt: OnboardingAttemptRecord | null;
  accountProvider: AccountProvider | null;
  activeUserCount: number;
  githubConnected: boolean;
  desktopComputeTargetExists: boolean;
  syncedSessionData: KnownFlag;
  settings: JsonObject;
  clerkProviders: readonly string[];
};

function buildServerContext(
  inputs: ServerContextInputs
): ServerOnboardingContext {
  return {
    membership: resolveMembership(inputs.activeUserCount),
    // ISS-11256: an account that exists, never a memory of having deferred one.
    // Every reader of this snapshot authenticated to reach the route — all three
    // `withAnyAuth` arms resolve a stored user and organization — and so did
    // every writer of `accountSkippedAt`, which is why that marker can never
    // mean the account is absent. Deriving `Skipped` from it reported a
    // present-tense absence from a past action, and because the marker is
    // write-once (`markersFor`) the report was permanent: with
    // `isStepOutstanding(CreateAccount)` keyed on `Skipped` and
    // `PENDING_STEP_RANK` ranking it first, Create Account stayed at the top of
    // Desktop's checklist after the reader signed in, and resuming it re-entered
    // `OnboardingPhase.Account` — the same Continue flow, forever.
    //
    // The marker is untouched: still stamped, still guarding its own once-only
    // write. `AccountStatus.Skipped` keeps its producer on the one surface where
    // it is true — the signed-out Desktop guest context that the guest card and
    // the guest run share, which holds no server snapshot.
    accountStatus: AccountStatus.Established,
    accountProvider:
      inputs.accountProvider ?? resolveAccountProvider(inputs.clerkProviders),
    githubConnected: inputs.githubConnected,
    githubDataConnectionStatusMeasured: true,
    // The marker records that this run took the download action; the compute
    // target records that a machine actually registered. Either is proof, and
    // the marker is what keeps the step from re-asking a user whose desktop has
    // not phoned home yet.
    desktopAppDownloaded:
      inputs.attempt?.desktopDownloadedAt != null ||
      inputs.desktopComputeTargetExists,
    organizationHasSyncedSessionData: inputs.syncedSessionData,
    // ISS-11670: THIS reader's own send, never the organization's.
    //
    // It used to be `isTeamInvited(activeUserCount, settings)`, and both of that
    // predicate's arms are org-scoped: `activeUserCount > 1` is the same input
    // `resolveMembership` reads for `ExistingMember`, and the org's
    // `invitesSentAt` is written by `recordInvitesSent(organizationId)` with no
    // user on it. So every member of every multi-person org arrived here already
    // reading `true` — which the invite step rendered as "Your teammates have
    // been invited", hid its composer behind, and `isStepOutstanding` read as
    // grounds to skip the step entirely.
    //
    // The operator ruled on 2026-09-30 that each new user is prompted regardless
    // of what the rest of the org has done, so this reads the per-user marker
    // the invitation send path stamps on `invited > 0`
    // (`organizations/invitations/service.ts`) — a send this server performed,
    // not a transition the client posted. `isTeamInvited` is UNCHANGED and still
    // answers the v1 checklist's org-level row (`onboarding/service.ts`); the
    // two questions were sharing one predicate, and this ruling separates them
    // deliberately rather than by drift.
    //
    // A reader who had already FINISHED onboarding reads `true` here without
    // ever having posted a send, because the column's migration seeded the
    // marker from `completedAt` for every completed run — the operator's second
    // ruling the same day, and the mechanism he named for it. That is a
    // one-time data fact, not a second predicate: nothing below re-derives it,
    // so do not add an `|| hasFinishedOnboarding(...)` arm here. Readers who
    // finished onboarding with NO attempt row at all are outside the backfill's
    // reach; see `foldForFinishedOrganization`.
    teamInvited: inputs.attempt?.invitesSentAt != null,
    tourCompleted: inputs.attempt?.tourCompletedAt != null,
  };
}

/**
 * Whether this reader has finished onboarding (ISS-10339).
 *
 * The teams-and-projects arm of `isOnboardingWizardCompleted` is an inference
 * standing in for a completion marker that could not have been written, and it
 * is admitted only for an organization created before this run could record
 * one. For everything newer the marker is the only evidence accepted, because
 * folding on the inference instead suppressed the dialog permanently for every
 * account that reached a team and a project by any route — which, on desktop,
 * is the ordinary one.
 *
 * WHAT THIS DOES NOT CLAIM. It is not that a post-cutoff organization would
 * have the marker if it were onboarded. The cutoff's job is narrower than "who
 * is onboarded" — it is to keep the pre-wizard population, which genuinely
 * cannot answer either way, out of a first run.
 *
 * ISS-11073 CORRECTED THE POST-CUTOFF ARM. This docstring used to
 * argue that a post-cutoff organization was "structurally unable to carry the
 * marker", so reading it there was harmless. That was false in exactly one
 * direction and it is the direction that shipped: a brand-new organization was
 * sent to the legacy wizard and completed it, `completeWizard` stamped
 * `wizardCompletedAt`, and the marker settles a guided run the reader has not
 * started — invitations and the Desktop download folded away before either was
 * shown.
 *
 * ISS-11072 (#7864) DID NOT CLOSE THIS, and made the read load-bearing rather
 * than merely harmless. `OnboardingGuard` no longer redirects unconditionally:
 * it asks this snapshot first and keeps the legacy redirect unless the run is
 * on a blocking phase. So the marker's effect here is now what decides that
 * redirect — an organization already carrying it folds to `Ready`,
 * `isBlockingPhase` is false, and the guard sends its reader to the legacy
 * wizard. #7864 closed one route by which a new organization ACQUIRES the
 * marker; every organization that already has one still reads it here.
 *
 * Under the `web-guided-onboarding-required-phases` gate the post-cutoff arm
 * therefore reads the GUIDED run's own completion instead — for the readers
 * {@link readsGuidedRunCompletion} admits, which is narrower than "post-cutoff":
 * an organization with measured synced session data has demonstrably been used
 * and keeps the legacy marker. The legacy marker records a different, retired
 * flow; it is evidence of the wrong event, but only where there is no other
 * evidence the organization is already past its first run. With the gate closed
 * the marker is honored exactly as before, so the cohort that already finished
 * the legacy wizard is unaffected until the gate opens for them, and the
 * pre-cutoff inference arm is untouched either way.
 */
function hasFinishedOnboarding(inputs: {
  guidedRunCompleted: boolean;
  membership: OrganizationMembership;
  organizationCreatedAt: Date | null;
  organizationHasSyncedSessionData: KnownFlag;
  projectCount: number;
  requiredPhasesEnabled: boolean;
  state: OnboardingState;
  teamCount: number;
}): boolean {
  // The caller completed this exact run, even if its history belongs to the
  // other host. Never restore that completion as another first-run wizard.
  if (inputs.guidedRunCompleted) {
    return true;
  }
  if (
    inputs.organizationCreatedAt === null ||
    inputs.organizationCreatedAt >= GUIDED_ONBOARDING_SHIPPED_AT
  ) {
    return readsGuidedRunCompletion(inputs)
      ? inputs.guidedRunCompleted
      : isOnboardingWizardRecorded(inputs.state);
  }
  return isOnboardingWizardCompleted({
    projectCount: inputs.projectCount,
    state: inputs.state,
    teamCount: inputs.teamCount,
  });
}

/**
 * The run an account that has already finished onboarding reports: at rest, on
 * a Dashboard it demonstrably reached. Not every such account — a run inside a
 * resumed step is left as it is, for the reason its caller states, and so is a
 * live run; see {@link foldForFinishedOrganization}.
 *
 * Without this, an onboarded account reports whatever the machine's default is,
 * and that default is {@link OnboardingPhase.Welcome} — a BLOCKING phase, since
 * the first accepted transition is what materialises a row and nobody who
 * onboarded before ISS-8375 has one. The guided dialog opens on any blocking
 * phase, so every such account got a full-screen first-run takeover on load, and
 * the deferred-completion card (which renders only at
 * {@link OnboardingPhase.Ready}) got nothing — the exact inversion of the
 * approved ISS-8353 amendment, which routes an authenticated user's outstanding
 * steps to that card and forbids a blocking post-auth takeover (ISS-9916).
 *
 * `history` is load-bearing, not decoration. `isReachableOnboardingState`
 * refuses `Ready` with an empty history, and the client re-parses this state
 * through `restoreOnboardingState`, which would recover such a payload to a
 * fresh `Welcome` and reopen the very dialog this closes.
 */
function settledOnboardingState(
  restored: OnboardingMachineState
): OnboardingMachineState {
  return {
    phase: OnboardingPhase.Ready,
    history: [OnboardingPhase.DashboardAvailable],
    accountProvider: restored.accountProvider,
    resuming: false,
    organizationEstablished: true,
  };
}

/**
 * When the settled fold reached production: the 2026-09-11 production merge
 * (#7047) carrying ISS-9916 (#6949), taken at the next UTC midnight so a row
 * written while that deploy rolled out still counts as before it.
 */
const SETTLED_FOLD_SHIPPED_AT = new Date("2026-09-12T00:00:00.000Z");

/**
 * The run a finished organization's reader is reported at on a blocking phase.
 *
 * {@link settledOnboardingState} stands in for absent evidence: no row, a row
 * this host cannot restore, or a row written before the fold shipped (the
 * takeover ISS-9916 fixed). A later row is a run the reader is advancing, since
 * a finished organization's reader is folded before any row exists, so it is
 * kept (ISS-11036; the attempt-backed live run ISS-10339 deferred). That
 * includes a row this fold used to hide, which resumes at the step its reader
 * never reached.
 *
 * One step still folds, and only as far as the next one, on either host:
 * `CreateOrganization`. The settled fold already skipped it on both, the
 * organization it asks for exists, and a Desktop host cannot complete it. That
 * is the whole of {@link foldEstablishedOrganizationStep}, including its Back
 * branch, so this defers to it rather than restating it — the two reached the
 * same answer for the same reason, and a second copy is a second thing to drift.
 */
function foldForFinishedOrganization(
  restored: OnboardingRestoreResult,
  attempt: OnboardingAttemptRecord | null
): OnboardingMachineState {
  const live =
    restored.outcome === OnboardingRestoreOutcome.Restored &&
    attempt !== null &&
    attempt.createdAt >= SETTLED_FOLD_SHIPPED_AT;
  if (!live) {
    return settledOnboardingState(restored.state);
  }
  return foldEstablishedOrganizationStep(restored.state);
}

/** Which organization branch `activeUserCount` puts this reader on. */
function resolveMembership(activeUserCount: number): OrganizationMembership {
  return activeUserCount > 1
    ? OrganizationMembership.ExistingMember
    : OrganizationMembership.FirstUser;
}

/**
 * Whether the guided run's OWN completion is what settles this reader, rather
 * than the legacy wizard's organization-level marker (ISS-11073).
 *
 * Gated, and bounded to the FIRST USER, because the two markers are not the
 * same KIND of fact. `wizardCompletedAt` is written on the ORGANIZATION, so it
 * settles the run for every member; `attempt.completedAt` is per
 * `(organizationId, userId)`, like every other guided marker. Swapping one for
 * the other across the board would hand a blocking first-run takeover to every
 * teammate of an already-onboarded organization who has no attempt row of their
 * own — the exact ISS-9916 inversion the settled fold exists to prevent, and
 * nothing this ticket asks for. ISS-11073 is about a NEW EMPTY organization, so
 * the swap is scoped to the reader that organization has: its first user.
 *
 * An existing member therefore keeps reading the organization marker in both
 * gate positions, unchanged.
 *
 * MEMBERSHIP ALONE IS NOT THAT SCOPE, and the second condition is why
 * (tamsinb on #7854). `FirstUser` discriminates a teammate from a founder; it
 * does not discriminate a NEW organization from an OLD one, because every solo
 * organization is its own first user for as long as it stays solo. A one-person
 * organization created after the guided cutoff, finished on the legacy wizard
 * weeks ago and productive ever since, carries no attempt row simply because the
 * guided flow did not exist for it — so on membership alone the gate opening
 * would answer `guidedRunCompleted: false` and hand that reader a full-screen
 * Welcome takeover on their next dashboard load. That is a post-auth takeover
 * nobody asked for and the ISS-9916 inversion again, arriving by a different
 * door.
 *
 * SYNCED SESSION DATA IS THE SECOND CONDITION, and it is required to be a
 * MEASURED `No`. It is the one fact this snapshot already reads that says
 * whether the organization has been USED, and a new empty organization cannot
 * have any. {@link KnownFlag.Unknown} is a failed or still-loading read and is
 * therefore not evidence of emptiness: it withholds the swap, so a transient
 * producer failure costs one page load of the reconciled sequence rather than
 * re-onboarding somebody. That is the same direction the gate itself fails.
 *
 * NARROWED DELIBERATELY, with the alternative named: the wider reading is that
 * the rollout SHOULD re-walk that cohort, and `state.wizardCompletedAt` is a
 * timestamp, so a recency cutoff could express it instead. Re-onboarding
 * already-productive organizations is a product decision and this is an
 * implementation change, so the non-regressive reading is taken here and the
 * choice is left open for the rollout.
 */
function readsGuidedRunCompletion(inputs: {
  membership: OrganizationMembership;
  organizationHasSyncedSessionData: KnownFlag;
  requiredPhasesEnabled: boolean;
}): boolean {
  return (
    inputs.requiredPhasesEnabled &&
    inputs.membership === OrganizationMembership.FirstUser &&
    inputs.organizationHasSyncedSessionData === KnownFlag.No
  );
}

/**
 * The organization step folded away for a reader who demonstrably has one
 * (ISS-11073).
 *
 * Load-bearing for this ticket, not a tidy-up. The acceptance criterion is that
 * a new empty Web organization SEES invitations and then the download gate
 * before the dashboard, and `Start` resolves to `create_organization` on Web.
 * Leaving that step in the way would replace one wrong destination with
 * another, and a reader who answered it would create a SECOND organization:
 * this snapshot is ORG-SCOPED — `resolveClerkIdentityContext` refuses a
 * principal whose token carries no `org_id` — so a caller who reaches this
 * service at all already belongs to one.
 *
 * Only as far as the NEXT step. It lands on {@link OnboardingPhase.InviteTeam},
 * the order PRD-689 gives both cohorts and the same landing
 * {@link foldForFinishedOrganization} already uses for the same reason. That is
 * the next step only on Web: on Desktop the sync policy now comes between them
 * (ISS-10890), but the fold keeps `InviteTeam` on both hosts (operator
 * decision, 2026-09-24), because sending an ISS-10624-era Desktop build to
 * `SyncPolicy` would walk it on to `SessionDiscovery`, `Account` and back
 * through the organization step. A folded Desktop reader therefore skips the
 * wizard's sync step and is still offered it by the deferred
 * `PendingOnboardingStep.ChooseSessionSync` item.
 *
 * No `resuming` guard, deliberately: `ResumePendingStep` opens only
 * phase-backed `PendingOnboardingStep`s, and the organization step is not
 * one, so a resuming run can never occupy this phase and a guard for it would
 * be unreachable.
 *
 * `history` records the skipped phase so Back still walks the path the reader
 * took, exactly as `advance` would have.
 *
 * BACK IS NOT A ROUND TRIP, and that takes the second branch. A run already
 * carrying `organizationEstablished` at this phase got here by Back from the
 * `InviteTeam` this fold produced — `transitionBack` preserves the flag — so
 * advancing it again would hand the reader back the screen they just left, on
 * the very response meant to confirm the Back. It is reported one step further
 * back instead, at the phase they left for the skipped step, as it stood
 * before the advance. Same case, same guard, same reason as
 * {@link foldForFinishedOrganization}.
 */
function foldEstablishedOrganizationStep(
  state: OnboardingMachineState
): OnboardingMachineState {
  if (state.phase !== OnboardingPhase.CreateOrganization) {
    return state;
  }
  const previous = state.history.at(-1);
  if (state.organizationEstablished && previous !== undefined) {
    return {
      phase: previous,
      history: state.history.slice(0, -1),
      accountProvider: state.accountProvider,
      resuming: false,
      organizationEstablished: false,
    };
  }
  return {
    phase: OnboardingPhase.InviteTeam,
    history: [...state.history, OnboardingPhase.CreateOrganization],
    accountProvider: state.accountProvider,
    resuming: false,
    organizationEstablished: true,
  };
}

/**
 * The host the stored run started on, or `undefined` when there is no run or
 * the column holds a value this build does not know. Omitted rather than
 * guessed: the Web shell stands down on `Desktop`, and an invented value would
 * either hide a wizard the reader owes or show one Desktop already runs.
 */
function storedOnboardingHost(
  attempt: OnboardingAttemptRecord | null
): OnboardingHost | undefined {
  return Object.values(OnboardingHost).find(
    (candidate) => candidate === attempt?.host
  );
}
