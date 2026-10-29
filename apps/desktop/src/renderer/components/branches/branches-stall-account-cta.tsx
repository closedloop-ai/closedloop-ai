import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { useRequestGuestAccount } from "../onboarding/use-request-guest-account";

/**
 * ISS-10645 — the account ask a stalled Branches load offers beside Retry.
 *
 * The operator's reason is that this listing may hold nothing at all until a
 * connection exists, so a Retry alone names a fix that need not be one: a guest
 * can press it forever and the list will still be empty.
 *
 * It goes through the same {@link useRequestGuestAccount} every guest entry
 * point does, so it reopens the guided onboarding at its Account step
 * (ISS-11480) and is withheld by the same gate, so a signed-in user is never
 * told to create an account they already have.
 */
export function BranchesStallAccountCta() {
  const requestAccount = useRequestGuestAccount();
  if (!requestAccount) {
    return null;
  }
  return (
    <Button
      onClick={requestAccount}
      size="sm"
      type="button"
      // Matches the connect arm's weight (GatedMetricIndicator hardcodes
      // outline) so one reader is not shown a filled ask where the other gets
      // an outline one for the same job.
      variant="outline"
    >
      {BRANCHES_STALL_ACCOUNT_CTA_LABEL}
    </Button>
  );
}

// Owned here rather than read from WORKSPACE_MENU_ENTRY_LABEL: ISS-10249 does
// not list this CTA, so whether it shares the account menu's wording is an
// open product question (PR #8093 review).
export const BRANCHES_STALL_ACCOUNT_CTA_LABEL = "Create account";
