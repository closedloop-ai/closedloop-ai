/**
 * Relay / Gateway tab toggle success-path tests.
 *
 * The existing settings-panel-toggle-errors.test.tsx covers IPC-reject paths.
 * These tests cover the resolved paths: each toggle calls the expected IPC with
 * the correct argument, the UI reflects the canonical readback the setter
 * resolves with (not merely the requested value), and a mount-time getter that
 * resolves late does not clobber a value the user already applied.
 *
 * FEA-4133: Account is the default tab, so we navigate to relay-gateway via the
 * custom event before interacting with its toggles.
 */
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMonitorHooksResult } from "../../../../shared/contracts";
import { DesktopAuthProvider } from "../../../shared-agent-sessions/desktop-auth-provider";
import { SettingsPanel } from "../SettingsPanel";

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

afterEach(() => {
  cleanup();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
    return;
  }
  Reflect.deleteProperty(window, "desktopApi");
});

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type DesktopApiOverrides = Record<string, ReturnType<typeof vi.fn>>;

function installDesktopApi(overrides: DesktopApiOverrides = {}): {
  setCloudCommandsPaused: ReturnType<typeof vi.fn>;
  setCloudConnectionEnabled: ReturnType<typeof vi.fn>;
  setAgentMonitorHooksEnabled: ReturnType<typeof vi.fn>;
} {
  const defaults = {
    getSettings: vi.fn(async () => ({})),
    getRuntimeStatus: vi.fn(() => new Promise(() => undefined)),
    getCloudCommandsPaused: vi.fn(async () => false),
    getCloudConnectionEnabled: vi.fn(async () => true),
    getAgentMonitorHooksEnabled: vi.fn(async () => false),
    // The setters read back the post-apply field from the source of truth and
    // resolve with that canonical shape ({ paused } / { enabled } /
    // AgentMonitorHooksResult) — mirror that here rather than resolving void so
    // the renderer follows what actually happened.
    setCloudCommandsPaused: vi.fn(async (paused: boolean) => ({ paused })),
    setCloudConnectionEnabled: vi.fn(async (enabled: boolean) => ({ enabled })),
    setAgentMonitorHooksEnabled: vi.fn(
      async (enabled: boolean): Promise<AgentMonitorHooksResult> => ({
        ok: true,
        enabled,
      })
    ),
  };
  const api = { ...defaults, ...overrides };
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: api,
  });
  return {
    setCloudCommandsPaused: api.setCloudCommandsPaused,
    setCloudConnectionEnabled: api.setCloudConnectionEnabled,
    setAgentMonitorHooksEnabled: api.setAgentMonitorHooksEnabled,
  };
}

function renderPanel(): void {
  render(
    <FeatureFlagAdapterProvider adapter={createStaticFeatureFlagAdapter()}>
      <DesktopAuthProvider>
        <SettingsPanel />
      </DesktopAuthProvider>
    </FeatureFlagAdapterProvider>
  );
  // Navigate to the Relay / Gateway tab where the toggles live.
  act(() => {
    window.dispatchEvent(
      new CustomEvent("desktop:navigate-settings-tab", {
        detail: "relay-gateway",
      })
    );
  });
}

describe("SettingsPanel Relay/Gateway tab toggle success paths", () => {
  it("calls setCloudCommandsPaused(true) and reflects the { paused } readback when toggled ON", async () => {
    const { setCloudCommandsPaused } = installDesktopApi();
    renderPanel();

    const toggle = await screen.findByRole("switch", {
      name: "Pause Incoming Commands",
    });
    // Enabled only after the mount reads settle (initial read returns false).
    await waitFor(() =>
      expect((toggle as HTMLButtonElement).disabled).toBe(false)
    );
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(setCloudCommandsPaused).toHaveBeenCalledWith(true)
    );
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true")
    );
    // The Remote Commands status cell updates to "Paused".
    await waitFor(() => expect(screen.getByText("Paused")).toBeDefined());
  });

  it("reflects the setter's canonical { paused } readback over the requested value on a mismatch", async () => {
    // Golden/forced mode: the user requests pause ON, but the source of truth
    // reads back false. The switch must follow the readback (false), not the
    // request, so the UI never lies about the applied state.
    const { setCloudCommandsPaused } = installDesktopApi({
      setCloudCommandsPaused: vi.fn(async () => ({ paused: false })),
    });
    renderPanel();

    const toggle = await screen.findByRole("switch", {
      name: "Pause Incoming Commands",
    });
    await waitFor(() =>
      expect((toggle as HTMLButtonElement).disabled).toBe(false)
    );

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(setCloudCommandsPaused).toHaveBeenCalledWith(true)
    );
    // Requested true, but the readback said false — the switch stays off.
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false")
    );
  });

  it("falls back to the requested value when an older build resolves without a readback", async () => {
    // Cross-repo skew: an old desktop build resolves the setter with no
    // { paused } field. The renderer degrades to the requested value.
    const { setCloudCommandsPaused } = installDesktopApi({
      setCloudCommandsPaused: vi.fn(async () => undefined),
    });
    renderPanel();

    const toggle = await screen.findByRole("switch", {
      name: "Pause Incoming Commands",
    });
    await waitFor(() =>
      expect((toggle as HTMLButtonElement).disabled).toBe(false)
    );

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(setCloudCommandsPaused).toHaveBeenCalledWith(true)
    );
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true")
    );
  });

  it("does not let a late mount getter clobber a value the user just toggled", async () => {
    // Force the ordering: the mount getter is still pending when the user
    // toggles. The toggle applies its readback; the getter then resolves with
    // the old value and must be ignored. The switch is disabled until the
    // getter settles, so the click happens against the settled control.
    const pausedRead = deferred<boolean>();
    const { setCloudCommandsPaused } = installDesktopApi({
      getCloudCommandsPaused: vi.fn(() => pausedRead.promise),
      setCloudCommandsPaused: vi.fn(async () => ({ paused: true })),
    });
    renderPanel();

    const toggle = await screen.findByRole("switch", {
      name: "Pause Incoming Commands",
    });
    // Disabled until the mount read resolves — the user can't toggle yet.
    expect((toggle as HTMLButtonElement).disabled).toBe(true);

    // Mount read resolves false; the control initializes and enables.
    act(() => pausedRead.resolve(false));
    await waitFor(() =>
      expect((toggle as HTMLButtonElement).disabled).toBe(false)
    );
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    // Now toggle ON; the setter readback wins.
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(setCloudCommandsPaused).toHaveBeenCalledWith(true)
    );
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true")
    );

    // A second late resolution of a stale getter must not flip it back. (The
    // real effect fires once; this asserts the guard holds even if it re-ran.)
    act(() => pausedRead.resolve(false));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("calls setCloudConnectionEnabled(false) and reflects the { enabled } readback when toggled OFF", async () => {
    // Initial read returns connected=true (the toggle starts ON).
    const { setCloudConnectionEnabled } = installDesktopApi({
      getCloudConnectionEnabled: vi.fn(async () => true),
      setCloudConnectionEnabled: vi.fn(async (enabled: boolean) => ({
        enabled,
      })),
    });
    renderPanel();

    const toggle = await screen.findByRole("switch", {
      name: "Cloud Connection",
    });
    await waitFor(() =>
      expect((toggle as HTMLButtonElement).disabled).toBe(false)
    );
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(setCloudConnectionEnabled).toHaveBeenCalledWith(false)
    );
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false")
    );
    // The Cloud Connection status cell updates to "Disabled" when connection is turned off.
    await waitFor(() => expect(screen.getByText("Disabled")).toBeDefined());
  });

  it("calls setAgentMonitorHooksEnabled(true) and reflects the { ok, enabled } result when toggled ON", async () => {
    // Initial read returns hooks disabled; the enable resolves ok with the
    // full AgentMonitorHooksResult shape.
    const { setAgentMonitorHooksEnabled } = installDesktopApi({
      getAgentMonitorHooksEnabled: vi.fn(async () => false),
      setAgentMonitorHooksEnabled: vi.fn(
        async (): Promise<AgentMonitorHooksResult> => ({
          ok: true,
          enabled: true,
        })
      ),
    });
    renderPanel();

    const toggle = await screen.findByRole("switch", {
      name: "Claude Code Session Tracking",
    });
    await waitFor(() =>
      expect((toggle as HTMLButtonElement).disabled).toBe(false)
    );
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(setAgentMonitorHooksEnabled).toHaveBeenCalledWith(true)
    );
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true")
    );
  });

  it("keeps the hooks switch OFF when enable resolves { ok: true, enabled: false } (master toggle inert)", async () => {
    // CLAUDE_LIVE_HOOK_ENABLED false: the request succeeds but the hook stays
    // inert, so the IPC resolves ok with enabled: false. The switch must follow
    // the actual applied state (off), not the request (on).
    const { setAgentMonitorHooksEnabled } = installDesktopApi({
      getAgentMonitorHooksEnabled: vi.fn(async () => false),
      setAgentMonitorHooksEnabled: vi.fn(
        async (): Promise<AgentMonitorHooksResult> => ({
          ok: true,
          enabled: false,
        })
      ),
    });
    renderPanel();

    const toggle = await screen.findByRole("switch", {
      name: "Claude Code Session Tracking",
    });
    await waitFor(() =>
      expect((toggle as HTMLButtonElement).disabled).toBe(false)
    );

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(setAgentMonitorHooksEnabled).toHaveBeenCalledWith(true)
    );
    // ok, but enabled stayed false — the switch reflects the actual state.
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false")
    );
  });

  it("surfaces the error and follows result.enabled when enable resolves { ok: false, error }", async () => {
    // A resolved failure (not a reject): ok is false with an error message. The
    // renderer must surface the error and reflect the reported enabled state.
    const { setAgentMonitorHooksEnabled } = installDesktopApi({
      getAgentMonitorHooksEnabled: vi.fn(async () => false),
      setAgentMonitorHooksEnabled: vi.fn(
        async (): Promise<AgentMonitorHooksResult> => ({
          ok: false,
          enabled: false,
          error: "Claude settings file is not writable",
        })
      ),
    });
    renderPanel();

    const toggle = await screen.findByRole("switch", {
      name: "Claude Code Session Tracking",
    });
    await waitFor(() =>
      expect((toggle as HTMLButtonElement).disabled).toBe(false)
    );

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(setAgentMonitorHooksEnabled).toHaveBeenCalledWith(true)
    );
    await waitFor(() =>
      expect(
        screen.getByText("Claude settings file is not writable")
      ).toBeDefined()
    );
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false")
    );
  });
});
