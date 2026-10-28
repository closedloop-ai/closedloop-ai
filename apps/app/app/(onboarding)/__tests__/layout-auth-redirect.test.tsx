import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FEA-632: the onboarding shell defaults unauthenticated visitors to sign-up,
 * exactly as the (authenticated) layout does. Pinned here as well as there
 * because the two layouts hold the same contract independently — ISS-10335
 * moved both off `currentUser()` onto the session's `userId`, and only the
 * authenticated half had coverage.
 */

const { authMock, redirectToSignUpMock, redirectToSignInMock } = vi.hoisted(
  () => ({
    authMock: vi.fn(),
    redirectToSignUpMock: vi.fn(() => "SIGN_UP_REDIRECT"),
    redirectToSignInMock: vi.fn(() => "SIGN_IN_REDIRECT"),
  })
);

vi.mock("@repo/auth/server", () => ({
  auth: authMock,
}));

vi.mock("@repo/design-system/components/ui/mode-toggle", () => ({
  ModeToggle: () => null,
}));

function stubSession(userId: string | null) {
  authMock.mockResolvedValue({
    redirectToSignUp: redirectToSignUpMock,
    redirectToSignIn: redirectToSignInMock,
    userId,
  });
}

async function importLayout() {
  const mod = await import("../layout");
  return mod.default;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("(onboarding) layout unauthenticated redirect", () => {
  it("redirects unauthenticated visitors to sign-up, not sign-in", async () => {
    stubSession(null);

    const OnboardingLayout = await importLayout();
    const result = await OnboardingLayout({ children: null });

    expect(redirectToSignUpMock).toHaveBeenCalledTimes(1);
    expect(redirectToSignInMock).not.toHaveBeenCalled();
    expect(result).toBe("SIGN_UP_REDIRECT");
  });

  it("does not redirect when a session carries a user", async () => {
    stubSession("user_1");

    const OnboardingLayout = await importLayout();
    await OnboardingLayout({ children: null });

    expect(redirectToSignUpMock).not.toHaveBeenCalled();
    expect(redirectToSignInMock).not.toHaveBeenCalled();
  });
});
