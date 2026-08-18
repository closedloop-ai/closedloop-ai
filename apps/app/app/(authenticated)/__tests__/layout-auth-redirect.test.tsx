import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FEA-632: unauthenticated visitors should default to the sign-up page rather
 * than sign-in, since nearly everyone landing on app.closedloop.ai is a new
 * user. This test pins the redirect decision in the (authenticated) layout so a
 * future refactor cannot silently flip new visitors back to sign-in.
 */

const {
  authMock,
  currentUserMock,
  redirectToSignUpMock,
  redirectToSignInMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  currentUserMock: vi.fn(),
  redirectToSignUpMock: vi.fn(() => "SIGN_UP_REDIRECT"),
  redirectToSignInMock: vi.fn(() => "SIGN_IN_REDIRECT"),
}));

vi.mock("@repo/auth/server", () => ({
  auth: authMock,
  currentUser: currentUserMock,
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => undefined })),
  headers: vi.fn(async () => new Map()),
}));

// The unauthenticated branch returns before rendering any children, but the
// layout module still imports these at load time. Stub them so importing the
// layout does not pull in heavy client/provider trees.
vi.mock("@repo/analytics/components/user-identifier", () => ({
  UserIdentifier: () => null,
}));
vi.mock("@repo/design-system/components/ui/sidebar", () => ({
  SIDEBAR_COOKIE_NAME: "sidebar",
  SidebarProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/components/engineer/engineer-transport-bootstrap", () => ({
  EngineerTransportBootstrap: () => null,
}));
vi.mock("@/lib/frontend-capture/frontend-capture-controller", () => ({
  FrontendCaptureController: () => null,
}));
vi.mock("@/lib/system-check/pre-loop-system-check-provider", () => ({
  PreLoopSystemCheckProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock("../components/collaboration-provider-wrapper", () => ({
  CollaborationProviderWrapper: ({ children }: { children: unknown }) =>
    children,
}));
vi.mock("../components/command-palette", () => ({
  CommandPalette: () => null,
}));
vi.mock("../components/onboarding-guard", () => ({
  OnboardingGuard: ({ children }: { children: unknown }) => children,
}));
vi.mock("../components/sidebar", () => ({ GlobalSidebar: () => null }));

async function importLayout() {
  const mod = await import("../layout");
  return mod.default;
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({
    redirectToSignUp: redirectToSignUpMock,
    redirectToSignIn: redirectToSignInMock,
  });
});

describe("(authenticated) layout unauthenticated redirect", () => {
  it("redirects unauthenticated visitors to sign-up, not sign-in", async () => {
    currentUserMock.mockResolvedValue(null);

    const AppLayout = await importLayout();
    const result = await AppLayout({ children: null });

    expect(redirectToSignUpMock).toHaveBeenCalledTimes(1);
    expect(redirectToSignInMock).not.toHaveBeenCalled();
    expect(result).toBe("SIGN_UP_REDIRECT");
  });

  it("does not redirect when a user is present", async () => {
    currentUserMock.mockResolvedValue({ id: "user_1" });

    const AppLayout = await importLayout();
    await AppLayout({ children: null });

    expect(redirectToSignUpMock).not.toHaveBeenCalled();
    expect(redirectToSignInMock).not.toHaveBeenCalled();
  });
});
