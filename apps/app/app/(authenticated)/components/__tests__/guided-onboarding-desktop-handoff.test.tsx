// @vitest-environment jsdom

/**
 * ISS-10988, the Desktop-originated path end to end on the web shell.
 *
 * Finishing the takeover's last step hands off to the Dashboard, where
 * `OnboardingGuard` routes on the status answer it has cached. This drives the
 * REAL web host, shared host, transition hook, status query and guard over one
 * QueryClient. Stubbed: the transport, Clerk, navigation, and the leaf reads
 * the last step does not route on (GitHub status and authorize link, org slug,
 * invites, members, local sync policy, platform detection).
 *
 * ISS-11912 moved where that run happens. This suite used to drive the whole
 * thing ON the desktop authorize route, because the sidebar-mounted takeover
 * opened over the consent card there — which is the defect the operator ruled
 * out: a desktop sign-up must hand back to Desktop at once and let Desktop run
 * its own tail (sync policy, then invite). So the handoff is now driven from an
 * ordinary authenticated route, and the authorize route keeps its own case
 * below as the counterfactual: the guard still exempts it, and the takeover is
 * no longer there.
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
  OnboardingPhase,
  OrganizationMembership,
} from "@repo/api/src/types/onboarding-phase";
import { WorkspaceExperience } from "@repo/api/src/types/workspace-experience";
import {
  IDLE_INVITE_OUTCOME,
  UNKNOWN_ORGANIZATION_MEMBERS,
} from "@repo/app/onboarding/components/guided-onboarding-data";
import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import { createStaticAuthAdapter } from "@repo/app/shared/auth/static-auth-adapter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebFeatureFlagProvider } from "@/__tests__/helpers/web-feature-flag-provider";
import { WebGuidedOnboardingDialogHost } from "../guided-onboarding-dialog-host";
import { OnboardingGuard } from "../onboarding-guard";

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  navigate: vi.fn(),
  pathListeners: new Set<() => void>(),
  pathname: "",
  replace: vi.fn(),
}));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({ get: mocks.apiGet, post: mocks.apiPost }),
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

// A path store, so a navigation re-renders every reader of the path the way
// the router does — the guard must SEE the handoff, not a later forced render.
vi.mock("@repo/navigation/use-path", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    mocks.pathListeners.add(listener);
    return () => mocks.pathListeners.delete(listener);
  };
  return {
    usePath: () => useSyncExternalStore(subscribe, () => mocks.pathname),
  };
});

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

// Pinned to the pre-detection arm so the step's forward control does not
// depend on the platform the suite happens to run on.
vi.mock("@repo/app/onboarding/hooks/use-detected-desktop-os", () => ({
  useDetectedDesktopOs: () => null,
}));

/** The route Desktop opens in the browser; `OnboardingGuard` exempts it and
 * the guided takeover no longer renders over it (ISS-11912). */
const DESKTOP_AUTHORIZE_PATH = "/acme/settings/integrations/desktop/authorize";
const DASHBOARD_PATH = "/acme/dashboard";
/** An ordinary authenticated route — one the takeover is still owed on. */
const SESSIONS_PATH = "/acme/sessions";
const ONBOARDING_PATH = "/onboarding";
const STATUS_PATH = "/onboarding";
const SNAPSHOT_PATH_PREFIX = "/onboarding/guided/snapshot";
const FINAL_STEP_REVISION = 5;
const CONTINUE_WITHOUT_INSTALLING = /continue without installing/i;

function status(wizardCompleted: boolean): OnboardingStatus {
  return { checklist: [], checklistDismissed: false, wizardCompleted };
}

function webSnapshot(
  phase: OnboardingPhase,
  history: OnboardingPhase[],
  revision: number
): GuidedOnboardingSnapshot {
  return {
    attemptId: "attempt-1",
    context: {
      accountProvider: AccountProvider.GitHub,
      accountStatus: AccountStatus.Established,
      // Desktop-originated: the reader already runs the desktop app.
      desktopAppDownloaded: true,
      githubConnected: true,
      membership: OrganizationMembership.FirstUser,
      organizationHasSyncedSessionData: KnownFlag.No,
      teamInvited: true,
      tourCompleted: false,
    },
    experienceVariant: WorkspaceExperience.V2,
    restoreOutcome: OnboardingRestoreOutcome.Restored,
    revision,
    state: serializeOnboardingState({
      accountProvider: AccountProvider.GitHub,
      history,
      organizationEstablished: true,
      phase,
      resuming: false,
    }),
  };
}

const RUN_BEFORE_LAST_STEP = [
  OnboardingPhase.Welcome,
  OnboardingPhase.CreateOrganization,
  OnboardingPhase.InviteTeam,
];

/** The web run parked on its last blocking step: the desktop download gate. */
const finalStepSnapshot = webSnapshot(
  OnboardingPhase.DownloadDesktop,
  RUN_BEFORE_LAST_STEP,
  FINAL_STEP_REVISION
);

/** What the transition answers once that step is taken. */
const dashboardSnapshot = webSnapshot(
  OnboardingPhase.DashboardAvailable,
  [...RUN_BEFORE_LAST_STEP, OnboardingPhase.DownloadDesktop],
  FINAL_STEP_REVISION + 1
);

function Shell() {
  // The production topology: the takeover host lives in the sidebar, OUTSIDE
  // the guard that wraps the content region.
  return (
    <>
      <WebGuidedOnboardingDialogHost />
      <OnboardingGuard>
        <div>content region</div>
      </OnboardingGuard>
    </>
  );
}

function renderShell() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree = (
    <QueryClientProvider client={queryClient}>
      <AuthAdapterProvider
        adapter={createStaticAuthAdapter({
          isLoaded: true,
          orgId: "org-a",
          userId: "user-a",
        })}
      >
        <Shell />
      </AuthAdapterProvider>
    </QueryClientProvider>
  );
  render(tree, { wrapper: WebFeatureFlagProvider });
}

function statusReads() {
  return mocks.apiGet.mock.calls.filter(([path]) => path === STATUS_PATH);
}

describe("Desktop-originated web onboarding — last step to next destination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pathname = SESSIONS_PATH;
    // The server's answers, in order: incomplete while the run is mid-takeover,
    // complete once its last step has landed (ISS-10988's server half).
    let finished = false;
    mocks.apiGet.mockImplementation((path: string) => {
      if (path.startsWith(SNAPSHOT_PATH_PREFIX)) {
        return Promise.resolve(
          finished ? dashboardSnapshot : finalStepSnapshot
        );
      }
      if (path === STATUS_PATH) {
        return Promise.resolve(status(finished));
      }
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
    mocks.apiPost.mockImplementation(() => {
      finished = true;
      return Promise.resolve(dashboardSnapshot);
    });
    // The web host's `onDashboardAvailable` navigates.
    mocks.navigate.mockImplementation((href: string) => {
      mocks.pathname = href;
      for (const listener of mocks.pathListeners) {
        listener();
      }
    });
  });

  it("lands on the Dashboard instead of being routed back to /onboarding", async () => {
    renderShell();

    // The content renders while the guard holds this reader's incomplete
    // status from the server and the takeover is up over it.
    expect(await screen.findByText("content region")).toBeInTheDocument();
    await waitFor(() => expect(statusReads()).toHaveLength(1));
    const takeover = await screen.findByRole("dialog");
    fireEvent.click(
      within(takeover).getByRole("button", {
        name: CONTINUE_WITHOUT_INSTALLING,
      })
    );

    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith(DASHBOARD_PATH)
    );
    // Settled once the guard has either redirected or gone back to the server.
    await waitFor(() =>
      expect(
        mocks.replace.mock.calls.length + statusReads().length
      ).toBeGreaterThan(1)
    );
    expect(mocks.replace).not.toHaveBeenCalledWith(ONBOARDING_PATH);
    expect(await screen.findByText("content region")).toBeInTheDocument();
    expect(statusReads()).toHaveLength(2);
  });

  /**
   * ISS-11912 counterfactual, and the half of the old contract that is still
   * live. The guard's exemption is unchanged — the consent page renders while
   * the reader's status is incomplete, with no detour to `/onboarding` — but
   * the takeover that used to open over it does not, so the reader reaches
   * Connect and Desktop owns the rest of the run. Asserted by ROLE: the
   * consent page mounts no dialog of its own, so any dialog here is the
   * takeover.
   */
  it("leaves the desktop authorize route to the consent page", async () => {
    mocks.pathname = DESKTOP_AUTHORIZE_PATH;

    renderShell();

    expect(await screen.findByText("content region")).toBeInTheDocument();
    await waitFor(() => expect(statusReads()).toHaveLength(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.replace).not.toHaveBeenCalledWith(ONBOARDING_PATH);
  });
});
