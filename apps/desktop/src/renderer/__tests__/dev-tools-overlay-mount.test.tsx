import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderDesktopApp, setupAppShellSuite } from "./app-shell-harness";

/**
 * ISS-12048 — the desktop renderer mounts the shared Dev Tools overlay once.
 *
 * The real overlay renders nothing unless Dev Mode is on, and the desktop shell
 * mounts no Dev Mode provider today, so without this marker the mount is
 * invisible: deleting it from `App.tsx` would leave every other suite green.
 */
vi.mock("@repo/app/shared/dev-tools/components/dev-tools-overlay", () => ({
  DevToolsOverlay: () => <div data-testid="dev-tools-overlay-marker" />,
}));
vi.mock("../components/UpdateBanner", () => ({ UpdateBanner: () => null }));
vi.mock("../components/desktop-session-expired-banner", () => ({
  DesktopSessionExpiredBanner: () => null,
}));
vi.mock("../components/desktop-sync-prompt", () => ({
  DesktopSyncPrompt: () => null,
}));
vi.mock("../components/opt-in-distributions-banner", () => ({
  OptInDistributionsBanner: () => null,
}));
vi.mock("../components/command-palette/command-palette", () => ({
  CommandPalette: () => null,
}));
vi.mock("../components/layout/Sidebar", () => ({
  Sidebar: () => <div data-testid="sidebar-marker" />,
}));
vi.mock("../components/layout/Topbar", () => ({
  Topbar: () => <div data-testid="topbar-marker" />,
}));
vi.mock("../components/layout/mac-window-controls-underlay", () => ({
  MacWindowControlsUnderlay: () => null,
}));
vi.mock("../components/dashboard/DashboardPage", () => ({
  DashboardPage: () => <div data-testid="dashboard-marker" />,
}));

describe("the desktop renderer mounts the Dev Tools overlay (ISS-12048)", () => {
  setupAppShellSuite();

  it("renders the overlay exactly once in the shell", async () => {
    renderDesktopApp("#/");

    await screen.findByTestId("sidebar-marker");
    expect(screen.getAllByTestId("dev-tools-overlay-marker")).toHaveLength(1);
  });
});
