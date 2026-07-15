import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PackagedUpdateInstallBlockedReason } from "../../../shared/packaged-update-install-blocked-reason";
import { UpdateBanner } from "../UpdateBanner";

// Behavioral replacement for the old renderer-logs-static source-text guard:
// mount the real UpdateBanner, drive it through the IPC-bridged window events it
// subscribes to (desktop:update-status / desktop:update-available), and assert
// the apply action calls window.desktopApi.applyUpdate. The pure visibility/apply
// reducers are separately unit-tested in test/update-banner-state.test.ts.

// Module-scoped so the matcher isn't recompiled per assertion (useTopLevelRegex).
const MOVE_AND_UPDATE_LABEL = /Move & Update/i;
const MOVE_FAILED_MESSAGE = /Couldn't move automatically/i;
const RELAUNCH_TO_UPDATE_LABEL = /Relaunch to update/i;
const UPDATE_ERROR_PREFIX = /Update error:/i;
const UPDATES_PAUSED_MESSAGE = /Updates are paused/i;

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

type DesktopUpdateApiMocks = {
  applyUpdate: ReturnType<typeof vi.fn>;
  moveToApplications: ReturnType<typeof vi.fn>;
};

function installUpdateApi({
  applyUpdate = vi.fn(async () => undefined),
  moveToApplications = vi.fn(async () => true),
}: Partial<DesktopUpdateApiMocks> = {}): DesktopUpdateApiMocks {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: { applyUpdate, moveToApplications },
  });
  return { applyUpdate, moveToApplications };
}

function dispatchDesktopEvent(name: string, detail: unknown): void {
  act(() => {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  });
}

afterEach(() => {
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

describe("UpdateBanner update IPC wiring", () => {
  it("stays hidden until an actionable update event arrives", () => {
    installUpdateApi();
    render(<UpdateBanner />);

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows a downloading strip on a desktop:update-status downloading event", () => {
    installUpdateApi();
    render(<UpdateBanner />);

    dispatchDesktopEvent("desktop:update-status", {
      status: "downloading",
      updateAvailable: true,
      percent: 40,
      version: "1.2.3",
    });

    expect(screen.getByRole("status").textContent).toContain(
      "Downloading update"
    );
  });

  it("escalates to a Relaunch action on a downloaded status and calls applyUpdate on click", async () => {
    const { applyUpdate } = installUpdateApi();
    render(<UpdateBanner />);

    dispatchDesktopEvent("desktop:update-status", {
      status: "downloaded",
      updateAvailable: true,
      readyToInstall: true,
      version: "1.2.3",
    });

    fireEvent.click(
      screen.getByRole("button", { name: RELAUNCH_TO_UPDATE_LABEL })
    );

    await waitFor(() => expect(applyUpdate).toHaveBeenCalled());
  });

  it("renders a read-only install block as a warning Move & Update action", async () => {
    const { applyUpdate, moveToApplications } = installUpdateApi();
    render(<UpdateBanner />);

    dispatchDesktopEvent("desktop:update-status", {
      status: "error",
      updateAvailable: true,
      readyToInstall: false,
      error: "should not be shown",
      installBlockedReason: PackagedUpdateInstallBlockedReason.ReadOnlyVolume,
    });

    const status = screen.getByRole("status");
    expect(status.textContent).toMatch(UPDATES_PAUSED_MESSAGE);
    expect(status.textContent).not.toMatch(UPDATE_ERROR_PREFIX);
    expect(status.className).toContain("warning");
    expect(status.className).not.toContain("destructive");
    expect(
      screen.queryByRole("button", { name: RELAUNCH_TO_UPDATE_LABEL })
    ).toBeNull();

    const moveButton = screen.getByRole("button", {
      name: MOVE_AND_UPDATE_LABEL,
    });
    fireEvent.click(moveButton);

    await waitFor(() => expect(moveToApplications).toHaveBeenCalled());
    await waitFor(() =>
      expect((moveButton as HTMLButtonElement).disabled).toBe(false)
    );
    expect(applyUpdate).not.toHaveBeenCalled();
  });

  it("keeps the blocked warning when an update-available nudge follows", () => {
    installUpdateApi();
    render(<UpdateBanner />);

    dispatchDesktopEvent("desktop:update-status", {
      status: "error",
      updateAvailable: true,
      readyToInstall: false,
      error: "move the app",
      installBlockedReason: PackagedUpdateInstallBlockedReason.ReadOnlyVolume,
    });
    dispatchDesktopEvent("desktop:update-available", {
      updateAvailable: true,
      version: "2.0.0",
    });

    expect(screen.getByRole("status").textContent).toMatch(
      UPDATES_PAUSED_MESSAGE
    );
    expect(
      screen.queryByRole("button", { name: RELAUNCH_TO_UPDATE_LABEL })
    ).toBeNull();
    expect(
      (
        screen.getByRole("button", {
          name: MOVE_AND_UPDATE_LABEL,
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false);
  });

  it("shows manual guidance when the Move & Update action returns false", async () => {
    const { moveToApplications } = installUpdateApi({
      moveToApplications: vi.fn(async () => false),
    });
    render(<UpdateBanner />);

    dispatchDesktopEvent("desktop:update-status", {
      status: "error",
      updateAvailable: true,
      readyToInstall: false,
      installBlockedReason: PackagedUpdateInstallBlockedReason.ReadOnlyVolume,
    });

    fireEvent.click(
      screen.getByRole("button", { name: MOVE_AND_UPDATE_LABEL })
    );

    await waitFor(() => expect(moveToApplications).toHaveBeenCalled());
    expect(screen.getByRole("status").textContent).toMatch(MOVE_FAILED_MESSAGE);
  });

  it("shows manual guidance when the Move & Update action rejects", async () => {
    const { moveToApplications } = installUpdateApi({
      moveToApplications: vi.fn(() =>
        Promise.reject(new Error("native move failed"))
      ),
    });
    render(<UpdateBanner />);

    dispatchDesktopEvent("desktop:update-status", {
      status: "error",
      updateAvailable: true,
      readyToInstall: false,
      installBlockedReason: PackagedUpdateInstallBlockedReason.ReadOnlyVolume,
    });

    fireEvent.click(
      screen.getByRole("button", { name: MOVE_AND_UPDATE_LABEL })
    );

    await waitFor(() => expect(moveToApplications).toHaveBeenCalled());
    expect(screen.getByRole("status").textContent).toMatch(MOVE_FAILED_MESSAGE);
  });

  it("keeps generic update errors destructive without the move CTA", () => {
    installUpdateApi();
    render(<UpdateBanner />);

    dispatchDesktopEvent("desktop:update-status", {
      status: "error",
      updateAvailable: false,
      readyToInstall: false,
      error: "download failed",
    });

    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Update error: download failed");
    expect(status.className).toContain("destructive");
    expect(
      screen.queryByRole("button", { name: MOVE_AND_UPDATE_LABEL })
    ).toBeNull();
  });

  it("surfaces the available state from a desktop:update-available nudge", () => {
    installUpdateApi();
    render(<UpdateBanner />);

    dispatchDesktopEvent("desktop:update-available", {
      updateAvailable: true,
      version: "2.0.0",
    });

    expect(screen.getByRole("status").textContent).toContain("available");
  });
});
