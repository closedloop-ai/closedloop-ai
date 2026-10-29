import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { DEV_MODE_STORAGE_KEY } from "../dev-mode-contract";
import {
  DevModeEligibility,
  DevModeProvider,
  useDevMode,
} from "../dev-mode-provider";

afterEach(() => {
  cleanup();
  localStorage.removeItem(DEV_MODE_STORAGE_KEY);
});

/** The verdicts identity actually settles on; `Unknown` is the window between. */
const SETTLED_ELIGIBILITIES = [
  DevModeEligibility.Eligible,
  DevModeEligibility.Ineligible,
] as const;

describe("DevModeProvider (ISS-7477)", () => {
  it("starts an eligible viewer in dev mode, so nothing changes until they choose", () => {
    const { result } = renderDevMode(DevModeEligibility.Eligible);

    expect(result.current.isDevModeAvailable).toBe(true);
    expect(result.current.isDevModeEnabled).toBe(true);
  });

  it("persists an eligible viewer's choice to leave dev mode", () => {
    const { result } = renderDevMode(DevModeEligibility.Eligible);

    act(() => {
      result.current.setDevModeEnabled(false);
    });

    expect(result.current.isDevModeEnabled).toBe(false);
    expect(localStorage.getItem(DEV_MODE_STORAGE_KEY)).toBe("false");
  });

  it("restores a persisted choice on a fresh mount", () => {
    localStorage.setItem(DEV_MODE_STORAGE_KEY, "false");

    const { result } = renderDevMode(DevModeEligibility.Eligible);

    expect(result.current.isDevModeEnabled).toBe(false);
  });

  it("pins a viewer KNOWN to be ineligible to dev mode, key or no key", () => {
    localStorage.setItem(DEV_MODE_STORAGE_KEY, "false");

    const { result } = renderDevMode(DevModeEligibility.Ineligible);

    // Same stored value as the test above, opposite verdict — eligibility is
    // doing the work, not the absence of a stored choice.
    expect(result.current.isDevModeEnabled).toBe(true);
    expect(result.current.isDevModeAvailable).toBe(false);
  });

  it("honours a stored choice while eligibility is still UNKNOWN", () => {
    localStorage.setItem(DEV_MODE_STORAGE_KEY, "false");

    const { result } = renderDevMode(DevModeEligibility.Unknown);

    // Unknown must not behave like Ineligible: the previous case pins to `true`
    // on the same stored value, and folding the two together is what would show
    // the internal view to a viewer who chose the customer one.
    expect(result.current.isDevModeEnabled).toBe(false);
    // Still not eligible to OPERATE it, so the control stays hidden meanwhile.
    expect(result.current.isDevModeAvailable).toBe(false);
  });

  it("releases a stored customer-view choice once the rollout is rolled BACK", () => {
    localStorage.setItem(DEV_MODE_STORAGE_KEY, "false");

    const { result } = renderDevMode(DevModeEligibility.Eligible, {
      isRolledOut: false,
    });

    // The trap this closes: the rollout gate hides the control, so honouring the
    // stored `false` here would suppress every non-exempt flag with no rendered
    // way back. Same eligibility and same stored value as "restores a persisted
    // choice on a fresh mount", which reads `false` — the rollout verdict is
    // doing the work.
    expect(result.current.isDevModeEnabled).toBe(true);
    expect(result.current.isDevModeAvailable).toBe(false);
  });

  it("never suppresses while the control is unavailable, across every SETTLED input", () => {
    localStorage.setItem(DEV_MODE_STORAGE_KEY, "false");

    // The invariant behind the two gates, stated once over the settled input
    // space: suppression (`isDevModeEnabled === false`) may never coincide with
    // a control the viewer cannot reach to undo it. A future third input that
    // hides the row without releasing the choice fails here.
    //
    // `Unknown` is deliberately excluded rather than overlooked: it suppresses
    // with the row hidden ON PURPOSE (see the test above), and it is not a trap
    // because it always settles into one of the two below — which is precisely
    // what this asserts about them.
    for (const eligibility of SETTLED_ELIGIBILITIES) {
      for (const isRolledOut of [true, false]) {
        const { result, unmount } = renderDevMode(eligibility, { isRolledOut });
        const { isDevModeAvailable, isDevModeEnabled } = result.current;

        expect({
          eligibility,
          isRolledOut,
          trapped: !(isDevModeAvailable || isDevModeEnabled),
        }).toEqual({ eligibility, isRolledOut, trapped: false });
        unmount();
      }
    }
  });

  it("ignores a set attempt while the rollout is off", () => {
    const { result } = renderDevMode(DevModeEligibility.Eligible, {
      isRolledOut: false,
    });

    act(() => {
      result.current.setDevModeEnabled(false);
    });

    // Nothing may write a choice the viewer has no rendered control to reverse.
    expect(localStorage.getItem(DEV_MODE_STORAGE_KEY)).toBeNull();
    expect(result.current.isDevModeEnabled).toBe(true);
  });

  it("ignores a set attempt from a viewer who is not eligible", () => {
    const { result } = renderDevMode(DevModeEligibility.Ineligible);

    act(() => {
      result.current.setDevModeEnabled(false);
    });

    expect(result.current.isDevModeEnabled).toBe(true);
    expect(localStorage.getItem(DEV_MODE_STORAGE_KEY)).toBeNull();
  });

  it("ignores a set attempt while eligibility is UNKNOWN", () => {
    const { result } = renderDevMode(DevModeEligibility.Unknown);

    act(() => {
      result.current.setDevModeEnabled(false);
    });

    expect(localStorage.getItem(DEV_MODE_STORAGE_KEY)).toBeNull();
  });

  it("reports dev mode on, and ineligible, with no provider at all", () => {
    localStorage.setItem(DEV_MODE_STORAGE_KEY, "false");

    const { result } = renderHook(() => useDevMode());

    expect(result.current).toMatchObject({
      isDevModeAvailable: false,
      isDevModeEnabled: true,
    });
  });

  it("keeps the context value stable across a re-render that changes nothing", () => {
    const { result, rerender } = renderDevMode(DevModeEligibility.Eligible);
    const first = result.current;

    rerender();

    // A fresh object each render would re-render every consumer of the context
    // on any unrelated parent update.
    expect(result.current).toBe(first);
  });
});

function renderDevMode(
  eligibility: DevModeEligibility,
  { isRolledOut = true }: { isRolledOut?: boolean } = {}
) {
  return renderHook(() => useDevMode(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <DevModeProvider eligibility={eligibility} isRolledOut={isRolledOut}>
        {children}
      </DevModeProvider>
    ),
  });
}

/**
 * ISS-8533. The highest-stakes coercion in that change: the fallback here is `true`,
 * so a validator written as `value === true ? true : fallback` would turn a stored
 * `false` back into `true` — silently returning a viewer who chose the customer view
 * to the internal one, with the switch that turns it back off hidden behind the
 * rollout gate.
 */
describe("DevModeProvider malformed persisted preference (ISS-8533)", () => {
  it("PIN: a stored false is still honoured", () => {
    localStorage.setItem(DEV_MODE_STORAGE_KEY, "false");

    const { result } = renderDevMode(DevModeEligibility.Eligible);

    expect(result.current.isDevModeEnabled).toBe(false);
  });

  it("coerces a non-boolean to the default rather than reading it as truthy", () => {
    localStorage.setItem(DEV_MODE_STORAGE_KEY, "0");

    const { result } = renderDevMode(DevModeEligibility.Eligible);

    expect(result.current.isDevModeEnabled).toBe(true);
  });
});
