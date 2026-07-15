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

describe("DashboardPage", () => {
  it("mounts the local dashboard body while runtime readiness is still pending", () => {
    render(<DashboardPage />);

    expect(screen.getByTestId("desktop-insights-provider")).toBeDefined();
    expect(screen.getByTestId("first-launch-dashboard")).toBeDefined();
  });
});
