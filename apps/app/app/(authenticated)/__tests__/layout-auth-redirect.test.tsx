import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FEA-632: unauthenticated visitors should default to the sign-up page rather
 * than sign-in, since nearly everyone landing on app.closedloop.ai is a new
 * user. This test pins the redirect decision in the (authenticated) layout so a
 * future refactor cannot silently flip new visitors back to sign-in.
 */

const {
  authMock,
  redirectToSignUpMock,
  redirectToSignInMock,
  onboardingGuardTestId,
  workspaceAuthGuardTestId,
  pageTestId,
  artifactPrewarmTestId,
  devToolsOverlayTestId,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  redirectToSignUpMock: vi.fn(() => "SIGN_UP_REDIRECT"),
  redirectToSignInMock: vi.fn(() => "SIGN_IN_REDIRECT"),
  onboardingGuardTestId: "onboarding-guard",
  workspaceAuthGuardTestId: "workspace-auth-guard",
  pageTestId: "page",
  artifactPrewarmTestId: "artifact-route-prewarm",
  devToolsOverlayTestId: "dev-tools-overlay",
}));

vi.mock("@repo/auth/server", () => ({
  auth: authMock,
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => undefined })),
  headers: vi.fn(async () => new Map()),
}));

// Stub the layout's client and provider trees so importing and rendering it
// stays light. The two guards render as marker elements the nesting test
// locates; everything else renders nothing or passes its children through.
vi.mock("@repo/analytics/components/user-identifier", () => ({
  UserIdentifier: () => null,
}));
vi.mock("@repo/design-system/components/ui/sidebar", () => ({
  SIDEBAR_COOKIE_NAME: "sidebar",
  SidebarProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/lib/frontend-capture/frontend-capture-controller", () => ({
  FrontendCaptureController: () => null,
}));
vi.mock(
  "@repo/app/documents/components/collaboration-provider-wrapper",
  () => ({
    CollaborationProviderWrapper: ({ children }: { children: unknown }) =>
      children,
  })
);
vi.mock("../components/command-palette", () => ({
  CommandPalette: () => null,
}));
vi.mock("../components/artifact-route-prewarm", () => ({
  ArtifactRoutePrewarm: () => <div data-testid={artifactPrewarmTestId} />,
}));
vi.mock("../components/onboarding-guard", () => ({
  OnboardingGuard: ({ children }: { children: ReactNode }) => (
    <div data-testid={onboardingGuardTestId}>{children}</div>
  ),
}));
vi.mock("../components/workspace-auth-guard", () => ({
  WorkspaceAuthGuard: ({ children }: { children: ReactNode }) => (
    <div data-testid={workspaceAuthGuardTestId}>{children}</div>
  ),
}));
vi.mock("../components/sidebar", () => ({
  GlobalSidebar: ({ children }: { children: unknown }) => children,
}));
vi.mock("@repo/app/shared/components/mobile-bottom-nav", () => ({
  MobileBottomNav: () => null,
}));
vi.mock("@repo/app/shared/dev-tools/components/dev-tools-overlay", () => ({
  DevToolsOverlay: () => <div data-testid={devToolsOverlayTestId} />,
}));

async function importLayout() {
  const mod = await import("../layout");
  return mod.default;
}

function stubSession(userId: string | null) {
  authMock.mockResolvedValue({
    redirectToSignUp: redirectToSignUpMock,
    redirectToSignIn: redirectToSignInMock,
    userId,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("(authenticated) layout unauthenticated redirect", () => {
  it("redirects unauthenticated visitors to sign-up, not sign-in", async () => {
    stubSession(null);

    const AppLayout = await importLayout();
    const result = await AppLayout({ children: null });

    expect(redirectToSignUpMock).toHaveBeenCalledTimes(1);
    expect(redirectToSignInMock).not.toHaveBeenCalled();
    expect(result).toBe("SIGN_UP_REDIRECT");
  });

  it("does not redirect when a user is present", async () => {
    stubSession("user_1");

    const AppLayout = await importLayout();
    await AppLayout({ children: null });

    expect(redirectToSignUpMock).not.toHaveBeenCalled();
    expect(redirectToSignInMock).not.toHaveBeenCalled();
  });
});

// ISS-7828: with no settled onboarding status and a held session rejection,
// OnboardingGuard renders its children and leaves recovery to
// WorkspaceAuthGuard. That is safe only while the page renders inside
// WorkspaceAuthGuard, inside OnboardingGuard. The guard suites build that
// nesting themselves, so only a render of this layout catches a reorder.
describe("(authenticated) layout guard nesting", () => {
  it("renders the page inside WorkspaceAuthGuard, inside OnboardingGuard", async () => {
    stubSession("user_1");

    const AppLayout = await importLayout();
    render(await AppLayout({ children: <div data-testid={pageTestId} /> }));

    const onboardingGuard = screen.getByTestId(onboardingGuardTestId);
    const workspaceAuthGuard = screen.getByTestId(workspaceAuthGuardTestId);
    expect(onboardingGuard.contains(workspaceAuthGuard)).toBe(true);
    expect(workspaceAuthGuard.contains(screen.getByTestId(pageTestId))).toBe(
      true
    );
  });
});

// ISS-7492: the prewarm exists to start the page's reads before OnboardingGuard
// has an answer. Moved inside the guard it still renders and still passes its
// own suite, but warms nothing.
describe("(authenticated) layout artifact prewarm placement", () => {
  it("mounts the artifact prewarm outside OnboardingGuard", async () => {
    stubSession("user_1");

    const AppLayout = await importLayout();
    render(await AppLayout({ children: <div data-testid={pageTestId} /> }));

    const prewarm = screen.getByTestId(artifactPrewarmTestId);
    expect(screen.getByTestId(onboardingGuardTestId).contains(prewarm)).toBe(
      false
    );
  });
});

// ISS-12048: the overlay is mounted once in the authenticated shell, outside
// OnboardingGuard so it stays reachable while the guard blanks its subtree.
describe("(authenticated) layout Dev Tools overlay mount", () => {
  it("mounts the Dev Tools overlay once, outside OnboardingGuard", async () => {
    stubSession("user_1");

    const AppLayout = await importLayout();
    render(await AppLayout({ children: <div data-testid={pageTestId} /> }));

    const overlays = screen.getAllByTestId(devToolsOverlayTestId);
    expect(overlays).toHaveLength(1);
    expect(
      screen.getByTestId(onboardingGuardTestId).contains(overlays[0] ?? null)
    ).toBe(false);
  });
});
