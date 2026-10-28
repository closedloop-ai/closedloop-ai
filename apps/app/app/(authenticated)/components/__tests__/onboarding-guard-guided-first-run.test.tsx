// @vitest-environment jsdom

/**
 * ISS-11072: a Web reader whose legacy team/project wizard is incomplete and
 * whose guided run's takeover is up stays on the page they opened, under the
 * takeover, instead of being routed through `/onboarding` first. Drives the
 * REAL web host, shared host, snapshot and status queries, and guard over one
 * QueryClient in the production topology (host in the sidebar, outside the
 * guard). Stubbed: the transport, Clerk, navigation, and the leaf reads the
 * takeover's first screens do not route on.
 */

import type { OnboardingStatus } from "@repo/api/src/types/onboarding";
import type { GuidedOnboardingSnapshot } from "@repo/api/src/types/onboarding-guided";
import {
  OnboardingRestoreOutcome,
  serializeOnboardingState,
} from "@repo/api/src/types/onboarding-persistence";
import {
  AccountProvider,
  AccountStatus,
  KnownFlag,
  OnboardingHost,
  type OnboardingMachineState,
  OnboardingPhase,
  OrganizationMembership,
} from "@repo/api/src/types/onboarding-phase";
import { WorkspaceExperience } from "@repo/api/src/types/workspace-experience";
import {
  IDLE_INVITE_OUTCOME,
  UNKNOWN_ORGANIZATION_MEMBERS,
} from "@repo/app/onboarding/components/guided-onboarding-data";
import { guidedOnboardingKeys } from "@repo/app/onboarding/hooks/use-guided-onboarding";
import { onboardingKeys } from "@repo/app/onboarding/hooks/use-onboarding";
import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import { createStaticAuthAdapter } from "@repo/app/shared/auth/static-auth-adapter";
import {
  queryRetryDelay,
  shouldRetryQuery,
} from "@repo/app/shared/query/query-client";
import {
  type DefaultOptions,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebFeatureFlagProvider } from "@/__tests__/helpers/web-feature-flag-provider";
import { WebGuidedOnboardingDialogHost } from "../guided-onboarding-dialog-host";
import { OnboardingGuard } from "../onboarding-guard";

const ME_PATH = "/me";
/** Only the organization row id is read off it (ISS-11253 rename route). */
const CURRENT_USER = { id: "user-a", organizationId: "org-db-a" };

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  navigate: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({ get: mocks.apiGet, post: vi.fn() }),
}));

vi.mock("@repo/auth/client", () => ({
  useClerk: () => ({ signOut: vi.fn(() => Promise.resolve()) }),
  useOrganization: () => ({ organization: { name: "Acme" } }),
  useOrganizationList: () => ({
    createOrganization: vi.fn(),
    setActive: vi.fn(),
  }),
  useUser: () => ({
    user: {
      emailAddresses: [],
      primaryEmailAddress: { emailAddress: "ada@example.test" },
    },
  }),
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: mocks.navigate, replace: mocks.replace }),
}));

vi.mock("@repo/navigation/use-path", () => ({
  usePath: () => DASHBOARD_PATH,
}));

vi.mock("@repo/app/github/hooks/use-github-integration", () => ({
  useGitHubIntegrationStatus: () => ({ data: null }),
}));

vi.mock("@/hooks/use-github-authorize-href", () => ({
  useGitHubAuthorizeHref: () => "/github/connect",
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useNavOrgSlug: () => "acme",
}));

vi.mock("@repo/app/onboarding/hooks/use-onboarding-invite-team", () => ({
  useOnboardingInviteTeam: () => ({
    invite: vi.fn(),
    invitedEmails: [],
    outcome: IDLE_INVITE_OUTCOME,
  }),
}));

vi.mock(
  "@repo/app/onboarding/hooks/use-onboarding-organization-members",
  () => ({
    useOnboardingOrganizationMembers: () => UNKNOWN_ORGANIZATION_MEMBERS,
  })
);

vi.mock("@repo/app/shared/settings-host/use-local-sync-policy", () => ({
  useLocalSyncPolicy: () => ({
    isWriting: false,
    state: { status: "loading" },
    supported: false,
    write: vi.fn(),
    writeOutcome: null,
  }),
}));

describe("OnboardingGuard — guided first run on Web (ISS-11072)", () => {
  let mounts = 0;

  beforeEach(() => {
    vi.clearAllMocks();
    mounts = 0;
  });

  it("keeps a new organization's reader on the Dashboard under the Welcome takeover, through a background refetch", async () => {
    // The guided read answers after `/onboarding` does, so the guard first
    // sees an incomplete wizard with the guided answer still in flight.
    let answerSnapshot: () => void = () => undefined;
    const snapshotAnswered = new Promise<void>((resolve) => {
      answerSnapshot = resolve;
    });
    serve(FRESH_RUN, Promise.resolve(), snapshotAnswered);
    const queryClient = renderShell();

    await waitFor(() =>
      expect(
        queryClient.getQueryData(onboardingKeys.status("org-a", "user-a"))
      ).toEqual(INCOMPLETE_STATUS)
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(screen.queryByText(CONTENT_TEXT)).not.toBeInTheDocument();
    expect(mocks.replace).not.toHaveBeenCalled();
    await act(async () => {
      answerSnapshot();
      await snapshotAnswered;
    });

    const takeover = await screen.findByRole("dialog");
    expect(
      within(takeover).getByText(WELCOME_HEADING_TEXT)
    ).toBeInTheDocument();
    expect(await screen.findByText(CONTENT_TEXT)).toBeInTheDocument();
    expect(mocks.replace).not.toHaveBeenCalled();

    // Held in flight so the refetching render is observable, not batched away.
    let answerRefetch: () => void = () => undefined;
    const refetched = new Promise<void>((resolve) => {
      answerRefetch = resolve;
    });
    const readsBefore = mocks.apiGet.mock.calls.length;
    serve(FRESH_RUN, refetched);
    act(() => {
      queryClient.invalidateQueries();
    });
    // Named rather than counted. The subject is that the guided snapshot AND
    // the status are both re-read while the region stays put; a bare count also
    // moves whenever the tree mounts one more query, which is what happened when
    // the onboarding host started reading `/me` for the organization row id.
    await waitFor(() =>
      expect(
        mocks.apiGet.mock.calls
          .slice(readsBefore)
          .map((call) => String(call[0]))
          .map((path) =>
            path.startsWith(SNAPSHOT_PATH_PREFIX) ? SNAPSHOT_PATH_PREFIX : path
          )
          .sort()
      ).toEqual([ME_PATH, SNAPSHOT_PATH_PREFIX, STATUS_PATH].sort())
    );
    expect(screen.getByText(CONTENT_TEXT)).toBeInTheDocument();

    await act(async () => {
      answerRefetch();
      await refetched;
    });
    expect(screen.getByText(CONTENT_TEXT)).toBeInTheDocument();
    expect(mounts).toBe(1);
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  // ISS-11072 review: a guided read that blipped is pending between attempts.
  // Under the shared client's own retry policy it stays in flight across the
  // backoff, so the region neither flashes content nor redirects before the
  // retry answers.
  it("keeps the region blank without redirecting while a failed guided read waits to retry", {
    timeout: 10_000,
  }, async () => {
    let guidedReads = 0;
    mocks.apiGet.mockImplementation((path: string) => {
      if (path === STATUS_PATH) {
        return Promise.resolve(INCOMPLETE_STATUS);
      }
      if (path === ME_PATH) {
        return Promise.resolve(CURRENT_USER);
      }
      guidedReads += 1;
      // A bare network error: the one failure `shouldRetryQuery` retries.
      return guidedReads === 1
        ? Promise.reject(new TypeError("Failed to fetch"))
        : Promise.resolve(FRESH_RUN);
    });
    const queryClient = renderShell({
      retry: shouldRetryQuery,
      retryDelay: queryRetryDelay,
    });

    await waitFor(() =>
      expect(
        queryClient.getQueryState(
          guidedOnboardingKeys.snapshot(OnboardingHost.Web, "org-a", "user-a")
        )?.fetchFailureCount
      ).toBe(1)
    );
    expect(guidedReads).toBe(1);
    expect(screen.queryByText(CONTENT_TEXT)).not.toBeInTheDocument();
    expect(mocks.replace).not.toHaveBeenCalled();

    const takeover = await screen.findByRole("dialog", undefined, {
      timeout: 5000,
    });
    expect(
      within(takeover).getByText(WELCOME_HEADING_TEXT)
    ).toBeInTheDocument();
    expect(await screen.findByText(CONTENT_TEXT)).toBeInTheDocument();
    expect(guidedReads).toBe(2);
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("resumes a run persisted mid-takeover instead of routing to the legacy wizard", async () => {
    serve(RUN_PARKED_ON_INVITE);
    renderShell();

    const takeover = await screen.findByRole("dialog");
    expect(within(takeover).getByText(INVITE_HEADING_TEXT)).toBeInTheDocument();
    expect(await screen.findByText(CONTENT_TEXT)).toBeInTheDocument();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  function ContentRegion() {
    useEffect(() => {
      mounts += 1;
    }, []);
    return <div>{CONTENT_TEXT}</div>;
  }

  function renderShell(
    queries: DefaultOptions["queries"] = { retry: false }
  ): QueryClient {
    const queryClient = new QueryClient({ defaultOptions: { queries } });
    render(
      <QueryClientProvider client={queryClient}>
        <AuthAdapterProvider
          adapter={createStaticAuthAdapter({
            isLoaded: true,
            orgId: "org-a",
            userId: "user-a",
          })}
        >
          <WebGuidedOnboardingDialogHost />
          <OnboardingGuard>
            <ContentRegion />
          </OnboardingGuard>
        </AuthAdapterProvider>
      </QueryClientProvider>,
      { wrapper: WebFeatureFlagProvider }
    );
    return queryClient;
  }
});

const DASHBOARD_PATH = "/acme/dashboard";
const STATUS_PATH = "/onboarding";
const SNAPSHOT_PATH_PREFIX = "/onboarding/guided/snapshot";
const CONTENT_TEXT = "content region";
const WELCOME_HEADING_TEXT = "Discover how you (and your team) build with AI.";
const INVITE_HEADING_TEXT = "Invite people you build with";

/**
 * A new organization: no team, project, or legacy wizard marker, and the
 * reader's guided run has not left its takeover — so `/onboarding` reports the
 * wizard incomplete, exactly as it does for the run in both cases.
 */
const INCOMPLETE_STATUS: OnboardingStatus = {
  checklist: [],
  checklistDismissed: false,
  wizardCompleted: false,
};

const FRESH_RUN = snapshot(
  {
    accountProvider: null,
    history: [],
    organizationEstablished: false,
    phase: OnboardingPhase.Welcome,
    resuming: false,
  },
  { attemptId: null, revision: 0 }
);

const RUN_PARKED_ON_INVITE = snapshot(
  {
    accountProvider: AccountProvider.GitHub,
    history: [OnboardingPhase.Welcome, OnboardingPhase.CreateOrganization],
    organizationEstablished: true,
    phase: OnboardingPhase.InviteTeam,
    resuming: false,
  },
  { attemptId: "attempt-1", revision: 3 }
);

/** Answers both reads once `answered` settles, the guided one once `guidedAnswered` does. */
function serve(
  guidedRun: GuidedOnboardingSnapshot,
  answered: Promise<void> = Promise.resolve(),
  guidedAnswered: Promise<void> = answered
) {
  mocks.apiGet.mockImplementation(async (path: string) => {
    await answered;
    if (path.startsWith(SNAPSHOT_PATH_PREFIX)) {
      await guidedAnswered;
      return guidedRun;
    }
    if (path === STATUS_PATH) {
      return INCOMPLETE_STATUS;
    }
    if (path === ME_PATH) {
      return CURRENT_USER;
    }
    throw new Error(`unexpected GET ${path}`);
  });
}

function snapshot(
  state: OnboardingMachineState,
  attempt: { attemptId: string | null; revision: number }
): GuidedOnboardingSnapshot {
  const persisted = attempt.attemptId !== null;
  return {
    attemptId: attempt.attemptId,
    context: {
      accountProvider: AccountProvider.GitHub,
      accountStatus: AccountStatus.Established,
      desktopAppDownloaded: false,
      githubConnected: false,
      membership: OrganizationMembership.FirstUser,
      organizationHasSyncedSessionData: KnownFlag.No,
      teamInvited: false,
      tourCompleted: false,
    },
    experienceVariant: persisted ? WorkspaceExperience.V2 : null,
    restoreOutcome: persisted
      ? OnboardingRestoreOutcome.Restored
      : OnboardingRestoreOutcome.Absent,
    revision: attempt.revision,
    state: serializeOnboardingState(state),
  };
}
