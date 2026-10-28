import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { DashboardPage } from "../DashboardPage";

vi.mock("../../insights/desktop-insights-provider", () => ({
  DesktopInsightsProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid="desktop-insights-provider">{children}</div>
  ),
}));

vi.mock("../first-launch-dashboard", () => ({
  FirstLaunchDashboard: () => <div data-testid="first-launch-dashboard" />,
}));

vi.mock("../desktop-dashboard-page-viewed", () => ({
  DesktopDashboardPageViewed: () => null,
}));

describe("DashboardPage", () => {
  it("mounts the local dashboard body while runtime readiness is still pending", () => {
    render(<DashboardPage />);

    expect(screen.getByTestId("desktop-insights-provider")).toBeDefined();
    expect(screen.getByTestId("first-launch-dashboard")).toBeDefined();
  });

  it("layers nothing over the dashboard", () => {
    // ISS-7995: the page used to mount a blocking pre-auth overlay
    // (`role="dialog"`, "Set up your Closedloop account") for a signed-out
    // device. Guest-mode first run replaced it, so this page composes the
    // dashboard and nothing else — no dialog. The analytics child is mocked
    // because this suite does not provide its auth and insights contexts.
    render(<DashboardPage />);

    expect(screen.queryByRole("dialog")).toBe(null);
    expect(screen.queryByLabelText("Set up your Closedloop account")).toBe(
      null
    );
  });
});
