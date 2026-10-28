import {
  type OnboardingInviteOutcome,
  OnboardingInviteStatus,
  type OnboardingSessionDiscovery,
} from "../components/guided-onboarding-data";
import type { OnboardingTransitionAnalyticsOutcome } from "./onboarding-funnel-analytics";

/**
 * `invites_sent_count` for the SendInvitations completion (PRD-736): the
 * server-confirmed invited tally. Counts only, never addresses. A 0 is only
 * ever the MEASURED zero of an already-member batch; a failed or unconfirmed
 * batch has no reportable count, so `undefined` omits the property rather
 * than reporting an unknown tally as a confident 0.
 */
export function countInvitesSent(
  outcome: OnboardingInviteOutcome
): number | undefined {
  if (
    outcome.status === OnboardingInviteStatus.Sent ||
    outcome.status === OnboardingInviteStatus.Partial
  ) {
    return outcome.invited;
  }
  if (outcome.status === OnboardingInviteStatus.AlreadyMember) {
    return 0;
  }
  return undefined;
}

/**
 * `session_discovery` completion outcome (ISS-10502): what the local scan
 * MEASURED, from the same `discovery` value the step renders. An unmeasured
 * scan reports nothing — each property is omitted, never zeroed, because a
 * count nobody took is not a measured 0. The harness pair is gated the same
 * way as `sessionsFoundCount`: the measured arm is reachable with only bytes
 * or an estimate reported, and since ISS-11591 a source reaches the list only
 * on positive evidence, so the pair is emitted whenever the list has any row at
 * all — an empty list means nobody enumerated, not zero harnesses. A list whose
 * rows are all `not-detected` really is a measured zero (evidence of absence is
 * the only thing that produces that status).
 */
export function discoveryAnalyticsOutcome(
  discovery: OnboardingSessionDiscovery
): OnboardingTransitionAnalyticsOutcome {
  if (discovery.status !== "measured") {
    return {};
  }
  const enumerated = discovery.sources.length > 0;
  // The stable harness ids, never `label` — that is title-cased display text,
  // so an unknown local id would smuggle arbitrary prose into the closed
  // `harnesses_detected` vocabulary (whitlockk on #7748).
  const harnessesDetected = discovery.sources
    .filter((source) => source.detection.status === "detected")
    .map((source) => source.harness);
  return {
    ...(discovery.sessionsFound === null
      ? {}
      : { sessionsFoundCount: discovery.sessionsFound }),
    ...(enumerated
      ? {
          harnessesDetected,
          harnessesDetectedCount: harnessesDetected.length,
        }
      : {}),
  };
}
