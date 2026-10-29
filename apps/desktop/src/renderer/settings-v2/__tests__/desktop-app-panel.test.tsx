import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAppPanel } from "../panels/desktop-app-panel";

/**
 * ISS-10286 — how the Desktop App panel handles its ONE machine-local read.
 *
 * The four control blocks are the shipped legacy tab bodies, mounted as
 * sections; they are markers here because this suite is about what the panel
 * does with `getSettings()`, not about what those bodies render.
 *
 * WHY THIS SUITE EXISTS (whitlockk, #4032080278). The blocks read
 * `settings?.field ?? <default>`, so a `null` record renders as a confident
 * configuration — `SecurityTab` shows Auth Mode as `standard`. A rejected read
 * that left `settings` null forever therefore presented a FAILED read as a real
 * setting, and nothing re-ran the effect, so it stayed that way for the life of
 * the mount.
 */
vi.mock("../../components/settings/security-tab", () => ({
  SecurityTab: () => <div data-testid="security-block">security</div>,
}));
vi.mock("../../components/settings/relay-gateway-tab", () => ({
  RelayGatewayTab: () => <div data-testid="relay-block">relay</div>,
}));
vi.mock("../../components/settings/data-sync-tab", () => ({
  DataSyncTab: () => <div data-testid="data-sync-block">data sync</div>,
}));
vi.mock("../../components/settings/binary-paths-tab", () => ({
  BinaryPathsTab: () => <div data-testid="binary-paths-block">paths</div>,
}));

const getSettings = vi.fn();

beforeEach(() => {
  getSettings.mockReset();
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: { getSettings },
    writable: true,
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "desktopApi");
});

describe("DesktopAppPanel", () => {
  it("mounts the blocks that need the record once the read settles", async () => {
    getSettings.mockResolvedValue({ authMode: "enforced" });

    render(<DesktopAppPanel />);

    expect(await screen.findByTestId("security-block")).toBeTruthy();
    expect(screen.getByTestId("relay-block")).toBeTruthy();
  });

  /**
   * The SAME two locators the ready case proves resolve. An absence assertion
   * on a selector that never matches is satisfied by a typo, so this claim is
   * only load-bearing because its twin above goes green on it.
   */
  it("withholds the record-backed blocks when the read is refused", async () => {
    getSettings.mockRejectedValue(new Error("main process refused"));

    render(<DesktopAppPanel />);

    await waitFor(() => {
      expect(screen.queryByTestId("security-block")).toBeNull();
    });
    expect(screen.queryByTestId("relay-block")).toBeNull();
  });

  /**
   * The failure is scoped to the blocks whose operand is missing. Data Sync and
   * Binary Paths take no `settings` prop and own their own reads, so dropping
   * them on this failure would withdraw two working capabilities to report one
   * broken one.
   */
  it("keeps the blocks that need no record rendering through the failure", async () => {
    getSettings.mockRejectedValue(new Error("main process refused"));

    render(<DesktopAppPanel />);

    await waitFor(() => {
      expect(screen.queryByTestId("security-block")).toBeNull();
    });
    expect(screen.getByTestId("data-sync-block")).toBeTruthy();
    expect(screen.getByTestId("binary-paths-block")).toBeTruthy();
  });

  it("offers a retry that re-reads and recovers", async () => {
    getSettings
      .mockRejectedValueOnce(new Error("main process refused"))
      .mockResolvedValueOnce({ authMode: "enforced" });

    render(<DesktopAppPanel />);

    const retry = await screen.findByRole("button", { name: "Try again" });
    fireEvent.click(retry);

    expect(await screen.findByTestId("security-block")).toBeTruthy();
    expect(getSettings).toHaveBeenCalledTimes(2);
  });
});
