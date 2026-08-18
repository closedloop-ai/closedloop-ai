import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CloudReadCutoverBlocker,
  CloudReadCutoverLatch,
  DesktopAppCoreMode,
} from "../../../shared-agent-sessions/desktop-app-core-mode";
import { DashboardCutoverStatus } from "../dashboard-cutover-status";

const hooks = vi.hoisted(() => ({
  useDesktopCloudReadCutover: vi.fn(),
}));

vi.mock("../../../shared-agent-sessions/desktop-app-core-provider", () => ({
  useDesktopCloudReadCutover: hooks.useDesktopCloudReadCutover,
}));

function cutover(overrides: Record<string, unknown> = {}) {
  return {
    blocker: CloudReadCutoverBlocker.SyncDraining,
    deadLetteredCount: 0,
    failedOpen: false,
    itemsRemaining: 3401,
    latch: CloudReadCutoverLatch.None,
    mode: DesktopAppCoreMode.Local,
    ...overrides,
  };
}

describe("DashboardCutoverStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("says the drain out loud, with its size, instead of only on hover", () => {
    hooks.useDesktopCloudReadCutover.mockReturnValue(cutover());

    render(<DashboardCutoverStatus analyzing={false} />);

    const status = screen.getByTestId("dashboard-cutover-status");
    expect(status.textContent).toContain("Uploading history");
    expect(status.textContent).toContain("3,401 to go");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
  });

  it("stands down while the scan is already talking, so the row never stacks two", () => {
    hooks.useDesktopCloudReadCutover.mockReturnValue(cutover());

    render(<DashboardCutoverStatus analyzing />);

    expect(screen.queryByTestId("dashboard-cutover-status")).toBeNull();
  });

  it("claims no count when a lane cannot measure its own remainder", () => {
    hooks.useDesktopCloudReadCutover.mockReturnValue(
      cutover({ itemsRemaining: null })
    );

    render(<DashboardCutoverStatus analyzing={false} />);

    const status = screen.getByTestId("dashboard-cutover-status");
    expect(status.textContent).toContain("Uploading history");
    expect(status.textContent).not.toContain("to go");
    expect(status.textContent).not.toContain("0");
  });

  it("stays silent where there is no work to report", () => {
    for (const decision of [
      cutover({ blocker: CloudReadCutoverBlocker.Offline }),
      cutover({ blocker: CloudReadCutoverBlocker.NotAuthenticated }),
      cutover({ blocker: CloudReadCutoverBlocker.ReadinessUnknown }),
      cutover({ blocker: null }),
      // Already cut over: the badge's own detail covers catching-up.
      cutover({ mode: DesktopAppCoreMode.Cloud }),
    ]) {
      hooks.useDesktopCloudReadCutover.mockReturnValue(decision);
      const { unmount } = render(<DashboardCutoverStatus analyzing={false} />);
      expect(screen.queryByTestId("dashboard-cutover-status")).toBeNull();
      unmount();
    }
  });

  it("also speaks for a lane that has not started uploading yet", () => {
    hooks.useDesktopCloudReadCutover.mockReturnValue(
      cutover({ blocker: CloudReadCutoverBlocker.SyncNotEstablished })
    );

    render(<DashboardCutoverStatus analyzing={false} />);

    expect(screen.getByTestId("dashboard-cutover-status")).toBeTruthy();
  });
});
