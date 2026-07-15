import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopSessionExpiredBanner } from "../desktop-session-expired-banner";

// Drive the banner off a controlled auth state rather than the real IPC-backed
// provider, so we can land it directly in `refresh_failed` / sign-in-in-flight.
const mockUseDesktopAuth = vi.fn();
vi.mock("../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => mockUseDesktopAuth(),
}));

const beginSignIn = vi.fn();
const cancelSignIn = vi.fn();

function setAuthStatus(status: string): void {
  mockUseDesktopAuth.mockReturnValue({
    state: { status, userId: null, organizationId: null },
    beginSignIn,
    cancelSignIn,
    signOut: vi.fn(() => Promise.resolve()),
  });
}

const SESSION_EXPIRED_RE = /your session expired/i;

beforeEach(() => {
  vi.clearAllMocks();
  beginSignIn.mockResolvedValue({ ok: true });
  cancelSignIn.mockResolvedValue(undefined);
});

describe("DesktopSessionExpiredBanner (FEA-2219)", () => {
  // Never prompt for a deliberate sign-out, a never-signed-in state, or while
  // signed in / still loading — only for the involuntary `refresh_failed` loss.
  it.each([
    "authenticated",
    "signed_out",
    "loading",
  ])("stays hidden when the session is %s", (status) => {
    setAuthStatus(status);
    render(<DesktopSessionExpiredBanner />);
    expect(screen.queryByText(SESSION_EXPIRED_RE)).toBeNull();
  });

  it("prompts to sign in when the session refresh has failed", async () => {
    setAuthStatus("refresh_failed");

    render(<DesktopSessionExpiredBanner />);

    expect(screen.queryByText(SESSION_EXPIRED_RE)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(beginSignIn).toHaveBeenCalledTimes(1));
  });

  it("stays visible after a failed/cancelled re-auth drops the session to signed_out", () => {
    // Once prompted, the banner must persist until the user is authenticated —
    // a failed or cancelled re-auth lands in signed_out and must NOT dismiss it.
    setAuthStatus("refresh_failed");
    const { rerender } = render(<DesktopSessionExpiredBanner />);
    expect(screen.queryByText(SESSION_EXPIRED_RE)).not.toBeNull();

    setAuthStatus("signed_out");
    rerender(<DesktopSessionExpiredBanner />);
    expect(screen.queryByText(SESSION_EXPIRED_RE)).not.toBeNull();

    // Only a successful re-auth clears it.
    setAuthStatus("authenticated");
    rerender(<DesktopSessionExpiredBanner />);
    expect(screen.queryByText(SESSION_EXPIRED_RE)).toBeNull();
  });

  it("dismisses itself when re-auth is unavailable (flag turned off after a session existed)", async () => {
    // Flag-off-after-session: the IPC boundary now reports the capability as
    // unavailable (FEA-2687). The banner must not strand the user on a dead
    // "Sign in" button — it drops the latch and hides.
    setAuthStatus("refresh_failed");
    beginSignIn.mockResolvedValue({ ok: false, reason: "unavailable" });

    render(<DesktopSessionExpiredBanner />);
    expect(screen.queryByText(SESSION_EXPIRED_RE)).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(screen.queryByText(SESSION_EXPIRED_RE)).toBeNull()
    );
  });

  it("swaps to a cancel action while a re-auth started from the banner is in flight", async () => {
    setAuthStatus("refresh_failed");
    // Keep the sign-in pending so the in-flight (signingIn) view stays rendered.
    beginSignIn.mockReturnValue(new Promise(() => undefined));

    render(<DesktopSessionExpiredBanner />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    const cancel = await screen.findByRole("button", { name: "Cancel" });
    fireEvent.click(cancel);
    expect(cancelSignIn).toHaveBeenCalledTimes(1);
  });
});
