import { ReadSource } from "@repo/api/src/types/read-source";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  drainedCutover,
  drainingCutover,
  signedOutCutover,
} from "../../../shared-agent-sessions/__tests__/fixtures/cloud-read-cutover-fixtures";
import {
  CloudReadCutoverBlocker,
  CloudReadCutoverLatch,
  DesktopAppCoreMode,
} from "../../../shared-agent-sessions/desktop-app-core-mode";
import { DashboardReadSourceBadge } from "../dashboard-read-source-badge";

// PLN-1138: the dashboard read-source badge unifies with the Sessions/Branches
// toolbars on the shared ReadSourceBadge. It derives its source from the
// app-core mode — "Cloud" in Cloud mode, "Local" in Local mode (which, for an
// authenticated session, is either the offline degradation, AC-3.3, or the
// ISS-5477 hold while the upload backlog drains).
const hooks = vi.hoisted(() => ({
  useDesktopAppCoreMode: vi.fn(),
  useDesktopCloudReadCutover: vi.fn(),
}));

vi.mock("../../../shared-agent-sessions/desktop-app-core-provider", () => ({
  useDesktopAppCoreMode: hooks.useDesktopAppCoreMode,
  useDesktopCloudReadCutover: hooks.useDesktopCloudReadCutover,
}));

describe("DashboardReadSourceBadge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hooks.useDesktopCloudReadCutover.mockReturnValue(signedOutCutover());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the Cloud read source in Cloud mode", () => {
    hooks.useDesktopAppCoreMode.mockReturnValue(DesktopAppCoreMode.Cloud);
    hooks.useDesktopCloudReadCutover.mockReturnValue(drainedCutover());

    render(<DashboardReadSourceBadge />);

    const badge = screen.getByTestId("read-source-badge");
    expect(badge.textContent).toContain("Cloud");
    expect(badge.getAttribute("data-read-source")).toBe(ReadSource.Cloud);
    // A genuinely drained cloud read needs no caveat.
    expect(badge.getAttribute("data-read-source-detail")).toBeNull();
  });

  it("shows the Local read source in Local mode (authenticated-offline own-data)", () => {
    hooks.useDesktopAppCoreMode.mockReturnValue(DesktopAppCoreMode.Local);

    render(<DashboardReadSourceBadge />);

    const badge = screen.getByTestId("read-source-badge");
    expect(badge.textContent).toContain("Local");
    expect(badge.getAttribute("data-read-source")).toBe(ReadSource.Local);
  });

  it("explains the ISS-5477 hold, with progress, while the backlog drains", () => {
    hooks.useDesktopAppCoreMode.mockReturnValue(DesktopAppCoreMode.Local);
    hooks.useDesktopCloudReadCutover.mockReturnValue(drainingCutover(3401));

    render(<DashboardReadSourceBadge />);

    const badge = screen.getByTestId("read-source-badge");
    const detail = badge.getAttribute("data-read-source-detail") ?? "";
    // Not an error and not an empty state: the app is usable, this IS the
    // user's data, and the wait has a legible size.
    expect(detail).toContain("still uploading");
    // ISS-5768: routed through the shared `formatCount`, so this badge and the
    // Settings History Sync cell quote one machine identically — they agreed on
    // the noun but not the separator ("3401" beside "3,401" for one number).
    expect(detail).toContain("3,401 items");
    expect(detail).toContain("Nothing is missing");
  });

  it("says the cloud view may be incomplete when the fail-open let it through", () => {
    hooks.useDesktopAppCoreMode.mockReturnValue(DesktopAppCoreMode.Cloud);
    hooks.useDesktopCloudReadCutover.mockReturnValue({
      mode: DesktopAppCoreMode.Cloud,
      blocker: CloudReadCutoverBlocker.SyncGaveUp,
      failedOpen: true,
      latch: CloudReadCutoverLatch.FailedOpen,
      itemsRemaining: 0,
      deadLetteredCount: 12,
    });

    render(<DashboardReadSourceBadge />);

    const detail =
      screen
        .getByTestId("read-source-badge")
        .getAttribute("data-read-source-detail") ?? "";
    expect(detail).toContain("may be missing");
    expect(detail).toContain("12 items could not be uploaded");
  });

  it("does not dress a fail-open cloud read as a calm, drained one", () => {
    hooks.useDesktopAppCoreMode.mockReturnValue(DesktopAppCoreMode.Cloud);
    hooks.useDesktopCloudReadCutover.mockReturnValue({
      mode: DesktopAppCoreMode.Cloud,
      blocker: CloudReadCutoverBlocker.SyncGaveUp,
      failedOpen: true,
      latch: CloudReadCutoverLatch.FailedOpen,
      itemsRemaining: 0,
      deadLetteredCount: 12,
    });

    render(<DashboardReadSourceBadge />);

    const badge = screen.getByTestId("read-source-badge");
    // Provenance is still the cloud; the presentation is what changes.
    expect(badge.getAttribute("data-read-source")).toBe(ReadSource.Cloud);
    expect(badge.getAttribute("data-read-source-incomplete")).toBe("true");
  });

  it("leaves a genuinely drained cloud read unmarked", () => {
    hooks.useDesktopAppCoreMode.mockReturnValue(DesktopAppCoreMode.Cloud);
    hooks.useDesktopCloudReadCutover.mockReturnValue(drainedCutover());

    render(<DashboardReadSourceBadge />);

    expect(
      screen
        .getByTestId("read-source-badge")
        .getAttribute("data-read-source-incomplete")
    ).toBeNull();
  });
});
