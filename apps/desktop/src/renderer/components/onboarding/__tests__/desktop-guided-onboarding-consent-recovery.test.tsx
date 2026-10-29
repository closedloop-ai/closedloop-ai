/** Exercises the actual device consent reader, Desktop adapters and shared surfaces. */
import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { OnboardingEvent } from "@repo/api/src/types/onboarding-events";
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
  PendingOnboardingStep,
} from "@repo/api/src/types/onboarding-phase";
import { settingsLocalSyncPolicyReady } from "@repo/api/src/types/settings-host-capabilities";
import { WorkspaceExperience } from "@repo/api/src/types/workspace-experience";
import { GETTING_STARTED_STEP_CONTENT } from "@repo/app/onboarding/components/getting-started-card-shell";
import { DESKTOP_WELCOME_CTA_LABEL } from "@repo/app/onboarding/components/guided-onboarding-welcome-copy";
import { createTestQueryClient } from "@repo/app/shared/test-utils";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../../../../../test/deferred.js";
import {
  DesktopAuthStatus,
  SyncObservabilityTier,
} from "../../../../shared/contracts";
import {
  hasAnsweredSyncConsent,
  type SyncConsentRecord,
} from "../../../../shared/sync-consent";
import { stubLocalStorage } from "../../../__tests__/local-storage-stub";
import {
  dashboardOnboardedStorageKey,
  desktopGuestGuidedOnboardingStorageKey,
  writeFlag,
} from "../../dashboard/dashboard-storage-keys";
import { DesktopSidebarFooterItems } from "../../layout/sidebar-shared-items";
import { DesktopGuidedOnboardingDialogHost } from "../desktop-guided-onboarding-dialog-host";
import {
  readGuestGuidedOnboardingRecord,
  writeGuestGuidedOnboardingRecord,
} from "../guest-guided-onboarding-record";
import { useDeviceSyncConsentRecord } from "../use-sync-consent-record";

const fixtures = vi.hoisted(() => ({
  auth: {
    status: "signed_out",
    userId: null as string | null,
    organizationId: null as string | null,
  },
  snapshot: undefined as GuidedOnboardingSnapshot | undefined,
  mutate: vi.fn(),
  startup: vi.fn(),
  readConsent: vi.fn(),
  record: null as SyncConsentRecord | null,
  writeOutcome: null as ReturnType<typeof settingsLocalSyncPolicyReady> | null,
  listeners: new Set<(record: SyncConsentRecord) => void>(),
}));

vi.mock("../../../startup-readiness/use-startup-readiness", () => ({
  useStartupReadiness: (args: unknown) => {
    fixtures.startup(args);
    return { active: false };
  },
}));
vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));
vi.mock("@repo/navigation/use-path", () => ({ usePath: () => "/sessions" }));
vi.mock("@repo/app/onboarding/hooks/use-guided-onboarding", () => ({
  useGuidedOnboardingSnapshot: () => ({
    data: fixtures.snapshot,
    isLoading: false,
  }),
  useGuidedOnboardingTransition: () => ({
    isPending: false,
    mutate: fixtures.mutate,
  }),
}));
vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({ get: vi.fn(), post: vi.fn() }),
}));
vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({
    beginSignIn: vi.fn(),
    signOut: vi.fn(),
    state: fixtures.auth,
  }),
}));
vi.mock("../../../shared-agent-sessions/use-desktop-identity", () => ({
  useDesktopIdentity: () => ({ identity: null, isResolved: true }),
}));
vi.mock("../../../shared-branches/desktop-github-integration-status", () => ({
  useDesktopGitHubIntegrationStatus: () => null,
}));
vi.mock("../../../hooks/use-onboarding-session-discovery", () => ({
  useOnboardingSessionDiscovery: () => ({
    discovery: { status: "unknown" },
    progress: { status: "unknown" },
    settled: true,
    started: false,
  }),
}));
vi.mock("@repo/app/shared/settings-host/use-local-sync-policy", () => ({
  useLocalSyncPolicy: () => ({
    supported: true,
    isWriting: false,
    state: {
      status: "settled",
      projection: settingsLocalSyncPolicyReady(
        DataSyncLevel.Off,
        fixtures.record !== null && fixtures.record.tier !== null
      ),
    },
    writeOutcome: fixtures.writeOutcome,
    write: (level: DataSyncLevel) => {
      if (level !== DataSyncLevel.Off) {
        throw new Error("This regression saves Off");
      }
      fixtures.record = {
        bound: true,
        organizationId: null,
        tier: SyncObservabilityTier.Local,
      };
      fixtures.writeOutcome = settingsLocalSyncPolicyReady(
        DataSyncLevel.Off,
        true
      );
      for (const listener of fixtures.listeners) {
        listener(fixtures.record);
      }
    },
  }),
}));
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: () => false,
}));
vi.mock(
  "@repo/app/shared/feature-flags/dev-mode/dev-mode-sidebar-item",
  () => ({ DevModeSidebarItem: () => null })
);
vi.mock("../../layout/desktop-invite-entry-placement", () => ({
  useDesktopWorkspaceMenuHoldsInvite: () => true,
}));

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);
beforeEach(() => {
  vi.clearAllMocks();
  stubLocalStorage();
  writeFlag(dashboardOnboardedStorageKey);
  fixtures.auth = {
    status: DesktopAuthStatus.SignedOut,
    userId: null,
    organizationId: null,
  };
  fixtures.snapshot = undefined;
  fixtures.record = { bound: false, organizationId: null, tier: null };
  fixtures.writeOutcome = null;
  fixtures.listeners.clear();
  fixtures.readConsent.mockImplementation(() =>
    Promise.resolve(fixtures.record)
  );
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getSyncConsentRecord: fixtures.readConsent,
      onSyncConsentRecordChanged: (
        listener: (record: SyncConsentRecord) => void
      ) => {
        fixtures.listeners.add(listener);
        return () => fixtures.listeners.delete(listener);
      },
    },
  });
});
afterEach(() => {
  cleanup();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
  vi.unstubAllGlobals();
});

describe("Desktop consent under the restored step order", () => {
  // Operator ruling (Marisol Ashgrove, 2026-10-20): Sync policy follows Create
  // organization again, and Start does not record a sync answer.
  it("routes Welcome Start to Session discovery and records no sync answer", async () => {
    seedGuestRun(OnboardingPhase.Welcome, []);
    renderSurface(<DesktopGuidedOnboardingDialogHost />);
    fireEvent.click(
      await screen.findByRole("button", { name: DESKTOP_WELCOME_CTA_LABEL })
    );
    await waitFor(() =>
      expect(readGuestGuidedOnboardingRecord()).toMatchObject({
        revision: 2,
        state: {
          phase: OnboardingPhase.SessionDiscovery,
          history: [OnboardingPhase.Welcome],
        },
      })
    );
    expect(screen.queryByRole("radio", { name: "Off" })).toBeNull();
    expect(fixtures.record).not.toBeNull();
    expect(
      fixtures.record !== null && hasAnsweredSyncConsent(fixtures.record)
    ).toBe(false);
    expect(fixtures.startup).toHaveBeenLastCalledWith(
      expect.objectContaining({ syncElected: false })
    );
  });

  it("resumes an interrupted discovery run at discovery while consent is unset", async () => {
    seedGuestRun(OnboardingPhase.SessionDiscovery, [OnboardingPhase.Welcome]);
    const read = deferred<SyncConsentRecord | null>();
    fixtures.readConsent.mockReturnValue(read.promise);
    renderSurface(<DesktopGuidedOnboardingDialogHost />);
    await act(async () => {
      read.resolve(fixtures.record);
      await read.promise;
    });
    await waitFor(() => expect(fixtures.readConsent).toHaveBeenCalled());
    expect(screen.queryByRole("radio", { name: "Off" })).toBeNull();
    expect(readGuestGuidedOnboardingRecord()).toMatchObject({
      revision: 1,
      state: {
        phase: OnboardingPhase.SessionDiscovery,
        history: [OnboardingPhase.Welcome],
      },
    });
    expect(
      fixtures.record !== null && hasAnsweredSyncConsent(fixtures.record)
    ).toBe(false);
  });

  it("keeps a guest's saved local answer separate from cloud consent", async () => {
    seedGuestRun(OnboardingPhase.SessionDiscovery, [OnboardingPhase.Welcome]);
    fixtures.record = {
      bound: false,
      organizationId: null,
      tier: SyncObservabilityTier.Full,
    };
    function SettledProbe() {
      const consent = useDeviceSyncConsentRecord();
      return <span>{consent.record?.tier}</span>;
    }
    renderSurface(
      <>
        <DesktopGuidedOnboardingDialogHost />
        <SettledProbe />
      </>
    );
    expect(
      await screen.findByText(SyncObservabilityTier.Full, { exact: true })
    ).not.toBeNull();
    expect(screen.queryByRole("radio", { name: "Off" })).toBeNull();
    expect(fixtures.startup).toHaveBeenLastCalledWith(
      expect.objectContaining({ syncElected: false })
    );
  });

  it("shows ChooseSessionSync for a signed-in, already-onboarded legacy profile with an unset record", async () => {
    fixtures.auth = {
      status: DesktopAuthStatus.Authenticated,
      userId: "user-a",
      organizationId: "org-a",
    };
    localStorage.removeItem(desktopGuestGuidedOnboardingStorageKey);
    fixtures.snapshot = completedSnapshot();
    renderSurface(
      <>
        <DesktopGuidedOnboardingDialogHost />
        <DesktopSidebarFooterItems />
      </>
    );
    const name =
      GETTING_STARTED_STEP_CONTENT[PendingOnboardingStep.ChooseSessionSync]
        .label;
    const choose = await screen.findByRole("button", { name });
    expect((choose as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(choose);
    expect(fixtures.mutate).toHaveBeenCalledWith({
      snapshot: fixtures.snapshot,
      event: {
        type: OnboardingEvent.ResumePendingStep,
        step: PendingOnboardingStep.ChooseSessionSync,
      },
    });
  });
});

function renderSurface(children: ReactNode) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      {children}
    </QueryClientProvider>
  );
}

function seedGuestRun(phase: OnboardingPhase, history: OnboardingPhase[]) {
  writeGuestGuidedOnboardingRecord({
    revision: 1,
    state: serializeOnboardingState({
      phase,
      history,
      accountProvider: null,
      organizationEstablished: false,
      resuming: false,
    }),
  });
}

function completedSnapshot(): GuidedOnboardingSnapshot {
  return {
    attemptId: "attempt-a",
    context: {
      accountProvider: AccountProvider.GitHub,
      accountStatus: AccountStatus.Established,
      desktopAppDownloaded: true,
      githubConnected: true,
      membership: OrganizationMembership.FirstUser,
      organizationHasSyncedSessionData: KnownFlag.Yes,
      teamInvited: true,
      tourCompleted: true,
    },
    experienceVariant: WorkspaceExperience.V2,
    restoreOutcome: OnboardingRestoreOutcome.Restored,
    revision: 5,
    state: serializeOnboardingState({
      accountProvider: AccountProvider.GitHub,
      history: [
        OnboardingPhase.DashboardAvailable,
        OnboardingPhase.DashboardTour,
      ],
      organizationEstablished: true,
      phase: OnboardingPhase.Ready,
      resuming: false,
    }),
  };
}
