/**
 * @file onboarding-transitions.ts
 * @description The pure onboarding transition machine (ISS-8349).
 *
 * One canonical model for both hosts: every edge of the PRD-689 finite-state
 * diagram is a typed {@link OnboardingEventInput} plus a guard over
 * {@link OnboardingContext}. Nothing here touches React, the network, or
 * storage, so all four host/member cohorts are testable as data.
 *
 * The diagram's choice pseudo-states are the branch helpers below —
 * `HostMode` is {@link resolvePostWelcomePhase}, `OrganizationKind` is
 * {@link resolveOrganizationPhase}, `AfterOrganization` is
 * {@link resolvePostOrganizationPhase}, `AfterInitialInvite` is
 * {@link resolvePostInvitePhase}, `AfterDownload` is
 * {@link resolvePostDownloadPhase}, and `PendingStep` lives in
 * `onboarding-completion.ts`. Resolving them here is what keeps a persisted
 * phase always a real screen.
 */

import {
  canSkipDesktopDownload,
  phaseForPendingStep,
  resolvePendingOnboardingStep,
} from "@repo/api/src/types/onboarding-completion";
import {
  OnboardingEvent,
  type OnboardingEventInput,
  OnboardingRejection,
} from "@repo/api/src/types/onboarding-events";
import {
  AccountProvider,
  AccountStatus,
  isBlockingPhase,
  KnownFlag,
  type OnboardingContext,
  OnboardingHost,
  type OnboardingMachineState,
  OnboardingPhase,
  OrganizationMembership,
} from "@repo/api/src/types/onboarding-phase";
import type { AuthSnapshot } from "../../shared/auth/auth-adapter";
import { canRecordDashboardTourCompletion } from "./dashboard-tour-completion";

/** The outcome of dispatching one event. */
export type OnboardingTransitionResult =
  | { status: "moved"; state: OnboardingMachineState }
  | { status: "rejected"; reason: OnboardingRejection };

function moved(state: OnboardingMachineState): OnboardingTransitionResult {
  return { status: "moved", state };
}

function rejected(reason: OnboardingRejection): OnboardingTransitionResult {
  return { status: "rejected", reason };
}

/** Advance to `phase`, recording the phase being left so Back can return to it. */
function advance(
  state: OnboardingMachineState,
  phase: OnboardingPhase,
  resuming = state.resuming,
  organizationEstablished = state.organizationEstablished,
  accountProvider = state.accountProvider
): OnboardingTransitionResult {
  return moved({
    phase,
    history: [...state.history, state.phase],
    accountProvider,
    resuming,
    organizationEstablished,
  });
}

/**
 * `HostMode`. Desktop begins local analysis first; Web goes straight to
 * account setup — unless the account is already established, which is the
 * canonical shell's `getPostWelcomePhase` shortcut for a signed-in Web user
 * restarting the flow.
 */
export function resolvePostWelcomePhase(
  context: OnboardingContext
): OnboardingPhase {
  if (context.host === OnboardingHost.Desktop) {
    return OnboardingPhase.SessionDiscovery;
  }
  if (context.accountStatus === AccountStatus.Established) {
    return resolveOrganizationPhase(context);
  }
  return OnboardingPhase.Account;
}

/**
 * `OrganizationKind`. Branches on membership, never on host mode, and creates
 * only for a first user known to have no organization. One who is already
 * acting in one (Clerk's signup task made it) chooses it, since Clerk
 * membership is the authority for selecting an existing organization (PRD-689,
 * 2026-09-03); the create step added a second and restarted the run on it
 * (ISS-11090).
 *
 * No server-backed run reaches the create branch today: the guided routes
 * refuse a Clerk session with no `orgId` (`withAnyAuth`), and a Desktop
 * session's identity always carries one, so no session that holds a snapshot
 * states `No`. The guest-local run states `Unknown` and never posts
 * `account_established`: the sign-in handoff does, under the server's measured
 * context.
 *
 * The naming the create step carried is not lost with that branch: the choose
 * step edits the active organization's name and slug in place (ISS-11253), so
 * nothing here needs an edge into create to give a first user that capability.
 */
export function resolveOrganizationPhase(
  context: OnboardingContext
): OnboardingPhase {
  return context.membership === OrganizationMembership.FirstUser &&
    context.organizationActive === KnownFlag.No
    ? OnboardingPhase.CreateOrganization
    : OnboardingPhase.ChooseOrganization;
}

/**
 * `AfterOrganization`. Desktop chooses a sync policy before invitations, once
 * the organization it is recorded against exists (ISS-10890).
 */
export function resolvePostOrganizationPhase(
  context: OnboardingContext
): OnboardingPhase {
  return context.host === OnboardingHost.Desktop
    ? OnboardingPhase.SyncPolicy
    : OnboardingPhase.InviteTeam;
}

/**
 * `AfterInitialInvite`. A resumed invitation returns straight to the Dashboard;
 * the initial run continues to the Web download gate, to the conditional GitHub
 * step, or out.
 */
export function resolvePostInvitePhase(
  state: OnboardingMachineState,
  context: OnboardingContext
): OnboardingPhase {
  if (state.resuming) {
    return OnboardingPhase.DashboardAvailable;
  }
  if (context.host === OnboardingHost.Web) {
    return OnboardingPhase.DownloadDesktop;
  }
  if (requiresGitHubStep(context)) {
    return OnboardingPhase.ConnectGitHub;
  }
  return OnboardingPhase.DashboardAvailable;
}

/**
 * `AfterDownload`. The Web download gate's two exits land on the same place.
 * A modern snapshot measured the user's data connection, so its result decides
 * whether this initial run owes the canonical GitHub prompt (ISS-11398). An
 * older API omits that measurement signal and retains the provider branch it
 * used before this change; its false reported installation status alone.
 *
 * A RESUMED download step ends at the Dashboard instead, the same way a resumed
 * invitation does: the completion card offers one item at a time, so chaining a
 * second step out of a resumed one would pull a reader who asked only for the
 * installer back into a run they had already finished.
 */
function resolvePostDownloadPhase(
  state: OnboardingMachineState,
  context: OnboardingContext
): OnboardingPhase {
  if (state.resuming) {
    return OnboardingPhase.DashboardAvailable;
  }
  if (
    context.host === OnboardingHost.Web &&
    context.githubDataConnectionStatusMeasured === true
  ) {
    return context.githubConnected
      ? OnboardingPhase.DashboardAvailable
      : OnboardingPhase.ConnectGitHub;
  }
  return requiresGitHubStep(context)
    ? OnboardingPhase.ConnectGitHub
    : OnboardingPhase.DashboardAvailable;
}

/**
 * Whether the provider-based initial run still owes a GitHub step. Desktop
 * retains this branch, as does Web when an older API cannot report whether it
 * measured the user's personal registry connection.
 *
 * Read by {@link resolvePostInvitePhase} on Desktop, which has no download
 * gate, and by {@link resolvePostDownloadPhase} on Web only for legacy snapshots.
 */
export function requiresGitHubStep(context: OnboardingContext): boolean {
  return (
    context.accountProvider !== AccountProvider.GitHub &&
    !context.githubConnected
  );
}

/** Whether the account screen may be skipped. Desktop only; Web requires it. */
export function canSkipAccount(context: OnboardingContext): boolean {
  return context.host === OnboardingHost.Desktop;
}

/**
 * Whether Desktop discovery may continue. PRD-689: Continue becomes available
 * only after analysis has actually begun, so a stalled analyzer cannot be
 * clicked past into a flow that claims work is underway.
 */
export function canContinueFromDiscovery(context: OnboardingContext): boolean {
  return context.analysisStarted;
}

function transitionFromWelcome(
  state: OnboardingMachineState,
  event: OnboardingEventInput,
  context: OnboardingContext
): OnboardingTransitionResult {
  if (event.type !== OnboardingEvent.Start) {
    return rejected(OnboardingRejection.NotAllowedFromPhase);
  }
  return advance(state, resolvePostWelcomePhase(context));
}

function transitionFromSessionDiscovery(
  state: OnboardingMachineState,
  event: OnboardingEventInput,
  context: OnboardingContext
): OnboardingTransitionResult {
  if (event.type !== OnboardingEvent.ContinueFromDiscovery) {
    return rejected(OnboardingRejection.NotAllowedFromPhase);
  }
  if (!canContinueFromDiscovery(context)) {
    return rejected(OnboardingRejection.GuardBlocked);
  }
  return advance(state, OnboardingPhase.Account);
}

function transitionFromAccount(
  state: OnboardingMachineState,
  event: OnboardingEventInput,
  context: OnboardingContext
): OnboardingTransitionResult {
  if (event.type === OnboardingEvent.SkipAccount) {
    if (!canSkipAccount(context)) {
      return rejected(OnboardingRejection.GuardBlocked);
    }
    // Skipping the account leaves the organization/sync/invite tail unrun, and
    // reaching the Dashboard ends any resumed step.
    return advance(state, OnboardingPhase.DashboardAvailable, false);
  }
  if (event.type !== OnboardingEvent.AccountEstablished) {
    return rejected(OnboardingRejection.NotAllowedFromPhase);
  }
  // A resumed account step skips straight back to the Dashboard ONLY when the
  // organization tail already ran. `SkipAccount` is the one path that defers
  // this step, and it bypassed that tail entirely, so resuming it has to hand
  // the user the organization branch rather than the Dashboard they would
  // otherwise be stranded on with no organization (ISS-8349 review).
  if (state.resuming && state.organizationEstablished) {
    return advance(
      state,
      OnboardingPhase.DashboardAvailable,
      false,
      state.organizationEstablished,
      event.provider
    );
  }
  // Continuing into the deferred tail is no longer a single resumed step, so
  // `resuming` is cleared and the full tail plays out.
  return advance(
    state,
    resolveOrganizationPhase(context),
    false,
    state.organizationEstablished,
    event.provider
  );
}

function transitionFromOrganization(
  state: OnboardingMachineState,
  event: OnboardingEventInput,
  context: OnboardingContext
): OnboardingTransitionResult {
  if (event.type !== OnboardingEvent.OrganizationReady) {
    return rejected(OnboardingRejection.NotAllowedFromPhase);
  }
  return advance(
    state,
    resolvePostOrganizationPhase(context),
    state.resuming,
    true
  );
}

/**
 * A run that holds SyncPolicy straight after Welcome was stored by an older
 * Desktop build (the ISS-10624 order, or the ISS-12523 order the operator
 * reverted on 2026-10-20) and continues in that order to discovery, even when
 * its organization is already established (ISS-10890 PR 2).
 */
function transitionFromSyncPolicy(
  state: OnboardingMachineState,
  event: OnboardingEventInput
): OnboardingTransitionResult {
  if (event.type !== OnboardingEvent.ContinueFromSyncPolicy) {
    return rejected(OnboardingRejection.NotAllowedFromPhase);
  }
  // `resuming` is consumed here for the same reason it is at InviteTeam: a step
  // resumed from the completion card returns the reader to the app they were
  // already in, never onward into a tail they finished (ISS-11249).
  //
  // ROOTED rather than appended, and that is a COMPATIBILITY requirement, not a
  // style choice. `advance` would leave the chain `[dashboard_available,
  // sync_policy]` and then `[…, sync_policy, dashboard_available]` PERSISTED on
  // the settled run, and neither hop is an edge a Desktop build older than this
  // change knows — so `isReachableOnboardingState` there rejects the finished
  // run and `restoreOnboardingState` recovers it to the blocking `Welcome`
  // takeover, on every launch, for good. `DashboardAvailable` is a history root
  // on every build, so rooting the exit keeps the durable state readable by all
  // of them. Nothing is lost: Back is rejected from `DashboardAvailable`
  // regardless of what sits behind it, so the appended entry was never walkable.
  if (state.resuming) {
    return moved({
      phase: OnboardingPhase.DashboardAvailable,
      history: [],
      accountProvider: state.accountProvider,
      resuming: false,
      organizationEstablished: state.organizationEstablished,
    });
  }
  return advance(
    state,
    state.organizationEstablished &&
      state.history.at(-1) !== OnboardingPhase.Welcome
      ? OnboardingPhase.InviteTeam
      : OnboardingPhase.SessionDiscovery
  );
}

function transitionFromInviteTeam(
  state: OnboardingMachineState,
  event: OnboardingEventInput,
  context: OnboardingContext
): OnboardingTransitionResult {
  const sentOrSkipped =
    event.type === OnboardingEvent.SendInvitations ||
    event.type === OnboardingEvent.SkipInvitations;
  if (!sentOrSkipped) {
    return rejected(OnboardingRejection.NotAllowedFromPhase);
  }
  // `resuming` is consumed here: the resumed invite exits to the Dashboard and
  // the run is no longer inside a resumed step.
  return advance(state, resolvePostInvitePhase(state, context), false);
}

/**
 * Downloading and skipping exit to the SAME phase, because taking the installer
 * says nothing about GitHub: the step that follows is decided by
 * {@link resolvePostDownloadPhase}, never by which button was pressed.
 */
function transitionFromDownloadDesktop(
  state: OnboardingMachineState,
  event: OnboardingEventInput,
  context: OnboardingContext
): OnboardingTransitionResult {
  if (event.type === OnboardingEvent.DownloadDesktopApp) {
    return advance(state, resolvePostDownloadPhase(state, context), false);
  }
  if (event.type !== OnboardingEvent.SkipDownload) {
    return rejected(OnboardingRejection.NotAllowedFromPhase);
  }
  if (!canSkipDesktopDownload(context)) {
    return rejected(OnboardingRejection.GuardBlocked);
  }
  return advance(state, resolvePostDownloadPhase(state, context), false);
}

function transitionFromConnectGitHub(
  state: OnboardingMachineState,
  event: OnboardingEventInput
): OnboardingTransitionResult {
  const connectedOrSkipped =
    event.type === OnboardingEvent.ConnectGitHub ||
    event.type === OnboardingEvent.SkipGitHub;
  if (!connectedOrSkipped) {
    return rejected(OnboardingRejection.NotAllowedFromPhase);
  }
  return advance(state, OnboardingPhase.DashboardAvailable, false);
}

function transitionFromDashboardAvailable(
  state: OnboardingMachineState,
  event: OnboardingEventInput,
  context: OnboardingContext
): OnboardingTransitionResult {
  if (event.type !== OnboardingEvent.DashboardEntered) {
    return rejected(OnboardingRejection.NotAllowedFromPhase);
  }
  // First completion runs the tour; a returning user goes straight to Ready,
  // where the completion card projects any outstanding step.
  const phase = context.tourCompleted
    ? OnboardingPhase.Ready
    : OnboardingPhase.DashboardTour;
  return advance(state, phase, false);
}

function transitionFromDashboardTour(
  state: OnboardingMachineState,
  event: OnboardingEventInput
): OnboardingTransitionResult {
  // The deferral half of the phase's exit; `finish_tour` is handled ahead of the
  // phase table by `transitionOnFinishTour`, which lands it on the same Ready.
  // What separates the two is the marker `finish_tour` stamps and `defer_tour`
  // does not (`dashboard-tour-completion.ts`). While `finish_tour` was the only
  // edge out, an org with no synced sessions - whose dashboard emits no anchor
  // to ring - could not leave this phase at all without being recorded as having
  // seen a tour it was never shown.
  if (event.type !== OnboardingEvent.DeferTour) {
    return rejected(OnboardingRejection.NotAllowedFromPhase);
  }
  return advance(state, OnboardingPhase.Ready, false);
}

/**
 * `finish_tour`, from wherever the run happens to be.
 *
 * It is a MARKER, not a step: it records that this reader was shown the tour and
 * ended it, and only `dashboard_tour` has a phase to leave on the way. Scoping
 * it to the phases the run is ASKING from is what dropped almost every desktop
 * completion - desktop's tour fires on first launch and not on the run, and with
 * nothing in production posting `dashboard_entered` those readers' runs sit on
 * `Welcome` (no attempt row yet) or `DashboardAvailable`. The completion went
 * nowhere and web kept offering a tour they had already finished.
 *
 * The reader does not MOVE when they were not on the tour phase: the state is
 * returned unchanged and the transition exists purely to stamp the marker.
 * Appending the current phase to its own history instead would write a chain no
 * run can walk (`onboarding-reachability.ts`), and the next restore would throw
 * the run away.
 */
function transitionOnFinishTour(
  state: OnboardingMachineState,
  context: OnboardingContext
): OnboardingTransitionResult {
  if (state.phase === OnboardingPhase.DashboardTour) {
    return advance(state, OnboardingPhase.Ready, false);
  }
  if (
    !canRecordDashboardTourCompletion({
      phase: state.phase,
      tourCompleted: context.tourCompleted,
    })
  ) {
    return rejected(OnboardingRejection.GuardBlocked);
  }
  return moved(state);
}

function transitionFromReady(
  state: OnboardingMachineState,
  event: OnboardingEventInput,
  context: OnboardingContext
): OnboardingTransitionResult {
  if (event.type !== OnboardingEvent.ResumePendingStep) {
    return rejected(OnboardingRejection.NotAllowedFromPhase);
  }
  // Only the step the card is actually offering may be resumed, so a stale
  // click cannot re-enter a step the context has since satisfied.
  if (resolvePendingOnboardingStep(context) !== event.step) {
    return rejected(OnboardingRejection.StepNotPending);
  }
  // History is reset to the Dashboard: Back from a resumed step returns to the
  // app, never into the initial blocking run the user already finished.
  return moved({
    phase: phaseForPendingStep(event.step),
    history: [OnboardingPhase.DashboardAvailable],
    accountProvider: state.accountProvider,
    resuming: true,
    organizationEstablished: state.organizationEstablished,
  });
}

function transitionBack(
  state: OnboardingMachineState
): OnboardingTransitionResult {
  const previous = state.history.at(-1);
  if (!previous) {
    return rejected(OnboardingRejection.NoHistory);
  }
  return moved({
    phase: previous,
    history: state.history.slice(0, -1),
    accountProvider: state.accountProvider,
    // Backing out to the Dashboard ends the resumed step.
    resuming:
      previous === OnboardingPhase.DashboardAvailable ? false : state.resuming,
    organizationEstablished: state.organizationEstablished,
  });
}

/** One phase's outgoing edges. Every phase names one, exhaustively. */
type PhaseTransition = (
  state: OnboardingMachineState,
  event: OnboardingEventInput,
  context: OnboardingContext
) => OnboardingTransitionResult;

/**
 * The dispatch table, keyed exhaustively by phase.
 *
 * A `Record<OnboardingPhase, …>` rather than an if-chain with a trailing
 * fallback: the old chain ended in `return transitionFromReady(…)`, so a newly
 * added {@link OnboardingPhase} typechecked and silently inherited Ready's
 * behavior. Here a new phase has no entry, so `tsc` fails until an intentional
 * mapping is written — the side-inventory hole the repo's review lessons name
 * (ISS-8349 review).
 */
const PHASE_TRANSITIONS: Record<OnboardingPhase, PhaseTransition> = {
  [OnboardingPhase.Welcome]: transitionFromWelcome,
  [OnboardingPhase.SessionDiscovery]: transitionFromSessionDiscovery,
  [OnboardingPhase.Account]: transitionFromAccount,
  [OnboardingPhase.CreateOrganization]: transitionFromOrganization,
  [OnboardingPhase.ChooseOrganization]: transitionFromOrganization,
  [OnboardingPhase.SyncPolicy]: transitionFromSyncPolicy,
  [OnboardingPhase.InviteTeam]: transitionFromInviteTeam,
  [OnboardingPhase.DownloadDesktop]: transitionFromDownloadDesktop,
  [OnboardingPhase.ConnectGitHub]: transitionFromConnectGitHub,
  [OnboardingPhase.DashboardAvailable]: transitionFromDashboardAvailable,
  [OnboardingPhase.DashboardTour]: transitionFromDashboardTour,
  [OnboardingPhase.Ready]: transitionFromReady,
};

/**
 * Apply one event. Pure: same `(state, event, context)` always yields the same
 * result, and a rejected event leaves the caller's state untouched.
 */
export function transitionOnboarding(
  state: OnboardingMachineState,
  event: OnboardingEventInput,
  context: OnboardingContext
): OnboardingTransitionResult {
  if (event.type === OnboardingEvent.Back) {
    // Back is a blocking-flow control only. Accepting it from the Dashboard,
    // the tour, or Ready let a completed run walk backwards out of the app and
    // into the setup screens it had already finished (ISS-8349 review). A
    // resumed step is itself a blocking phase, so its Back still pops to the
    // Dashboard.
    if (!isBlockingPhase(state.phase)) {
      return rejected(OnboardingRejection.NotAllowedFromPhase);
    }
    return transitionBack(state);
  }
  // Ahead of the phase table for the same reason Back is, and for the opposite
  // one: Back belongs to no phase, and this belongs to ALL of them. See
  // `transitionOnFinishTour` - a completion is a fact about the reader, and the
  // surface that shows the tour is not always the run.
  if (event.type === OnboardingEvent.FinishTour) {
    return transitionOnFinishTour(state, context);
  }
  return PHASE_TRANSITIONS[state.phase](state, event, context);
}

/**
 * ISS-11090: a run parked on CreateOrganization, whether persisted before the
 * resolver stopped routing there or posted by an older client, is the choose
 * step unless the session is known to have no organization. Applied to the
 * restored STATE that both the host renders and the transition hook runs the
 * machine on, so the step shown, the command posted, and the funnel event
 * emitted all name the same step. History entries follow, so Back lands on it
 * too.
 */
export function chooseActiveOrganization(
  state: OnboardingMachineState,
  organizationActive: KnownFlag
): OnboardingMachineState {
  if (organizationActive === KnownFlag.No) {
    return state;
  }
  const choose = (phase: OnboardingPhase) =>
    phase === OnboardingPhase.CreateOrganization
      ? OnboardingPhase.ChooseOrganization
      : phase;
  return {
    ...state,
    history: state.history.map(choose),
    phase: choose(state.phase),
  };
}

/**
 * Whether the session is acting in an organization, from the same identity
 * every guided request is scoped to. `No` only for a loaded, signed-in session
 * with no active organization: `orgId` is also null while auth loads, when
 * signed out, and with no auth provider mounted, and none of those may reach
 * the create step (ISS-11090 review).
 */
export function organizationActiveFlag({
  isLoaded,
  orgId,
  userId,
}: Pick<AuthSnapshot, "isLoaded" | "orgId" | "userId">): KnownFlag {
  if (!isLoaded || userId === null) {
    return KnownFlag.Unknown;
  }
  return orgId === null ? KnownFlag.No : KnownFlag.Yes;
}

/**
 * Whether a live run has left Welcome through Start and is still in the
 * blocking flow. Start is Welcome's only exit, so Welcome in the history means
 * Start was accepted; a settled or resumed run is rooted at the Dashboard and
 * never qualifies (ISS-10890 analysis agreement, operator 2026-09-24).
 */
export function hasLeftWelcomeThroughStart(
  state: OnboardingMachineState
): boolean {
  return (
    isBlockingPhase(state.phase) &&
    state.history.includes(OnboardingPhase.Welcome)
  );
}
