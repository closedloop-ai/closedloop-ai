/**
 * @file onboarding-funnel-analytics.ts
 * @description Pure derivation of the PRD-736 funnel events from one accepted
 * onboarding transition. The FSM consumer (`useGuidedOnboardingTransition`) is
 * the single emit site — components stay uninstrumented, so events cannot
 * drift from the product flow (PRD-736 design principle 1).
 */

import {
  FirstOrgUserValue,
  type OnboardingAccountModes,
  OnboardingAnalyticsEvent,
  OnboardingAnalyticsProperty,
  OnboardingEntryPoint,
  type OnboardingSyncPolicyChoice,
  OrgMembershipOutcome,
} from "@repo/api/src/types/onboarding-analytics";
import { canSkipDesktopDownload } from "@repo/api/src/types/onboarding-completion";
import {
  OnboardingEvent,
  type OnboardingEventInput,
} from "@repo/api/src/types/onboarding-events";
import {
  type OnboardingContext,
  OnboardingHost,
  type OnboardingMachineState,
  OnboardingPhase,
  OrganizationMembership,
} from "@repo/api/src/types/onboarding-phase";
import type { SurfaceAnalyticsProperties } from "@repo/api/src/types/surface-analytics";
import type { OnboardingFlowSession } from "./onboarding-flow-session";

export type OnboardingFunnelEmission = {
  event: OnboardingAnalyticsEvent;
  properties: SurfaceAnalyticsProperties;
};

/** Host-supplied facts the FSM cannot see (PRD-736 §Event catalog). */
export type OnboardingTransitionAnalyticsOutcome = {
  /** Actual installer interaction, independent of the legacy completion marker. */
  downloadClicked?: boolean;
  /** `invite_team` completion: how many invitations this flow actually sent. */
  invitesSentCount?: number;
  /** `session_discovery` completion (desktop, ISS-10502): measured session count. */
  sessionsFoundCount?: number;
  /** `session_discovery` completion (desktop, ISS-10502): detected harness count. */
  harnessesDetectedCount?: number;
  /** `session_discovery` completion (desktop, ISS-10502): detected harness names. */
  harnessesDetected?: readonly string[];
  /** `sync_policy` completion (desktop, ISS-10502): the consent level chosen. */
  syncPolicyChoice?: OnboardingSyncPolicyChoice;
  /**
   * `account` completion (desktop, ISS-10913): the observed auth facts, already
   * folded to a NON-EMPTY, deduplicated, deterministically ordered set by
   * `onboardingAccountModesForOutcome`. Supplied by the desktop host, which is
   * the only surface that observes an external auth return; the web guided
   * dialog supplies none and the property stays off its completion.
   */
  accountMode?: OnboardingAccountModes;
};

/**
 * Position of each phase within its surface's step sequence (`step_index`).
 * `null` marks a phase the host never occupies, so it is omitted rather than
 * given an invented position. Exhaustive by construction: a phase added to
 * {@link OnboardingPhase} fails typecheck here until it is placed.
 */
export const ONBOARDING_STEP_INDEX: Record<
  OnboardingHost,
  Record<OnboardingPhase, number | null>
> = {
  [OnboardingHost.Web]: {
    [OnboardingPhase.Welcome]: 0,
    [OnboardingPhase.SessionDiscovery]: null,
    [OnboardingPhase.Account]: 1,
    [OnboardingPhase.CreateOrganization]: 2,
    [OnboardingPhase.ChooseOrganization]: 2,
    [OnboardingPhase.SyncPolicy]: null,
    [OnboardingPhase.InviteTeam]: 3,
    [OnboardingPhase.DownloadDesktop]: 4,
    [OnboardingPhase.ConnectGitHub]: 5,
    [OnboardingPhase.DashboardAvailable]: 6,
    [OnboardingPhase.DashboardTour]: 7,
    [OnboardingPhase.Ready]: 8,
  },
  // ISS-10890 moved the sync policy back after the organization step, so a
  // Desktop step_index means a different step in builds before and after it.
  [OnboardingHost.Desktop]: {
    [OnboardingPhase.Welcome]: 0,
    [OnboardingPhase.SessionDiscovery]: 1,
    [OnboardingPhase.Account]: 2,
    [OnboardingPhase.CreateOrganization]: 3,
    [OnboardingPhase.ChooseOrganization]: 3,
    [OnboardingPhase.SyncPolicy]: 4,
    [OnboardingPhase.InviteTeam]: 5,
    [OnboardingPhase.DownloadDesktop]: null,
    [OnboardingPhase.ConnectGitHub]: 6,
    [OnboardingPhase.DashboardAvailable]: 7,
    [OnboardingPhase.DashboardTour]: 8,
    [OnboardingPhase.Ready]: 9,
  },
};

/** The explicit skip affordances (PRD-736 `onboarding_step_skipped`). */
const SKIP_EVENTS: ReadonlySet<OnboardingEventInput["type"]> = new Set([
  OnboardingEvent.SkipAccount,
  OnboardingEvent.SkipInvitations,
  OnboardingEvent.SkipDownload,
  OnboardingEvent.SkipGitHub,
]);

export function isOnboardingSkipEvent(event: OnboardingEventInput): boolean {
  return SKIP_EVENTS.has(event.type);
}

type StepOutcomeInput = {
  context: OnboardingContext;
  event: OnboardingEventInput;
  outcome?: OnboardingTransitionAnalyticsOutcome;
};

/**
 * Per-step outcome properties on `onboarding_step_completed` (PRD-736 §Event
 * catalog). Exhaustive over {@link OnboardingPhase}: a new phase fails
 * typecheck until it declares its outcome properties (`{}` is a declaration).
 * `session_discovery` and `sync_policy` complete only on desktop (ISS-10502):
 * their outcome facts arrive through {@link OnboardingTransitionAnalyticsOutcome}
 * from the desktop dialog host, and each property is omitted — never zeroed —
 * when the host measured nothing.
 */
const STEP_COMPLETION_OUTCOME_PROPS: Record<
  OnboardingPhase,
  (input: StepOutcomeInput) => SurfaceAnalyticsProperties
> = {
  [OnboardingPhase.Welcome]: () => ({}),
  [OnboardingPhase.SessionDiscovery]: ({ outcome }) => ({
    ...(outcome?.sessionsFoundCount === undefined
      ? {}
      : {
          [OnboardingAnalyticsProperty.SessionsFoundCount]:
            outcome.sessionsFoundCount,
        }),
    ...(outcome?.harnessesDetectedCount === undefined
      ? {}
      : {
          [OnboardingAnalyticsProperty.HarnessesDetectedCount]:
            outcome.harnessesDetectedCount,
        }),
    ...(outcome?.harnessesDetected === undefined
      ? {}
      : {
          [OnboardingAnalyticsProperty.HarnessesDetected]:
            outcome.harnessesDetected,
        }),
  }),
  [OnboardingPhase.Account]: ({ event, outcome }) => ({
    ...(event.type === OnboardingEvent.AccountEstablished
      ? { [OnboardingAnalyticsProperty.AccountProvider]: event.provider }
      : {}),
    // ISS-10913: emitted whenever the host observed an auth return, including
    // the `["unknown"]` a version-skewed gateway folds to — an ABSENT property
    // is the ambiguity this set exists to remove, so the omission below is only
    // for a host with no auth return to report at all (web).
    ...(outcome?.accountMode === undefined
      ? {}
      : { [OnboardingAnalyticsProperty.AccountMode]: outcome.accountMode }),
  }),
  [OnboardingPhase.CreateOrganization]: orgMembershipOutcomeProps,
  [OnboardingPhase.ChooseOrganization]: orgMembershipOutcomeProps,
  [OnboardingPhase.SyncPolicy]: ({ outcome }) =>
    outcome?.syncPolicyChoice === undefined
      ? {}
      : {
          [OnboardingAnalyticsProperty.SyncPolicyChoice]:
            outcome.syncPolicyChoice,
        },
  [OnboardingPhase.InviteTeam]: ({ outcome }) =>
    outcome?.invitesSentCount === undefined
      ? {}
      : {
          [OnboardingAnalyticsProperty.InvitesSentCount]:
            outcome.invitesSentCount,
        },
  [OnboardingPhase.DownloadDesktop]: ({ context, event, outcome }) => ({
    [OnboardingAnalyticsProperty.DownloadClicked]:
      outcome?.downloadClicked ??
      event.type === OnboardingEvent.DownloadDesktopApp,
    [OnboardingAnalyticsProperty.SkipAvailable]:
      canSkipDesktopDownload(context),
  }),
  [OnboardingPhase.ConnectGitHub]: ({ event }) => ({
    [OnboardingAnalyticsProperty.GitHubConnected]:
      event.type === OnboardingEvent.ConnectGitHub,
  }),
  [OnboardingPhase.DashboardAvailable]: () => ({}),
  [OnboardingPhase.DashboardTour]: () => ({}),
  [OnboardingPhase.Ready]: () => ({}),
};

/** `entry_point` on `onboarding_flow_started` is the surface the flow began on. */
export function onboardingEntryPointForHost(
  host: OnboardingHost
): OnboardingEntryPoint {
  return host === OnboardingHost.Desktop
    ? OnboardingEntryPoint.FreshInstall
    : OnboardingEntryPoint.WebSignup;
}

/**
 * Tri-state `first_org_user`: resolved by the org step's outcome, recorded on
 * the flow session, `unknown` before that (PRD-736 §Common context).
 */
export function firstOrgUserValue(
  session: Pick<OnboardingFlowSession, "firstOrgUser">
): FirstOrgUserValue {
  return session.firstOrgUser ?? FirstOrgUserValue.Unknown;
}

/** The context properties stamped on every funnel event. */
export function onboardingContextProperties(input: {
  host: OnboardingHost;
  phase: OnboardingPhase;
  session: Pick<OnboardingFlowSession, "flowId" | "firstOrgUser">;
}): SurfaceAnalyticsProperties {
  const stepIndex = ONBOARDING_STEP_INDEX[input.host][input.phase];
  return {
    [OnboardingAnalyticsProperty.FlowId]: input.session.flowId,
    [OnboardingAnalyticsProperty.FirstOrgUser]: firstOrgUserValue(
      input.session
    ),
    ...(stepIndex === null
      ? {}
      : { [OnboardingAnalyticsProperty.StepIndex]: stepIndex }),
  };
}

/**
 * Every funnel event one accepted transition implies, in emission order:
 * completed/skipped/back for the phase being left, viewed for the phase being
 * entered, and `onboarding_flow_completed` when the run reaches Ready.
 */
export function deriveOnboardingTransitionEmissions(input: {
  context: OnboardingContext;
  event: OnboardingEventInput;
  host: OnboardingHost;
  nextState: OnboardingMachineState;
  outcome?: OnboardingTransitionAnalyticsOutcome;
  priorState: OnboardingMachineState;
  session: OnboardingFlowSession;
}): OnboardingFunnelEmission[] {
  const { context, event, host, nextState, outcome, priorState, session } =
    input;
  const priorPhase = priorState.phase;
  const nextPhase = nextState.phase;
  if (nextPhase === priorPhase) {
    // A marker transition (`finish_tour` off-phase) moved nothing the funnel
    // narrates; the tour host owns the tour events themselves.
    return [];
  }
  const emissions: OnboardingFunnelEmission[] = [];
  const priorContextProps = onboardingContextProperties({
    host,
    phase: priorPhase,
    session,
  });

  if (event.type === OnboardingEvent.Back) {
    emissions.push({
      event: OnboardingAnalyticsEvent.StepBack,
      properties: {
        ...priorContextProps,
        [OnboardingAnalyticsProperty.FromStep]: priorPhase,
      },
    });
  } else if (isOnboardingSkipEvent(event)) {
    emissions.push({
      event: OnboardingAnalyticsEvent.StepSkipped,
      properties: {
        ...priorContextProps,
        [OnboardingAnalyticsProperty.Step]: priorPhase,
        ...(priorPhase === OnboardingPhase.DownloadDesktop
          ? {
              [OnboardingAnalyticsProperty.SkipAvailable]:
                canSkipDesktopDownload(context),
            }
          : {}),
      },
    });
  } else if (
    event.type !== OnboardingEvent.ResumePendingStep &&
    event.type !== OnboardingEvent.DeferTour
  ) {
    // Resuming re-enters a deferred step, and a deferred tour exits its phase
    // with the tour still OWED (PLN-1875 Step 9) — neither completed anything,
    // so neither may claim a step_completed.
    emissions.push({
      event: OnboardingAnalyticsEvent.StepCompleted,
      properties: {
        ...priorContextProps,
        [OnboardingAnalyticsProperty.Step]: priorPhase,
        ...STEP_COMPLETION_OUTCOME_PROPS[priorPhase]({
          context,
          event,
          outcome,
        }),
      },
    });
  }

  emissions.push({
    event: OnboardingAnalyticsEvent.StepViewed,
    properties: {
      ...onboardingContextProperties({ host, phase: nextPhase, session }),
      [OnboardingAnalyticsProperty.Step]: nextPhase,
      ...(nextPhase === OnboardingPhase.DownloadDesktop
        ? {
            [OnboardingAnalyticsProperty.SkipAvailable]:
              canSkipDesktopDownload(context),
          }
        : {}),
    },
  });

  // `priorState.resuming` marks post-onboarding work re-entered from the
  // completion card (ResumePendingStep). That run's original arrival at Ready
  // already emitted its completion and ended the session, so a resumed step
  // returning to Ready must not complete the flow a second time under a
  // freshly minted flow_id with no matching start.
  if (nextPhase === OnboardingPhase.Ready && !priorState.resuming) {
    emissions.push({
      event: OnboardingAnalyticsEvent.FlowCompleted,
      properties: {
        ...onboardingContextProperties({ host, phase: nextPhase, session }),
        [OnboardingAnalyticsProperty.StepsSkipped]: session.skippedSteps,
        // Omitted, never 0, when this client did not observe the flow start —
        // a duration measured from a lazily minted session would be invented.
        ...(session.startedAtMs === null
          ? {}
          : {
              [OnboardingAnalyticsProperty.DurationSeconds]: Math.round(
                (Date.now() - session.startedAtMs) / 1000
              ),
            }),
      },
    });
  }

  return emissions;
}

/**
 * `org_membership` from membership rather than the org phase left: since
 * ISS-11090 a first user already in the organization Clerk's signup made
 * leaves ChooseOrganization, and that organization is still theirs.
 */
function orgMembershipOutcomeProps({
  context,
}: StepOutcomeInput): SurfaceAnalyticsProperties {
  return {
    [OnboardingAnalyticsProperty.OrgMembership]:
      context.membership === OrganizationMembership.FirstUser
        ? OrgMembershipOutcome.Created
        : OrgMembershipOutcome.Joined,
  };
}
