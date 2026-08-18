/**
 * ISS-5489 (PLN-1694 M1) — the decision table for the post-auth consent takeover.
 *
 * This is the half of the trigger that can be decided without a window, a bridge
 * or a flag snapshot. `sync-consent-takeover-gate.test.tsx` owns the wiring the
 * predicate cannot see (that the record is actually read, that Save persists and
 * routes, that there is no way out).
 *
 * Every case here is asked in the direction that matters: this predicate mounts a
 * modal the user CANNOT dismiss, so a false positive is not a cosmetic bug — it
 * is an app the user cannot get into.
 */

import { describe, expect, it } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import type { SyncConsentRecord } from "../../../../shared/sync-consent";
import { shouldShowSyncConsentTakeover } from "../sync-consent-takeover-gate";

const USER = "user_current";
const ORG = "org_current";
const OTHER_ORG = "org_previous";

/** Never answered on this device — the population the takeover exists for. */
const UNANSWERED: SyncConsentRecord = {
  tier: null,
  organizationId: null,
  bound: false,
};

/** Answered, and bound to the org that is signed in now. */
const ANSWERED_HERE: SyncConsentRecord = {
  tier: "metadata",
  organizationId: ORG,
  bound: true,
};

function args(
  overrides: Partial<Parameters<typeof shouldShowSyncConsentTakeover>[0]> = {}
) {
  return {
    answeredFor: null,
    authStatus: DesktopAuthStatus.Authenticated,
    flagEnabled: true,
    flagsResolved: true,
    organizationId: ORG,
    record: UNANSWERED,
    recordResolved: true,
    userId: USER,
    ...overrides,
  };
}

describe("shouldShowSyncConsentTakeover", () => {
  it("shows for an authenticated device that has never answered", () => {
    expect(shouldShowSyncConsentTakeover(args())).toBe(true);
  });

  it("stays closed once the device has answered for this org", () => {
    expect(shouldShowSyncConsentTakeover(args({ record: ANSWERED_HERE }))).toBe(
      false
    );
  });

  it("re-asks when the recorded answer belongs to a different org", () => {
    expect(
      shouldShowSyncConsentTakeover(
        args({
          record: { tier: "full", organizationId: OTHER_ORG, bound: true },
        })
      )
    ).toBe(true);
  });

  it("honors a pre-ISS-5489 answer that has no org recorded", () => {
    // An install that consented before the org binding existed has a real tier
    // and a null org. Re-prompting it would ask a settled question again.
    expect(
      shouldShowSyncConsentTakeover(
        args({ record: { tier: "full", organizationId: null, bound: false } })
      )
    ).toBe(false);
  });

  it("treats an explicit Off answer as answered, not as never-asked", () => {
    // Off persists the `local` tier, which is what keeps "I chose not to sync"
    // distinguishable from "nobody ever asked me".
    expect(
      shouldShowSyncConsentTakeover(
        args({ record: { tier: "local", organizationId: ORG, bound: true } })
      )
    ).toBe(false);
  });

  it("re-asks an org after consent was recorded with no org bound to it", () => {
    // A user who consented on a personal account records `organizationId: null`
    // ON PURPOSE (bound). That must not read as the pre-ISS-5489 legacy record,
    // which would honor itself for every org forever.
    expect(
      shouldShowSyncConsentTakeover(
        args({ record: { tier: "full", organizationId: null, bound: true } })
      )
    ).toBe(true);
  });

  it("stays closed for the personal account that actually answered", () => {
    expect(
      shouldShowSyncConsentTakeover(
        args({
          organizationId: null,
          record: { tier: "full", organizationId: null, bound: true },
        })
      )
    ).toBe(false);
  });

  it("never shows on a signed-out device", () => {
    expect(
      shouldShowSyncConsentTakeover(
        args({ authStatus: DesktopAuthStatus.SignedOut })
      )
    ).toBe(false);
  });

  it("withholds while auth is still settling", () => {
    // A sign-in in flight is not a returning user yet; interrupting it with a
    // blocking modal would cut across a flow already under way.
    for (const status of [
      DesktopAuthStatus.Loading,
      DesktopAuthStatus.OpeningBrowser,
      DesktopAuthStatus.AwaitingRedirect,
      DesktopAuthStatus.Exchanging,
      DesktopAuthStatus.RefreshFailed,
    ]) {
      expect(shouldShowSyncConsentTakeover(args({ authStatus: status }))).toBe(
        false
      );
    }
  });

  it("withholds until the consent record has been read", () => {
    // Otherwise every launch flashes the takeover over the app during the IPC
    // round trip, including for users who answered months ago.
    expect(
      shouldShowSyncConsentTakeover(
        args({ record: null, recordResolved: false })
      )
    ).toBe(false);
  });

  it("withholds when the record is settled but unreadable", () => {
    // No bridge or a failed read. Showing the takeover here would block the app
    // behind a modal whose Save writes through the same broken bridge.
    expect(
      shouldShowSyncConsentTakeover(
        args({ record: null, recordResolved: true })
      )
    ).toBe(false);
  });

  it("stays closed for the rest of the session once THIS identity answered", () => {
    expect(
      shouldShowSyncConsentTakeover(
        args({ answeredFor: { userId: USER, organizationId: ORG } })
      )
    ).toBe(false);
  });

  it("re-asks after a sign-out and sign-in as a different user", () => {
    // The gate stays mounted across sign-out (Settings -> Account can sign out
    // and back in in-session), so a bare "already answered" flag would carry
    // user A's answer into user B's session and skip the question entirely.
    expect(
      shouldShowSyncConsentTakeover(
        args({ answeredFor: { userId: "user_previous", organizationId: ORG } })
      )
    ).toBe(true);
  });

  it("re-asks when the same user switches org in-session", () => {
    expect(
      shouldShowSyncConsentTakeover(
        args({ answeredFor: { userId: USER, organizationId: OTHER_ORG } })
      )
    ).toBe(true);
  });

  it("is inert with the guest-onboarding flag off", () => {
    expect(shouldShowSyncConsentTakeover(args({ flagEnabled: false }))).toBe(
      false
    );
  });

  it("counts an unresolved flag snapshot as off", () => {
    // ISS-5037: an unresolved snapshot reads every flag as its registry default,
    // which for a default-off flag is indistinguishable from "turned off".
    expect(
      shouldShowSyncConsentTakeover(
        args({ flagEnabled: true, flagsResolved: false })
      )
    ).toBe(false);
  });
});
