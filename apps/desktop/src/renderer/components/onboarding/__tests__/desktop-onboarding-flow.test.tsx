import type { SyncConsentLevel } from "@repo/app/onboarding/components/sync-consent";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataSyncLevel } from "../../../../shared/contracts";
import { DesktopGitHubConnectState } from "../../branches/use-desktop-github-connect";
import { DesktopOnboardingFlow } from "../desktop-onboarding-flow";

// PRD-532 (M4) / FEA-4055: the desktop first-launch onboarding flow composes the
// shared AuthMethods → AccountSetupFlow steps with the REAL desktop handlers
// (beginSignIn loopback OAuth, the GitHub App connect route, and the persisted
// data-sync LEVEL). The sync-consent step persists through the ONE consolidated
// `setDataSyncLevel` setter — the same path Settings uses — so the persisted
// level deterministically derives `transcriptSyncEnabled` + the observability
// tier + connectivity together (a fresh user picking Full genuinely enables
// transcript upload). These tests mock only the platform boundary
// (`window.desktopApi`) and the two desktop hooks the flow depends on, and
// assert the state-machine transitions and that the chosen level is persisted —
// no mocked/simulated round-trips leak into the component itself.

const hooks = vi.hoisted(() => ({
  useDesktopAuth: vi.fn(),
  useGitHubIntegrationStatus: vi.fn(),
  useDesktopGitHubConnect: vi.fn(),
}));

vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: hooks.useDesktopAuth,
}));
vi.mock("@repo/app/github/hooks/use-github-integration", () => ({
  useGitHubIntegrationStatus: hooks.useGitHubIntegrationStatus,
}));
vi.mock("../../branches/use-desktop-github-connect", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../branches/use-desktop-github-connect")
    >();
  return {
    ...actual,
    useDesktopGitHubConnect: hooks.useDesktopGitHubConnect,
  };
});

const CONTINUE_GITHUB_RE = /continue with github/i;
const CONTINUE_GOOGLE_RE = /continue with google/i;
const CONNECT_HEADING_RE = /connect github to finish setup/i;
const SYNC_HEADING_RE = /choose what syncs to the cloud/i;
const FULL_SYNC_RE = /full transcripts/i;
const METADATA_RE = /metadata only/i;
const CONTINUE_RE = /^continue$/i;
const SIGN_IN_ERROR_RE = /sign-in didn't complete/i;
const PERSIST_ERROR_RE = /couldn't save your sync choice/i;
const CONNECT_ERROR_RE = /github connect could not be opened/i;

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

function setDesktopApi(overrides: Record<string, unknown>): void {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: overrides,
    writable: true,
  });
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderFlow(onComplete?: (level?: SyncConsentLevel) => void) {
  return render(
    <Wrapper>
      <DesktopOnboardingFlow onComplete={onComplete} />
    </Wrapper>
  );
}

const FOOTER_LABEL = "Back to landing";

function renderFlowWithFooter() {
  return render(
    <Wrapper>
      <DesktopOnboardingFlow
        footer={<button type="button">{FOOTER_LABEL}</button>}
      />
    </Wrapper>
  );
}

function authState(status: string) {
  return {
    state: { status, userId: null, organizationId: null },
    beginSignIn: vi.fn().mockResolvedValue({ ok: true }),
    cancelSignIn: vi.fn(),
    signOut: vi.fn(),
  };
}

beforeEach(() => {
  hooks.useGitHubIntegrationStatus.mockReturnValue({
    data: { connected: false },
  });
  hooks.useDesktopGitHubConnect.mockReturnValue({
    connectState: "idle",
    connectGitHub: vi.fn(),
  });
});

afterEach(() => {
  vi.clearAllMocks();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    // biome-ignore lint/performance/noDelete: restore the pre-test global shape.
    delete (window as { desktopApi?: unknown }).desktopApi;
  }
});

describe("DesktopOnboardingFlow", () => {
  it("keeps the sign-up wording for the host that really is signing people up", () => {
    // ISS-5112 made the heading and the email CTA overridable for the account
    // dialog, whose entry point is ambiguous. The blocking first-launch overlay
    // passes neither, and must read exactly as it did before.
    hooks.useDesktopAuth.mockReturnValue(authState("signed_out"));
    setDesktopApi({ setDataSyncLevel: vi.fn() });

    renderFlow();

    expect(
      screen.getByRole("heading", { name: "Create your Closedloop account" })
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Create account with email" })
    ).toBeDefined();
  });

  it("drops the host's footer once auth completes, so it cannot offer a way back that no longer exists", async () => {
    // ISS-5112 Step F: the landing's sign-in step is full-window, so its "Back to
    // landing" control is the only exit and lives in this footer. Rendering it
    // under `setup` too was a promise the app could not keep — by then the
    // browser round-trip has completed, the device is authenticated, and the
    // host's guest test no longer matches, so pressing it dropped the user into
    // the live app with connect-GitHub and sync-consent silently abandoned.
    const beginSignIn = vi.fn().mockResolvedValue({ ok: true });
    hooks.useDesktopAuth.mockReturnValue({
      ...authState("signed_out"),
      beginSignIn,
    });
    hooks.useGitHubIntegrationStatus.mockReturnValue({
      data: { connected: true },
    });
    setDesktopApi({ setDataSyncLevel: vi.fn() });

    renderFlowWithFooter();

    // Present on the auth step — asserted first, so the absence below cannot
    // pass against a footer that never rendered at all.
    expect(screen.getByRole("button", { name: FOOTER_LABEL })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: CONTINUE_GITHUB_RE }));
    await waitFor(() => expect(beginSignIn).toHaveBeenCalledTimes(1));
    await screen.findByRole("heading", { name: SYNC_HEADING_RE });

    expect(screen.queryByRole("button", { name: FOOTER_LABEL })).toBe(null);
  });

  it("GitHub sign-in goes straight to sync-consent (skips connect step)", async () => {
    const beginSignIn = vi.fn().mockResolvedValue({ ok: true });
    hooks.useDesktopAuth.mockReturnValue({
      ...authState("signed_out"),
      beginSignIn,
    });
    // A GitHub sign-up already granted the scoped connection.
    hooks.useGitHubIntegrationStatus.mockReturnValue({
      data: { connected: true },
    });
    setDesktopApi({ setDataSyncLevel: vi.fn() });

    renderFlow();
    fireEvent.click(screen.getByRole("button", { name: CONTINUE_GITHUB_RE }));

    await waitFor(() => expect(beginSignIn).toHaveBeenCalledTimes(1));
    // Straight to sync-consent — no connect prompt.
    await screen.findByRole("heading", { name: SYNC_HEADING_RE });
    expect(screen.queryByRole("heading", { name: CONNECT_HEADING_RE })).toBe(
      null
    );
  });

  it("Google sign-in shows the required connect step before sync-consent", async () => {
    const beginSignIn = vi.fn().mockResolvedValue({ ok: true });
    hooks.useDesktopAuth.mockReturnValue({
      ...authState("signed_out"),
      beginSignIn,
    });
    // Google/email sign-up has no GitHub connection yet.
    hooks.useGitHubIntegrationStatus.mockReturnValue({
      data: { connected: false },
    });
    setDesktopApi({ setDataSyncLevel: vi.fn() });

    const { rerender } = renderFlow();
    fireEvent.click(screen.getByRole("button", { name: CONTINUE_GOOGLE_RE }));

    await waitFor(() => expect(beginSignIn).toHaveBeenCalledTimes(1));
    // Required Connect-GitHub step first.
    await screen.findByRole("heading", { name: CONNECT_HEADING_RE });
    expect(screen.queryByRole("heading", { name: SYNC_HEADING_RE })).toBe(null);

    // Once GitHub connects, the flow advances to sync-consent.
    hooks.useGitHubIntegrationStatus.mockReturnValue({
      data: { connected: true },
    });
    rerender(
      <Wrapper>
        <DesktopOnboardingFlow />
      </Wrapper>
    );
    await screen.findByRole("heading", { name: SYNC_HEADING_RE });
  });

  it("persists the chosen level through setDataSyncLevel and fires onComplete", async () => {
    const beginSignIn = vi.fn().mockResolvedValue({ ok: true });
    hooks.useDesktopAuth.mockReturnValue({
      ...authState("signed_out"),
      beginSignIn,
    });
    hooks.useGitHubIntegrationStatus.mockReturnValue({
      data: { connected: true },
    });
    // FEA-4055: onboarding persists the LEVEL through the consolidated setter,
    // NOT `setSyncObservabilityTier` alone. Only `setDataSyncLevel` is stubbed,
    // so a regression back to the tier-only write would throw "not a function"
    // and fail here.
    const setDataSyncLevel = vi
      .fn()
      .mockResolvedValue({ level: DataSyncLevel.Metadata });
    setDesktopApi({ setDataSyncLevel });
    const onComplete = vi.fn();

    renderFlow(onComplete);
    fireEvent.click(screen.getByRole("button", { name: CONTINUE_GITHUB_RE }));
    await screen.findByRole("heading", { name: SYNC_HEADING_RE });

    // Pick the metadata level, then confirm.
    const metadataOption = screen.getByText(METADATA_RE).closest("label");
    expect(metadataOption).not.toBe(null);
    fireEvent.click(within(metadataOption as HTMLElement).getByRole("radio"));
    fireEvent.click(screen.getByRole("button", { name: CONTINUE_RE }));

    await waitFor(() =>
      expect(setDataSyncLevel).toHaveBeenCalledWith(DataSyncLevel.Metadata)
    );
    await waitFor(() =>
      expect(onComplete).toHaveBeenCalledWith(DataSyncLevel.Metadata)
    );
  });

  it("persists the safe metadata default when the user confirms without changing it", async () => {
    hooks.useDesktopAuth.mockReturnValue({
      ...authState("signed_out"),
      beginSignIn: vi.fn().mockResolvedValue({ ok: true }),
    });
    hooks.useGitHubIntegrationStatus.mockReturnValue({
      data: { connected: true },
    });
    const setDataSyncLevel = vi
      .fn()
      .mockResolvedValue({ level: DataSyncLevel.Metadata });
    setDesktopApi({ setDataSyncLevel });

    renderFlow();
    fireEvent.click(screen.getByRole("button", { name: CONTINUE_GITHUB_RE }));
    await screen.findByRole("heading", { name: SYNC_HEADING_RE });
    // Confirm without picking a different level. Consent is explicit and
    // per-level: the shared SyncConsent pre-selects the SAFEST insight-bearing
    // level ("metadata"), never the broadest, so an untouched Continue must
    // persist Metadata — not silently pre-consent to full transcript upload.
    expect(screen.getByText(FULL_SYNC_RE)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: CONTINUE_RE }));

    await waitFor(() =>
      expect(setDataSyncLevel).toHaveBeenCalledWith(DataSyncLevel.Metadata)
    );
  });

  /**
   * ISS-5489 regression. The landing's "Sign in" door and the guest account
   * dialog both live behind `guest-onboarding` — the same flag that mounts the
   * post-auth consent takeover. Before this, signing in through either one
   * advanced THIS flow to its own consent step while the takeover mounted on top
   * of it: two consent surfaces at once, sharing one native radio group, each
   * breaking the other's selection. The flow must end at sign-in instead.
   */
  it("ends at sign-in when the takeover owns consent, showing no consent step of its own", async () => {
    const beginSignIn = vi.fn().mockResolvedValue({ ok: true });
    hooks.useDesktopAuth.mockReturnValue({
      ...authState("signed_out"),
      beginSignIn,
    });
    hooks.useGitHubIntegrationStatus.mockReturnValue({
      data: { connected: true },
    });
    const setDataSyncLevel = vi.fn();
    setDesktopApi({ setDataSyncLevel });
    const onComplete = vi.fn();

    render(
      <Wrapper>
        <DesktopOnboardingFlow consentOwnedElsewhere onComplete={onComplete} />
      </Wrapper>
    );
    fireEvent.click(screen.getByRole("button", { name: CONTINUE_GITHUB_RE }));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    // The host is told the flow is finished so it can dismiss itself. Without
    // this the landing stayed on screen forever behind the takeover.
    expect(onComplete).toHaveBeenCalledWith();
    expect(screen.queryByRole("heading", { name: SYNC_HEADING_RE })).toBe(null);
    // And it must not have written a level: the takeover owns that write, and a
    // silent default here would pre-answer the question the user is about to be
    // asked.
    expect(setDataSyncLevel).not.toHaveBeenCalled();
  });

  it("surfaces a sign-in failure and stays on the auth step", async () => {
    const beginSignIn = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: "start_failed" });
    hooks.useDesktopAuth.mockReturnValue({
      ...authState("signed_out"),
      beginSignIn,
    });
    setDesktopApi({ setDataSyncLevel: vi.fn() });

    renderFlow();
    fireEvent.click(screen.getByRole("button", { name: CONTINUE_GITHUB_RE }));

    // The error surfaces via the canonical DS Alert (role="alert",
    // data-slot="alert"), not a hand-rolled banner. We assert the DS slot,
    // not its tint value — retuning the variant in alert.tsx must not redden
    // this test.
    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("data-slot")).toBe("alert");
    expect(within(alert).getByText(SIGN_IN_ERROR_RE)).toBeTruthy();
    // Still on the auth step (no sync-consent).
    expect(screen.queryByRole("heading", { name: SYNC_HEADING_RE })).toBe(null);
  });

  it("shows a single setup error, latest-wins (a save failure supersedes a stale connect one)", async () => {
    hooks.useDesktopAuth.mockReturnValue({
      ...authState("signed_out"),
      beginSignIn: vi.fn().mockResolvedValue({ ok: true }),
    });
    hooks.useGitHubIntegrationStatus.mockReturnValue({
      data: { connected: true },
    });
    // A connect failure is already on screen when the save also fails.
    hooks.useDesktopGitHubConnect.mockReturnValue({
      connectState: DesktopGitHubConnectState.Failed,
      connectGitHub: vi.fn(),
    });
    const setDataSyncLevel = vi.fn().mockRejectedValue(new Error("nope"));
    setDesktopApi({ setDataSyncLevel });

    renderFlow();
    fireEvent.click(screen.getByRole("button", { name: CONTINUE_GITHUB_RE }));
    await screen.findByRole("heading", { name: SYNC_HEADING_RE });
    fireEvent.click(screen.getByRole("button", { name: CONTINUE_RE }));

    // The persist failure wins; only one banner renders, not two stacked.
    await screen.findByText(PERSIST_ERROR_RE);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryByText(CONNECT_ERROR_RE)).toBe(null);
  });
});
