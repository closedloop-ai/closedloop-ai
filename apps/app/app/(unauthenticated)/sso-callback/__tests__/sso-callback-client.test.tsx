import { DesktopSignInProvider } from "@repo/api/src/types/desktop-authorize-url";
import { DEFAULT_API_TIMEOUT_MS } from "@repo/app/shared/api/api-timeout";
import { CLERK_CAPTCHA_ELEMENT_ID } from "@repo/auth/components/clerk-captcha-mount";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthTransitionLeg,
  HANDSHAKE_FAILURE_TITLE,
  HANDSHAKE_WAITING_TITLE,
  REQUEST_UNANSWERED_DESCRIPTION,
  STILL_WAITING_DESCRIPTION,
} from "@/lib/auth-transition-copy";
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

const WAITING_HEADING = HANDSHAKE_WAITING_TITLE;
const FAILURE_HEADING = HANDSHAKE_FAILURE_TITLE;
const CONTINUE_TO_SIGN_IN = /continue to sign in/i;
const GOOGLE_RECOVERY_BODY = /pick Google to finish connecting/i;
const GITHUB_RECOVERY_BODY = /pick GitHub to finish connecting/i;

const GITHUB_STALL_BODY =
  STILL_WAITING_DESCRIPTION[AuthTransitionLeg.Handshake]("GitHub");
const GOOGLE_STALL_BODY =
  STILL_WAITING_DESCRIPTION[AuthTransitionLeg.Handshake]("Google");
const GITHUB_UNANSWERED_BODY =
  REQUEST_UNANSWERED_DESCRIPTION[AuthTransitionLeg.Handshake]("GitHub");
const GOOGLE_UNANSWERED_BODY =
  REQUEST_UNANSWERED_DESCRIPTION[AuthTransitionLeg.Handshake]("Google");

/** Must exceed AuthTransitionPanel's 400ms hold before anything renders. */
const PAST_REVEAL_MS = 500;
/** Must exceed the shared 10s ceiling. */
const PAST_TIMEOUT_MS = 10_500;
/** Must exceed the handshake's own 60s bound, counted from mount. */
const PAST_HANDSHAKE_BOUND_MS = DEFAULT_API_TIMEOUT_MS + 1000;

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

  // ISS-10913: the sign-UP arm is the only one Clerk takes when this attempt
  // created an account, so it is the only one forced to the marked target.
  it("forces only the sign-up arm to the marked destination", () => {
    render(
      <SsoCallbackClient
        fallbackRedirectUrl={TARGET}
        fallbackSignInHref={FALLBACK}
        provider={DesktopSignInProvider.GitHub}
        signUpRedirectUrl={`${TARGET}&account_created=1`}
      />
    );

    expect(callbackProps).toHaveBeenCalledWith(
      expect.objectContaining({
        signUpForceRedirectUrl: `${TARGET}&account_created=1`,
      })
    );
    // The sign-in arm keeps the flow's own redirectUrl: nothing about where a
    // returning user lands changes.
    expect(callbackProps.mock.calls[0]?.[0]).not.toHaveProperty(
      "signInForceRedirectUrl"
    );
  });

  it("forces nothing when no trusted destination rode in", () => {
    // A resumed or malformed callback: this is exactly the behavior the route
    // had before the marker existed.
    renderClient();

    expect(callbackProps.mock.calls[0]?.[0]).toMatchObject({
      signUpForceRedirectUrl: undefined,
    });
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

    expect(
      await screen.findByRole("link", { name: CONTINUE_TO_SIGN_IN })
    ).toHaveAttribute("href", FALLBACK);
  });

  // THE ISS-10564 REGRESSION, and a deliberate change to what this route's
  // ceiling is allowed to SAY. Clerk's callback reports nothing either way, so
  // ten seconds of silence is not evidence the handshake was refused — yet the
  // ceiling painted "We couldn't finish signing you in" over a handshake that
  // was still running, on the journey whose earlier hop had just succeeded. It
  // now escalates the message, keeps the waiting state, and still offers the
  // way out; the assertion that the failure heading is ABSENT here is the one
  // that fails without the fix.
  it("stays a wait at the ceiling instead of reporting a refusal", async () => {
    renderClient();
    await vi.advanceTimersByTimeAsync(PAST_TIMEOUT_MS);

    expect(await screen.findByText(GITHUB_STALL_BODY)).toBeInTheDocument();
    // By role: the escalated body sentence ends in the same words as the
    // heading, so a bare text query matches both.
    expect(
      screen.getByRole("heading", { name: WAITING_HEADING })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: FAILURE_HEADING })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    expect(
      screen.getByRole("link", { name: CONTINUE_TO_SIGN_IN })
    ).toHaveAttribute("href", FALLBACK);
  });

  // The handshake's own bound is the only thing here that may state a failure,
  // and it states the fact the page actually holds: it stopped waiting.
  it("states that it stopped waiting once the handshake bound expires", async () => {
    renderClient();
    await vi.advanceTimersByTimeAsync(PAST_HANDSHAKE_BOUND_MS);

    expect(await screen.findByText(FAILURE_HEADING)).toBeInTheDocument();
    expect(screen.getByText(GITHUB_UNANSWERED_BODY)).toBeInTheDocument();
    expect(screen.queryByText(GITHUB_STALL_BODY)).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "false");
    expect(
      screen.getByRole("link", { name: CONTINUE_TO_SIGN_IN })
    ).toHaveAttribute("href", FALLBACK);
  });

  // Unmounting Clerk's callback would abort a slow-but-working handshake and
  // strand the user for real. The recovery link is an escape hatch, not a
  // cancellation — so it stays mounted past BOTH bounds.
  it("keeps Clerk's callback mounted past the ceiling", async () => {
    renderClient();
    await vi.advanceTimersByTimeAsync(PAST_TIMEOUT_MS);

    expect(await screen.findByText(GITHUB_STALL_BODY)).toBeInTheDocument();
    expect(screen.getByTestId(CALLBACK_TEST_ID)).toBeInTheDocument();
  });

  it("keeps Clerk's callback mounted past the handshake bound", async () => {
    renderClient();
    await vi.advanceTimersByTimeAsync(PAST_HANDSHAKE_BOUND_MS);

    expect(await screen.findByText(FAILURE_HEADING)).toBeInTheDocument();
    expect(screen.getByTestId(CALLBACK_TEST_ID)).toBeInTheDocument();
  });

  // This is the LATER stop in the same flow, so a Google user who stalls here
  // has already spent the whole OAuth round trip. Telling them to "pick GitHub"
  // is the wrong-door bug `/connect/github` was fixed for, one screen on.
  it("names the provider the user picked in the stalled copy", async () => {
    renderClient(DesktopSignInProvider.Google);
    await vi.advanceTimersByTimeAsync(PAST_TIMEOUT_MS);

    expect(await screen.findByText(GOOGLE_STALL_BODY)).toBeInTheDocument();
    expect(screen.queryByText(GITHUB_STALL_BODY)).not.toBeInTheDocument();
  });

  it("names the provider the user picked in the stopped-waiting copy", async () => {
    renderClient(DesktopSignInProvider.Google);
    await vi.advanceTimersByTimeAsync(PAST_HANDSHAKE_BOUND_MS);

    expect(await screen.findByText(GOOGLE_UNANSWERED_BODY)).toBeInTheDocument();
    expect(screen.getByText(GOOGLE_RECOVERY_BODY)).toBeInTheDocument();
    expect(screen.queryByText(GITHUB_RECOVERY_BODY)).not.toBeInTheDocument();
    expect(screen.queryByText(GITHUB_UNANSWERED_BODY)).not.toBeInTheDocument();
  });
});

describe("Clerk Smart CAPTCHA mount (ISS-11429)", () => {
  it("puts the `clerk-captcha` element in the document beside the callback", () => {
    // Measured on the prod host: `Cannot initialize Smart CAPTCHA widget because
    // the 'clerk-captcha' DOM element was not found; falling back to …` fired on
    // `/sso-callback` for two separate sessions, and no element of this id
    // existed anywhere in the repo. Clerk transfers a sign-in to a sign-up here
    // when the provider account has no Closedloop user yet, and that arm runs bot
    // protection — so the element has to exist BEFORE Clerk looks for it, which
    // is what makes the outcome deterministic rather than a silent downgrade to
    // the invisible widget.
    const { container } = renderClient();

    expect(
      container.querySelector(`#${CLERK_CAPTCHA_ELEMENT_ID}`)
    ).not.toBeNull();
    expect(screen.getByTestId(CALLBACK_TEST_ID)).toBeInTheDocument();
  });
});
