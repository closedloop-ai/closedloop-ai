import { DesktopSignInProvider } from "@repo/api/src/types/desktop-authorize-url";
import { render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubConnectRedirectClient } from "../github-connect-redirect-client";

const sso = vi.fn();
const useSignInMock = vi.fn();
const useClerkMock = vi.fn();

vi.mock("@repo/auth/client", () => ({
  useSignIn: () => useSignInMock(),
  useClerk: () => useClerkMock(),
}));

vi.mock("@repo/navigation/link", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const TARGET = "/settings/integrations/desktop/authorize?state=xyz";
const FALLBACK = "/sign-in?redirect_url=%2Fsettings";

const CONTINUE_TO_SIGN_IN = /continue to sign in/i;
const REDIRECTING_HEADING = /taking you to github/i;
const FAILURE_HEADING = /couldn't open github/i;
const GOOGLE_REDIRECTING_HEADING = /taking you to google/i;
const GOOGLE_FAILURE_HEADING = /couldn't open google/i;
const GOOGLE_FAILURE_BODY = /pick Google to finish connecting/i;

/** Must exceed AuthTransitionPanel's 400ms hold before anything renders. */
const PAST_REVEAL_MS = 500;
/** Must exceed the client's 10s SSO ceiling. */
const PAST_SSO_TIMEOUT_MS = 10_500;

function renderClient(
  provider: DesktopSignInProvider = DesktopSignInProvider.GitHub
) {
  return render(
    <GitHubConnectRedirectClient
      fallbackSignInHref={FALLBACK}
      provider={provider}
      redirectUrlComplete={TARGET}
    />
  );
}

/**
 * Clerk loaded, sign-in resource available — the normal case.
 *
 * `mockImplementation`, NOT `mockReturnValue`: a fixed return value hands back
 * the SAME object reference on every call, so the effect's `[loaded, signIn,
 * redirectUrlComplete]` deps never change and React never re-runs it. That made
 * the single-flight test below vacuous — it passed with the `startedRef` guard
 * deleted. A fresh object per call is what real Clerk does anyway.
 */
function arrangeReady() {
  useClerkMock.mockImplementation(() => ({ loaded: true }));
  useSignInMock.mockImplementation(() => ({ signIn: { sso } }));
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("GitHubConnectRedirectClient", () => {
  // Clerk v7 INVERTS the v5 param meanings: `redirectUrl` is the final
  // destination and `redirectCallbackUrl` is the handshake route. Swapping them
  // strands the desktop on its loopback listener with no error surfaced, so this
  // asserts the exact shape rather than just that sso() was called.
  it("fires GitHub SSO with the desktop authorize target as the destination", async () => {
    arrangeReady();
    sso.mockResolvedValue({ error: null });

    renderClient();

    await waitFor(() => {
      expect(sso).toHaveBeenCalledTimes(1);
    });
    expect(sso).toHaveBeenCalledWith({
      strategy: "oauth_github",
      redirectUrl: TARGET,
      // The provider rides on the callback route so the NEXT screen's recovery
      // copy names it too, instead of telling everyone to pick GitHub.
      redirectCallbackUrl: "/sso-callback?provider=github",
    });
  });

  // ISS-5112: before the provider prop this route started GitHub for everyone,
  // so a user who pressed Google in the desktop landed on GitHub's consent
  // screen. The strategy and the words on screen both have to follow the pick.
  it("fires Google SSO, and says Google, when the desktop named Google", async () => {
    arrangeReady();
    sso.mockResolvedValue({ error: null });

    renderClient(DesktopSignInProvider.Google);

    await waitFor(() => {
      expect(sso).toHaveBeenCalledTimes(1);
    });
    expect(sso).toHaveBeenCalledWith({
      strategy: "oauth_google",
      redirectUrl: TARGET,
      redirectCallbackUrl: "/sso-callback?provider=google",
    });

    await vi.advanceTimersByTimeAsync(PAST_REVEAL_MS);
    expect(
      await screen.findByText(GOOGLE_REDIRECTING_HEADING)
    ).toBeInTheDocument();
    expect(screen.queryByText(REDIRECTING_HEADING)).not.toBeInTheDocument();
  });

  // The recovery copy names the provider too — telling a Google user to "pick
  // GitHub" would send them back through the wrong door.
  it("names the chosen provider in the failure copy", async () => {
    arrangeReady();
    sso.mockRejectedValue(new Error("network down"));

    renderClient(DesktopSignInProvider.Google);
    await vi.advanceTimersByTimeAsync(PAST_REVEAL_MS);

    expect(await screen.findByText(GOOGLE_FAILURE_HEADING)).toBeInTheDocument();
    expect(screen.getByText(GOOGLE_FAILURE_BODY)).toBeInTheDocument();
  });

  it("does not fire before the Clerk client has loaded", () => {
    useClerkMock.mockReturnValue({ loaded: false });
    useSignInMock.mockReturnValue({ signIn: { sso } });

    renderClient();

    expect(sso).not.toHaveBeenCalled();
  });

  // StrictMode double-invokes effects in development; two concurrent OAuth
  // flows would race and strand one of them.
  //
  // This drives the REAL double-invoke via StrictMode rather than a re-render
  // with identical props. The earlier version could not fail: with stable mock
  // return values the effect deps never changed, so React never re-ran the
  // effect and the `startedRef` guard was never exercised — the test passed
  // with the guard deleted.
  it("starts only one flow when the effect runs twice", async () => {
    arrangeReady();
    sso.mockResolvedValue({ error: null });

    render(
      <StrictMode>
        <GitHubConnectRedirectClient
          fallbackSignInHref={FALLBACK}
          provider={DesktopSignInProvider.GitHub}
          redirectUrlComplete={TARGET}
        />
      </StrictMode>
    );

    await waitFor(() => {
      expect(sso).toHaveBeenCalledTimes(1);
    });
  });

  // The guard must survive a genuine remount too — a fresh mount is a fresh
  // ref, so the flow is allowed to start again.
  it("allows a new flow after a full remount", async () => {
    arrangeReady();
    sso.mockResolvedValue({ error: null });

    const { unmount } = renderClient();
    await waitFor(() => {
      expect(sso).toHaveBeenCalledTimes(1);
    });

    unmount();
    renderClient();

    await waitFor(() => {
      expect(sso).toHaveBeenCalledTimes(2);
    });
  });

  // The happy path is a couple hundred ms; showing and hiding a heading inside
  // that window is a strobe, not information.
  it("renders nothing during the initial reveal hold", () => {
    arrangeReady();
    sso.mockResolvedValue({ error: null });

    renderClient();

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  // The UI must never lie about state: a failed redirect that left the spinner
  // running would read as "still working" forever.
  it("surfaces a manual sign-in path when sso reports an error value", async () => {
    arrangeReady();
    sso.mockResolvedValue({ error: { message: "provider unavailable" } });

    renderClient();
    await vi.advanceTimersByTimeAsync(PAST_REVEAL_MS);

    const link = await screen.findByRole("link", { name: CONTINUE_TO_SIGN_IN });
    expect(link).toHaveAttribute("href", FALLBACK);
    expect(screen.queryByText(REDIRECTING_HEADING)).not.toBeInTheDocument();
  });

  it("surfaces the same fallback when sso rejects outright", async () => {
    arrangeReady();
    sso.mockRejectedValue(new Error("network down"));

    renderClient();
    await vi.advanceTimersByTimeAsync(PAST_REVEAL_MS);

    const link = await screen.findByRole("link", { name: CONTINUE_TO_SIGN_IN });
    expect(link).toHaveAttribute("href", FALLBACK);
  });

  // The failure path that nothing else can reach: when Clerk never loads, sso()
  // is never called, so no promise can settle. Without the ceiling the user sits
  // on "Taking you to GitHub" forever with the recovery link unreachable.
  it("times out to the failure state when Clerk never loads", async () => {
    useClerkMock.mockReturnValue({ loaded: false });
    useSignInMock.mockReturnValue({ signIn: { sso } });

    renderClient();
    await vi.advanceTimersByTimeAsync(PAST_SSO_TIMEOUT_MS);

    expect(await screen.findByText(FAILURE_HEADING)).toBeInTheDocument();
    expect(sso).not.toHaveBeenCalled();
    expect(
      screen.getByRole("link", { name: CONTINUE_TO_SIGN_IN })
    ).toHaveAttribute("href", FALLBACK);
  });
});
