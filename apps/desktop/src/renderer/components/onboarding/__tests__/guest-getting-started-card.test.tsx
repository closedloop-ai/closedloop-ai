/**
 * ISS-10942 — the Getting started module a signed-out guest gets, and the offer
 * it carries.
 *
 * The header's `Create account` button was this guest's standing account offer
 * and it is gone. What proves the offer MOVED rather than being deleted is here:
 * the module renders for a guest, its action is the `CreateAccount` step's own
 * label, and pressing it resumes the guest run at the Account step (ISS-11480).
 */

import {
  DesktopSignInFraming,
  DesktopSignInMethod,
} from "@repo/api/src/types/desktop-authorize-url";
import { PendingOnboardingStep } from "@repo/api/src/types/onboarding-phase";
import {
  WORKSPACE_MENU_ENTRY_LABEL,
  WorkspaceMenuEntryId,
} from "@repo/api/src/types/workspace-menu";
import {
  GETTING_STARTED_CARD_LABEL,
  GETTING_STARTED_STEP_CONTENT,
} from "@repo/app/onboarding/components/getting-started-card-shell";
import { createWrapper } from "@repo/app/shared/test-utils";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { GuestGettingStartedCard } from "../guest-getting-started-card";
import {
  publishRecordingGuestRun,
  RESUME_CREATE_ACCOUNT,
  type RecordingGuestRun,
} from "./published-guest-run-fixture";

let authStatus: DesktopAuthStatus = DesktopAuthStatus.SignedOut;
let guestRun: RecordingGuestRun | null = null;
const beginSignIn = vi.fn(async () => ({ ok: true }));

vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({ state: { status: authStatus }, beginSignIn }),
}));

vi.mock("../use-guest-onboarding", async () => {
  const actual = await vi.importActual<
    typeof import("../use-guest-onboarding")
  >("../use-guest-onboarding");
  return { ...actual, useGuestOnboarding: () => ({ authStatus }) };
});

/** The label the card renders for the pending step, from the canonical map. */
/**
 * Desktop's whole checklist. Four, not three, since ISS-11249: the sync choice
 * used to be dropped here because a signed-out device has no Connected Devices
 * Settings target, and the step is now answered inside the onboarding modal, so
 * no external route has to exist for it to belong in the count. That is also why
 * the guest's denominator no longer jumps from 3 to 4 at sign-in.
 *
 * Written out rather than derived from the component's own context: a
 * denominator computed from the thing under test agrees with the thing under
 * test.
 */
const GUEST_APPLICABLE_STEP_COUNT = 4;

const CREATE_ACCOUNT_LABEL =
  GETTING_STARTED_STEP_CONTENT[PendingOnboardingStep.CreateAccount].label;

describe("GuestGettingStartedCard", () => {
  beforeEach(() => {
    beginSignIn.mockClear();
    authStatus = DesktopAuthStatus.SignedOut;
    guestRun = publishRecordingGuestRun();
  });

  afterEach(() => {
    guestRun?.withdraw();
    guestRun = null;
  });

  it("renders the Getting started module for a signed-out guest", () => {
    render(<GuestGettingStartedCard />, { wrapper: createWrapper() });

    expect(
      screen.getByRole("region", { name: GETTING_STARTED_CARD_LABEL })
    ).not.toBeNull();
  });

  it("offers the create-account step as the module's own action", () => {
    render(<GuestGettingStartedCard />, { wrapper: createWrapper() });

    const action = screen.getByRole("button", { name: CREATE_ACCOUNT_LABEL });
    expect(action.textContent).toContain(CREATE_ACCOUNT_LABEL);
  });

  it("resumes the published guest run at the Account step", () => {
    render(<GuestGettingStartedCard />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByRole("button", { name: CREATE_ACCOUNT_LABEL }));

    expect(guestRun?.posted).toHaveLength(1);
    expect(guestRun?.posted[0]?.[0]).toBe(guestRun?.snapshot);
    expect(guestRun?.posted[0]?.[1]).toEqual(RESUME_CREATE_ACCOUNT);
  });

  it("renders nothing while no guest run is published", () => {
    guestRun?.withdraw();
    const { container } = render(<GuestGettingStartedCard />, {
      wrapper: createWrapper(),
    });

    expect(container.textContent).toBe("");
  });

  it("signs in directly without entering account creation", async () => {
    render(<GuestGettingStartedCard />, { wrapper: createWrapper() });

    fireEvent.click(
      screen.getByRole("button", {
        name: WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.SignIn],
      })
    );

    await waitFor(() =>
      expect(beginSignIn).toHaveBeenCalledWith(
        DesktopSignInMethod.Email,
        undefined,
        DesktopSignInFraming.SignIn
      )
    );
    expect(guestRun?.posted).toHaveLength(0);
  });

  it("renders nothing once the device is no longer a settled guest", () => {
    authStatus = DesktopAuthStatus.Authenticated;
    const { container } = render(<GuestGettingStartedCard />, {
      wrapper: createWrapper(),
    });

    expect(container.textContent).toBe("");
  });

  it("counts the guest's outstanding steps rather than claiming progress", () => {
    render(<GuestGettingStartedCard />, { wrapper: createWrapper() });

    const region = screen.getByRole("region", {
      name: GETTING_STARTED_CARD_LABEL,
    });
    // BOTH halves. The numerator is the easy one; the DENOMINATOR is what the
    // guest context and the actionability narrowing actually decide, so a change
    // that drops a step from the guest's applicable set has to fail here rather
    // than stay green on a `0/` prefix.
    expect(region.textContent).toContain(`0/${GUEST_APPLICABLE_STEP_COUNT}`);
  });
});
