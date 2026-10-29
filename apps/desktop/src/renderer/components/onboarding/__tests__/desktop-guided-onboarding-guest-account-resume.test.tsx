/**
 * ISS-11480 (PLN-2126 Step 7): a settled guest's "Create account" reopens the
 * guided onboarding at its Account step — the prototype's `openAccountSetup` —
 * rather than the retired standalone offer.
 *
 * Mounts the REAL chain: the desktop host, its local guest run, the shared
 * `GuidedOnboardingDialogHost`, the dialog and the Account step, with the
 * request made through `useRequestGuestAccount`, the hook every entry point
 * presses. Only the server snapshot, the auth state and the leaf reads the host
 * composes are fixtures.
 */

import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import { stubLocalStorage } from "../../../__tests__/local-storage-stub";
import { hrefForNavId, NavId } from "../../../navigation/route-table";
import { signInFailureMessage } from "../../../shared-agent-sessions/desktop-sign-in-copy";
import {
  dashboardOnboardedStorageKey,
  writeFlag,
} from "../../dashboard/dashboard-storage-keys";
import { DesktopAuthFraming } from "../desktop-auth-copy";
import { DesktopGuidedOnboardingDialogHost } from "../desktop-guided-onboarding-dialog-host";
import { readGuestGuidedOnboardingRecord } from "../guest-guided-onboarding-record";
import { signInMethodForAuthMethod } from "../sign-in-method-for-auth-method";
import { useRequestGuestAccount } from "../use-request-guest-account";
import { seedDashboardRecord } from "./guest-guided-onboarding-handoff-fixtures";

const fixtures = vi.hoisted(() => ({
  beginSignIn: vi.fn(),
  navigate: vi.fn(),
  request: undefined as (() => void) | undefined,
}));

vi.mock("../../../startup-readiness/use-startup-readiness", () => ({
  useStartupReadiness: () => ({ active: false }),
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: fixtures.navigate }),
}));

// Off the Dashboard, as the Branches and workspace-menu entry points are, so
// the host's own `dashboard_entered` does not move the run before the request.
vi.mock("@repo/navigation/use-path", () => ({ usePath: () => "/sessions" }));

vi.mock("@repo/app/onboarding/hooks/use-guided-onboarding", () => ({
  useGuidedOnboardingSnapshot: () => ({ data: undefined, isLoading: false }),
  useGuidedOnboardingTransition: () => ({ isPending: false, mutate: vi.fn() }),
}));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({ get: vi.fn(), post: vi.fn() }),
}));

vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({
    beginSignIn: fixtures.beginSignIn,
    signOut: vi.fn(() => Promise.resolve()),
    state: {
      organizationId: null,
      status: DesktopAuthStatus.SignedOut,
      userId: null,
    },
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
    started: true,
  }),
}));

vi.mock("../use-sync-consent-record", () => ({
  useDeviceSyncConsentRecord: () => ({
    record: { bound: false, organizationId: null, tier: null },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  fixtures.beginSignIn.mockResolvedValue({ ok: true });
  fixtures.request = undefined;
  stubLocalStorage();
  // A returning guest: past first launch, parked on the Dashboard.
  writeFlag(dashboardOnboardedStorageKey);
  seedDashboardRecord();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("guest Create account → onboarding Account step (ISS-11480)", () => {
  it("opens the Account step with GitHub, Google and email in the onboarding dialog", async () => {
    renderHost();
    // Parked on the Dashboard, the modal is closed until something asks.
    expect(screen.queryByRole("dialog")).toBeNull();

    requestAccount();

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("button", { name: "Continue with GitHub" })
    ).toBeDefined();
    expect(
      within(dialog).getByRole("button", { name: "Continue with Google" })
    ).toBeDefined();
    expect(
      within(dialog).getByRole("textbox", { name: "Email address" })
    ).toBeDefined();
    // The old offer was a dialog of its own; the Account step is the ONLY
    // dialog on screen, so its decline control cannot be sitting in front.
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    // Persisted as a resumed step, so a relaunch restores it.
    expect(readGuestGuidedOnboardingRecord()?.state).toMatchObject({
      history: [OnboardingPhase.DashboardAvailable],
      phase: OnboardingPhase.Account,
      resuming: true,
    });
  });

  it("returns to the Dashboard with the modal closed on Back", async () => {
    renderHost();
    requestAccount();
    const dialog = await screen.findByRole("dialog");

    fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fixtures.navigate).toHaveBeenCalledWith(
      hrefForNavId(NavId.Dashboard)
    );
    expect(readGuestGuidedOnboardingRecord()?.state.phase).toBe(
      OnboardingPhase.DashboardAvailable
    );
  });
});

describe("Account step sign-in feedback (ISS-11480 review)", () => {
  it("reports a refused sign-in on the step", async () => {
    fixtures.beginSignIn.mockResolvedValue({
      ok: false,
      reason: "open_failed",
    });
    renderHost();
    requestAccount();
    const dialog = await screen.findByRole("dialog");

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Continue with GitHub" })
    );

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toBe(signInFailureMessage("open_failed"));
    expect(fixtures.beginSignIn).toHaveBeenCalledWith(
      signInMethodForAuthMethod("github"),
      undefined,
      DesktopAuthFraming.SignUp
    );
  });

  it("does not carry a reported failure into the next time the step opens", async () => {
    fixtures.beginSignIn.mockResolvedValue({
      ok: false,
      reason: "open_failed",
    });
    renderHost();
    requestAccount();
    const first = await screen.findByRole("dialog");
    fireEvent.click(
      within(first).getByRole("button", { name: "Continue with GitHub" })
    );
    await within(first).findByRole("alert");

    fireEvent.click(within(first).getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    requestAccount();

    const reopened = await screen.findByRole("dialog");
    expect(within(reopened).queryByRole("alert")).toBeNull();
  });

  it("shows the picked method busy while the sign-in runs", async () => {
    fixtures.beginSignIn.mockReturnValue(new Promise(() => undefined));
    renderHost();
    requestAccount();
    const dialog = await screen.findByRole("dialog");
    const github = within(dialog).getByRole("button", {
      name: "Continue with GitHub",
    });

    fireEvent.click(github);

    await waitFor(() => expect(github.getAttribute("aria-busy")).toBe("true"));
    expect((github as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });
});

function RequestProbe() {
  fixtures.request = useRequestGuestAccount();
  return null;
}

function renderHost() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <DesktopGuidedOnboardingDialogHost />
      <RequestProbe />
    </QueryClientProvider>
  );
}

function requestAccount(): void {
  const request = fixtures.request;
  if (!request) {
    throw new Error("no guest account request was offered");
  }
  act(() => request());
}
