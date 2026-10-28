import { SESSIONS_LIST_LOADING_LABEL } from "@repo/app/agents/components/sessions/sessions-list-loading-labels";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  actAndFlush,
  applyDefaultSessionsViewHooks,
  installDesktopApiStub,
  probeStuckThenReady,
  renderSessionsView,
  restoreDesktopApi,
} from "./fixtures/sessions-view-render-fixture";

// ISS-8909: `SessionsView` mounts the v2 surface unconditionally now, so the v1
// body marker these cases read is no longer rendered. The
// subject here is the HOST's decision — which read state and how many rows it
// hands down — so the surface is stood down to the same marker, echoing the same
// two signals. The real v2 surface is covered by its own suites.
vi.mock("../sessions-v2-view", () => ({
  SessionsV2View: (props: {
    input: { isSessionsTableLoading?: boolean; items?: unknown[] };
  }) => (
    <div
      data-is-loading={props.input.isSessionsTableLoading ? "true" : "false"}
      data-item-count={props.input.items?.length ?? 0}
      data-testid="sessions-table-body"
    />
  ),
}));

/**
 * ISS-4772 (Step 3): the local-source status latch self-heals on tab
 * visibility / window focus. The 500ms self-poll only runs while the status is
 * "starting", so a dropped transition (a `getAgentMonitorUrl` result that never
 * lands after long uptime) leaves the latch stuck with nothing to re-check it.
 * This mounts SessionsView in LOCAL mode with the probe first stuck (never
 * resolving), then flips the probe to resolve "ready" and fires a
 * `visibilitychange` / `focus`. The bounded re-probe must re-read the status so
 * the latch flips to ready WITHOUT a remount. A settled current read already
 * keeps the list visible over a stale "starting" label, so this suite proves
 * the probe still fires while preserving the honest empty state.
 *
 * ISS-4837: the module mocks, hook baseline, `window.desktopApi` descriptor
 * handling and the render/flush helper live in the shared
 * `./fixtures/sessions-view-render-fixture` module, shared with
 * `sessions-view-data-wins-render`. Only this suite's own overrides stay here.
 * The fixture's default page-data read is the empty settled query this suite
 * needs: even with a "starting" source, current list data keeps the body on the
 * honest empty state while the focus/visibility probes heal the source label.
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

  it("re-probes the local source on window focus without returning to the starting spinner", async () => {
    // The probe is stuck (never resolves) on the initial mount call, so the
    // status stays latched on the initial "starting". A later call (fired by the
    // focus re-probe) resolves "ready".
    const getAgentMonitorUrl = probeStuckThenReady();
    installDesktopApiStub({
      getAgentMonitorUrl,
      onDbChanged: vi.fn(() => undefined),
    });

    await renderSessionsView();

    // The settled empty read keeps the list visible over the stale starting
    // source label; the self-heal probe below must not regress it to a spinner.
    // Awaited because ISS-11913 holds an empty default-window list on its
    // loading treatment until the outside-window probe answers.
    expect(screen.queryByText(SESSIONS_LIST_LOADING_LABEL)).toBeNull();
    await waitFor(() =>
      expect(
        screen
          .getByTestId("sessions-table-body")
          .getAttribute("data-is-loading")
      ).toBe("false")
    );
    expect(getAgentMonitorUrl).toHaveBeenCalledTimes(1);

    // Return to the window: the bounded re-probe fires a fresh status read (the
    // effect also re-fires once the status flips to ready, so the exact count is
    // not pinned — the observable heal below is the contract).
    await actAndFlush(() => {
      fireEvent.focus(window);
    });

    expect(getAgentMonitorUrl.mock.calls.length).toBeGreaterThan(1);
    // The latch healed to ready without a remount: the starting spinner is gone.
    expect(screen.queryByText(SESSIONS_LIST_LOADING_LABEL)).toBeNull();
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
    expect(screen.queryByText(SESSIONS_LIST_LOADING_LABEL)).toBeNull();
  });
});
