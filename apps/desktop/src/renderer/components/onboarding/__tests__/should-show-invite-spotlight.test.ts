/**
 * ISS-5489 (PLN-1694 M2): the invite spotlight's decision table.
 *
 * The half of the trigger that can be decided without a window, a bridge or a
 * flag snapshot. `invite-spotlight.test.tsx` owns the wiring the predicate
 * cannot see (which control it anchors to at each breakpoint, that "Maybe
 * later" is actually written to disk, that Invite opens the dialog).
 *
 * Every case is asked in the withholding direction. A nudge that fires at the
 * wrong moment is worse than one that waits: over the blocking consent takeover
 * it is a pop-up behind an inert overlay, at a guest it points at a dialog that
 * cannot mint an invitation, and at someone who already answered it is the app
 * asking a settled question again.
 */

import { describe, expect, it } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import type { SyncConsentRecord } from "../../../../shared/sync-consent";
import { shouldShowInviteSpotlight } from "../invite-spotlight";

const ORG_ID = "org_acme";
const OTHER_ORG_ID = "org_other";

const CONSENTED: SyncConsentRecord = {
  bound: true,
  organizationId: ORG_ID,
  tier: "metadata",
};

/** Every condition satisfied — the one input shape that must return true. */
function eligible(
  overrides: Partial<Parameters<typeof shouldShowInviteSpotlight>[0]> = {}
) {
  return {
    answeredThisRun: false,
    authStatus: DesktopAuthStatus.Authenticated,
    dismissal: { dismissed: false, organizationId: ORG_ID },
    flagEnabled: true,
    flagsResolved: true,
    organizationId: ORG_ID,
    record: CONSENTED,
    recordResolved: true,
    ...overrides,
  };
}

describe("shouldShowInviteSpotlight", () => {
  it("shows for an authenticated org member who has consented and not answered", () => {
    expect(shouldShowInviteSpotlight(eligible())).toBe(true);
  });

  it("withholds while the flag is off", () => {
    expect(shouldShowInviteSpotlight(eligible({ flagEnabled: false }))).toBe(
      false
    );
  });

  it("withholds while the flag snapshot is unresolved", () => {
    // ISS-5037: an unresolved snapshot reads every flag as its default, so a
    // `true` here is not yet an answer about what the user turned on.
    expect(shouldShowInviteSpotlight(eligible({ flagsResolved: false }))).toBe(
      false
    );
  });

  it("withholds on a signed-out device", () => {
    expect(
      shouldShowInviteSpotlight(
        eligible({ authStatus: DesktopAuthStatus.SignedOut })
      )
    ).toBe(false);
  });

  it("withholds while auth is still settling", () => {
    expect(
      shouldShowInviteSpotlight(
        eligible({ authStatus: DesktopAuthStatus.AwaitingRedirect })
      )
    ).toBe(false);
  });

  it("withholds when there is no org to invite anyone into", () => {
    expect(
      shouldShowInviteSpotlight(
        eligible({
          dismissal: { dismissed: false, organizationId: null },
          organizationId: null,
        })
      )
    ).toBe(false);
  });

  it("withholds until the consent record has been read", () => {
    expect(shouldShowInviteSpotlight(eligible({ recordResolved: false }))).toBe(
      false
    );
  });

  it("withholds when the consent record is unreadable", () => {
    expect(shouldShowInviteSpotlight(eligible({ record: null }))).toBe(false);
  });

  it("withholds while the consent takeover still owns the screen", () => {
    // An unanswered tier means the blocking takeover is up, and everything
    // behind it is inert — including a pop-up with two buttons.
    expect(
      shouldShowInviteSpotlight(
        eligible({
          record: { bound: false, organizationId: null, tier: null },
        })
      )
    ).toBe(false);
  });

  it("fires on the run the takeover was answered, before the record re-reads", () => {
    // The arrival run is the one this nudge is named after, and it is exactly
    // the run whose `record` is stale: `useSyncConsentRecord` holds per-call-site
    // state and re-reads only on a user change, so the takeover's `refresh()`
    // never reaches this consumer. Without the arrival signal the nudge waited
    // for a relaunch.
    expect(
      shouldShowInviteSpotlight(
        eligible({
          answeredThisRun: true,
          record: { bound: false, organizationId: null, tier: null },
        })
      )
    ).toBe(true);
  });

  it("does not let an arrival override an answer already given", () => {
    // `answeredThisRun` says the takeover is shut, not that the nudge is
    // unanswered. A user who already said Maybe later stays unasked.
    expect(
      shouldShowInviteSpotlight(
        eligible({
          answeredThisRun: true,
          dismissal: { dismissed: true, organizationId: ORG_ID },
        })
      )
    ).toBe(false);
  });

  it("withholds when consent was recorded for a DIFFERENT org", () => {
    expect(
      shouldShowInviteSpotlight(
        eligible({
          record: { bound: true, organizationId: OTHER_ORG_ID, tier: "full" },
        })
      )
    ).toBe(false);
  });

  it("withholds once the nudge has been answered for this org", () => {
    expect(
      shouldShowInviteSpotlight(
        eligible({ dismissal: { dismissed: true, organizationId: ORG_ID } })
      )
    ).toBe(false);
  });

  it("withholds until the dismissal has been read for THIS org", () => {
    // The read is per-org and lands one tick after mount. Treating "not read
    // yet" as "not dismissed" would flash the pop-up for one frame at every
    // user who already said Maybe later.
    expect(
      shouldShowInviteSpotlight(
        eligible({ dismissal: { dismissed: false, organizationId: null } })
      )
    ).toBe(false);
  });

  it("does not carry another org's answer into this one", () => {
    // A "Maybe later" given for the previous org is not an answer for the org
    // signed in now — it is a different team to invite.
    expect(
      shouldShowInviteSpotlight(
        eligible({
          dismissal: { dismissed: true, organizationId: OTHER_ORG_ID },
        })
      )
    ).toBe(false);
  });
});
