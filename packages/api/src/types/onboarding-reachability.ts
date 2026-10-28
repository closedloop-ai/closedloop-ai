/**
 * @file onboarding-reachability.ts
 * @description Whether a well-typed onboarding state is one the machine could
 * actually have produced (ISS-8349 review).
 *
 * `onboarding-persistence.ts` validates the SHAPE of a stored payload and that
 * its phases render on this host. Neither says the state is reachable: `Ready`
 * with an empty history is enum-valid and host-valid, yet no run from
 * {@link createInitialOnboardingState} can produce it, and restoring it hands
 * the user a finished onboarding they never completed. Because the persisted
 * state gates setup, an unreachable-but-well-typed payload is a setup bypass,
 * not a cosmetic defect.
 *
 * The predicate is three invariants over `(phase, history, resuming)`:
 *
 *  1. the chain `[...history, phase]` starts at a phase a run can occupy with
 *     no history behind it;
 *  2. every consecutive pair in that chain is an edge the machine can take, or
 *     the {@link LEGACY_RESTORE_EDGES} move an older Desktop build takes;
 *  3. `resuming` is only set inside a step resumed from the completion card.
 *
 * {@link PHASE_EDGES} and {@link ONBOARDING_HISTORY_ROOTS} describe the machine
 * in `onboarding-transitions.ts`, so they must not drift from it. They are not
 * recomputed at runtime — deriving them costs a full sweep of every phase,
 * event, and context combination, which is far too much work to do on a restore
 * in a browser. `__tests__/onboarding-reachability.test.ts` performs exactly
 * that sweep and fails if either constant disagrees with the machine, so the
 * derivation is mechanical even though the value here is written down.
 *
 * `organizationEstablished` is deliberately NOT validated: Back pops history,
 * so a run can legitimately hold the flag with no organization phase left in
 * its chain, and no sound predicate over `(phase, history)` can recover it.
 */

import {
  PENDING_STEP_PRIORITY,
  phaseForPendingStep,
} from "./onboarding-completion.ts";
import {
  type OnboardingMachineState,
  OnboardingPhase,
} from "./onboarding-phase.ts";

/**
 * The phases a run can occupy with an empty history: the phase a fresh run
 * starts at, and the Dashboard that resuming a step rewrites history to.
 */
export const ONBOARDING_HISTORY_ROOTS: readonly OnboardingPhase[] = [
  OnboardingPhase.Welcome,
  OnboardingPhase.DashboardAvailable,
];

/**
 * The phases each phase can move to in one transition, across every event and
 * every context. An exhaustive `Record` so a new {@link OnboardingPhase} fails
 * `tsc` here rather than being silently unreachable from everything.
 */
export const PHASE_EDGES: Record<OnboardingPhase, readonly OnboardingPhase[]> =
  {
    [OnboardingPhase.Welcome]: [
      OnboardingPhase.Account,
      OnboardingPhase.ChooseOrganization,
      OnboardingPhase.CreateOrganization,
      OnboardingPhase.SessionDiscovery,
    ],
    [OnboardingPhase.SessionDiscovery]: [OnboardingPhase.Account],
    [OnboardingPhase.Account]: [
      OnboardingPhase.ChooseOrganization,
      OnboardingPhase.CreateOrganization,
      OnboardingPhase.DashboardAvailable,
    ],
    [OnboardingPhase.CreateOrganization]: [
      OnboardingPhase.InviteTeam,
      OnboardingPhase.SyncPolicy,
    ],
    [OnboardingPhase.ChooseOrganization]: [
      OnboardingPhase.InviteTeam,
      OnboardingPhase.SyncPolicy,
    ],
    // No `DashboardAvailable` here, and its absence is load-bearing (ISS-11249).
    // The resumed sync step DOES exit to the Dashboard, but it RE-ROOTS the chain
    // instead of appending, so `sync_policy -> dashboard_available` is never a
    // persisted hop — which is what keeps a settled resumed run readable by a
    // Desktop build that predates this change. This table describes stored
    // chains, and the sweep in `onboarding-reachability.test.ts` derives it from
    // the machine on exactly that rule, so adding the entry back fails there.
    [OnboardingPhase.SyncPolicy]: [
      OnboardingPhase.InviteTeam,
      OnboardingPhase.SessionDiscovery,
    ],
    [OnboardingPhase.InviteTeam]: [
      OnboardingPhase.ConnectGitHub,
      OnboardingPhase.DashboardAvailable,
      OnboardingPhase.DownloadDesktop,
    ],
    [OnboardingPhase.DownloadDesktop]: [
      OnboardingPhase.ConnectGitHub,
      OnboardingPhase.DashboardAvailable,
    ],
    [OnboardingPhase.ConnectGitHub]: [OnboardingPhase.DashboardAvailable],
    [OnboardingPhase.DashboardAvailable]: [
      OnboardingPhase.Account,
      OnboardingPhase.ConnectGitHub,
      OnboardingPhase.DashboardTour,
      OnboardingPhase.DownloadDesktop,
      OnboardingPhase.InviteTeam,
      OnboardingPhase.Ready,
      OnboardingPhase.SyncPolicy,
    ],
    [OnboardingPhase.DashboardTour]: [OnboardingPhase.Ready],
    [OnboardingPhase.Ready]: [],
  };

/**
 * The one move of the ISS-10624 Desktop order (sync policy right after Welcome)
 * the current machine no longer takes. Desktop builds released since 2026-09-18
 * post and store chains through it, and the API validates every posted state
 * and restores every stored one through {@link isWalkableChain}, so dropping it
 * would reject every transition from those builds and restore their runs,
 * finished guest runs included, as a fresh Welcome. That order's next move,
 * SyncPolicy to SessionDiscovery, is still a machine edge in
 * {@link PHASE_EDGES}: a run that reaches SyncPolicy this way continues in it.
 *
 * Kept out of {@link PHASE_EDGES} so the reachability sweep still pins that
 * table to the machine exactly. Remove only with human approval under the
 * Compatibility Guardrail, once ISS-10624-era Desktop builds are no longer
 * supported (ISS-10890).
 *
 * lc-debt: legacy edge outside the machine-derived graph; remove with human approval once ISS-10624-era Desktop builds are unsupported.
 */
const LEGACY_RESTORE_EDGES: Partial<
  Record<OnboardingPhase, readonly OnboardingPhase[]>
> = {
  [OnboardingPhase.Welcome]: [OnboardingPhase.SyncPolicy],
};

/**
 * The phases a resumed step re-enters, derived from the completion contract
 * rather than restated, so the two cannot disagree about what is resumable.
 */
const RESUMABLE_PHASES: readonly OnboardingPhase[] =
  PENDING_STEP_PRIORITY.map(phaseForPendingStep);

/**
 * Whether the visited path is one the machine, or an older Desktop build taking
 * a {@link LEGACY_RESTORE_EDGES} move, could have walked.
 */
function isWalkableChain(chain: readonly OnboardingPhase[]): boolean {
  const root = chain[0];
  if (root === undefined || !ONBOARDING_HISTORY_ROOTS.includes(root)) {
    return false;
  }
  for (let index = 1; index < chain.length; index += 1) {
    const from = chain[index - 1];
    const to = chain[index];
    if (from === undefined || to === undefined) {
      return false;
    }
    if (
      !(
        PHASE_EDGES[from].includes(to) ||
        LEGACY_RESTORE_EDGES[from]?.includes(to)
      )
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Whether `state` is a state some run of the machine can end in.
 *
 * Sound before it is strict: every reachable state must pass, or a restore
 * would throw away a legitimate run. The test sweep asserts exactly that
 * against every state a bounded walk of the machine can reach.
 */
export function isReachableOnboardingState(
  state: OnboardingMachineState
): boolean {
  if (!isWalkableChain([...state.history, state.phase])) {
    return false;
  }
  if (!state.resuming) {
    return true;
  }
  // Resuming is entered only from Ready, which rewrites history to the
  // Dashboard, and every transition out of the resumed step clears it again.
  return (
    state.history.length === 1 &&
    state.history[0] === OnboardingPhase.DashboardAvailable &&
    RESUMABLE_PHASES.includes(state.phase)
  );
}
