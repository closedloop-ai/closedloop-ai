import { InsightsScope } from "@closedloop-ai/loops-api/insights";
import { useCallback, useEffect, useState } from "react";
import {
  GuestSignupIntent,
  useGuestSignup,
} from "../onboarding/guest-signup-provider";

export type OrgScopeGate = {
  /** Whether the guest is looking at the gated Organization view. */
  orgGated: boolean;
  /** Drop-in replacement for the scope toggle's `onValueChange`. */
  handleScopeChange: (value: string) => void;
  /** Back out of the gate and return to personal scope. */
  dismissOrgGate: () => void;
  /** Ask for the account the gate exists to ask for. */
  requestOrgAccount: () => void;
};

/**
 * ISS-5112 (PLN-1600 Step D) — Organization scope for a guest.
 *
 * Organization is the one thing on the dashboard an account actually buys, so
 * selecting it asks rather than silently resolving to personal scope. Extracted
 * from `FirstLaunchDashboard` rather than inlined: that component is already at
 * the cognitive-complexity ceiling, and this is a self-contained interaction
 * with its own state, its own resume effect, and its own three handlers.
 */
export function useOrgScopeGate(
  guestCanConvert: boolean,
  setScope: (value: string) => void
): OrgScopeGate {
  const { requestSignup, resuming, clearResume } = useGuestSignup();
  const [orgGated, setOrgGated] = useState(false);

  // Resume the job the ask interrupted: someone who signed up FROM this gate
  // wanted organization scope, so land them on it rather than dropping them back
  // on personal having forgotten why they signed up.
  useEffect(() => {
    if (resuming !== GuestSignupIntent.Organization) {
      return;
    }
    setOrgGated(false);
    setScope(InsightsScope.Org);
    clearResume();
  }, [resuming, clearResume, setScope]);

  const handleScopeChange = useCallback(
    (value: string) => {
      // Raise the gate and STOP. Firing the ask here too put two asks on screen
      // at once — this card, and the account dialog stacked over it — for one
      // request, with the card's own button dead behind the thing covering it.
      // The card IS the ask; its button is what opens the flow.
      if (value === InsightsScope.Org && guestCanConvert) {
        setOrgGated(true);
        return;
      }
      // Leaving Organization by the toggle has to lift the gate too. The header
      // stays live while the gate is up, so "Me" is a real second exit next to
      // the card's own button — and the toggle renders `gated ? Org : scope`, so
      // clearing only `scope` would leave it displaying Organization over a
      // personal-scope state, with the gate still covering the page.
      setOrgGated(false);
      setScope(value);
    },
    [guestCanConvert, setScope]
  );

  const dismissOrgGate = useCallback(() => {
    setOrgGated(false);
    setScope(InsightsScope.Me);
  }, [setScope]);

  const requestOrgAccount = useCallback(
    () => requestSignup(GuestSignupIntent.Organization),
    [requestSignup]
  );

  return { orgGated, handleScopeChange, dismissOrgGate, requestOrgAccount };
}
