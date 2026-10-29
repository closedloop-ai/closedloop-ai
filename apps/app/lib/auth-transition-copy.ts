/**
 * Copy for the two transitional routes in the desktop connect flow,
 * `/connect/github` and `/sso-callback`.
 *
 * Both hold the user while a round trip they cannot observe is outstanding, and
 * both reach {@link AUTH_TRANSITION_TIMEOUT_MS} knowing only that no answer has
 * arrived. ISS-10564: that is a STALL, never a refusal, so the sentences a
 * ceiling may reach are kept apart from the ones an observed failure may — same
 * split, and the same reasons, as the sibling `/connect/github/link` screen's
 * `link-failure-copy.ts` (ISS-10411).
 *
 * Shared rather than spelled twice because these two screens are one journey:
 * `/connect/github` hands off to the provider and `/sso-callback` takes the
 * return, so a sentence that drifts between them tells the user the hop moved
 * when only the wording did.
 */

/**
 * Which round trip the screen is waiting on. One per screen and fixed for the
 * life of a mount: the hand-off ends by navigating to the provider, and the
 * handshake is only reached on the fresh page load that comes back.
 */
export const AuthTransitionLeg = {
  /** `/connect/github`: `signIn.sso` opening the provider's authorize screen. */
  ProviderHandoff: "provider_handoff",
  /** `/sso-callback`: Clerk completing the handshake the provider sent back. */
  Handshake: "handshake",
} as const;
export type AuthTransitionLeg =
  (typeof AuthTransitionLeg)[keyof typeof AuthTransitionLeg];

/**
 * Shown while the leg is still outstanding past the ceiling. A message
 * escalation and nothing else — nothing here observed an outcome, so it names
 * the round trip that has gone quiet and keeps the waiting state.
 *
 * Exhaustive over {@link AuthTransitionLeg}: a leg added later fails `tsc` here
 * rather than falling back to a step it did not run.
 */
export const STILL_WAITING_DESCRIPTION: Record<
  AuthTransitionLeg,
  (providerLabel: string) => string
> = {
  [AuthTransitionLeg.ProviderHandoff]: (providerLabel) =>
    `This is taking longer than usual. We're still waiting for ${providerLabel} to open.`,
  [AuthTransitionLeg.Handshake]: (providerLabel) =>
    `This is taking longer than usual. You're back from ${providerLabel}, and we're still finishing sign-in.`,
};

/**
 * The leg's own deadline expired with the request still outstanding: the page
 * itself stopped waiting. Distinct from an observed refusal, and each sentence
 * opens by naming the half that survived — on this journey the desktop app is
 * still holding its loopback listener, so the user can finish from the sign-in
 * page rather than starting the desktop flow over.
 *
 * Exhaustive over {@link AuthTransitionLeg} for the same reason as above.
 */
export const REQUEST_UNANSWERED_DESCRIPTION: Record<
  AuthTransitionLeg,
  (providerLabel: string) => string
> = {
  [AuthTransitionLeg.ProviderHandoff]: (providerLabel) =>
    `We stopped waiting for ${providerLabel} to open. ${desktopStillWaitingSentence(providerLabel)}`,
  [AuthTransitionLeg.Handshake]: (providerLabel) =>
    `You're back from ${providerLabel}, but we stopped waiting for sign-in to finish. ${desktopStillWaitingSentence(providerLabel)}`,
};

/**
 * `/connect/github` reached the ceiling before anything was outstanding:
 * Clerk's client never loaded, so `signIn.sso` never ran. The one state on
 * either screen where the ceiling may legitimately end the wait, because the
 * step it reports on is this page's own start rather than a provider's answer.
 */
export const HANDOFF_NEVER_STARTED_DESCRIPTION = (
  providerLabel: string
): string =>
  `This page didn't finish loading. ${desktopStillWaitingSentence(providerLabel)}`;

/** `signIn.sso` answered with an error or rejected — an observed refusal. */
export const HANDOFF_REFUSED_DESCRIPTION = (providerLabel: string): string =>
  desktopStillWaitingSentence(providerLabel);

/**
 * The panel headings, canonical so a spec asserting one is ABSENT locates it
 * through the same value the component renders. A reworded heading then
 * reddens the assertion instead of matching nothing and passing silently
 * (root AGENTS.md, Test Practices).
 */
export function handoffWaitingTitle(providerLabel: string): string {
  return `Taking you to ${providerLabel}`;
}

export function handoffFailureTitle(providerLabel: string): string {
  return `We couldn't open ${providerLabel}`;
}

export const HANDSHAKE_WAITING_TITLE = "Finishing sign-in";

export const HANDSHAKE_FAILURE_TITLE = "We couldn't finish signing you in";

/**
 * The half that survives every failure on this journey: the desktop app opened
 * this URL and is still holding its loopback listener, so the recovery is to
 * sign in here rather than to restart the desktop flow. One spelling, because
 * both screens closed on the same sentence before ISS-10564 and a copy edit to
 * one of them would otherwise silently split the journey in two.
 */
function desktopStillWaitingSentence(providerLabel: string): string {
  return `Your desktop app is still waiting. Sign in and pick ${providerLabel} to finish connecting.`;
}
