import { DesktopSignInProvider } from "@repo/api/src/types/desktop-authorize-url";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopBrowserSignInResult } from "../../../../shared/contracts";
import { DesktopAuthProvider } from "../../../shared-agent-sessions/desktop-auth-provider";
import type { DesktopAuthState } from "../../../types/desktop-api";
import { DesktopGitHubConnectState } from "../../branches/use-desktop-github-connect";
import { DesktopAccountTab } from "../desktop-account-tab";

// Regex literals hoisted to top level (Biome useTopLevelRegex).
const SIGN_IN_RE = /^sign in$/i;
const SIGN_OUT_RE = /^sign out$/i;
const SIGN_OUT_ERROR_RE = /Sign-out could not be completed\. Try again\./;
const CONTINUE_WITH_GITHUB_RE = /continue with github/i;
const CONTINUE_WITH_GOOGLE_RE = /continue with google/i;
const CONNECT_GITHUB_HEADING_RE = /connect github to finish setup/i;
const SIGNED_OUT_STATE: DesktopAuthState = {
  status: "signed_out",
  userId: null,
  organizationId: null,
};
const NOT_CONNECTED_RE = /^not connected$/i;
const CONNECTED_RE = /^connected$/i;

const AUTHENTICATED_STATE: DesktopAuthState = {
  status: "authenticated",
  userId: "user_123",
  organizationId: "org_456",
};

// The GitHub status hook + the desktop connect hook are the two real
// dependencies of the unified surface; stub them so the account tab renders
// against a controllable connection state without a live cloud API.
const githubStatus = vi.hoisted(() => ({
  connected: false as boolean,
  // When true, the status query has not resolved (loading / error) so `data` is
  // undefined — the case where sign-out must not disappear.
  unresolved: false as boolean,
}));
const connectGitHub = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock("@repo/app/github/hooks/use-github-integration", () => ({
  useGitHubIntegrationStatus: () => ({
    data: githubStatus.unresolved
      ? undefined
      : { connected: githubStatus.connected },
  }),
}));

vi.mock("../../branches/use-desktop-github-connect", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../branches/use-desktop-github-connect")
    >();
  return {
    ...actual,
    useDesktopGitHubConnect: () => ({
      connectState: actual.DesktopGitHubConnectState.Idle,
      connectGitHub,
    }),
  };
});

// Stub the auth bridge. `getDesktopAuthState` seeds the mirrored snapshot;
// `signOutDesktop` drives the sign-out outcome under test. The identity fetch
// is omitted so the panel falls back to the id.
function installDesktopApi(
  overrides: Partial<Window["desktopApi"]> = {}
): void {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getDesktopAuthState: vi.fn(() => Promise.resolve(AUTHENTICATED_STATE)),
      signOutDesktop: vi.fn(() => Promise.resolve()),
      ...overrides,
    },
  });
}

function renderAccountTab(): void {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <DesktopAuthProvider>{children}</DesktopAuthProvider>
  );
  render(
    <Wrapper>
      <DesktopAccountTab />
    </Wrapper>
  );
}

describe("DesktopAccountTab unified surface (PRD-532)", () => {
  beforeEach(() => {
    // Default to a resolved status query; individual tests opt into the
    // unresolved (loading/error) case explicitly.
    githubStatus.unresolved = false;
  });

  it("surfaces an error message when sign-out rejects", async () => {
    githubStatus.connected = true;
    installDesktopApi({
      signOutDesktop: vi.fn(() => Promise.reject(new Error("boom"))),
    });
    renderAccountTab();

    fireEvent.click(await screen.findByRole("button", { name: SIGN_OUT_RE }));

    expect(await screen.findByText(SIGN_OUT_ERROR_RE)).not.toBeNull();
  });

  it("shows no error when sign-out resolves", async () => {
    githubStatus.connected = true;
    installDesktopApi();
    renderAccountTab();

    fireEvent.click(await screen.findByRole("button", { name: SIGN_OUT_RE }));

    // Let the resolved sign-out settle; the busy button returns to "Sign out".
    await screen.findByRole("button", { name: SIGN_OUT_RE });
    expect(screen.queryByText(SIGN_OUT_ERROR_RE)).toBeNull();
  });

  // ISS-5112: this surface took the picked method and then called the sign-in
  // with no argument, so every method fell through to the absent-provider
  // default — "Continue with Google" opened GitHub's consent screen. Both
  // methods are asserted because a hardcoded provider passes the GitHub case.
  it("forwards the picked provider to the sign-in, per method", async () => {
    const beginDesktopSignIn = vi.fn(
      (
        _provider?: DesktopSignInProvider
      ): Promise<DesktopBrowserSignInResult> => Promise.resolve({ ok: true })
    );
    installDesktopApi({
      beginDesktopSignIn,
      getDesktopAuthState: vi.fn(() => Promise.resolve(SIGNED_OUT_STATE)),
    });
    renderAccountTab();

    fireEvent.click(
      await screen.findByRole("button", { name: CONTINUE_WITH_GOOGLE_RE })
    );
    await waitFor(() =>
      expect(beginDesktopSignIn).toHaveBeenCalledWith(
        DesktopSignInProvider.Google
      )
    );

    fireEvent.click(
      await screen.findByRole("button", { name: CONTINUE_WITH_GITHUB_RE })
    );
    await waitFor(() =>
      expect(beginDesktopSignIn).toHaveBeenCalledWith(
        DesktopSignInProvider.GitHub
      )
    );
  });

  it("renders GitHub-first AuthMethods when signed out", async () => {
    installDesktopApi({
      getDesktopAuthState: vi.fn(() =>
        Promise.resolve<DesktopAuthState>({
          status: "signed_out",
          userId: null,
          organizationId: null,
        })
      ),
    });
    renderAccountTab();

    // GitHub is the primary (first) action, above Google.
    const github = await screen.findByRole("button", {
      name: CONTINUE_WITH_GITHUB_RE,
    });
    const google = screen.getByRole("button", {
      name: CONTINUE_WITH_GOOGLE_RE,
    });
    expect(github).not.toBeNull();
    // GitHub renders before Google in document order (GitHub-first hierarchy).
    const buttons = screen.getAllByRole("button");
    expect(buttons.indexOf(github)).toBeLessThan(buttons.indexOf(google));
    // The legacy single "Sign in" button no longer exists.
    expect(screen.queryByRole("button", { name: SIGN_IN_RE })).toBeNull();
  });

  it("renders ConnectGitHubPrompt when signed in but GitHub not connected", async () => {
    githubStatus.connected = false;
    installDesktopApi();
    renderAccountTab();

    expect(
      await screen.findByRole("heading", { name: CONNECT_GITHUB_HEADING_RE })
    ).not.toBeNull();
    expect(screen.getByText(NOT_CONNECTED_RE)).not.toBeNull();
    // Sign-out stays available on the not-connected surface: it doesn't depend
    // on GitHub, and this same surface renders while the connection status is
    // still loading or has failed to load, so the user is never trapped.
    expect(screen.getByRole("button", { name: SIGN_OUT_RE })).not.toBeNull();
  });

  it("keeps sign-out available when the GitHub status is unresolved (loading/error)", async () => {
    // Signed in, but the status query has not resolved: `data` is undefined, so
    // the tab renders the connect-GitHub surface. Sign-out must still be present
    // — signing out does not depend on GitHub, and an offline/API-error user
    // must not be trapped without a way to leave.
    githubStatus.unresolved = true;
    const signOutDesktop = vi.fn(() => Promise.resolve());
    installDesktopApi({ signOutDesktop });
    renderAccountTab();

    fireEvent.click(await screen.findByRole("button", { name: SIGN_OUT_RE }));
    expect(signOutDesktop).toHaveBeenCalledTimes(1);
  });

  it("calls connectGitHub when the connect prompt is clicked", async () => {
    githubStatus.connected = false;
    connectGitHub.mockClear();
    installDesktopApi();
    renderAccountTab();

    // Wait for the auth snapshot to resolve to authenticated (the prompt
    // heading only renders on the signed-in + not-connected branch) so the
    // clicked button is the ConnectGitHubPrompt's, not AuthMethods' identically
    // labeled GitHub button that renders during the transient loading state.
    await screen.findByRole("heading", { name: CONNECT_GITHUB_HEADING_RE });
    fireEvent.click(
      screen.getByRole("button", { name: CONTINUE_WITH_GITHUB_RE })
    );
    expect(connectGitHub).toHaveBeenCalledTimes(1);
  });

  it("renders identity + connected status + sign-out when connected", async () => {
    githubStatus.connected = true;
    installDesktopApi();
    renderAccountTab();

    expect(await screen.findByText(CONNECTED_RE)).not.toBeNull();
    // Falls back to the raw id when the identity fetch is omitted.
    expect(screen.getByText("user_123")).not.toBeNull();
    expect(screen.getByRole("button", { name: SIGN_OUT_RE })).not.toBeNull();
  });

  it("calls signOut when the sign-out button is clicked (connected)", async () => {
    githubStatus.connected = true;
    const signOutDesktop = vi.fn(() => Promise.resolve());
    installDesktopApi({ signOutDesktop });
    renderAccountTab();

    fireEvent.click(await screen.findByRole("button", { name: SIGN_OUT_RE }));
    expect(signOutDesktop).toHaveBeenCalledTimes(1);
  });

  it("keeps the connect state exhaustive across DesktopGitHubConnectState", () => {
    // Guard: every terminal connect state is a known member; adding a new one
    // without handling it here fails the type-level exhaustiveness in the tab.
    const states = Object.values(DesktopGitHubConnectState);
    expect(states).toContain(DesktopGitHubConnectState.Failed);
    expect(states).toContain(DesktopGitHubConnectState.SignInRequired);
  });
});
