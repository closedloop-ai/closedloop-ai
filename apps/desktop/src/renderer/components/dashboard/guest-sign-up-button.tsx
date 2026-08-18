import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  GuestSignupIntent,
  useGuestSignup,
} from "../onboarding/guest-signup-provider";
import {
  canOfferAccount,
  useGuestOnboarding,
} from "../onboarding/use-guest-onboarding";

/**
 * ISS-5112 (PLN-1600 Step D) — the standing sign-up offer.
 *
 * The other three asks are contextual: they fire where an account unlocks a
 * specific thing (organization scope, inviting a teammate, the end of the tour).
 * This one is for someone who has decided on their own.
 *
 * It lives on the DASHBOARD TITLE ROW, beside Tour and the range and scope
 * controls, not in the Topbar. The Topbar is window chrome — the sidebar
 * trigger and the breadcrumb — and a filled primary button there follows the
 * user onto Sessions, Branches, Agents and Settings, where it is the loudest
 * element on screens an account changes nothing about. The dashboard is the one
 * screen whose content an account actually changes, so the offer belongs with
 * that screen's own working controls (both onboarding prototypes place it
 * there, and `desktop-onboarding-landing/components/app-header.tsx` says so in
 * as many words).
 *
 * Renders nothing outside guest mode, so a signed-in user never sees it.
 */
export function GuestSignUpButton() {
  const guest = useGuestOnboarding();
  const { requestSignup } = useGuestSignup();
  if (!canOfferAccount(guest)) {
    return null;
  }
  return (
    <Button
      onClick={() => requestSignup(GuestSignupIntent.Header)}
      size="sm"
      type="button"
    >
      Create account
    </Button>
  );
}
