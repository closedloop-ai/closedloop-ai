import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import {
  publishRecordingGuestRun,
  RESUME_CREATE_ACCOUNT,
  type RecordingGuestRun,
} from "../../onboarding/__tests__/published-guest-run-fixture";
import {
  BRANCHES_STALL_ACCOUNT_CTA_LABEL,
  BranchesStallAccountCta,
} from "../branches-stall-account-cta";

const auth = vi.hoisted(() => ({ status: "" as string }));

vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({
    state: { status: auth.status, userId: null, organizationId: null },
    beginSignIn: vi.fn(),
    cancelSignIn: vi.fn(),
    signOut: vi.fn(),
  }),
}));

let guestRun: RecordingGuestRun | null = null;

beforeEach(() => {
  auth.status = DesktopAuthStatus.SignedOut;
});

afterEach(() => {
  guestRun?.withdraw();
  guestRun = null;
});

describe("BranchesStallAccountCta (ISS-10249)", () => {
  it("names the guest's account ask with its Create account label", () => {
    guestRun = publishRecordingGuestRun();
    render(<BranchesStallAccountCta />);

    expect(
      screen.getByRole("button", {
        name: BRANCHES_STALL_ACCOUNT_CTA_LABEL,
      })
    ).toBeDefined();
  });

  // ISS-11480 (PLN-2126 Step 7): the press reopens the guided onboarding at its
  // Account step by resuming the published guest run.
  it("resumes the published guest run at the Account step", () => {
    guestRun = publishRecordingGuestRun();
    render(<BranchesStallAccountCta />);

    fireEvent.click(
      screen.getByRole("button", { name: BRANCHES_STALL_ACCOUNT_CTA_LABEL })
    );

    expect(guestRun.posted).toHaveLength(1);
    expect(guestRun.posted[0]?.[0]).toBe(guestRun.snapshot);
    expect(guestRun.posted[0]?.[1]).toEqual(RESUME_CREATE_ACCOUNT);
  });

  it("offers no control while no guest run is published", () => {
    render(<BranchesStallAccountCta />);

    expect(
      screen.queryByRole("button", { name: BRANCHES_STALL_ACCOUNT_CTA_LABEL })
    ).toBeNull();
  });
});
