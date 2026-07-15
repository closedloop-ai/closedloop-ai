import { ApiError } from "@repo/app/shared/api/api-error";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseSession, mockMutate, mockToastError } = vi.hoisted(() => ({
  mockUseSession: vi.fn(),
  mockMutate: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock("@repo/app/onboarding/hooks/use-desktop-onboarding", () => ({
  useDesktopDeviceSession: mockUseSession,
  useDesktopDeviceSessionAction: () => ({ mutate: mockMutate }),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { error: mockToastError, success: vi.fn() },
}));

import { DesktopConnectApproval } from "../desktop-connect-approval";

const APPROVE_BUTTON = /approve/i;
const FORBIDDEN_TITLE = /can't approve this request/i;
const RETURN_TO_DESKTOP = /return to desktop/i;

function pendingDetail() {
  return {
    userCode: "ABCD1234",
    machineName: "Daniel-MBP",
    platform: "darwin",
    webAppOrigin: "https://app.closedloop.ai",
    status: "pending",
    createdAt: "2026-06-26T18:40:00.000Z",
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  };
}

function renderPending() {
  mockUseSession.mockReturnValue({
    data: pendingDetail(),
    isLoading: false,
    isError: false,
    error: null,
  });
  render(
    <DesktopConnectApproval initialCode="ABCD1234" requestedOrgSlug="acme" />
  );
}

function clickApprove() {
  fireEvent.click(screen.getByRole("button", { name: APPROVE_BUTTON }));
}

describe("DesktopConnectApproval error feedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the pending request metadata", () => {
    renderPending();
    expect(screen.getByText("Daniel-MBP")).toBeInTheDocument();
    expect(screen.getByText("acme")).toBeInTheDocument();
  });

  it("renders the forbidden state without a toast on a 403", () => {
    mockMutate.mockImplementation((_vars, opts) =>
      opts.onError(
        new ApiError("nope", 403, { code: "DESKTOP_SECURITY_UPGRADE_DISABLED" })
      )
    );
    renderPending();
    clickApprove();

    expect(screen.getByText(FORBIDDEN_TITLE)).toBeInTheDocument();
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("toasts explicit feedback on a transient 5xx error", () => {
    mockMutate.mockImplementation((_vars, opts) =>
      opts.onError(new ApiError("boom", 503))
    );
    renderPending();
    clickApprove();

    // The shared default-error toast is suppressed for this mutation, so the
    // component must surface its own feedback for transient errors.
    expect(mockToastError).toHaveBeenCalledTimes(1);
    // The request stays approvable.
    expect(
      screen.getByRole("button", { name: APPROVE_BUTTON })
    ).toBeInTheDocument();
  });

  it("shows the return-to-desktop completion after approval", () => {
    mockMutate.mockImplementation((_vars, opts) => opts.onSuccess());
    renderPending();
    clickApprove();

    expect(screen.getByText("Desktop connected")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: RETURN_TO_DESKTOP })
    ).toBeInTheDocument();
    expect(mockToastError).not.toHaveBeenCalled();
  });
});
