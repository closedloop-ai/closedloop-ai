/**
 * ISS-5354 (PRD-538 R6) — the sidebar session-limit bars obey the
 * `subscriptionSessionLimits` Labs gate, and obeying it means NOT READING.
 *
 * The ruling on this feature gates the capture, not merely the render: with the
 * toggle off the desktop performs no credential read and issues no `/usage`
 * request (ISS-5353 enforces that in the main process). The renderer's share of
 * that contract is that the reading component never mounts, so it never even
 * asks the main process for a snapshot — a gate that hid the bars while the
 * hook kept polling would leave a user who never opted in still driving the
 * feature's machinery.
 *
 * BOTH directions are asserted. Without the open-gate case, an implementation
 * that simply never rendered the bars would pass every closed-gate case.
 */
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SessionLimitsSnapshot } from "../../shared/session-limits-channel";
import {
  installDesktopApi,
  renderDesktopApp,
  setupAppShellSuite,
} from "./app-shell-harness";

vi.mock("../components/UpdateBanner", () => ({
  UpdateBanner: () => null,
}));

const SESSIONS_HASH = "#/sessions";

const SNAPSHOT: SessionLimitsSnapshot = {
  fiveHour: { utilization: 42, resetsAt: "2126-07-19T15:00:00.000Z" },
  sevenDay: { utilization: 70, resetsAt: "2126-07-21T12:00:00.000Z" },
  sevenDayOpus: null,
  sevenDaySonnet: null,
  extraUsage: null,
  fetchedAt: new Date().toISOString(),
  source: "usage_api",
};

describe("ISS-5354 session-limit bars under the Labs gate", () => {
  setupAppShellSuite();

  it("renders the bars and reads the snapshot when the gate is open", async () => {
    const getSessionLimits = vi.fn(() => Promise.resolve(SNAPSHOT));
    installDesktopApi({ getSessionLimits, subscriptionSessionLimits: true });

    renderDesktopApp(SESSIONS_HASH);

    const trigger = await screen.findByTestId("session-limits-nav-trigger");
    expect(trigger.textContent).toContain("Current session");
    expect(trigger.textContent).toContain("42% used");
    expect(getSessionLimits).toHaveBeenCalled();
  });

  it("renders nothing AND never reads the snapshot when the gate is closed", async () => {
    const getSessionLimits = vi.fn(() => Promise.resolve(SNAPSHOT));
    installDesktopApi({ getSessionLimits, subscriptionSessionLimits: false });

    renderDesktopApp(SESSIONS_HASH);

    // Wait for the sidebar itself so the absences below are a settled shell,
    // not a race against first paint.
    await screen.findByTitle("Collapse sidebar");
    await waitFor(() =>
      expect(screen.queryByTestId("session-limits-nav-trigger")).toBeNull()
    );
    // Not even the loading skeleton: the gate is checked before the reading
    // component mounts, so there is no in-flight state to show.
    expect(screen.queryByTestId("session-limits-loading")).toBeNull();
    // The gate suppresses the read itself, not just the pixels.
    expect(getSessionLimits).not.toHaveBeenCalled();
  });
});
