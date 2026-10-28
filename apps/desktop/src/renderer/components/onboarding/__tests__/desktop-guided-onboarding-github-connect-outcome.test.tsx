// @vitest-environment jsdom

/**
 * ISS-10990: the desktop onboarding Connect GitHub control must report a
 * handoff it could not open.
 *
 * The reported symptom — "the Connect GitHub link on the dashboard does nothing
 * after signing in with another method" — reaches this step and no other. A
 * GitHub sign-in satisfies the step from the account provider alone
 * (`isGitHubSignInSufficient`), so the prompt these cases render is only ever
 * shown to a Google/email-authenticated reader. The host read `connectState`
 * for `Pending` and discarded `Failed`/`SignInRequired`, so a refused handoff
 * ran the spinner and then restored the screen unchanged.
 *
 * These mount the REAL chain — the desktop host, the shared
 * `GuidedOnboardingDialogHost`, the dialog, the GitHub step, the prompt, and the
 * real `useDesktopGitHubConnect` — so only the leaf IPC and the server snapshot
 * are fixtures. The failing case drives the outcome through
 * `window.desktopApi.openGitHubConnect`, which is where the refusal actually
 * comes from.
 */

import type { GitHubIntegrationStatus } from "@repo/api/src/types/github";
import { GitHubDataConnectionSource } from "@repo/api/src/types/github";
import type { GuidedOnboardingSnapshot } from "@repo/api/src/types/onboarding-guided";
import {
  OnboardingRestoreOutcome,
  serializeOnboardingState,
} from "@repo/api/src/types/onboarding-persistence";
import {
  AccountProvider,
  AccountStatus,
  createInitialOnboardingState,
  KnownFlag,
  OnboardingPhase,
  OrganizationMembership,
} from "@repo/api/src/types/onboarding-phase";
import { WorkspaceExperience } from "@repo/api/src/types/workspace-experience";
import { GitHubConnectAction } from "@repo/app/github/lib/github-connect-action";
import { GITHUB_CONNECT_PROMPT_COPY } from "@repo/app/github/lib/github-connect-copy";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { stubLocalStorage } from "../../../__tests__/local-storage-stub";
import {
  DesktopGitHubConnectSurface,
  desktopGitHubConnectFailureMessage,
} from "../../../shared-branches/desktop-github-connect-copy";
import { DesktopGitHubConnectState } from "../../branches/use-desktop-github-connect";
import { desktopGuestGuidedOnboardingStorageKey } from "../../dashboard/dashboard-storage-keys";
import { DesktopGuidedOnboardingDialogHost } from "../desktop-guided-onboarding-dialog-host";

const fixtures = vi.hoisted(() => ({
  authStatus: "authenticated",
  beginSignIn: vi.fn(),
  githubStatus: null as GitHubIntegrationStatus | null,
  openGitHubConnect: vi.fn(),
  snapshot: null as unknown,
}));

vi.mock("../../../startup-readiness/use-startup-readiness", () => ({
  useStartupReadiness: () => ({ active: false }),
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));

vi.mock("@repo/navigation/use-path", () => ({ usePath: () => "/dashboard" }));

vi.mock("@repo/app/onboarding/hooks/use-guided-onboarding", () => ({
  useGuidedOnboardingSnapshot: () => ({
    data: fixtures.snapshot,
    isLoading: false,
  }),
  useGuidedOnboardingTransition: () => ({ isPending: false, mutate: vi.fn() }),
}));

vi.mock("@repo/app/onboarding/hooks/use-onboarding-invite-team", () => ({
  useOnboardingInviteTeam: () => ({
    invite: vi.fn(),
    invitedEmails: [],
    outcome: { status: "idle" },
  }),
}));

vi.mock(
  "@repo/app/onboarding/hooks/use-onboarding-organization-members",
  () => ({
    useOnboardingOrganizationMembers: () => ({ status: "unknown" }),
  })
);

// The real connect hook resolves its own status only when no `connectAction` is
// injected; the desktop host always injects one, so this read exists purely to
// keep the disabled query off an API adapter this mount has no reason to carry.
vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({ get: vi.fn(), post: vi.fn() }),
}));

vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({
    beginSignIn: fixtures.beginSignIn,
    signOut: vi.fn(() => Promise.resolve()),
    state: {
      organizationId: "org_acme",
      status: fixtures.authStatus,
      userId: "user_1",
    },
  }),
}));

vi.mock("../../../shared-agent-sessions/use-desktop-identity", () => ({
  useDesktopIdentity: () => ({
    identity: {
      email: "ada@example.com",
      organizationId: "org_acme",
      organizationName: "Acme Engineering",
      organizationSlug: "acme",
      userId: "user_1",
    },
  }),
}));

vi.mock("../../../shared-branches/desktop-github-integration-status", () => ({
  useDesktopGitHubIntegrationStatus: () => fixtures.githubStatus,
}));

vi.mock("../../../hooks/use-onboarding-session-discovery", () => ({
  useOnboardingSessionDiscovery: () => ({
    discovery: { status: "unknown" },
    progress: { status: "unknown" },
    settled: true,
    started: true,
  }),
}));

vi.mock("../use-sync-consent-record", () => ({
  useDeviceSyncConsentRecord: () => ({
    record: { bound: true, organizationId: "org_acme", tier: "full" },
  }),
}));

const CONNECT_CTA_LABEL =
  GITHUB_CONNECT_PROMPT_COPY[GitHubConnectAction.Connect].ctaLabel;
const FAILED_MESSAGE = desktopGitHubConnectFailureMessage(
  DesktopGitHubConnectState.Failed,
  DesktopGitHubConnectSurface.Panel
);
const SIGN_IN_REQUIRED_MESSAGE = desktopGitHubConnectFailureMessage(
  DesktopGitHubConnectState.SignInRequired,
  DesktopGitHubConnectSurface.Panel
);

/** A modern payload that MEASURED the user's own grant and found none. */
const DISCONNECTED_STATUS: GitHubIntegrationStatus = {
  connected: false,
  githubDataConnection: {
    connected: false,
    oauthRequiredReasons: [],
    sources: [],
  },
};

/**
 * A live USER grant with no org App installation — the shape a reader who just
 * finished this step actually holds, and the reason the legacy `connected` field
 * stays `false`: it only ever reported the installation.
 */
const CONNECTED_STATUS: GitHubIntegrationStatus = {
  connected: false,
  githubDataConnection: {
    connected: true,
    oauthRequiredReasons: [],
    sources: [GitHubDataConnectionSource.UserOAuth],
  },
};

let originalDesktopApi: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  originalDesktopApi = Object.getOwnPropertyDescriptor(window, "desktopApi");
  fixtures.authStatus = DesktopAuthStatus.Authenticated;
  fixtures.beginSignIn = vi.fn(async () => ({ ok: true }));
  fixtures.githubStatus = DISCONNECTED_STATUS;
  fixtures.openGitHubConnect = vi.fn(async () => ({
    ok: true,
    url: "https://app.example.com/connect/github/link",
  }));
  fixtures.snapshot = googleAccountSnapshot();
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      get openGitHubConnect() {
        return fixtures.openGitHubConnect;
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

describe("desktop onboarding Connect GitHub outcome (ISS-10990)", () => {
  it("opens the connect flow for a Google-authenticated reader with no GitHub grant", async () => {
    renderHost();

    fireEvent.click(
      await screen.findByRole("button", { name: CONNECT_CTA_LABEL })
    );

    await waitFor(() => expect(fixtures.openGitHubConnect).toHaveBeenCalled());
    // The post-connect destination is the surface the reader clicked from, so a
    // completed authorize returns them to the dashboard rather than the default.
    // `returnToDesktop` asks main to bring Desktop forward once the connect
    // lands, because first-time onboarding continues here, not in the browser.
    expect(fixtures.openGitHubConnect.mock.calls[0][0]).toEqual({
      returnTo: "/dashboard",
      returnToDesktop: true,
    });
    // The authorization boundary this fix must not move: a reader who already
    // holds a desktop session is never pushed back through sign-in to reach the
    // connect flow. `beginSignIn` runs only when the session is absent.
    expect(fixtures.beginSignIn).not.toHaveBeenCalled();
  });

  it("renders a visible failure beside the retry when the handoff cannot be opened", async () => {
    fixtures.openGitHubConnect = vi.fn(async () => ({
      ok: false,
      reason: "open_failed",
    }));
    renderHost();

    fireEvent.click(
      await screen.findByRole("button", { name: CONNECT_CTA_LABEL })
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(FAILED_MESSAGE);
    // The CTA stands as the retry rather than being replaced by the failure.
    expect(
      screen.getByRole("button", { name: CONNECT_CTA_LABEL })
    ).toBeTruthy();
  });

  it("renders a visible failure when the connect IPC rejects outright", async () => {
    fixtures.openGitHubConnect = vi.fn(() =>
      Promise.reject(new Error("bridge is gone"))
    );
    renderHost();

    fireEvent.click(
      await screen.findByRole("button", { name: CONNECT_CTA_LABEL })
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(FAILED_MESSAGE);
  });

  it("reports no failure on a handoff that opened", async () => {
    renderHost();

    fireEvent.click(
      await screen.findByRole("button", { name: CONNECT_CTA_LABEL })
    );

    await waitFor(() => expect(fixtures.openGitHubConnect).toHaveBeenCalled());
    // Paired with the negative: the step is still mounted and still offering the
    // control, so an absent alert cannot be a component that rendered nothing.
    expect(
      screen.getByRole("button", { name: CONNECT_CTA_LABEL })
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // The host threads BOTH terminal outcomes, so both are pinned. Without this
  // case, narrowing the host to `connectState === Failed` — the original bug's
  // exact shape, one outcome over — leaves every other case green.
  it("renders the sign-up failure when the session leg never completes", async () => {
    fixtures.authStatus = DesktopAuthStatus.SignedOut;
    fixtures.beginSignIn = vi.fn(async () => ({ ok: false }));
    // A signed-out reader's run is the local guest run for every settled guest
    // since ISS-11480, so the GitHub position is seeded there.
    stubLocalStorage();
    localStorage.setItem(
      desktopGuestGuidedOnboardingStorageKey,
      JSON.stringify({ revision: 3, state: googleAccountSnapshot().state })
    );
    renderHost();

    fireEvent.click(
      await screen.findByRole("button", { name: CONNECT_CTA_LABEL })
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(SIGN_IN_REQUIRED_MESSAGE);
    // Distinct from the connect-refused sentence: one wall, two different
    // reasons, and the reader has to be able to tell which one they hit.
    expect(alert.textContent).not.toBe(FAILED_MESSAGE);
    // A failed session leg must never reach the connect handoff.
    expect(fixtures.openGitHubConnect).not.toHaveBeenCalled();
  });

  it("offers no connect prompt once the reader's own grant is live", async () => {
    fixtures.githubStatus = CONNECTED_STATUS;
    renderHost();

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "GitHub connected",
      })
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: CONNECT_CTA_LABEL })
    ).toBeNull();
  });
});

function renderHost() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <DesktopGuidedOnboardingDialogHost />
    </QueryClientProvider>
  );
}

/**
 * A desktop reader who signed in with Google, resuming the GitHub step from the
 * dashboard — the `DashboardAvailable → ConnectGitHub` edge the "Getting
 * started" card posts. The history is the walk that actually reaches it: a
 * fixture that skips an edge restores as an unreachable state and recovers to a
 * fresh Welcome, which would silently test a different screen.
 */
function googleAccountSnapshot(): GuidedOnboardingSnapshot {
  const phase = OnboardingPhase.ConnectGitHub;
  return {
    attemptId: null,
    context: {
      accountProvider: AccountProvider.Google,
      accountStatus: AccountStatus.Established,
      desktopAppDownloaded: true,
      githubConnected: false,
      membership: OrganizationMembership.ExistingMember,
      organizationHasSyncedSessionData: KnownFlag.Yes,
      teamInvited: true,
      tourCompleted: true,
    },
    experienceVariant: WorkspaceExperience.V2,
    restoreOutcome: OnboardingRestoreOutcome.Restored,
    revision: 3,
    state: serializeOnboardingState({
      ...createInitialOnboardingState(),
      history: [
        OnboardingPhase.Welcome,
        OnboardingPhase.SyncPolicy,
        OnboardingPhase.SessionDiscovery,
        OnboardingPhase.Account,
        OnboardingPhase.ChooseOrganization,
        OnboardingPhase.InviteTeam,
        OnboardingPhase.DashboardAvailable,
      ],
      phase,
    }),
  };
}
