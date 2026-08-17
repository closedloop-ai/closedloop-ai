import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  actAndFlush,
  applyDefaultSessionsViewHooks,
  installDesktopApiStub,
  probeStuckThenReady,
  renderSessionsView,
  restoreDesktopApi,
} from "./fixtures/sessions-view-render-fixture";

/**
 * ISS-4772 (Step 3): the local-source status latch self-heals on tab
 * visibility / window focus. The 500ms self-poll only runs while the status is
 * "starting", so a dropped transition (a `getAgentMonitorUrl` result that never
 * lands after long uptime) leaves the latch stuck with nothing to re-check it.
 * This mounts SessionsView in LOCAL mode with the probe first stuck (never
 * resolving), then flips the probe to resolve "ready" and fires a
 * `visibilitychange` / `focus`. The bounded re-probe must re-read the status so
 * the latch flips to ready WITHOUT a remount — the full-body spinner clears once
 * the source reports ready (with the query still empty, the ready source shows
 * the honest empty state, not the "Loading sessions..." starting spinner).
 *
 * ISS-4837: the module mocks, hook baseline, `window.desktopApi` descriptor
 * handling and the render/flush helper live in the shared
 * `./fixtures/sessions-view-render-fixture` module, shared with
 * `sessions-view-data-wins-render`. Only this suite's own overrides stay here.
 * The fixture's default page-data read is the empty settled query this suite
 * needs: with a "starting" source the body spins; with a "ready" source the same
 * empty query yields the honest empty state, so the label flip is the observable
 * heal.
 *
 * The transient-REJECTION half of the re-probe contract (ISS-4840 — a healthy
 * `ready` view must not flip to `unavailable` on one dropped call) is pinned
 * directly on the hook in `sessions-view-source-status-transient-probe`.
 */

describe("SessionsView status latch self-heal (ISS-4772)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyDefaultSessionsViewHooks();
  });

  afterEach(() => {
    cleanup();
    restoreDesktopApi();
  });

  it("re-probes the local source on window focus and flips a latched starting to ready without a remount", async () => {
    // The probe is stuck (never resolves) on the initial mount call, so the
    // status stays latched on the initial "starting". A later call (fired by the
    // focus re-probe) resolves "ready".
    const getAgentMonitorUrl = probeStuckThenReady();
    installDesktopApiStub({
      getAgentMonitorUrl,
      onDbChanged: vi.fn(() => undefined),
    });

    await renderSessionsView();

    // Latched starting → full-body "Loading sessions..." spinner.
    expect(screen.getByText("Loading sessions...")).toBeTruthy();
    expect(getAgentMonitorUrl).toHaveBeenCalledTimes(1);

    // Return to the window: the bounded re-probe fires a fresh status read (the
    // effect also re-fires once the status flips to ready, so the exact count is
    // not pinned — the observable heal below is the contract).
    await actAndFlush(() => {
      fireEvent.focus(window);
    });

    expect(getAgentMonitorUrl.mock.calls.length).toBeGreaterThan(1);
    // The latch healed to ready without a remount: the starting spinner is gone.
    expect(screen.queryByText("Loading sessions...")).toBeNull();
    expect(
      screen.getByTestId("sessions-table-body").getAttribute("data-is-loading")
    ).toBe("false");
  });

  it("re-probes on visibilitychange when the tab becomes visible", async () => {
    const getAgentMonitorUrl = probeStuckThenReady();
    installDesktopApiStub({
      getAgentMonitorUrl,
      onDbChanged: vi.fn(() => undefined),
    });

    await renderSessionsView();
    expect(getAgentMonitorUrl).toHaveBeenCalledTimes(1);

    await actAndFlush(() => {
      fireEvent(document, new Event("visibilitychange"));
    });

    expect(getAgentMonitorUrl.mock.calls.length).toBeGreaterThan(1);
    expect(screen.queryByText("Loading sessions...")).toBeNull();
  });
});
