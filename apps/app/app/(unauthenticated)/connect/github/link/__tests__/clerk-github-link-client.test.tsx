import { act, render, screen, waitFor } from "@testing-library/react";
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
    session: { lastActiveOrganizationId: "org_acme" as string | null },
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
import {
  GITHUB_CLERK_OAUTH_SCOPES,
  GITHUB_CLERK_RELINK_ATTEMPTED_PARAM,
} from "@repo/api/src/types/github-clerk-link";
import { DEFAULT_API_TIMEOUT_MS } from "@repo/app/shared/api/api-timeout";
import { ClerkGitHubLinkClient } from "../clerk-github-link-client";
import {
  GENERIC_FAILURE_DESCRIPTION,
  LINK_FAILURE_DESCRIPTION,
  LINK_THREW_DESCRIPTION,
  PendingLeg,
  PREFLIGHT_TIMEOUT_DESCRIPTION,
  REQUEST_UNANSWERED_DESCRIPTION,
  SIGN_IN_INTACT_SENTENCE,
  STILL_CONNECTING_DESCRIPTION,
} from "../link-failure-copy";
import {
  CLIENT_FAILURE_PATH,
  type FakeExternalAccount,
  LINK_REQUEST_PATH,
  makeLocationMock,
  PAGE_URL,
  PAST_REVEAL_MS,
  RESUME_PATH,
  RETURN_TO,
} from "./clerk-github-link-harness";

/**
 * Deliberate literals: the ISS-8156 pin has to fail when the CONSTANT changes,
 * so it cannot be written in terms of `GITHUB_CLERK_OAUTH_SCOPES`.
 */
const GITHUB_REPO_SCOPE_LITERAL = "repo";
const RETIRED_ORG_READ_SCOPE = "read:org";

const CONTINUE_TO_SIGN_IN = /continue to sign in/i;
const SCOPE_DENIAL_BODY = /doesn't include repository access/i;
const TRY_AGAIN = /try again/i;
const RESUME_CLAIM_FAILURE = /connecting the installed app didn't finish/i;

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

function clientElement(resumeInstallationId: string | null = null) {
  return (
    <ClerkGitHubLinkClient
      resumeInstallationId={resumeInstallationId}
      resumePath={RESUME_PATH}
      returnToPath={RETURN_TO}
    />
  );
}

function renderClient(resumeInstallationId: string | null = null) {
  return render(clientElement(resumeInstallationId));
}

beforeEach(() => {
  mocks.useClerk.mockReturnValue({
    session: { lastActiveOrganizationId: "org_acme" },
    setActive: vi.fn(),
  });
  vi.useFakeTimers({ shouldAdvanceTime: true });
  stubLocation(PAGE_URL);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ClerkGitHubLinkClient", () => {
  it("activates the sole Desktop-created organization before saving the GitHub link", async () => {
    stubLocation(
      "http://localhost:3000/connect/github/link?returnTo=%2Fdashboard"
    );
    const setActive = vi.fn().mockResolvedValue(undefined);
    mocks.useClerk.mockReturnValue({
      session: { lastActiveOrganizationId: null },
      setActive,
    });
    const getOrganizationMemberships = vi.fn().mockResolvedValue({
      total_count: 1,
      data: [{ organization: { id: "org_new", slug: "new-org" } }],
    });
    mocks.useUser.mockReturnValue({
      isLoaded: true,
      user: {
        externalAccounts: [
          { provider: "github", verification: { status: "verified" } },
        ],
        getOrganizationMemberships,
      },
    });
    mocks.post.mockResolvedValue({ linked: true });
    renderClient();
    await waitFor(() =>
      expect(locationMock.assign).toHaveBeenCalledWith(
        "/new-org/dashboard?github=connected"
      )
    );
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(setActive).toHaveBeenCalledWith({ organization: "org_new" });
    expect(setActive.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.post.mock.invocationCallOrder[0]
    );
  });

  it("does not choose an arbitrary organization for an older Desktop client", async () => {
    const setActive = vi.fn();
    mocks.useClerk.mockReturnValue({
      session: { lastActiveOrganizationId: null },
      setActive,
    });
    mocks.useUser.mockReturnValue({
      isLoaded: true,
      user: {
        externalAccounts: [
          { provider: "github", verification: { status: "verified" } },
        ],
        getOrganizationMemberships: vi.fn().mockResolvedValue({
          total_count: 2,
          data: [
            { organization: { id: "org_a", slug: "a" } },
            { organization: { id: "org_b", slug: "b" } },
          ],
        }),
      },
    });
    mocks.post.mockResolvedValue({ linked: false });
    renderClient();
    await waitFor(() => expect(mocks.post).toHaveBeenCalled());
    expect(setActive).not.toHaveBeenCalled();
  });

  it("offers sign-in that resumes THIS page, not the destination", async () => {
    mocks.useUser.mockReturnValue({ isLoaded: true, user: null });

    renderClient();
    await vi.advanceTimersByTimeAsync(PAST_REVEAL_MS);

    const signInLink = await screen.findByRole("link", {
      name: CONTINUE_TO_SIGN_IN,
    });
    // Signing in must land back on the linking flow with returnTo preserved —
    // landing on the destination would leave GitHub silently unconnected.
    expect(signInLink).toHaveAttribute(
      "href",
      `/sign-in?redirect_url=${encodeURIComponent(RESUME_PATH)}`
    );
    expect(locationMock.replace).not.toHaveBeenCalled();
  });

  it("times out a flow that never starts onto the failure panel", async () => {
    // Clerk never loads — the exact stall AUTH_TRANSITION_TIMEOUT_MS exists
    // for on the sibling routes.
    mocks.useUser.mockReturnValue({ isLoaded: false, user: null });

    renderClient();
    await vi.advanceTimersByTimeAsync(11_000);

    expect(
      await screen.findByRole("button", { name: TRY_AGAIN })
    ).toBeInTheDocument();
    expect(locationMock.assign).not.toHaveBeenCalled();
    expect(locationMock.replace).not.toHaveBeenCalled();
  });

  // ISS-10411: the mount ceiling used to flip a LIVE request onto the failure
  // panel, so a first-ever link taking longer than 10s was reported as
  // "Something interrupted the GitHub connection" — and then navigated the user
  // away on the success it had just denied. The request's own settlement
  // decides now; the ceiling may only escalate the message.
  it("never fails a slow link that ultimately succeeds", async () => {
    signedIn({
      externalAccounts: [
        { provider: "github", verification: { status: "verified" } },
      ],
    });
    let settleLink: (response: { linked: boolean }) => void = () => {
      // Replaced synchronously by the promise executor below.
    };
    mocks.post.mockImplementation(
      () =>
        new Promise<{ linked: boolean }>((resolve) => {
          settleLink = resolve;
        })
    );
    mocks.invalidateQueries.mockResolvedValue(undefined);

    renderClient();
    // Past the pre-flight ceiling with the POST still outstanding.
    await vi.advanceTimersByTimeAsync(11_000);

    expect(
      await screen.findByText(
        STILL_CONNECTING_DESCRIPTION[PendingLeg.ServerSync]
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: TRY_AGAIN })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(GENERIC_FAILURE_DESCRIPTION)
    ).not.toBeInTheDocument();

    settleLink({ linked: true });

    await waitFor(() => {
      expect(locationMock.assign).toHaveBeenCalledWith(
        "/acme/branches?github=connected"
      );
    });
    expect(
      screen.queryByRole("button", { name: TRY_AGAIN })
    ).not.toBeInTheDocument();
  });

  // ISS-10411: the ceiling above deliberately stops short of failing a live
  // request — but `createExternalAccount` is a Clerk SDK call the shared API
  // client's deadline never covers, so without a bound of its own the
  // first-ever link holds the spinner forever with no way out.
  it("ends an in-flight phase no request deadline covers, with a way out", async () => {
    const createExternalAccount = vi.fn().mockReturnValue(
      new Promise(() => {
        // A hung Clerk call: never settles.
      })
    );
    signedIn({ createExternalAccount });

    renderClient();
    await vi.advanceTimersByTimeAsync(11_000);

    expect(
      await screen.findByText(STILL_CONNECTING_DESCRIPTION[PendingLeg.GitHub])
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: TRY_AGAIN })
    ).not.toBeInTheDocument();

    // One second short of the deadline, which is anchored on ENTERING the
    // in-flight phase. Stepping right past it in a single advance would pass
    // either way, because a timer wrongly restarted at the InFlight → Stalled
    // escalation fires only 10s later and one long advance crosses both.
    await vi.advanceTimersByTimeAsync(DEFAULT_API_TIMEOUT_MS - 11_000 - 1000);

    expect(
      screen.getByText(STILL_CONNECTING_DESCRIPTION[PendingLeg.GitHub])
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: TRY_AGAIN })
    ).not.toBeInTheDocument();

    // Crossing the anchored deadline. A restarted one would still have 9s to
    // run, leaving the spinner up and every assertion below it red.
    await vi.advanceTimersByTimeAsync(2000);

    expect(
      await screen.findByText(REQUEST_UNANSWERED_DESCRIPTION[PendingLeg.GitHub])
    ).toBeInTheDocument();
    (await screen.findByRole("button", { name: TRY_AGAIN })).click();
    // The retry keeps the return target the desktop handed over.
    expect(locationMock.assign).toHaveBeenCalledWith(
      "/connect/github/link?returnTo=%2Facme%2Fbranches"
    );
    expect(mocks.post).not.toHaveBeenCalled();
  });

  // ISS-10411: the in-flight ceiling above sets the terminal state and cancels
  // nothing, so the POST it gave up on can still resolve. Before this guard the
  // late success navigated the user to `returnTo` off a panel that had just
  // told them the connection failed.
  it("does not navigate on a link that succeeds after the in-flight ceiling", async () => {
    signedIn({
      externalAccounts: [
        { provider: "github", verification: { status: "verified" } },
      ],
    });
    let settleLink: (response: { linked: boolean }) => void = () => {
      // Replaced synchronously by the promise executor below.
    };
    mocks.post.mockImplementation(
      () =>
        new Promise<{ linked: boolean }>((resolve) => {
          settleLink = resolve;
        })
    );
    mocks.invalidateQueries.mockResolvedValue(undefined);

    renderClient();
    await vi.advanceTimersByTimeAsync(DEFAULT_API_TIMEOUT_MS + 11_000);
    expect(
      await screen.findByText(
        REQUEST_UNANSWERED_DESCRIPTION[PendingLeg.ServerSync]
      )
    ).toBeInTheDocument();

    // Inside `act` so the continuation and any render it schedules are drained
    // before the assertions: an unflushed update would leave the panel looking
    // untouched whether or not the guard is there.
    await act(async () => {
      settleLink({ linked: true });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(
      screen.getByText(REQUEST_UNANSWERED_DESCRIPTION[PendingLeg.ServerSync])
    ).toBeInTheDocument();
    expect(locationMock.assign).not.toHaveBeenCalled();
  });

  // The other half of the same race: the superseded request rejecting must not
  // rewrite the sentence the user is already reading with a different reason.
  it("keeps the terminal copy when a retired link request then fails", async () => {
    signedIn({
      externalAccounts: [
        { provider: "github", verification: { status: "verified" } },
      ],
    });
    let rejectLink: (error: Error) => void = () => {
      // Replaced synchronously by the promise executor below.
    };
    mocks.post.mockImplementation(
      () =>
        new Promise<{ linked: boolean }>((_resolve, reject) => {
          rejectLink = reject;
        })
    );

    renderClient();
    await vi.advanceTimersByTimeAsync(DEFAULT_API_TIMEOUT_MS + 11_000);
    expect(
      await screen.findByText(
        REQUEST_UNANSWERED_DESCRIPTION[PendingLeg.ServerSync]
      )
    ).toBeInTheDocument();

    await act(async () => {
      rejectLink(new Error("refused"));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(
      screen.getByText(REQUEST_UNANSWERED_DESCRIPTION[PendingLeg.ServerSync])
    ).toBeInTheDocument();
    expect(
      screen.queryByText(GENERIC_FAILURE_DESCRIPTION)
    ).not.toBeInTheDocument();
    // ISS-11244: a retired attempt must not REPORT either. The report is a
    // post-await side effect and owes the ceiling the same deference as the copy
    // — and because emission is bounded per org per window, a retired attempt's
    // report would burn the slot the live retry's report needs, so the failure
    // the user actually retried would be the one that went unrecorded.
    expect(
      mocks.post.mock.calls.filter(([path]) => path === CLIENT_FAILURE_PATH)
    ).toHaveLength(0);
    // Non-vacuous: the link leg DID post on this same spy, so the assertion
    // above is about the retired REPORT and not about a spy that never ran.
    expect(mocks.post).toHaveBeenCalledWith(LINK_REQUEST_PATH, {});
  });

  // The same race across a navigation: leaving the route cancels the in-flight
  // request no more than the ceiling does, so a link that settles after the
  // mount is gone must not pull the user back to `returnTo` from wherever they
  // went.
  it("does not navigate on a link that succeeds after the user leaves", async () => {
    signedIn({
      externalAccounts: [
        { provider: "github", verification: { status: "verified" } },
      ],
    });
    let settleLink: (response: { linked: boolean }) => void = () => {
      // Replaced synchronously by the promise executor below.
    };
    mocks.post.mockImplementation(
      () =>
        new Promise<{ linked: boolean }>((resolve) => {
          settleLink = resolve;
        })
    );
    mocks.invalidateQueries.mockResolvedValue(undefined);

    const { unmount } = renderClient();
    await vi.advanceTimersByTimeAsync(PAST_REVEAL_MS);
    // The request is genuinely outstanding at the moment the mount goes away.
    expect(mocks.post).toHaveBeenCalledTimes(1);

    unmount();

    await act(async () => {
      settleLink({ linked: true });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(locationMock.assign).not.toHaveBeenCalled();
  });

  // The pre-flight stall and a GitHub refusal are different facts. Before
  // ISS-10411 both rendered the same generic sentence.
  it("names the pre-flight stall instead of blaming GitHub", async () => {
    mocks.useUser.mockReturnValue({ isLoaded: false, user: null });

    renderClient();
    await vi.advanceTimersByTimeAsync(11_000);

    expect(
      await screen.findByText(PREFLIGHT_TIMEOUT_DESCRIPTION)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(GENERIC_FAILURE_DESCRIPTION)
    ).not.toBeInTheDocument();
    // This ceiling is reached before `isLoaded`, so the panel must not claim
    // the Closedloop session held — that is the one fact it does not have.
    expect(
      screen.queryByText(SIGN_IN_INTACT_SENTENCE, { exact: false })
    ).not.toBeInTheDocument();
  });

  // The ceiling terminates a flow that never started, and a late `isLoaded`
  // flip must not reopen it: the panel would swap back to a spinner under a
  // user who had already been handed a way out.
  it("keeps the pre-flight failure when Clerk loads after the ceiling", async () => {
    mocks.useUser.mockReturnValue({ isLoaded: false, user: null });
    const createExternalAccount = vi.fn();

    const { rerender } = renderClient();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(
      await screen.findByRole("button", { name: TRY_AGAIN })
    ).toBeInTheDocument();

    signedIn({ createExternalAccount });
    rerender(clientElement());
    await vi.advanceTimersByTimeAsync(PAST_REVEAL_MS);

    expect(screen.getByRole("button", { name: TRY_AGAIN })).toBeInTheDocument();
    expect(createExternalAccount).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  // The outer catch covers every throw in the chain — a Clerk validation error
  // as much as a refused POST — so it may not claim we stopped waiting. That
  // sentence belongs to the in-flight deadline alone.
  //
  // ISS-11244 CHANGED THE EXPECTATION HERE, deliberately: a throw is no longer
  // reported as an unrecognised response shape. It is attributed to the leg that
  // was running, which for a refused link POST is the sync leg. The original
  // invariant is unchanged and still asserted — the sentence must not claim a
  // timeout. A plain `Error` carries no Clerk code, so the failure is still
  // REPORTED (that is the point of the ticket) but with no code to carry.
  it("attributes a thrown link request to the sync leg, not to residue", async () => {
    signedIn({
      externalAccounts: [
        { provider: "github", verification: { status: "verified" } },
      ],
    });
    mocks.post.mockRejectedValue(new Error("refused"));

    renderClient();
    await vi.advanceTimersByTimeAsync(PAST_REVEAL_MS);

    expect(
      await screen.findByText(LINK_THREW_DESCRIPTION[PendingLeg.ServerSync])
    ).toBeInTheDocument();
    expect(
      screen.queryByText(GENERIC_FAILURE_DESCRIPTION)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(REQUEST_UNANSWERED_DESCRIPTION[PendingLeg.ServerSync])
    ).not.toBeInTheDocument();
    expect(mocks.post).toHaveBeenCalledWith(CLIENT_FAILURE_PATH, {
      stage: GitHubClerkLinkClientFailureStage.Threw,
    });

    (await screen.findByRole("button", { name: TRY_AGAIN })).click();

    // ISS-10411's third bullet: the retry keeps the return target the desktop
    // handed over, from this newly reachable failure state too.
    expect(locationMock.assign).toHaveBeenCalledWith(
      "/connect/github/link?returnTo=%2Facme%2Fbranches"
    );
  });

  // ISS-10411: "Retry must retain the initiating desktop return target and not
  // duplicate or lose the connection attempt." The failure path used to reopen
  // the start guard, and the start effect re-runs on every render because
  // `useApiClient()` hands it a fresh object — so one refusal re-issued the
  // link POST behind a failure screen the user had not acted on.
  it("does not re-issue the link request behind the failure panel", async () => {
    stubLocation(`${PAGE_URL}&relink=1`);
    signedIn({
      externalAccounts: [
        {
          provider: "github",
          verification: { status: "verified" },
          reauthorize: vi.fn(),
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
      await screen.findByRole("button", { name: TRY_AGAIN })
    ).toBeInTheDocument();

    expect(mocks.post).toHaveBeenCalledTimes(1);
  });

  // ISS-10411: "If device login succeeds but GitHub authorization actually
  // fails, clearly distinguish those outcomes." The user has just completed a
  // device authorization, so the panel must say that half held.
  it("states the Closedloop sign-in survived when GitHub refuses", async () => {
    stubLocation(`${PAGE_URL}&relink=1`);
    signedIn({
      externalAccounts: [
        {
          provider: "github",
          verification: { status: "verified" },
          reauthorize: vi.fn(),
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
    ).toHaveTextContent(SIGN_IN_INTACT_SENTENCE);
  });

  it("starts Clerk linking for an enrolled org with no GitHub account", async () => {
    const verificationUrl = new URL("https://clerk.example.test/v1/verify");
    const createExternalAccount = vi.fn().mockResolvedValue({
      verification: { externalVerificationRedirectURL: verificationUrl },
    });
    signedIn({ createExternalAccount });

    renderClient();

    await waitFor(() => {
      expect(locationMock.assign).toHaveBeenCalledWith(verificationUrl.href);
    });
    expect(createExternalAccount).toHaveBeenCalledWith({
      additionalScopes: [...GITHUB_CLERK_OAUTH_SCOPES],
      strategy: "oauth_github",
      redirectUrl: PAGE_URL,
    });
  });

  it("syncs the registry then returns with the connected marker once verified", async () => {
    signedIn({
      externalAccounts: [
        { provider: "github", verification: { status: "verified" } },
      ],
    });
    mocks.post.mockResolvedValue({ linked: true });
    mocks.invalidateQueries.mockResolvedValue(undefined);

    renderClient();

    await waitFor(() => {
      expect(locationMock.assign).toHaveBeenCalledWith(
        "/acme/branches?github=connected"
      );
    });
    expect(mocks.post).toHaveBeenCalledWith(
      "/integrations/github/clerk-link",
      {}
    );
  });

  /**
   * ISS-10459: the server cannot otherwise tell a terminal
   * `insufficient_scope` from the benign one this page answers by re-linking,
   * so it emits no failure record without this marker. The unmarked POST
   * above is its negative control — dropping the marker here leaves that one
   * green.
   */
  it("marks the post-consent link request as a re-link attempt", async () => {
    stubLocation(`${PAGE_URL}&${GITHUB_CLERK_RELINK_ATTEMPTED_PARAM}=1`);
    signedIn({
      externalAccounts: [
        { provider: "github", verification: { status: "verified" } },
      ],
    });
    mocks.post.mockResolvedValue({ linked: true });
    mocks.invalidateQueries.mockResolvedValue(undefined);

    renderClient();

    await waitFor(() => {
      expect(mocks.post).toHaveBeenCalledWith(
        `/integrations/github/clerk-link?${GITHUB_CLERK_RELINK_ATTEMPTED_PARAM}=1`,
        {}
      );
    });
  });

  it("destroys a stale unverified account before re-linking", async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    const verificationUrl = new URL("https://clerk.example.test/v1/verify");
    const createExternalAccount = vi.fn().mockResolvedValue({
      verification: { externalVerificationRedirectURL: verificationUrl },
    });
    signedIn({
      createExternalAccount,
      externalAccounts: [
        { provider: "github", verification: { status: "unverified" }, destroy },
      ],
    });

    renderClient();

    await waitFor(() => {
      expect(locationMock.assign).toHaveBeenCalledWith(verificationUrl.href);
    });
    expect(destroy).toHaveBeenCalled();
  });

  // PLN-1742 M5: a verified narrow-scope account is no longer a dead end —
  // it re-links in place through GitHub's consent screen, so the denial
  // panel is reserved for a consent that ALREADY happened and still failed.
  it("re-links a verified narrow-scope account through GitHub consent", async () => {
    const verificationUrl = new URL(
      "https://clerk.example.test/v1/reauthorize"
    );
    const reauthorize = vi.fn().mockResolvedValue({
      verification: { externalVerificationRedirectURL: verificationUrl },
    });
    signedIn({
      externalAccounts: [
        {
          provider: "github",
          verification: { status: "verified" },
          reauthorize,
        },
      ],
    });
    mocks.post.mockResolvedValue({
      linked: false,
      reason: GitHubAccessDenialReason.InsufficientScope,
    });

    renderClient();

    await waitFor(() => {
      expect(locationMock.assign).toHaveBeenCalledWith(verificationUrl.href);
    });
    expect(reauthorize).toHaveBeenCalledWith({
      additionalScopes: [...GITHUB_CLERK_OAUTH_SCOPES],
      redirectUrl: `${PAGE_URL}&relink=1`,
    });
  });

  // ISS-8156: `read:org` was requested but nothing consumed it — the one
  // org-scoped read on a user token (`orgs.getMembershipForAuthenticatedUser`,
  // the installation-claim ownership proof) accepts `repo`, which is already
  // the enforced floor. Asserted on the scopes the page actually HANDS Clerk,
  // not on the constant, so re-adding it anywhere upstream fails here.
  it("asks GitHub for repository access without read:org when re-linking", async () => {
    const reauthorize = vi.fn().mockResolvedValue({
      verification: {
        externalVerificationRedirectURL: new URL(
          "https://clerk.example.test/v1/reauthorize"
        ),
      },
    });
    signedIn({
      externalAccounts: [
        {
          provider: "github",
          verification: { status: "verified" },
          reauthorize,
        },
      ],
    });
    mocks.post.mockResolvedValue({
      linked: false,
      reason: GitHubAccessDenialReason.InsufficientScope,
    });

    renderClient();

    await waitFor(() => {
      expect(reauthorize).toHaveBeenCalled();
    });
    const requestedScopes: string[] =
      reauthorize.mock.calls[0][0].additionalScopes;
    expect(requestedScopes).toContain(GITHUB_REPO_SCOPE_LITERAL);
    expect(requestedScopes).not.toContain(RETIRED_ORG_READ_SCOPE);
  });

  // whitlockk cid 3865731045 / codex cid 3865693817: the re-link pin above left the
  // FIRST-time link unasserted, and that path handed Clerk no scopes at all —
  // so what a new user was asked for came solely from the dashboard config.
  // This is the in-repo half: the fresh link now names the same set. The
  // dashboard half is an operator action `additionalScopes` cannot perform.
  it("asks GitHub for repository access without read:org on a first-time link", async () => {
    const createExternalAccount = vi.fn().mockResolvedValue({
      verification: {
        externalVerificationRedirectURL: new URL(
          "https://clerk.example.test/v1/verify"
        ),
      },
    });
    signedIn({ createExternalAccount });

    renderClient();

    await waitFor(() => {
      expect(createExternalAccount).toHaveBeenCalled();
    });
    const requestedScopes: string[] | undefined =
      createExternalAccount.mock.calls[0][0].additionalScopes;
    // Named explicitly: handing Clerk NO scopes is the exact regression here,
    // and it must read as that rather than as a `toContain(undefined)` type error.
    expect(Array.isArray(requestedScopes)).toBe(true);
    expect(requestedScopes).toContain(GITHUB_REPO_SCOPE_LITERAL);
    expect(requestedScopes).not.toContain(RETIRED_ORG_READ_SCOPE);
  });

  it("surfaces the scope denial after a re-link attempt still lacks repo", async () => {
    stubLocation(`${PAGE_URL}&relink=1`);
    const reauthorize = vi.fn();
    signedIn({
      externalAccounts: [
        {
          provider: "github",
          verification: { status: "verified" },
          reauthorize,
        },
      ],
    });
    mocks.post.mockResolvedValue({
      linked: false,
      reason: GitHubAccessDenialReason.InsufficientScope,
    });

    renderClient();
    await vi.advanceTimersByTimeAsync(PAST_REVEAL_MS);

    expect(await screen.findByText(SCOPE_DENIAL_BODY)).toBeInTheDocument();
    expect(reauthorize).not.toHaveBeenCalled();
    expect(locationMock.assign).not.toHaveBeenCalled();
  });

  // PLN-1742 M5: the install callback hands over an installed-but-unclaimed
  // installation rather than dead-ending on "Failed to connect".
  it("finishes the install callback's pending claim once linking succeeds", async () => {
    signedIn({
      externalAccounts: [
        { provider: "github", verification: { status: "verified" } },
      ],
    });
    mocks.post.mockResolvedValue({ linked: true });
    mocks.invalidateQueries.mockResolvedValue(undefined);

    renderClient("42");

    await waitFor(() => {
      expect(locationMock.assign).toHaveBeenCalledWith(
        "/acme/branches?github=connected"
      );
    });
    expect(mocks.post).toHaveBeenCalledWith("/integrations/github/connect", {
      installationId: "42",
    });
  });

  it("does not claim anything when no installation was handed over", async () => {
    signedIn({
      externalAccounts: [
        { provider: "github", verification: { status: "verified" } },
      ],
    });
    mocks.post.mockResolvedValue({ linked: true });
    mocks.invalidateQueries.mockResolvedValue(undefined);

    renderClient();

    await waitFor(() => {
      expect(locationMock.assign).toHaveBeenCalled();
    });
    expect(mocks.post).not.toHaveBeenCalledWith(
      "/integrations/github/connect",
      expect.anything()
    );
  });

  it("says so when the link succeeded but the pending claim did not", async () => {
    signedIn({
      externalAccounts: [
        { provider: "github", verification: { status: "verified" } },
      ],
    });
    mocks.post.mockImplementation((path: string) =>
      path === "/integrations/github/connect"
        ? Promise.reject(new Error("claim refused"))
        : Promise.resolve({ linked: true })
    );

    renderClient("42");
    await vi.advanceTimersByTimeAsync(PAST_REVEAL_MS);

    expect(await screen.findByText(RESUME_CLAIM_FAILURE)).toBeInTheDocument();
    expect(locationMock.assign).not.toHaveBeenCalled();
  });

  it("offers a retry that can actually reach GitHub consent again", async () => {
    // A plain reload would keep `relink=1`, which is precisely what blocks a
    // second consent — so "Try again" would provably change nothing.
    stubLocation(`${PAGE_URL}&relink=1`);
    signedIn({
      externalAccounts: [
        {
          provider: "github",
          verification: { status: "verified" },
          reauthorize: vi.fn(),
        },
      ],
    });
    mocks.post.mockResolvedValue({
      linked: false,
      reason: GitHubAccessDenialReason.InsufficientScope,
    });

    renderClient();
    await vi.advanceTimersByTimeAsync(PAST_REVEAL_MS);
    (await screen.findByRole("button", { name: TRY_AGAIN })).click();

    expect(locationMock.assign).toHaveBeenCalledWith(
      "/connect/github/link?returnTo=%2Facme%2Fbranches"
    );
  });

  it("fails onto the panel when reauthorize yields no consent URL", async () => {
    const reauthorize = vi.fn().mockResolvedValue({ verification: null });
    signedIn({
      externalAccounts: [
        {
          provider: "github",
          verification: { status: "verified" },
          reauthorize,
        },
      ],
    });
    mocks.post.mockResolvedValue({
      linked: false,
      reason: GitHubAccessDenialReason.InsufficientScope,
    });

    renderClient();
    await vi.advanceTimersByTimeAsync(PAST_REVEAL_MS);

    expect(await screen.findByText(SCOPE_DENIAL_BODY)).toBeInTheDocument();
    expect(locationMock.assign).not.toHaveBeenCalled();
  });
});
