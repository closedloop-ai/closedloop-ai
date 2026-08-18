/**
 * ISS-5112 (PLN-1600 Step D): the half of the organization gate that only runs
 * AFTER a browser round-trip — landing someone who signed up FROM the gate on
 * the scope they asked for.
 *
 * This is the whole argument for carrying an intent rather than a "did they
 * sign up" boolean, and it was the one part of the machine with no test: delete
 * the `setScope` in the resume effect and every other suite here stays green
 * while a guest who signed up for organization insights lands back on personal
 * scope having been asked for nothing.
 *
 * `useGuestSignup` is stubbed rather than driven through a real sign-up, and
 * that is a deliberate seam, not a shortcut: `resuming` is only ever produced by
 * the reducer's `signed-up` action, which `guest-signup-provider.test.ts`
 * already pins (it returns the pending intent), and the only way to reach it for
 * real is to complete an OAuth round-trip plus both setup steps. What is left
 * untested by that seam is one line — `AccountDialog` calling `onSignedUp`
 * before its close — which its own suite covers.
 */
import { InsightsScope } from "@closedloop-ai/loops-api/insights";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GuestSignupIntent } from "../../onboarding/guest-signup-provider";
import { useOrgScopeGate } from "../use-org-scope-gate";

const clearResume = vi.fn();
const requestSignup = vi.fn();
let resuming: GuestSignupIntent | null = null;

vi.mock("../../onboarding/guest-signup-provider", async () => ({
  ...(await vi.importActual<
    typeof import("../../onboarding/guest-signup-provider")
  >("../../onboarding/guest-signup-provider")),
  useGuestSignup: () => ({ requestSignup, resuming, clearResume }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  resuming = null;
});

function renderGate(setScope: (value: string) => void) {
  const seen: { orgGated: boolean; dismiss: () => void } = {
    orgGated: false,
    dismiss: () => undefined,
  };
  function Probe() {
    const gate = useOrgScopeGate(true, setScope);
    seen.orgGated = gate.orgGated;
    seen.dismiss = gate.dismissOrgGate;
    return <span>{gate.orgGated ? "gated" : "open"}</span>;
  }
  const result = render(<Probe />);
  return { ...result, seen };
}

describe("useOrgScopeGate resume (ISS-5112)", () => {
  it("lands a guest who signed up from the gate on organization scope", () => {
    const setScope = vi.fn();
    resuming = GuestSignupIntent.Organization;

    const { seen } = renderGate(setScope);

    expect(setScope).toHaveBeenCalledWith(InsightsScope.Org);
    // ...and the gate is gone, so they see the view rather than the ask for it.
    expect(seen.orgGated).toBe(false);
    // The marker is consumed, so a later re-render cannot resume the same job
    // twice and yank someone back to organization after they left it.
    expect(clearResume).toHaveBeenCalledTimes(1);
  });

  it("leaves another surface's resume alone", () => {
    const setScope = vi.fn();
    // The tour's sign-up resumes the TOUR's job, not this one. A resume marker
    // is not a broadcast: reacting to any intent would drag someone who signed
    // up from the header onto organization scope they never asked for.
    resuming = GuestSignupIntent.Tour;

    renderGate(setScope);

    expect(setScope).not.toHaveBeenCalled();
    expect(clearResume).not.toHaveBeenCalled();
  });

  it("does nothing when there is no resume pending", () => {
    const setScope = vi.fn();

    renderGate(setScope);

    expect(setScope).not.toHaveBeenCalled();
    expect(clearResume).not.toHaveBeenCalled();
  });

  it("returns to personal scope when the guest backs out of the gate", () => {
    const setScope = vi.fn();
    const { seen } = renderGate(setScope);

    act(() => seen.dismiss());

    expect(setScope).toHaveBeenCalledWith(InsightsScope.Me);
    expect(seen.orgGated).toBe(false);
  });
});
