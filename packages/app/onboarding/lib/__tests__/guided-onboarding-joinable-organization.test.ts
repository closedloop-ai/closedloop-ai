import { describe, expect, it } from "vitest";
import { OnboardingJoinAuthority } from "../../components/guided-onboarding-data";
import { resolveJoinableOrganization } from "../guided-onboarding-joinable-organization";

const MEMBERSHIP_JOIN = {
  authority: OnboardingJoinAuthority.Membership,
  id: "org_acme",
} as const;

function joinable(name: string | null | undefined) {
  return { join: MEMBERSHIP_JOIN, name };
}

describe("resolveJoinableOrganization", () => {
  it("names the active organization without waiting on the joinable lookup", () => {
    expect(
      resolveJoinableOrganization({
        activeOrganizationName: "Acme Research",
        lookupSettled: false,
      })
    ).toEqual({ name: "Acme Research", status: "available" });
  });

  it("withholds an answer while the joinable lookup has not reported", () => {
    expect(
      resolveJoinableOrganization({
        activeOrganizationName: null,
        joinableOrganizations: [],
        lookupSettled: false,
      })
    ).toEqual({ status: "unknown" });
  });

  // ISS-11158 CHANGED this expectation deliberately. ISS-11145 resolved a failed
  // lookup to `unknown` because no arm for it existed, and `unknown` renders a
  // `role="status"` skeleton announcing a check that has already finished and
  // will not retry itself. The arm now exists, so a reported failure says so.
  it("states a reported failure as unavailable, not as empty and not as pending", () => {
    expect(
      resolveJoinableOrganization({
        activeOrganizationName: "",
        joinableOrganizations: [],
        lookupFailed: true,
        lookupSettled: true,
      })
    ).toEqual({ status: "unavailable" });
  });

  // A lookup that has not reported AT ALL is still the pending arm. This is the
  // cold first read, not a retry — ISS-11158 review (tamsinb) moved the retry
  // off this branch, because falling back here unmounted the failure card and
  // with it the Retry the reader had just pressed.
  it("withholds an answer when a failure has not reported yet", () => {
    expect(
      resolveJoinableOrganization({
        activeOrganizationName: "",
        joinableOrganizations: [],
        lookupFailed: true,
        lookupSettled: false,
      })
    ).toEqual({ status: "unknown" });
  });

  // The retry itself: the failure arm SURVIVES it and says so, so the step can
  // keep the control mounted and render it busy instead of swapping the card.
  it("keeps the failed arm and marks it retrying while a re-read is in flight", () => {
    expect(
      resolveJoinableOrganization({
        activeOrganizationName: "",
        joinableOrganizations: [],
        lookupFailed: true,
        lookupRetrying: true,
        lookupSettled: true,
      })
    ).toEqual({ lookupRetrying: true, status: "unavailable" });
  });

  // Absent rather than `false` when nothing is in flight, so the flag never
  // appears on a settled failure and the step's busy branch cannot be reached
  // by a resolver that always sets it.
  it("leaves the retrying flag off on a settled failure", () => {
    const resolved = resolveJoinableOrganization({
      activeOrganizationName: "",
      joinableOrganizations: [],
      lookupFailed: true,
      lookupSettled: true,
    });

    expect("lookupRetrying" in resolved).toBe(false);
  });

  // The partial arm carries it too: its Retry re-reads the same pair, so it goes
  // busy on the same signal rather than staying pressable mid-flight.
  it("marks a partial failure retrying while its re-read is in flight", () => {
    expect(
      resolveJoinableOrganization({
        activeOrganizationName: "",
        joinableOrganizations: [joinable("Acme Research")],
        lookupFailed: true,
        lookupRetrying: true,
        lookupSettled: true,
      })
    ).toEqual({
      join: MEMBERSHIP_JOIN,
      lookupRetrying: true,
      name: "Acme Research",
      partialLookupFailure: true,
      status: "available",
    });
  });

  // review-soul, ISS-11158. `lookupFailed` is the OR of two INDEPENDENT reads and
  // the candidate list is the union of their rows, so "one authority failed, the
  // other handed us a real invitation" is reachable. Returning the failure arm
  // there would drop a Join the shell can honor and state that nothing could be
  // checked, which is false about the half that answered — and would leave the
  // reader creating a second organization they already have an invitation to.
  it("still offers a substantiated candidate when the other read failed", () => {
    expect(
      resolveJoinableOrganization({
        activeOrganizationName: "",
        joinableOrganizations: [joinable("Acme Research")],
        lookupFailed: true,
        lookupSettled: true,
      })
    ).toEqual({
      join: MEMBERSHIP_JOIN,
      name: "Acme Research",
      partialLookupFailure: true,
      status: "available",
    });
  });

  // The other half of that: winning is not erasing. Without the flag the step
  // renders an ordinary Join row and the reader cannot tell a complete answer
  // from a half-read one (review-soul, ISS-11158).
  it("leaves the flag off when both authorities answered", () => {
    const resolved = resolveJoinableOrganization({
      activeOrganizationName: "",
      joinableOrganizations: [joinable("Acme Research")],
      lookupSettled: true,
    });

    expect(resolved).toEqual({
      join: MEMBERSHIP_JOIN,
      name: "Acme Research",
      status: "available",
    });
    expect("partialLookupFailure" in resolved).toBe(false);
  });

  // A failed joinable lookup answers a question the ACTIVE organization already
  // answered, so it must not displace a name the shell holds.
  it("still names the active organization when the joinable lookup failed", () => {
    expect(
      resolveJoinableOrganization({
        activeOrganizationName: "Acme Research",
        lookupFailed: true,
        lookupSettled: true,
      })
    ).toEqual({ name: "Acme Research", status: "available" });
  });

  it("offers a substantiated membership or invitation once the lookup reports", () => {
    expect(
      resolveJoinableOrganization({
        activeOrganizationName: "",
        joinableOrganizations: [joinable("Acme Research")],
        lookupSettled: true,
      })
    ).toEqual({
      join: MEMBERSHIP_JOIN,
      name: "Acme Research",
      status: "available",
    });
  });

  it("settles on none when the lookup reported nothing joinable", () => {
    expect(
      resolveJoinableOrganization({
        activeOrganizationName: "",
        joinableOrganizations: [],
        lookupSettled: true,
      })
    ).toEqual({ status: "none" });
  });

  it("ignores blank names rather than offering a nameless organization", () => {
    expect(
      resolveJoinableOrganization({
        activeOrganizationName: "   ",
        joinableOrganizations: ["", "   ", null, undefined].map(joinable),
        lookupSettled: true,
      })
    ).toEqual({ status: "none" });
  });

  it("trims the name it reports and carries the host's join target", () => {
    expect(
      resolveJoinableOrganization({
        joinableOrganizations: [joinable("  Acme Research  ")],
        lookupSettled: true,
      })
    ).toEqual({
      join: MEMBERSHIP_JOIN,
      name: "Acme Research",
      status: "available",
    });
  });
});
