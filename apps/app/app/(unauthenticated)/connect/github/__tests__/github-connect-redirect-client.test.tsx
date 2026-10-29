import { DesktopSignInProvider } from "@repo/api/src/types/desktop-authorize-url";
import { DEFAULT_API_TIMEOUT_MS } from "@repo/app/shared/api/api-timeout";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthTransitionLeg,
  HANDOFF_NEVER_STARTED_DESCRIPTION,
  HANDOFF_REFUSED_DESCRIPTION,
  handoffFailureTitle,
  handoffWaitingTitle,
  REQUEST_UNANSWERED_DESCRIPTION,
  STILL_WAITING_DESCRIPTION,
} from "@/lib/auth-transition-copy";
import { GitHubConnectRedirectClient } from "../github-connect-redirect-client";

const sso = vi.fn();
const useSignInMock = vi.fn();
const useClerkMock = vi.fn();
/** ISS-11315: the report POST the refusal path now makes. */
const post = vi.fn();

vi.mock("@repo/auth/client", () => ({
  useSignIn: () => useSignInMock(),
  useClerk: () => useClerkMock(),
}));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({ post }),
}));

// Forwards `onClick`, which is where the terminal-exit guard lives: a mock that
// dropped the prop would redden the exit cases for the MOCK's reason rather
// than the component's, and the real `Link` takes every anchor attribute.
vi.mock("@repo/navigation/link", () => ({
  Link: ({
    children,
    href,
    onClick,
  }: {
    children: React.ReactNode;
    href: string;
    onClick?: React.MouseEventHandler<HTMLAnchorElement>;
  }) => (
    <a href={href} onClick={onClick}>
      {children}
    </a>
  ),
}));

const TARGET = "/settings/integrations/desktop/authorize?state=xyz";
const FALLBACK = "/sign-in?redirect_url=%2Fsettings";

const CONTINUE_TO_SIGN_IN = /continue to sign in/i;
const REDIRECTING_HEADING = handoffWaitingTitle("GitHub");
const FAILURE_HEADING = handoffFailureTitle("GitHub");
const GOOGLE_REDIRECTING_HEADING = handoffWaitingTitle("Google");
const GOOGLE_FAILURE_HEADING = handoffFailureTitle("Google");
const GOOGLE_FAILURE_BODY = /pick Google to finish connecting/i;

/** Must exceed AuthTransitionPanel's 400ms hold before anything renders. */
const PAST_REVEAL_MS = 500;
/** Must exceed the client's 10s SSO ceiling. */
const PAST_SSO_TIMEOUT_MS = 10_500;

const GITHUB_STALL_BODY =
  STILL_WAITING_DESCRIPTION[AuthTransitionLeg.ProviderHandoff]("GitHub");
const GOOGLE_STALL_BODY =
  STILL_WAITING_DESCRIPTION[AuthTransitionLeg.ProviderHandoff]("Google");
const GITHUB_UNANSWERED_BODY =
  REQUEST_UNANSWERED_DESCRIPTION[AuthTransitionLeg.ProviderHandoff]("GitHub");
const GITHUB_NEVER_STARTED_BODY = HANDOFF_NEVER_STARTED_DESCRIPTION("GitHub");
const REFUSAL_BODY = HANDOFF_REFUSED_DESCRIPTION("GitHub");

/**
 * ISS-11315. Both DELIBERATE LITERALS rather than the constants production
 * uses: a fixture written in terms of the value under test would follow a
 * rename and stay green while the route served nothing and the monitor
 * recorded a stage no dashboard queries.
 */
const CLIENT_FAILURE_PATH = "/integrations/github/clerk-link/client-failure";
const REFUSAL_CLERK_CODE = "session_exists";

/** A hand-off that neither resolves nor rejects, so it is genuinely in flight. */
function arrangeOutstandingSso() {
  arrangeReady();
  sso.mockReturnValue(new Promise(() => undefined));
}

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

/**
 * jsdom refuses to redefine `location.assign`, so the whole object is stubbed —
 * the same shape the sibling link screen's suite uses.
 */
function makeLocationMock() {
  return { assign: vi.fn(), href: PAGE_URL, origin: new URL(PAGE_URL).origin };
}

const PAGE_URL = "https://app.closedloop.ai/connect/github";
let locationMock = makeLocationMock();

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  locationMock = makeLocationMock();
  vi.stubGlobal("location", locationMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  // `clearAllMocks` clears CALLS and keeps implementations, so the refused-report
  // case's `mockRejectedValue` would otherwise reject in every later case that
  // reports. Reset unconditionally here rather than at the end of that case: an
  // assertion throwing before the restore is exactly how one red becomes a file
  // of unrelated red.
  post.mockReset();
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
      // copy names it too, instead of telling everyone to pick GitHub. The
      // destination rides with it since ISS-10913, so that screen can mark the
      // sign-UP arm of the handshake — the account-created evidence.
      redirectCallbackUrl: `/sso-callback?provider=github&redirect_url=${encodeURIComponent(TARGET)}`,
    });
  });

  /**
   * ISS-11315: the sign-up hand-off leg's refusal is RECORDED, not discarded.
   *
   * `fail` took no argument before this, so `result.error` and a rejection were
   * both dropped and this leg left no artifact anywhere — which is why a
   * production recording of desktop onboarding locking could show that the
   * hand-off was refused and could not say by what. The sibling signed-in link
   * leg got exactly this treatment in ISS-11244.
   */
  it("reports the Clerk code when the hand-off is refused by value", async () => {
    arrangeReady();
    sso.mockResolvedValue({
      error: { errors: [{ code: REFUSAL_CLERK_CODE }] },
    });

    renderClient();

    await waitFor(() => {
      expect(post).toHaveBeenCalledTimes(1);
    });
    expect(post).toHaveBeenCalledWith(CLIENT_FAILURE_PATH, {
      clerkErrorCode: REFUSAL_CLERK_CODE,
      stage: "signup_handoff_refused",
    });
  });

  // The same record from the other path Clerk can fail on. A refusal that
  // REJECTS carried the identical `errors[]` shape and was discarded by the
  // identical bare `fail`, so both are pinned.
  it("reports the Clerk code when the hand-off rejects", async () => {
    arrangeReady();
    sso.mockRejectedValue({ errors: [{ code: REFUSAL_CLERK_CODE }] });

    renderClient();

    await waitFor(() => {
      expect(post).toHaveBeenCalledTimes(1);
    });
    expect(post).toHaveBeenCalledWith(CLIENT_FAILURE_PATH, {
      clerkErrorCode: REFUSAL_CLERK_CODE,
      stage: "signup_handoff_refused",
    });
  });

  // A refusal Clerk did not name still leaves a record: the STAGE is the fact
  // the page provably holds, and a codeless record is what says this leg
  // refused at all. Reported without a `clerkErrorCode` key rather than with a
  // null one, per the absent-optional-field rule.
  it("still reports the leg when the refusal carries no Clerk code", async () => {
    arrangeReady();
    sso.mockRejectedValue(new Error("no code here"));

    renderClient();

    await waitFor(() => {
      expect(post).toHaveBeenCalledTimes(1);
    });
    expect(post).toHaveBeenCalledWith(CLIENT_FAILURE_PATH, {
      stage: "signup_handoff_refused",
    });
  });

  /**
   * THE SIGNED-OUT LEG, which is most of this one (ISS-11315 review, tamsinb).
   *
   * This is the sign-UP hand-off, so the browser reaching it usually has no
   * session at all. `useApiClient` then sends no bearer, `withAnyAuth` refuses,
   * and the report is a 401 that `reportClientFailure` swallows by design — the
   * three cases above cannot show that, because a mocked `post` always resolves.
   *
   * WHAT IS PINNED is the degradation, not delivery: a refused report must not
   * take the panel with it. The reporter is fire-and-forget and the user is
   * already on their terminal screen, so a rejected POST has to leave that
   * screen intact and raise nothing. Opening an unauthenticated ingest so the
   * report WOULD arrive is a separate call on the auth boundary and is not made
   * here — see the reporter's own docstring, which no longer claims this leg
   * usually carries a session.
   */
  it("still shows the refusal panel when the report itself is refused", async () => {
    arrangeReady();
    sso.mockRejectedValue({ errors: [{ code: REFUSAL_CLERK_CODE }] });
    post.mockRejectedValue(
      Object.assign(new Error("Unauthorized"), { status: 401 })
    );

    renderClient();

    await waitFor(() => {
      expect(post).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByText(REFUSAL_BODY)).toBeInTheDocument();
  });

  // The positive half, so the three cases above are not satisfied by a page
  // that reports on every render: a hand-off that STARTS reports nothing.
  it("reports nothing when the hand-off starts normally", async () => {
    arrangeReady();
    sso.mockResolvedValue({ error: null });

    renderClient();

    await waitFor(() => {
      expect(sso).toHaveBeenCalledTimes(1);
    });
    expect(post).not.toHaveBeenCalled();
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
      redirectCallbackUrl: `/sso-callback?provider=google&redirect_url=${encodeURIComponent(TARGET)}`,
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
  //
  // ISS-10564: this is the one state where the ceiling may still END the wait —
  // nothing was outstanding, so the step it reports on is this page's own start.
  // The sentence says that, rather than implying GitHub answered.
  it("times out to the failure state when Clerk never loads", async () => {
    useClerkMock.mockReturnValue({ loaded: false });
    useSignInMock.mockReturnValue({ signIn: { sso } });

    renderClient();
    await vi.advanceTimersByTimeAsync(PAST_SSO_TIMEOUT_MS);

    expect(await screen.findByText(FAILURE_HEADING)).toBeInTheDocument();
    expect(screen.getByText(GITHUB_NEVER_STARTED_BODY)).toBeInTheDocument();
    expect(sso).not.toHaveBeenCalled();
    expect(
      screen.getByRole("link", { name: CONTINUE_TO_SIGN_IN })
    ).toHaveAttribute("href", FALLBACK);
  });

  // THE ISS-10564 REGRESSION. The ceiling observed no refusal — only that no
  // answer arrived in ten seconds — and this screen sits on the same desktop
  // journey as the device authorization that just succeeded. Before the fix it
  // painted "We couldn't open GitHub" over a hand-off that was still running.
  it("escalates the message instead of claiming failure when sso is still outstanding at the ceiling", async () => {
    arrangeOutstandingSso();

    renderClient();
    await vi.advanceTimersByTimeAsync(PAST_SSO_TIMEOUT_MS);

    expect(await screen.findByText(GITHUB_STALL_BODY)).toBeInTheDocument();
    expect(screen.getByText(REDIRECTING_HEADING)).toBeInTheDocument();
    expect(screen.queryByText(FAILURE_HEADING)).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    // The affordance the user already had at this moment is not withdrawn by
    // correcting what the screen claims.
    expect(
      screen.getByRole("link", { name: CONTINUE_TO_SIGN_IN })
    ).toHaveAttribute("href", FALLBACK);
  });

  // The stall names the leg that is outstanding, and the provider the user
  // actually picked — the wrong-door bug, one phase along.
  it("names the chosen provider in the stalled copy", async () => {
    arrangeOutstandingSso();

    renderClient(DesktopSignInProvider.Google);
    await vi.advanceTimersByTimeAsync(PAST_SSO_TIMEOUT_MS);

    expect(await screen.findByText(GOOGLE_STALL_BODY)).toBeInTheDocument();
    expect(screen.queryByText(GITHUB_STALL_BODY)).not.toBeInTheDocument();
  });

  // The in-flight phase's own bound. `sso()` is a Clerk SDK call with no
  // deadline of its own, so without this the stalled panel would wait forever —
  // the indefinite spinner the ceiling exists to prevent, one phase along.
  it("states that it stopped waiting once the in-flight bound expires", async () => {
    arrangeOutstandingSso();

    renderClient();
    await vi.advanceTimersByTimeAsync(PAST_SSO_TIMEOUT_MS);
    expect(await screen.findByText(GITHUB_STALL_BODY)).toBeInTheDocument();

    // Anchored on entering the phase, not on mount: escalating to Stalled must
    // not restart it, so the remaining budget is what is left of the 60s.
    await vi.advanceTimersByTimeAsync(
      DEFAULT_API_TIMEOUT_MS - PAST_SSO_TIMEOUT_MS + 1000
    );

    expect(await screen.findByText(GITHUB_UNANSWERED_BODY)).toBeInTheDocument();
    expect(screen.getByText(FAILURE_HEADING)).toBeInTheDocument();
    expect(screen.queryByText(GITHUB_STALL_BODY)).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "false");
    expect(
      screen.getByRole("link", { name: CONTINUE_TO_SIGN_IN })
    ).toHaveAttribute("href", FALLBACK);
  });

  // The in-flight bound sets a terminal state but cancels nothing, so the call
  // it gave up on can still settle. Before the attempt guard, a late rejection
  // rewrote "we stopped waiting" into a refusal the page never observed.
  it("keeps the stopped-waiting panel when the abandoned sso call rejects later", async () => {
    arrangeReady();
    let rejectSso: (reason: Error) => void = () => undefined;
    sso.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectSso = reject;
      })
    );

    renderClient();
    await vi.advanceTimersByTimeAsync(DEFAULT_API_TIMEOUT_MS + 1000);
    expect(await screen.findByText(GITHUB_UNANSWERED_BODY)).toBeInTheDocument();

    // `act` rather than a timer advance: the rejection reaches `fail` as a
    // microtask, and reading the DOM before React has flushed that update
    // measures the PREVIOUS render — which passes whether or not the guard is
    // there, so the counterfactual could not fail.
    await act(async () => {
      rejectSso(new Error("network down, far too late"));
      // Lets the rejection's own `.catch` microtask run inside this `act`, so
      // the flush below covers the state update it makes.
      await Promise.resolve();
    });

    expect(screen.getByText(GITHUB_UNANSWERED_BODY)).toBeInTheDocument();
    expect(
      screen.queryByText(REFUSAL_BODY),
      "a refusal the page never observed does not replace its own timeout"
    ).not.toBeInTheDocument();
  });

  // A Clerk client that loads AFTER the pre-flight ceiling must not revive the
  // spinner, and must not hand the browser to GitHub out from under a user who
  // has already been offered — and may already have taken — the way out.
  it("does not start the hand-off after the pre-flight ceiling has ended the wait", async () => {
    useClerkMock.mockImplementation(() => ({ loaded: false }));
    useSignInMock.mockImplementation(() => ({ signIn: { sso } }));
    sso.mockResolvedValue({ error: null });

    const { rerender } = renderClient();
    await vi.advanceTimersByTimeAsync(PAST_SSO_TIMEOUT_MS);
    expect(await screen.findByText(FAILURE_HEADING)).toBeInTheDocument();

    arrangeReady();
    rerender(
      <GitHubConnectRedirectClient
        fallbackSignInHref={FALLBACK}
        provider={DesktopSignInProvider.GitHub}
        redirectUrlComplete={TARGET}
      />
    );
    await vi.advanceTimersByTimeAsync(PAST_REVEAL_MS);

    expect(sso).not.toHaveBeenCalled();
    expect(screen.getByText(FAILURE_HEADING)).toBeInTheDocument();
    expect(screen.queryByText(REDIRECTING_HEADING)).not.toBeInTheDocument();
  });

  // ISS-10564 review (whitlockk): the bounds retire the ATTEMPT, but Clerk owns
  // `sso()`'s redirect internally and exposes no abort — a hand-off that
  // answers late still calls `window.location.assign` itself. A soft route
  // change keeps this document, and that call, alive, so the user who took the
  // way out is pulled off `/sign-in` and into the provider anyway. Taking the
  // way out therefore has to END this document.
  it("leaves for sign-in by a full document load, so a late hand-off cannot pull the user back", async () => {
    arrangeOutstandingSso();

    renderClient();
    await vi.advanceTimersByTimeAsync(DEFAULT_API_TIMEOUT_MS + 1000);
    expect(await screen.findByText(GITHUB_UNANSWERED_BODY)).toBeInTheDocument();

    const exit = screen.getByRole("link", { name: CONTINUE_TO_SIGN_IN });
    // Presence half of the pair: the anchor still carries the real href, so
    // middle-click and "open in new tab" keep working and the a11y tree still
    // announces a link to a destination.
    expect(exit).toHaveAttribute("href", FALLBACK);

    const clicked = fireEvent.click(exit, { button: 0 });

    expect(locationMock.assign).toHaveBeenCalledWith(FALLBACK);
    // Absence half, on the same locator: the soft route change is suppressed,
    // which is the only thing that tears down the context holding `sso()`.
    expect(
      clicked,
      "the soft navigation is cancelled so the document actually unloads"
    ).toBe(false);
  });

  // The browser's own meaning for a modifier click leaves THIS document
  // standing, so there is nothing to tear down and nothing to hijack.
  it("leaves a new-tab click to the browser", async () => {
    arrangeOutstandingSso();

    renderClient();
    await vi.advanceTimersByTimeAsync(DEFAULT_API_TIMEOUT_MS + 1000);
    expect(await screen.findByText(GITHUB_UNANSWERED_BODY)).toBeInTheDocument();

    const clicked = fireEvent.click(
      screen.getByRole("link", { name: CONTINUE_TO_SIGN_IN }),
      { button: 0, metaKey: true }
    );

    expect(locationMock.assign).not.toHaveBeenCalled();
    expect(clicked, "the default is not prevented").toBe(true);
  });
});
