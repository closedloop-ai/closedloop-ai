// @vitest-environment jsdom

import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import type { GitHubIntegrationStatus } from "@repo/api/src/types/github";
import type { GuidedOnboardingSnapshot } from "@repo/api/src/types/onboarding-guided";
import {
  OnboardingRestoreOutcome,
  restoreOnboardingState,
  serializeOnboardingState,
} from "@repo/api/src/types/onboarding-persistence";
import {
  AccountProvider,
  AccountStatus,
  KnownFlag,
  OnboardingHost,
  OnboardingPhase,
  OrganizationMembership,
} from "@repo/api/src/types/onboarding-phase";
import { settingsLocalSyncPolicyReady } from "@repo/api/src/types/settings-host-capabilities";
import { WorkspaceExperience } from "@repo/api/src/types/workspace-experience";
import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useReducer } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GuidedOnboardingTransitionInput } from "../../hooks/use-guided-onboarding";
import { transitionOnboarding } from "../../lib/onboarding-transitions";
import {
  IDLE_INVITE_OUTCOME,
  UNKNOWN_ORGANIZATION_MEMBERS,
} from "../guided-onboarding-data";
import { GuidedOnboardingDialogHost } from "../guided-onboarding-dialog-host";

/**
 * ISS-11254 at the SURFACE, not in the machine (@whitlockk).
 *
 * `onboarding-web-github-step.test.ts` proves `resolvePostDownloadPhase`
 * returns `ConnectGitHub`. That is a function returning a string, and the
 * regression readers actually hit was a SCREEN they never saw. This mounts the
 * production `GuidedOnboardingDialogHost`, clicks the download gate's real
 * control, and asserts the GitHub step draws.
 *
 * The transition HOOK is stubbed; the transition MACHINE is not. The stub's
 * `mutate` runs the real `transitionOnboarding` and re-seeds the snapshot from
 * its output, which is what the server does. A stub that returned a fixed next
 * snapshot would assert its own fixture and stay green through a revert.
 *
 * The browser half — both exits, a real Chromium, the persisted phase on the
 * wire — is `e2e/guided-onboarding-web-github-step.local-trusted.spec.ts`. This
 * one is the case that runs in unit CI in milliseconds.
 */

const mockHostDeps = vi.hoisted(() => ({
  useGuidedOnboardingSnapshot: vi.fn(),
  useGuidedOnboardingTransition: vi.fn(),
}));

// Behind `useDesktopAppRunning`: these suites mount the host with no provider.
vi.mock("../../../compute/hooks/use-compute-targets", () => ({
  useComputeTargets: () => ({ data: undefined }),
}));

vi.mock("../../hooks/use-guided-onboarding", () => ({
  useGuidedOnboardingSnapshot: mockHostDeps.useGuidedOnboardingSnapshot,
  useGuidedOnboardingTransition: mockHostDeps.useGuidedOnboardingTransition,
}));

vi.mock("../../hooks/use-onboarding-invite-team", () => ({
  useOnboardingInviteTeam: () => ({
    invite: vi.fn(),
    invitedEmails: [],
    outcome: IDLE_INVITE_OUTCOME,
  }),
}));

vi.mock("../../hooks/use-onboarding-organization-members", () => ({
  useOnboardingOrganizationMembers: () => UNKNOWN_ORGANIZATION_MEMBERS,
}));

vi.mock("../../../shared/settings-host/use-local-sync-policy", () => ({
  useLocalSyncPolicy: () => ({
    isWriting: false,
    state: {
      projection: settingsLocalSyncPolicyReady(DataSyncLevel.Full, false),
      status: "settled",
    },
    supported: true,
    write: vi.fn(),
    writeOutcome: null,
  }),
}));

/**
 * The download gate's skip control. `guided-onboarding-download-step.tsx` uses
 * this label when an installer IS on offer and "Continue without installing"
 * when none is; jsdom resolves to the former, and the browser spec covers the
 * macOS install link as the other exit.
 */
const SKIP_DOWNLOAD_NAME = "Skip for now";
const DOWNLOAD_HEADING = "Bring Closedloop to your desktop";
/**
 * Supplied so the step draws its SETTLED title. Left out, the connection probe
 * is `unknown` and the dialog names itself "Checking your GitHub connection" —
 * still the GitHub step, but asserting a loading state rather than the screen
 * the reader is owed.
 */
const DISCONNECTED_GITHUB_STATUS: GitHubIntegrationStatus = {
  connected: false,
  githubDataConnection: {
    connected: false,
    oauthRequiredReasons: [],
    sources: [],
  },
};
const CONNECT_GITHUB_HEADING = "Connect GitHub";

/**
 * The run under test, held OUTSIDE React so the two mocked hooks and the click
 * handler all read one value. `notify` is registered by the harness's effect,
 * never during render.
 */
let currentSnapshot: GuidedOnboardingSnapshot | null = null;
let notify: (() => void) | null = null;

/**
 * What the server does with a posted command, minus the network: run the REAL
 * machine and re-seed the run from its output. A stub that returned a fixed
 * next snapshot would assert its own fixture and stay green through a revert.
 */
function applyRealTransition({
  event,
  snapshot: posted,
}: GuidedOnboardingTransitionInput): void {
  const restored = restoreOnboardingState(posted.state, OnboardingHost.Web);
  const result = transitionOnboarding(restored.state, event, {
    ...posted.context,
    analysisStarted: true,
    host: OnboardingHost.Web,
    organizationActive: KnownFlag.Yes,
    syncConsentRecorded: KnownFlag.Unknown,
  });
  if (result.status !== "moved") {
    throw new Error(`the machine rejected ${event.type}: ${result.reason}`);
  }
  currentSnapshot = {
    ...posted,
    revision: posted.revision + 1,
    state: serializeOnboardingState(result.state),
  };
  notify?.();
}

beforeEach(() => {
  vi.clearAllMocks();
  currentSnapshot = null;
  notify = null;
  mockHostDeps.useGuidedOnboardingSnapshot.mockImplementation(() => ({
    data: currentSnapshot ?? undefined,
    isLoading: false,
  }));
  mockHostDeps.useGuidedOnboardingTransition.mockImplementation(() => ({
    isPending: false,
    mutate: applyRealTransition,
  }));
});

describe("the initial Web run's download gate, rendered", () => {
  it("draws the GitHub step for a Google signup that declines the installer", () => {
    renderWebRun(AccountProvider.Google);

    // The gate is asserted PRESENT first, on the same heading role the
    // assertion below uses for its successor, so a host that rendered nothing
    // at all cannot satisfy the absence check.
    expect(
      screen.getByRole("heading", { name: DOWNLOAD_HEADING })
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: SKIP_DOWNLOAD_NAME }));

    expect(
      screen.getByRole("heading", { name: CONNECT_GITHUB_HEADING })
    ).not.toBeNull();
    expect(
      screen.queryByRole("heading", { name: DOWNLOAD_HEADING })
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(
      screen.queryByRole("heading", { name: CONNECT_GITHUB_HEADING })
    ).toBeNull();
    expect(currentSnapshot?.context.githubConnected).toBe(false);
  });

  it("sends a GitHub signup straight past it, on the same locator", () => {
    renderWebRun(AccountProvider.GitHub);

    expect(
      screen.getByRole("heading", { name: DOWNLOAD_HEADING })
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: SKIP_DOWNLOAD_NAME }));

    // The falsifying half of the case above: the same click, the same locator,
    // and the step must NOT be there. Without this, a host that drew the GitHub
    // step unconditionally would pass the first case.
    expect(
      screen.queryByRole("heading", { name: CONNECT_GITHUB_HEADING })
    ).toBeNull();
  });
});

/** Mount the host on a Web run parked at the download gate. */
function renderWebRun(provider: AccountProvider) {
  currentSnapshot = downloadGateSnapshot(provider);
  return render(<WebRunHarness />);
}

function WebRunHarness() {
  const [, bump] = useReducer((tick: number) => tick + 1, 0);
  useEffect(() => {
    notify = bump;
    return () => {
      notify = null;
    };
  }, []);

  return (
    <GuidedOnboardingDialogHost
      analysisStarted={true}
      brand={<span>Closedloop.ai</span>}
      dashboardActive={false}
      desktopMode={false}
      githubStatus={DISCONNECTED_GITHUB_STATUS}
      host={OnboardingHost.Web}
      onBackFallback={vi.fn()}
      onDashboardAvailable={vi.fn()}
      organizationChosen
      organizationName="Example Organization"
      organizationSlug="example-organization"
    />
  );
}

/**
 * `membership: ExistingMember` is what makes the skip control legal
 * (`canSkipDesktopDownload`); without it the click target does not render and
 * the case would fail on the locator rather than on the edge under test.
 */
function downloadGateSnapshot(
  provider: AccountProvider
): GuidedOnboardingSnapshot {
  return {
    attemptId: "attempt-web-github-step",
    context: {
      accountProvider: provider,
      accountStatus: AccountStatus.Established,
      desktopAppDownloaded: false,
      githubConnected: provider === AccountProvider.GitHub,
      membership: OrganizationMembership.ExistingMember,
      organizationHasSyncedSessionData: KnownFlag.Yes,
      teamInvited: true,
      tourCompleted: false,
    },
    experienceVariant: WorkspaceExperience.V2,
    restoreOutcome: OnboardingRestoreOutcome.Restored,
    revision: 4,
    state: serializeOnboardingState({
      accountProvider: provider,
      history: [
        OnboardingPhase.Welcome,
        OnboardingPhase.Account,
        OnboardingPhase.ChooseOrganization,
        OnboardingPhase.InviteTeam,
      ],
      organizationEstablished: true,
      phase: OnboardingPhase.DownloadDesktop,
      resuming: false,
    }),
  };
}
