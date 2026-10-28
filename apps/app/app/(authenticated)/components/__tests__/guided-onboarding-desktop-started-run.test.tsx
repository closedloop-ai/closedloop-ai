// @vitest-environment jsdom

/**
 * Operator ruling, 2026-10-10: "web shouldn't start an onboarding if desktop
 * has started, no one should get 2 of them".
 *
 * The recorded case: a Google sign-in in Desktop creates the organization,
 * skips the invite, connects GitHub in the browser and lands on
 * `/<org>/dashboard?github=connected`. The Desktop run's history holds
 * Desktop-only phases, so the server restores it for the Web reader as a fresh
 * Welcome — and the web host opened that as a second wizard. Driven through
 * the REAL web host, shared host and dialog.
 */

import {
  GUIDED_ONBOARDING_SNAPSHOT_PATH,
  type GuidedOnboardingSnapshot,
} from "@repo/api/src/types/onboarding-guided";
import {
  OnboardingRestoreOutcome,
  serializeOnboardingState,
} from "@repo/api/src/types/onboarding-persistence";
import {
  AccountProvider,
  AccountStatus,
  createInitialOnboardingState,
  KnownFlag,
  OnboardingHost,
  OnboardingPhase,
  OrganizationMembership,
} from "@repo/api/src/types/onboarding-phase";
import { WorkspaceExperience } from "@repo/api/src/types/workspace-experience";
import { guidedOnboardingKeys } from "@repo/app/onboarding/hooks/use-guided-onboarding";
import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import { createStaticAuthAdapter } from "@repo/app/shared/auth/static-auth-adapter";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebGuidedOnboardingDialogHost } from "../guided-onboarding-dialog-host";
import { OnboardingGuard } from "../onboarding-guard";

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({
    get: mocks.apiGet,
    post: mocks.apiPost,
    put: vi.fn(),
  }),
}));

vi.mock("@repo/auth/client", () => ({
  useClerk: () => ({ signOut: vi.fn(() => Promise.resolve()) }),
  useOrganization: () => ({
    isLoaded: true,
    organization: { name: "New DMG Org Onboarding" },
  }),
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
  useNavigation: () => ({ navigate: vi.fn(), replace: mocks.replace }),
}));

vi.mock("@repo/navigation/use-path", () => ({
  usePath: () => "/new-dmg-org-onboarding/dashboard",
}));

vi.mock("@repo/app/github/hooks/use-github-integration", () => ({
  useGitHubIntegrationStatus: () => ({ data: null }),
}));

vi.mock("@/hooks/use-github-authorize-href", () => ({
  useGitHubAuthorizeHref: () => "/github/connect",
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useNavOrgSlug: () => "new-dmg-org-onboarding",
}));

const USER_ID = "user-a";
const ORG_ID = "org-a";

/**
 * What the server answers the Web reader for the recorded run: the Desktop
 * state is unreachable on Web, so it is reported as a fresh Welcome.
 */
function webSnapshotOfRun(
  startedOnHost: OnboardingHost | undefined
): GuidedOnboardingSnapshot {
  return {
    attemptId: "attempt-desktop",
    context: {
      accountProvider: AccountProvider.Google,
      accountStatus: AccountStatus.Established,
      desktopAppDownloaded: true,
      githubConnected: true,
      githubDataConnectionStatusMeasured: true,
      membership: OrganizationMembership.FirstUser,
      organizationHasSyncedSessionData: KnownFlag.No,
      teamInvited: false,
      tourCompleted: false,
    },
    experienceVariant: WorkspaceExperience.V2,
    restoreOutcome: OnboardingRestoreOutcome.UnreachableOnHost,
    revision: 4,
    state: serializeOnboardingState(createInitialOnboardingState()),
    ...(startedOnHost ? { startedOnHost } : {}),
  };
}

function renderWebHost(snapshot: GuidedOnboardingSnapshot): QueryClient {
  mocks.apiGet.mockImplementation((path: string) => {
    if (path.startsWith(GUIDED_ONBOARDING_SNAPSHOT_PATH)) {
      return Promise.resolve(snapshot);
    }
    if (path === "/onboarding") {
      return Promise.resolve({
        wizardCompleted: false,
        checklist: [],
        checklistDismissed: false,
      });
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
      >
        <AuthAdapterProvider
          adapter={createStaticAuthAdapter({
            isLoaded: true,
            orgId: ORG_ID,
            userId: USER_ID,
          })}
        >
          <OnboardingGuard>
            <div>Dashboard content</div>
            <WebGuidedOnboardingDialogHost />
          </OnboardingGuard>
        </AuthAdapterProvider>
      </FeatureFlagAdapterProvider>
    </QueryClientProvider>
  );
  return queryClient;
}

async function snapshotSettled(queryClient: QueryClient): Promise<void> {
  await waitFor(() =>
    expect(
      queryClient.getQueryCache().find({
        queryKey: guidedOnboardingKeys.snapshot(
          OnboardingHost.Web,
          ORG_ID,
          USER_ID
        ),
      })?.state.status
    ).toBe("success")
  );
}

describe("web guided onboarding for a run Desktop started", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens no second wizard and posts nothing over the Desktop run", async () => {
    const queryClient = renderWebHost(webSnapshotOfRun(OnboardingHost.Desktop));

    await snapshotSettled(queryClient);

    expect(await screen.findByText("Dashboard content")).not.toBeNull();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it("keeps a Desktop-owned nonblocking run on the dashboard instead of legacy onboarding", async () => {
    const queryClient = renderWebHost(
      nonblockingSnapshot(OnboardingHost.Desktop)
    );
    await snapshotSettled(queryClient);
    expect(await screen.findByText("Dashboard content")).not.toBeNull();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it("retains the legacy redirect for a Web-owned nonblocking run", async () => {
    renderWebHost(nonblockingSnapshot(OnboardingHost.Web));
    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith("/onboarding")
    );
    expect(screen.queryByText("Dashboard content")).toBeNull();
  });

  it("clears a Web-started installer step when Desktop completes the same run", async () => {
    const downloadSnapshot = {
      ...webSnapshotOfRun(OnboardingHost.Web),
      restoreOutcome: OnboardingRestoreOutcome.Restored,
      state: serializeOnboardingState({
        accountProvider: null,
        history: [
          OnboardingPhase.Welcome,
          OnboardingPhase.CreateOrganization,
          OnboardingPhase.InviteTeam,
        ],
        organizationEstablished: true,
        phase: OnboardingPhase.DownloadDesktop,
        resuming: false,
      }),
    };
    const queryClient = renderWebHost(downloadSnapshot);
    expect(await screen.findByRole("dialog")).not.toBeNull();
    const completedSnapshot = {
      ...downloadSnapshot,
      revision: 10,
      state: serializeOnboardingState({
        accountProvider: null,
        history: [OnboardingPhase.DashboardAvailable],
        organizationEstablished: true,
        phase: OnboardingPhase.Ready,
        resuming: false,
      }),
    };
    mocks.apiGet.mockImplementation((path: string) =>
      path === "/onboarding"
        ? Promise.resolve({
            wizardCompleted: true,
            checklist: [],
            checklistDismissed: false,
          })
        : Promise.resolve(completedSnapshot)
    );
    // The browser's scheduled read sees the completion without a web transition.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), {
      timeout: 8000,
    });
    expect(await screen.findByText("Dashboard content")).not.toBeNull();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.apiPost).not.toHaveBeenCalled();
    // Re-reading the same durable completion cannot reopen the wizard.
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: guidedOnboardingKeys.all,
      });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.replace).not.toHaveBeenCalled();
  }, 12_000);

  it("posts nothing when a Web-started run is now continuing in Desktop", async () => {
    const queryClient = renderWebHost(webSnapshotOfRun(OnboardingHost.Web));
    await snapshotSettled(queryClient);
    expect(await screen.findByText("Dashboard content")).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  // The counterfactual: a Welcome Web can restore remains a run Web owns,
  // and its wizard still opens. Suppressing every Welcome would
  // pass the case above and delete the web wizard.
  it.each([
    ["a Web-started run", OnboardingHost.Web],
    ["a server that predates startedOnHost", undefined],
  ])("still opens the wizard for %s", async (_label, startedOnHost) => {
    renderWebHost({
      ...webSnapshotOfRun(startedOnHost),
      restoreOutcome: OnboardingRestoreOutcome.Restored,
    });

    expect(await screen.findByRole("dialog")).not.toBeNull();
  });

  // A step the reader resumed from the Getting started card on Web is their
  // own request, not a second run, so it still opens for a Desktop run.
  it("still opens a step resumed on Web for a Desktop-started run", async () => {
    renderWebHost({
      ...webSnapshotOfRun(OnboardingHost.Desktop),
      restoreOutcome: OnboardingRestoreOutcome.Restored,
      state: serializeOnboardingState({
        ...createInitialOnboardingState(),
        history: [OnboardingPhase.DashboardAvailable],
        organizationEstablished: true,
        phase: OnboardingPhase.InviteTeam,
        resuming: true,
      }),
    });

    expect(await screen.findByRole("dialog")).not.toBeNull();
  });
});

function nonblockingSnapshot(
  startedOnHost: OnboardingHost
): GuidedOnboardingSnapshot {
  return {
    ...webSnapshotOfRun(startedOnHost),
    restoreOutcome: OnboardingRestoreOutcome.Restored,
    state: serializeOnboardingState({
      accountProvider: null,
      history: [OnboardingPhase.Welcome, OnboardingPhase.Account],
      organizationEstablished: false,
      phase: OnboardingPhase.DashboardAvailable,
      resuming: false,
    }),
  };
}
