import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardPage } from "../DashboardPage";

vi.mock("../../insights/desktop-insights-provider", () => ({
  DesktopInsightsProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid="desktop-insights-provider">{children}</div>
  ),
}));

vi.mock("../first-launch-dashboard", () => ({
  FirstLaunchDashboard: () => <div data-testid="first-launch-dashboard" />,
}));

// The overlay's props are captured rather than asserted inside the mock: the
// assertion belongs in the test body, where it fails if the overlay never
// rendered at all.
const onboardingFlowProps = vi.hoisted(
  () => ({ last: null }) as { last: { showEmail?: boolean } | null }
);
vi.mock("../../onboarding/desktop-onboarding-flow", () => ({
  DesktopOnboardingFlow: (props: { showEmail?: boolean }) => {
    onboardingFlowProps.last = props;
    return <div data-testid="desktop-onboarding-flow" />;
  },
}));

// PRD-532 (M4): the onboarding overlay layers over the dashboard when the device
// is not yet signed in. Auth state is controllable per test below.
const authState = vi.hoisted(() => ({
  status: "signed_out" as string,
}));
vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({
    state: { status: authState.status, userId: null, organizationId: null },
    beginSignIn: vi.fn(),
    cancelSignIn: vi.fn(),
    signOut: vi.fn(),
  }),
}));

// ISS-5112: the guest-onboarding Labs flag plus whether the desktop flag
// snapshot has settled. Both controllable per test, mirroring how auth state is
// handled above rather than mounting the real providers.
const flagState = vi.hoisted(() => ({
  resolved: true,
  guestOnboarding: false,
}));
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: () => flagState.guestOnboarding,
}));
vi.mock("../../../feature-flags/desktop-feature-flag-provider", () => ({
  useDesktopFeatureFlagsResolved: () => flagState.resolved,
}));

afterEach(() => {
  authState.status = "signed_out";
  flagState.resolved = true;
  flagState.guestOnboarding = false;
  onboardingFlowProps.last = null;
});

describe("DashboardPage", () => {
  it("mounts the local dashboard body while runtime readiness is still pending", () => {
    render(<DashboardPage />);

    expect(screen.getByTestId("desktop-insights-provider")).toBeDefined();
    expect(screen.getByTestId("first-launch-dashboard")).toBeDefined();
  });

  it("layers the onboarding overlay over the dashboard when signed out", () => {
    render(<DashboardPage />);

    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByTestId("desktop-onboarding-flow")).toBeDefined();
  });

  it("does not render the onboarding overlay for an authenticated device", () => {
    authState.status = "authenticated";
    render(<DashboardPage />);

    expect(screen.queryByRole("dialog")).toBe(null);
  });

  // ISS-5112 ---------------------------------------------------------------

  it("leaves the dashboard unblocked for a guest when guest onboarding is on", () => {
    flagState.guestOnboarding = true;
    render(<DashboardPage />);

    expect(screen.queryByRole("dialog")).toBe(null);
    // The dashboard itself still mounts — guest mode replaces the gate, it does
    // not replace the page.
    expect(screen.getByTestId("first-launch-dashboard")).toBeDefined();
  });

  // ISS-5112: desktop has no magic-link path, so an email pick opens the same
  // loopback OAuth as the others and resolves to GitHub. This overlay was the
  // last of the three doors still offering it; all three now offer the same two.
  it("offers the blocking overlay without the email method", () => {
    render(<DashboardPage />);

    expect(screen.getByTestId("desktop-onboarding-flow")).toBeDefined();
    expect(onboardingFlowProps.last?.showEmail).toBe(false);
  });

  it("does not flash the blocking overlay before the flag snapshot settles", () => {
    flagState.resolved = false;
    render(<DashboardPage />);

    expect(screen.queryByRole("dialog")).toBe(null);
  });
});
