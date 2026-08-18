import { GuestSignupIntent } from "./guest-signup-provider";

export type OfferCopy = {
  eyebrow?: string;
  title: string;
  body: string;
};

// Declared above the map that reads them: a `const` referenced before its own
// declaration is a load-time TDZ error, not a hoisted undefined.
const GUEST_OFFER_TITLE = "Create your account";
const GUEST_OFFER_BODY =
  "Sign up to see how your team uses AI and invite collaborators. Your agent session logs stay on this Mac.";

/**
 * The guest account ask, answering the question the person actually asked.
 *
 * ONE definition per intent, read by every surface that makes that ask. The
 * organization strings in particular render in two places that never appear
 * together — the in-place gate on the dashboard and (for exhaustiveness) the
 * offer dialog — so a duplicated literal here would drift for a long time
 * before anyone saw both copies at once.
 *
 * The intent is already threaded through sign-up so the RESUME lands right;
 * spending it on the copy too is what stops someone who pressed "Invite your
 * team" being met with a generic account pitch that never mentions a team.
 *
 * Not four different pitches, though. `Header` and `Tour` deliberately share a
 * title: both are UNCONTEXTUAL asks — a standing offer and the end of the tour
 * — so there is no specific question to answer, and inventing two wordings for
 * one situation is the drift this map exists to prevent. They differ only by
 * the eyebrow, which is the part with something extra to say.
 *
 * The titles also stay clear of `DesktopOnboardingFlow`'s own heading ("Create
 * your Closedloop account"), which is the very next screen. The prototype's
 * header variant used that exact string; shipping it would have shown a guest
 * the same title twice in a row and left the dialog's accessible name unable to
 * distinguish the two steps.
 */
export const GUEST_OFFER_COPY: Record<GuestSignupIntent, OfferCopy> = {
  [GuestSignupIntent.Header]: {
    eyebrow: "Welcome to Closedloop",
    title: GUEST_OFFER_TITLE,
    body: GUEST_OFFER_BODY,
  },
  [GuestSignupIntent.Tour]: {
    title: GUEST_OFFER_TITLE,
    body: GUEST_OFFER_BODY,
  },
  [GuestSignupIntent.Invite]: {
    eyebrow: "Bring your team",
    title: "Invite your team",
    body: "Sign up to create your organization and invite teammates. They will see shared insights the moment they join.",
  },
  // No eyebrow: its only renderer is the in-place dashboard gate, and the scope
  // toggle directly above it already says "Organization". `skipsOffer` sends
  // this intent straight into the flow, so the offer dialog never shows it.
  [GuestSignupIntent.Organization]: {
    title: "Organization scope needs an account",
    body: "Sign up to switch from just you to your whole organization and see how everyone's agents are performing.",
  },
};
