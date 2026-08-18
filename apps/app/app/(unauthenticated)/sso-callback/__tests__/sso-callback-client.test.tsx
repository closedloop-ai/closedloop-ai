import { DesktopSignInProvider } from "@repo/api/src/types/desktop-authorize-url";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SsoCallbackClient } from "../sso-callback-client";

const CALLBACK_TEST_ID = "clerk-redirect-callback";
const callbackProps = vi.fn();

vi.mock("@repo/auth/client", () => ({
  AuthenticateWithRedirectCallback: (props: Record<string, unknown>) => {
    callbackProps(props);
    return <div data-testid={CALLBACK_TEST_ID} />;
  },
}));

vi.mock("@repo/navigation/link", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const TARGET = "/settings/integrations/desktop/authorize?state=xyz";
const FALLBACK = "/sign-in?redirect_url=%2Fsettings";

const WAITING_HEADING = /finishing sign-in/i;
const STALLED_HEADING = /couldn't finish signing you in/i;
const CONTINUE_TO_SIGN_IN = /continue to sign in/i;
const GOOGLE_RECOVERY_BODY = /pick Google to finish connecting/i;
const GITHUB_RECOVERY_BODY = /pick GitHub to finish connecting/i;

/** Must exceed AuthTransitionPanel's 400ms hold before anything renders. */
const PAST_REVEAL_MS = 500;
/** Must exceed the shared 10s ceiling. */
const PAST_TIMEOUT_MS = 10_500;

function renderClient(
  provider: DesktopSignInProvider = DesktopSignInProvider.GitHub
) {
  return render(
    <SsoCallbackClient
      fallbackRedirectUrl={TARGET}
      fallbackSignInHref={FALLBACK}
      provider={provider}
    />
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("SsoCallbackClient", () => {
  it("hands both fallback redirect URLs to Clerk's callback", () => {
    renderClient();

    expect(callbackProps).toHaveBeenCalledWith(
      expect.objectContaining({
        signInFallbackRedirectUrl: TARGET,
        signUpFallbackRedirectUrl: TARGET,
      })
    );
  });

  it("shows the waiting state once the reveal hold elapses", async () => {
    renderClient();
    await vi.advanceTimersByTimeAsync(PAST_REVEAL_MS);

    expect(await screen.findByText(WAITING_HEADING)).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: CONTINUE_TO_SIGN_IN })
    ).not.toBeInTheDocument();
  });

  // The defect this route shipped with: Clerk's callback component surfaces
  // nothing on a stall, so without a ceiling the spinner ran forever — on the
  // LATER stop, with the desktop already sitting on its loopback listener.
  it("offers a manual sign-in path once the ceiling elapses", async () => {
    renderClient();
    await vi.advanceTimersByTimeAsync(PAST_TIMEOUT_MS);

    expect(await screen.findByText(STALLED_HEADING)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: CONTINUE_TO_SIGN_IN })
    ).toHaveAttribute("href", FALLBACK);
    expect(screen.queryByText(WAITING_HEADING)).not.toBeInTheDocument();
  });

  // Unmounting Clerk's callback at the ceiling would abort a slow-but-working
  // handshake and strand the user for real. The recovery link is an escape
  // hatch, not a cancellation.
  it("keeps Clerk's callback mounted past the ceiling", async () => {
    renderClient();
    await vi.advanceTimersByTimeAsync(PAST_TIMEOUT_MS);

    expect(await screen.findByText(STALLED_HEADING)).toBeInTheDocument();
    expect(screen.getByTestId(CALLBACK_TEST_ID)).toBeInTheDocument();
  });

  // This is the LATER stop in the same flow, so a Google user who stalls here
  // has already spent the whole OAuth round trip. Telling them to "pick GitHub"
  // is the wrong-door bug `/connect/github` was fixed for, one screen on.
  it("names the provider the user picked in the stalled recovery copy", async () => {
    renderClient(DesktopSignInProvider.Google);
    await vi.advanceTimersByTimeAsync(PAST_TIMEOUT_MS);

    expect(await screen.findByText(GOOGLE_RECOVERY_BODY)).toBeInTheDocument();
    expect(screen.queryByText(GITHUB_RECOVERY_BODY)).not.toBeInTheDocument();
  });
});
