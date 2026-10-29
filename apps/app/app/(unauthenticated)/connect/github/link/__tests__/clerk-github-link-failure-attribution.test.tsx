/**
 * ISS-11244: how a FAILURE of the Clerk GitHub link is attributed and reported.
 *
 * Split from `clerk-github-link-client.test.tsx`, which owns the flow itself —
 * timeouts, stalls, retries, the M5 re-link, the pending-install claim. This file
 * owns one concern: what the user is told when a leg refuses, and what reaches the
 * monitor. The `vi.mock` block is duplicated rather than shared because mocks are
 * hoisted per file; the mock-free fixtures come from the harness module.
 */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  // ISS-11315: assigned in `beforeEach` from `makeReverificationMock()` so each
  // case gets its own recorder; the hoisted object is only the mock SLOT.
  useReverification: ((fetcher: unknown) => fetcher) as unknown as <
    Args extends unknown[],
    Result,
  >(
    fetcher: (...args: Args) => Result
  ) => (...args: Args) => Result,
  useUser: vi.fn(),
  useClerk: vi.fn(() => ({
    session: { lastActiveOrganizationId: "org_acme" },
    setActive: vi.fn(),
  })),
  post: vi.fn(),
  invalidateQueries: vi.fn(),
}));

vi.mock("@repo/auth/client", () => ({
  // Delegates rather than reading the property once: the factory runs at module
  // init, so a `beforeEach` that rebinds `mocks.useReverification` would never
  // be seen by a direct reference and every case would silently share the
  // slot's initial value (ISS-11315).
  useReverification: <Args extends unknown[], Result>(
    fetcher: (...args: Args) => Result
  ) => mocks.useReverification(fetcher),
  useUser: mocks.useUser,
  useClerk: mocks.useClerk,
}));

vi.mock("@repo/app/github/hooks/use-github-integration", () => ({
  githubKeys: { all: ["github"] },
}));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({ post: mocks.post }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));

vi.mock("@repo/navigation/link", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

import {
  GitHubAccessDenialReason,
  GitHubClerkLinkClientFailureStage,
} from "@repo/api/src/types/github";
import { ApiError } from "@repo/app/shared/api/api-error";
import {
  API_TIMEOUT_ERROR_CODE,
  DEFAULT_API_TIMEOUT_MS,
} from "@repo/app/shared/api/api-timeout";
import { ClerkGitHubLinkClient } from "../clerk-github-link-client";
import {
  CLERK_LINK_ERROR_DESCRIPTION,
  ClerkLinkErrorCode,
  GENERIC_FAILURE_DESCRIPTION,
  LINK_FAILURE_DESCRIPTION,
  LINK_THREW_DESCRIPTION,
  PendingLeg,
  REQUEST_UNANSWERED_DESCRIPTION,
  REVERIFICATION_CANCELLED_DESCRIPTION,
} from "../link-failure-copy";
import {
  CLIENT_FAILURE_PATH,
  DESTROY_FAILED_CLERK_CODE,
  FakeClerkApiResponseError,
  type FakeExternalAccount,
  FakeReverificationCancelledError,
  makeLocationMock,
  makeReverificationMock,
  PAGE_URL,
  PAST_REVEAL_MS,
  RESUME_PATH,
  RETURN_TO,
  UNRECOGNISED_CLERK_CODE,
} from "./clerk-github-link-harness";

/** Top-level per `useTopLevelRegex`; asserted against the sync-leg sentence. */
const REFUSED_WORD = /refused/;
const RETRY_BUTTON = /try again/i;

let locationMock = makeLocationMock(PAGE_URL);

function stubLocation(url: string) {
  locationMock = makeLocationMock(url);
  vi.stubGlobal("location", locationMock);
}

function signedIn(options: {
  externalAccounts?: FakeExternalAccount[];
  createExternalAccount?: ReturnType<typeof vi.fn>;
}) {
  mocks.useUser.mockReturnValue({
    isLoaded: true,
    user: {
      externalAccounts: options.externalAccounts ?? [],
      createExternalAccount:
        options.createExternalAccount ??
        vi.fn().mockResolvedValue({ verification: null }),
    },
  });
}

function renderClient() {
  return render(
    <ClerkGitHubLinkClient
      resumeInstallationId={null}
      resumePath={RESUME_PATH}
      returnToPath={RETURN_TO}
    />
  );
}

/**
 * ISS-11315: what actually ran through `useReverification` this case. Reset per
 * case in `beforeEach`, where the hook mock is also rebound, so one case's
 * recording can never satisfy another's assertion.
 */
let reverifiedCalls: unknown[][] = [];

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  stubLocation(PAGE_URL);
  const reverification = makeReverificationMock();
  reverifiedCalls = reverification.reverifiedCalls;
  mocks.useReverification = reverification.useReverification;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ClerkGitHubLinkClient failure attribution", () => {
  /**
   * ISS-11315, the headline: the GitHub hand-off runs THROUGH Clerk's
   * re-verification, so a session Clerk considers stale is re-verified and the
   * call retried instead of refused.
   *
   * Production, 2026-09-27: four `github_clerk_link_failed` records, every one
   * `clerkErrorCode=session_reverification_required`, `stage=threw` — the
   * operator's click and his retries, all against a raw
   * `user.createExternalAccount()`. The code is not recognised, so the panel
   * showed the leg sentence and its "Try again" re-ran the same unwrapped call
   * into the same wall.
   *
   * Asserts the ARGUMENTS reached the wrapper, not merely that the hook was
   * called: a component that calls `useReverification` and then invokes the raw
   * method anyway is exactly the shipped defect, and it would satisfy a
   * call-count assertion.
   */
  it("creates the external account through Clerk re-verification", async () => {
    const createExternalAccount = vi.fn().mockResolvedValue({
      verification: {
        externalVerificationRedirectURL: new URL("https://github.test/consent"),
      },
    });
    signedIn({ createExternalAccount });

    renderClient();

    await waitFor(() => {
      expect(createExternalAccount).toHaveBeenCalledTimes(1);
    });
    // Two arguments: the NARROWED user, then the params. The user is passed
    // rather than closed over so the wrapper cannot return `undefined` and have
    // that read as "Clerk answered without a redirect URL" (ISS-11315 review).
    expect(reverifiedCalls).toEqual([
      [
        expect.objectContaining({ createExternalAccount }),
        {
          additionalScopes: expect.any(Array),
          redirectUrl: PAGE_URL,
          strategy: "oauth_github",
        },
      ],
    ]);
  });

  // The stale-account branch takes the same treatment: `destroy()` is an
  // SSO-connection change too, so calling it raw refuses on the same session
  // and strands the reader one step earlier, before the hand-off is reached.
  it("destroys a stale account through Clerk re-verification", async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    const stale: FakeExternalAccount = {
      destroy,
      provider: "github",
      verification: { status: "unverified" },
    };
    signedIn({ externalAccounts: [stale] });

    renderClient();

    await waitFor(() => {
      expect(destroy).toHaveBeenCalledTimes(1);
    });
    // The stale account goes through FIRST; the hand-off that follows it is
    // the case above's subject, so only the ordering is pinned here.
    expect(reverifiedCalls[0]).toEqual([stale]);
  });

  /**
   * A reader who DISMISSES Clerk's prompt, which WRAPPING the SSO-connection
   * calls is what made reachable: before it there was no prompt to dismiss.
   *
   * Both halves are pinned. The record keeps it apart from a refusal — "they
   * changed their mind" and "Clerk said no" are different facts and the monitor
   * is the only place that difference is read. And the reader now gets a
   * sentence that names the dismissal instead of the leg sentence, which says
   * only that the round trip did not finish; the absence of that sentence is
   * asserted too, because a page that rendered both would satisfy the first
   * half alone.
   *
   * Its control is the ISS-11244 headline case below: a throw that is NOT a
   * cancellation still reports `stage: "threw"` with its Clerk code, so this
   * cannot be satisfied by a page that reported `reverification_cancelled` for
   * everything.
   */
  it("names the dismissal, and records it apart from a refusal", async () => {
    const createExternalAccount = vi
      .fn()
      .mockRejectedValue(new FakeReverificationCancelledError());
    signedIn({ createExternalAccount });

    renderClient();

    await vi.advanceTimersByTimeAsync(PAST_REVEAL_MS);

    expect(
      screen.getByText(REVERIFICATION_CANCELLED_DESCRIPTION)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(LINK_THREW_DESCRIPTION[PendingLeg.GitHub])
    ).not.toBeInTheDocument();
    expect(mocks.post).toHaveBeenCalledWith(CLIENT_FAILURE_PATH, {
      stage: "reverification_cancelled",
    });
  });

  // ISS-11244, the headline. The bare catch this replaces rendered the
  // unrecognised-shape sentence for a Clerk refusal on the GitHub hand-off and
  // emitted nothing, so the failure the operator hit on 2026-09-26 could not be
  // named from outside their browser. Three things are pinned together because
  // AC4 is only met by all three: the leg is named, the residue sentence is NOT
  // what renders, and the Clerk code reaches the monitored event.
  it("names the hand-off leg and reports the Clerk code when the hand-off throws", async () => {
    const createExternalAccount = vi
      .fn()
      .mockRejectedValue(
        new FakeClerkApiResponseError(UNRECOGNISED_CLERK_CODE)
      );
    signedIn({ createExternalAccount });

    renderClient();
    await vi.advanceTimersByTimeAsync(PAST_REVEAL_MS);

    expect(
      await screen.findByText(LINK_THREW_DESCRIPTION[PendingLeg.GitHub])
    ).toBeInTheDocument();
    expect(
      screen.queryByText(GENERIC_FAILURE_DESCRIPTION)
    ).not.toBeInTheDocument();
    expect(mocks.post).toHaveBeenCalledWith(CLIENT_FAILURE_PATH, {
      clerkErrorCode: UNRECOGNISED_CLERK_CODE,
      stage: GitHubClerkLinkClientFailureStage.Threw,
    });
    // The hand-off never reached the link route, so nothing must have posted
    // there — a report that also resolved the identity would kick a
    // post-connect sync off a link that failed.
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });

  // The recognition map is consulted, not decorative: without this the case
  // above passes against a classifier that ignores the code entirely and always
  // returns the leg sentence. `identification_deletion_failed` is the code
  // ISS-11244 asked about — whether `existing.destroy()` can fail on its own —
  // and it gets a sentence neither the leg nor the residue arm can express.
  it("says the previous link could not be cleared when destroy refuses", async () => {
    const destroy = vi
      .fn()
      .mockRejectedValue(
        new FakeClerkApiResponseError(DESTROY_FAILED_CLERK_CODE)
      );
    const createExternalAccount = vi.fn();
    signedIn({
      createExternalAccount,
      externalAccounts: [
        { destroy, provider: "github", verification: { status: "unverified" } },
      ],
    });

    renderClient();
    await vi.advanceTimersByTimeAsync(PAST_REVEAL_MS);

    expect(
      await screen.findByText(
        CLERK_LINK_ERROR_DESCRIPTION[
          ClerkLinkErrorCode.IdentificationDeletionFailed
        ]
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByText(LINK_THREW_DESCRIPTION[PendingLeg.GitHub])
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(GENERIC_FAILURE_DESCRIPTION)
    ).not.toBeInTheDocument();
    // The stale account is still attached, so the hand-off must not proceed as
    // though it had been cleared.
    expect(createExternalAccount).not.toHaveBeenCalled();
    expect(mocks.post).toHaveBeenCalledWith(CLIENT_FAILURE_PATH, {
      clerkErrorCode: DESTROY_FAILED_CLERK_CODE,
      stage: GitHubClerkLinkClientFailureStage.Threw,
    });
    // The const the classifier dispatches on must BE that wire code.
    expect(ClerkLinkErrorCode.IdentificationDeletionFailed).toBe(
      DESTROY_FAILED_CLERK_CODE
    );
  });

  // ISS-11244 AC4's second half. The residue arm stays reachable for a genuinely
  // unrecognised shape — Clerk resolving with no redirect URL and no refusal —
  // and that is exactly where "renders a generic sentence and emits nothing"
  // was not an acceptable terminal state. The sentence is unchanged; what
  // changed is that it is no longer silent.
  it("reports the residue arm it still renders", async () => {
    const createExternalAccount = vi
      .fn()
      .mockResolvedValue({ verification: null });
    signedIn({ createExternalAccount });

    renderClient();
    await vi.advanceTimersByTimeAsync(PAST_REVEAL_MS);

    expect(
      await screen.findByText(GENERIC_FAILURE_DESCRIPTION)
    ).toBeInTheDocument();
    // No Clerk code to carry: nothing threw. The STAGE is what makes the
    // report actionable — three client-observed paths resolve without an error
    // of any kind, so without it they reach the monitor indistinguishable.
    expect(mocks.post).toHaveBeenCalledWith(CLIENT_FAILURE_PATH, {
      stage: GitHubClerkLinkClientFailureStage.HandoffNoRedirect,
    });
  });

  /**
   * THE PANEL MUST NOT DEPEND ON THE DIAGNOSTIC. Found by splitting this suite:
   * an `apiClient.post` that throws SYNCHRONOUSLY — rather than returning a
   * rejected promise — skipped `fail` entirely and stranded the user on the
   * spinner. A lost diagnostic must never become a dead end.
   *
   * TWO GUARDS NOW STOP IT and this case pins the PAIR, not either one: the
   * panel is rendered before the report is attempted, AND the report contains its
   * own synchronous throw. Either alone is sufficient, so removing one keeps this
   * green — verified, and stated here rather than left for the next reader to
   * discover that a single-line revert does not redden it.
   */
  it("still tells the user when the failure report itself throws", async () => {
    const createExternalAccount = vi
      .fn()
      .mockRejectedValue(
        new FakeClerkApiResponseError(UNRECOGNISED_CLERK_CODE)
      );
    signedIn({ createExternalAccount });
    mocks.post.mockImplementation(() => {
      throw new Error("client refused before returning a promise");
    });

    renderClient();
    await vi.advanceTimersByTimeAsync(PAST_REVEAL_MS);

    expect(
      await screen.findByText(LINK_THREW_DESCRIPTION[PendingLeg.GitHub])
    ).toBeInTheDocument();
    // Non-vacuous: the report WAS attempted on this same spy, so the panel above
    // rendered despite the throw rather than because nothing was tried.
    expect(mocks.post).toHaveBeenCalledWith(CLIENT_FAILURE_PATH, {
      clerkErrorCode: UNRECOGNISED_CLERK_CODE,
      stage: GitHubClerkLinkClientFailureStage.Threw,
    });
  });

  /**
   * WHY THE SYNC-LEG SENTENCE MUST STAY LEG-GENERIC. More than the link POST can
   * throw inside this leg: `reauthorize()` on the narrow-scope re-link path never
   * attempted a save at all, and `completeLinkedFlow` runs only AFTER the server
   * answered `linked: true`, where the save provably succeeded. A sentence naming
   * a refused save would be false in both, so this pins that a reauthorize throw
   * lands on the leg sentence and the residue arm is still not what renders.
   */
  it("attributes a reauthorize throw to the sync leg without claiming a refused save", async () => {
    const reauthorize = vi.fn().mockRejectedValue(new Error("clerk refused"));
    signedIn({
      externalAccounts: [
        {
          provider: "github",
          reauthorize,
          verification: { status: "verified" },
        },
      ],
    });
    mocks.post.mockResolvedValue({
      linked: false,
      reason: GitHubAccessDenialReason.InsufficientScope,
    });

    renderClient();
    await vi.advanceTimersByTimeAsync(PAST_REVEAL_MS);

    expect(
      await screen.findByText(LINK_THREW_DESCRIPTION[PendingLeg.ServerSync])
    ).toBeInTheDocument();
    expect(reauthorize).toHaveBeenCalled();
    expect(
      screen.queryByText(GENERIC_FAILURE_DESCRIPTION)
    ).not.toBeInTheDocument();
    // No save was attempted on this path, so the sentence must not name one.
    expect(LINK_THREW_DESCRIPTION[PendingLeg.ServerSync]).not.toMatch(
      REFUSED_WORD
    );
  });

  /**
   * A CLOSEDLOOP-SIDE DEADLINE MUST NOT BE TOLD AS A GITHUB-SIDE REFUSAL.
   *
   * `apiClient.post` carries its own `DEFAULT_API_TIMEOUT_MS`, armed inside the
   * effect body — before React can commit the `InFlight` state that schedules
   * the page's own equal-length timer — so on a hung sync request the client's
   * deadline ALWAYS rejects first and the page's own stopped-waiting path never
   * runs. Classifying that rejection by the Clerk schema would render "didn't
   * complete", which is the same conflation this ticket exists to remove, one
   * layer up. Raised by whitlockk on PR #7968.
   */
  it("keeps the stopped-waiting sentence when the client's own deadline expires", async () => {
    signedIn({
      externalAccounts: [
        { provider: "github", verification: { status: "verified" } },
      ],
    });
    mocks.post.mockRejectedValueOnce(
      new ApiError("timed out", 0, API_TIMEOUT_ERROR_CODE)
    );

    renderClient();
    await vi.advanceTimersByTimeAsync(PAST_REVEAL_MS);

    expect(
      await screen.findByText(
        REQUEST_UNANSWERED_DESCRIPTION[PendingLeg.ServerSync]
      )
    ).toBeInTheDocument();
    // The sentence a deadline must never borrow: it asserts the round trip
    // reached a conclusion, and a client-side abort reached none.
    expect(
      screen.queryByText(LINK_THREW_DESCRIPTION[PendingLeg.ServerSync])
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(GENERIC_FAILURE_DESCRIPTION)
    ).not.toBeInTheDocument();
    // Still reported, and now SEPARABLE in the monitor: a deadline the user was
    // correctly told about is still a customer who could not connect, and this
    // record is the only artifact the leg leaves when the server never answered.
    expect(mocks.post).toHaveBeenCalledWith(CLIENT_FAILURE_PATH, {
      apiErrorCode: API_TIMEOUT_ERROR_CODE,
      apiErrorStatus: 0,
      stage: GitHubClerkLinkClientFailureStage.Threw,
    });
  });

  /**
   * The other half of the same arm. `ApiError` has no `errors[]` array, so before
   * this every sync-leg throw posted one codeless record and a timeout, an
   * expired session and a refused POST were indistinguishable in the monitor —
   * "that is the leg this ticket most needs named". Raised by tamsinb on #7968.
   */
  it("carries the API status and code when the sync leg is refused outright", async () => {
    signedIn({
      externalAccounts: [
        { provider: "github", verification: { status: "verified" } },
      ],
    });
    mocks.post.mockRejectedValueOnce(
      new ApiError("session expired", 401, "session_expired")
    );

    renderClient();
    await vi.advanceTimersByTimeAsync(PAST_REVEAL_MS);

    expect(
      await screen.findByText(LINK_THREW_DESCRIPTION[PendingLeg.ServerSync])
    ).toBeInTheDocument();
    // A refusal IS an answer, so it must not claim we stopped waiting.
    expect(
      screen.queryByText(REQUEST_UNANSWERED_DESCRIPTION[PendingLeg.ServerSync])
    ).not.toBeInTheDocument();
    expect(mocks.post).toHaveBeenCalledWith(CLIENT_FAILURE_PATH, {
      apiErrorCode: "session_expired",
      apiErrorStatus: 401,
      stage: GitHubClerkLinkClientFailureStage.Threw,
    });
  });

  /**
   * THE ONE TERMINAL DENIAL THAT LEFT NO ARTIFACT ON EITHER SIDE. `reauthorize()`
   * resolving without a consent URL drops through to the `insufficient_scope`
   * fallback — and the API deliberately does NOT record that denial before
   * consent (`isPreConsentScopeWidening`), because before consent it is normally
   * a step inside a link that then succeeds. So the server stayed silent by
   * design and the client reported nothing, on a state the user cannot get out
   * of. Raised by whitlockk on #7968.
   *
   * The rendered sentence is deliberately UNCHANGED — the fallback already
   * renders exactly it, and what the page learned here is not something the
   * reader can act on differently. Only the silence is fixed.
   */
  it("reports the re-link that never got a consent URL", async () => {
    const reauthorize = vi.fn().mockResolvedValue({ verification: null });
    signedIn({
      externalAccounts: [
        {
          provider: "github",
          reauthorize,
          verification: { status: "verified" },
        },
      ],
    });
    mocks.post.mockResolvedValue({
      linked: false,
      reason: GitHubAccessDenialReason.InsufficientScope,
    });

    renderClient();
    await vi.advanceTimersByTimeAsync(PAST_REVEAL_MS);

    expect(
      await screen.findByText(
        LINK_FAILURE_DESCRIPTION[GitHubAccessDenialReason.InsufficientScope]
      )
    ).toBeInTheDocument();
    // Non-vacuous: the branch under test is the one that RAN.
    expect(reauthorize).toHaveBeenCalled();
    expect(mocks.post).toHaveBeenCalledWith(CLIENT_FAILURE_PATH, {
      stage: GitHubClerkLinkClientFailureStage.ReauthorizeNoConsentUrl,
    });
    // Not the residue arm, and not a throw: this path observed a recognised
    // denial and simply had nowhere to send the user.
    expect(
      screen.queryByText(GENERIC_FAILURE_DESCRIPTION)
    ).not.toBeInTheDocument();
  });
});

describe("ISS-12627 GitHub callback errors", () => {
  it.each(["oauth_identification_claimed", "future_callback_error"])(
    "stops a returned %s error without deleting or restarting the link",
    async (code) => {
      const destroy = vi.fn();
      const createExternalAccount = vi.fn();
      signedIn({
        externalAccounts: [
          {
            provider: "github",
            verification: {
              status: "unverified",
              error: { code, message: "private provider detail" },
            },
            destroy,
          },
        ],
        createExternalAccount,
      });
      mocks.post.mockResolvedValue({ recorded: true });
      const view = renderClient();
      await vi.advanceTimersByTimeAsync(PAST_REVEAL_MS);

      expect(screen.getByText(GENERIC_FAILURE_DESCRIPTION)).toBeInTheDocument();
      expect(mocks.post).toHaveBeenCalledExactlyOnceWith(CLIENT_FAILURE_PATH, {
        stage: GitHubClerkLinkClientFailureStage.Threw,
        clerkErrorCode: code,
      });
      view.rerender(
        <ClerkGitHubLinkClient
          resumeInstallationId={null}
          resumePath={RESUME_PATH}
          returnToPath={RETURN_TO}
        />
      );
      await vi.advanceTimersByTimeAsync(11_000);
      expect(destroy).not.toHaveBeenCalled();
      expect(createExternalAccount).not.toHaveBeenCalled();
      expect(locationMock.assign).not.toHaveBeenCalled();
      expect(mocks.post).toHaveBeenCalledTimes(1);
    }
  );

  it("contains a malformed callback error and omits an unavailable code", async () => {
    const destroy = vi.fn();
    signedIn({
      externalAccounts: [
        {
          provider: "github",
          verification: { status: "unverified", error: { code: "" } },
          destroy,
        },
      ],
    });
    mocks.post.mockResolvedValue({ recorded: true });
    renderClient();
    await vi.advanceTimersByTimeAsync(PAST_REVEAL_MS);
    expect(screen.getByText(GENERIC_FAILURE_DESCRIPTION)).toBeInTheDocument();
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(CLIENT_FAILURE_PATH, {
      stage: GitHubClerkLinkClientFailureStage.Threw,
    });
    expect(destroy).not.toHaveBeenCalled();
    expect(locationMock.assign).not.toHaveBeenCalled();
  });

  it("clears the failed account only after explicit retry and preserves the return target", async () => {
    let completeDestroy!: () => void;
    const destroy = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          completeDestroy = resolve;
        })
    );
    const failedAccount = {
      provider: "github",
      verification: {
        status: "unverified",
        error: { code: "oauth_identification_claimed" },
      },
      destroy,
    };
    const createExternalAccount = vi.fn();
    signedIn({ externalAccounts: [failedAccount], createExternalAccount });
    mocks.post.mockResolvedValue({ recorded: true });
    stubLocation(`${PAGE_URL}&relink=1&resumeInstallationId=42`);
    renderClient();
    await vi.advanceTimersByTimeAsync(PAST_REVEAL_MS);
    fireEvent.click(screen.getByRole("button", { name: RETRY_BUTTON }));
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(reverifiedCalls).toEqual([[failedAccount]]);
    expect(locationMock.assign).not.toHaveBeenCalled();
    await act(async () => completeDestroy());
    expect(locationMock.assign).toHaveBeenCalledExactlyOnceWith(
      `${RESUME_PATH}&resumeInstallationId=42`
    );
    expect(createExternalAccount).not.toHaveBeenCalled();
  });

  it("reports a refused explicit cleanup and keeps the failure recoverable", async () => {
    const destroy = vi
      .fn()
      .mockRejectedValue(
        new FakeClerkApiResponseError(DESTROY_FAILED_CLERK_CODE)
      );
    signedIn({
      externalAccounts: [
        {
          provider: "github",
          verification: {
            status: "unverified",
            error: { code: "oauth_identification_claimed" },
          },
          destroy,
        },
      ],
    });
    mocks.post.mockResolvedValue({ recorded: true });
    renderClient();
    await vi.advanceTimersByTimeAsync(PAST_REVEAL_MS);
    fireEvent.click(screen.getByRole("button", { name: RETRY_BUTTON }));
    await vi.advanceTimersByTimeAsync(PAST_REVEAL_MS);
    expect(
      screen.getByText(
        CLERK_LINK_ERROR_DESCRIPTION[
          ClerkLinkErrorCode.IdentificationDeletionFailed
        ]
      )
    ).toBeInTheDocument();
    expect(mocks.post).toHaveBeenLastCalledWith(CLIENT_FAILURE_PATH, {
      stage: GitHubClerkLinkClientFailureStage.Threw,
      clerkErrorCode: DESTROY_FAILED_CLERK_CODE,
    });
    expect(locationMock.assign).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: RETRY_BUTTON })
    ).toBeInTheDocument();
  });
});

it.each(["unmount", "expiry"])(
  "ISS-12627 ignores late explicit-retry completion after %s",
  async (end) => {
    let completeDestroy!: () => void;
    const destroy = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          completeDestroy = resolve;
        })
    );
    signedIn({
      externalAccounts: [
        {
          provider: "github",
          verification: {
            status: "unverified",
            error: { code: "oauth_identification_claimed" },
          },
          destroy,
        },
      ],
    });
    mocks.post.mockResolvedValue({ recorded: true });
    const view = renderClient();
    await vi.advanceTimersByTimeAsync(PAST_REVEAL_MS);
    fireEvent.click(await screen.findByRole("button", { name: RETRY_BUTTON }));
    expect(destroy).toHaveBeenCalledTimes(1);
    if (end === "unmount") {
      view.unmount();
    } else {
      await vi.advanceTimersByTimeAsync(
        DEFAULT_API_TIMEOUT_MS + PAST_REVEAL_MS
      );
      expect(
        screen.getByText(REQUEST_UNANSWERED_DESCRIPTION[PendingLeg.GitHub])
      ).toBeInTheDocument();
    }
    await act(async () => completeDestroy());
    expect(locationMock.assign).not.toHaveBeenCalled();
    expect(mocks.post).toHaveBeenCalledTimes(1);
  }
);

it.each(["resolve", "reject"])(
  "ISS-12627 retries expired cleanup while its late %s cannot finish the newer attempt",
  async (firstOutcome) => {
    let completeFirstDestroy!: () => void;
    let rejectFirstDestroy!: (error: Error) => void;
    let completeSecondDestroy!: () => void;
    const destroy = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve, reject) => {
            completeFirstDestroy = resolve;
            rejectFirstDestroy = reject;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            completeSecondDestroy = resolve;
          })
      );
    signedIn({
      externalAccounts: [
        {
          provider: "github",
          verification: {
            status: "unverified",
            error: { code: "oauth_identification_claimed" },
          },
          destroy,
        },
      ],
    });
    mocks.post.mockResolvedValue({ recorded: true });
    stubLocation(`${PAGE_URL}&relink=1&resumeInstallationId=42`);
    renderClient();
    await vi.advanceTimersByTimeAsync(PAST_REVEAL_MS);
    fireEvent.click(await screen.findByRole("button", { name: RETRY_BUTTON }));
    expect(destroy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DEFAULT_API_TIMEOUT_MS + PAST_REVEAL_MS);
    expect(
      screen.getByText(REQUEST_UNANSWERED_DESCRIPTION[PendingLeg.GitHub])
    ).toBeInTheDocument();

    const retry = screen.getByRole("button", { name: RETRY_BUTTON });
    act(() => {
      retry.click();
      retry.click();
    });
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(locationMock.assign).not.toHaveBeenCalled();

    if (firstOutcome === "reject") {
      await act(async () =>
        rejectFirstDestroy(new Error("expired cleanup refused"))
      );
    }
    expect(locationMock.assign).not.toHaveBeenCalled();
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: RETRY_BUTTON })).toBeNull();

    await act(async () => completeSecondDestroy());
    expect(locationMock.assign).toHaveBeenCalledExactlyOnceWith(
      `${RESUME_PATH}&resumeInstallationId=42`
    );
    if (firstOutcome === "resolve") {
      await act(async () => completeFirstDestroy());
    }
    expect(locationMock.assign).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(reverifiedCalls).toHaveLength(2);
    expect(mocks.post).toHaveBeenCalledTimes(1);
  }
);
