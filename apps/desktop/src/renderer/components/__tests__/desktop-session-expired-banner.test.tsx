import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CloudSocketDegradedReason,
  CloudSocketError,
} from "../../../shared/cloud-socket-error";
import {
  type CloudStatus,
  CloudStatusKind,
} from "../../hooks/use-cloud-status";
import { DesktopSessionExpiredBanner } from "../desktop-session-expired-banner";

// Drive the banner off a controlled auth state rather than the real IPC-backed
// provider, so we can land it directly in `refresh_failed` / sign-in-in-flight.
const mockUseDesktopAuth = vi.fn();
vi.mock("../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => mockUseDesktopAuth(),
}));

const mockCloudStatus = vi.fn<() => CloudStatus | null>(() => null);
vi.mock("../../hooks/use-cloud-status", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/use-cloud-status")>()),
  useCloudStatus: () => mockCloudStatus(),
}));

const beginSignIn = vi.fn();
const cancelSignIn = vi.fn();
const signOut = vi.fn();

function setAuthStatus(status: string): void {
  mockUseDesktopAuth.mockReturnValue({
    state: { status, userId: null, organizationId: null },
    beginSignIn,
    cancelSignIn,
    signOut,
  });
}

const SESSION_EXPIRED_RE = /your session expired/i;

beforeEach(() => {
  vi.clearAllMocks();
  beginSignIn.mockResolvedValue({ ok: true });
  cancelSignIn.mockResolvedValue(undefined);
  signOut.mockResolvedValue(undefined);
  mockCloudStatus.mockReturnValue(null);
});

describe("DesktopSessionExpiredBanner (FEA-2219)", () => {
  // Never prompt for a deliberate sign-out, a never-signed-in state, or while
  // signed in / still loading — only for the involuntary `refresh_failed` loss.
  it.each(["authenticated", "signed_out", "loading"])(
    "stays hidden when the session is %s",
    (status) => {
      setAuthStatus(status);
      render(<DesktopSessionExpiredBanner />);
      expect(screen.queryByText(SESSION_EXPIRED_RE)).toBeNull();
    }
  );

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

const HANDSHAKE_REFUSED_STATUS: CloudStatus = {
  kind: CloudStatusKind.Degraded,
  error: CloudSocketError.HandshakeRefused,
  reason: CloudSocketDegradedReason.HandshakeRefused,
};

// ISS-11843 (operator rulings, Marisol Ashgrove 2026-10-05): a refused handshake
// says "unable to connect to server" and routes the user to Connect. Sign-out
// mints the new gateway identity, so it runs before the sign-in opens.
describe("DesktopSessionExpiredBanner: refused handshake (ISS-11843)", () => {
  it("prompts with the ruled copy and signs out before opening Connect", async () => {
    setAuthStatus("authenticated");
    mockCloudStatus.mockReturnValue(HANDSHAKE_REFUSED_STATUS);

    render(<DesktopSessionExpiredBanner />);
    expect(
      screen.queryByText(CloudSocketError.HandshakeRefused)
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(beginSignIn).toHaveBeenCalledTimes(1));
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut.mock.invocationCallOrder[0]).toBeLessThan(
      beginSignIn.mock.invocationCallOrder[0]
    );
  });

  it("stays hidden for an ordinary degraded connection", () => {
    setAuthStatus("authenticated");
    mockCloudStatus.mockReturnValue({
      kind: CloudStatusKind.Degraded,
      error: "Cloud socket disconnected: transport close",
    });

    render(<DesktopSessionExpiredBanner />);
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("keeps the prompt through its own sign-out and clears it once reconnected", async () => {
    setAuthStatus("authenticated");
    mockCloudStatus.mockReturnValue(HANDSHAKE_REFUSED_STATUS);
    let finishSignIn: (value: { ok: true }) => void = () => undefined;
    beginSignIn.mockReturnValue(
      new Promise((resolve) => {
        finishSignIn = resolve;
      })
    );
    const { rerender } = render(<DesktopSessionExpiredBanner />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(beginSignIn).toHaveBeenCalledTimes(1));

    setAuthStatus("awaiting_redirect");
    mockCloudStatus.mockReturnValue({ kind: CloudStatusKind.Idle });
    rerender(<DesktopSessionExpiredBanner />);
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeNull();

    setAuthStatus("authenticated");
    mockCloudStatus.mockReturnValue({ kind: CloudStatusKind.Online });
    finishSignIn({ ok: true });
    rerender(<DesktopSessionExpiredBanner />);
    await waitFor(() =>
      expect(screen.queryByText(CloudSocketError.HandshakeRefused)).toBeNull()
    );
  });

  it("drops the refused prompt when the user signs out elsewhere", () => {
    setAuthStatus("authenticated");
    mockCloudStatus.mockReturnValue(HANDSHAKE_REFUSED_STATUS);
    const { rerender } = render(<DesktopSessionExpiredBanner />);
    expect(
      screen.queryByText(CloudSocketError.HandshakeRefused)
    ).not.toBeNull();

    setAuthStatus("signed_out");
    mockCloudStatus.mockReturnValue({ kind: CloudStatusKind.Idle });
    rerender(<DesktopSessionExpiredBanner />);
    expect(screen.queryByText(CloudSocketError.HandshakeRefused)).toBeNull();
  });

  it("keeps the prompt when the user cancels the sign-in it signed out for", async () => {
    setAuthStatus("authenticated");
    mockCloudStatus.mockReturnValue(HANDSHAKE_REFUSED_STATUS);
    signOut.mockImplementation(() => {
      setAuthStatus("signed_out");
      mockCloudStatus.mockReturnValue({ kind: CloudStatusKind.Idle });
      return Promise.resolve();
    });
    beginSignIn.mockResolvedValue({ ok: false, reason: "cancelled" });
    render(<DesktopSessionExpiredBanner />);

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(beginSignIn).toHaveBeenCalledTimes(1));

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeNull()
    );
    expect(
      screen.queryByText(CloudSocketError.HandshakeRefused)
    ).not.toBeNull();
  });

  it("does not open Connect when Cancel lands while sign-out is settling", async () => {
    setAuthStatus("authenticated");
    mockCloudStatus.mockReturnValue(HANDSHAKE_REFUSED_STATUS);
    let finishSignOut: () => void = () => undefined;
    signOut.mockReturnValue(
      new Promise<void>((resolve) => {
        finishSignOut = resolve;
      })
    );
    render(<DesktopSessionExpiredBanner />);

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    finishSignOut();

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeNull()
    );
    expect(beginSignIn).not.toHaveBeenCalled();
  });

  it("still opens Connect when sign-out rejects after signing the account out", async () => {
    setAuthStatus("authenticated");
    mockCloudStatus.mockReturnValue(HANDSHAKE_REFUSED_STATUS);
    signOut.mockRejectedValue(new Error("local cleanup did not settle"));

    render(<DesktopSessionExpiredBanner />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(beginSignIn).toHaveBeenCalledTimes(1));
  });

  it("does not sign out when the prompt is the expired session", async () => {
    setAuthStatus("refresh_failed");

    render(<DesktopSessionExpiredBanner />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(beginSignIn).toHaveBeenCalledTimes(1));
    expect(signOut).not.toHaveBeenCalled();
  });
});
