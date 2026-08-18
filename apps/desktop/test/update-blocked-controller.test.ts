import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { type Mock, vi } from "vitest";
import type { DesktopUpdateDiagnostics } from "../src/main/telemetry/telemetry-protocol.js";
import {
  createInitialPackagedUpdateState,
  mergePackagedUpdateState,
  type PackagedUpdateState,
} from "../src/main/update/packaged-update-state.js";
import {
  UpdateBlockedController,
  type UpdateBlockedControllerDeps,
} from "../src/main/update/update-blocked-controller.js";
import {
  UPDATE_BLOCKED_DIALOG_TITLE,
  UPDATE_BLOCKED_LATER_BUTTON,
  UPDATE_BLOCKED_MOVE_BUTTON,
} from "../src/main/update/update-install-blocked.js";
import { PackagedUpdateInstallBlockedReason } from "../src/shared/packaged-update-install-blocked-reason.js";
import { type Deferred, deferred } from "./deferred.js";

// Button indices in the native dialog: 0 = Move & Update, 1 = Later.
const MOVE_BUTTON_INDEX = 0;
const LATER_BUTTON_INDEX = 1;
const APPLICATIONS_STEP_PATTERN = /Applications/;

type Harness = {
  controller: UpdateBlockedController;
  state: { current: PackagedUpdateState };
  setPackagedUpdateState: Mock;
  notifyPackagedUpdateStatus: Mock;
  updateFailed: Mock;
  showMessageBox: Mock;
  showErrorBox: Mock;
  moveToApplicationsFolder: Mock;
  /**
   * Resolves when the controller's fire-and-forget dialog flow settles.
   * Await this (not a fixed number of event-loop turns) before asserting on the
   * dialog effects, so the assertions can never resume against stale call
   * counts — the desktop `test:node` determinism rule.
   */
  dialogFlowSettled: Deferred<void>;
};

function buildHarness(options?: {
  moveResponse?: number;
  moveSucceeds?: boolean;
  moveThrows?: boolean;
}): Harness {
  const state = { current: createInitialPackagedUpdateState() };
  const setPackagedUpdateState = vi.fn(
    (patch: Partial<PackagedUpdateState>) => {
      state.current = mergePackagedUpdateState(state.current, patch);
    }
  );
  const notifyPackagedUpdateStatus = vi.fn();
  const updateFailed = vi.fn((_input: DesktopUpdateDiagnostics) => undefined);
  const showMessageBox = vi.fn((_o: unknown) =>
    Promise.resolve({ response: options?.moveResponse ?? LATER_BUTTON_INDEX })
  );
  const showErrorBox = vi.fn();
  const moveToApplicationsFolder = vi.fn(() => {
    if (options?.moveThrows) {
      throw new Error("move failed hard");
    }
    return options?.moveSucceeds ?? true;
  });
  const dialogFlowSettled = deferred<void>();

  const deps: UpdateBlockedControllerDeps = {
    getPackagedUpdateState: () => state.current,
    setPackagedUpdateState,
    notifyPackagedUpdateStatus,
    telemetry: { updateFailed },
    platform: {
      showMessageBox:
        showMessageBox as UpdateBlockedControllerDeps["platform"]["showMessageBox"],
      showErrorBox,
      moveToApplicationsFolder,
    },
    onDialogFlowSettled: () => dialogFlowSettled.resolve(),
  };
  return {
    controller: new UpdateBlockedController(deps),
    state,
    setPackagedUpdateState,
    notifyPackagedUpdateStatus,
    updateFailed,
    showMessageBox,
    showErrorBox,
    moveToApplicationsFolder,
    dialogFlowSettled,
  };
}

describe("UpdateBlockedController.handleUpdateInstallBlocked", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test("sets the read-only-volume error state and notifies the renderer", () => {
    const h = buildHarness();

    h.controller.handleUpdateInstallBlocked("1.2.3");

    assert.equal(h.setPackagedUpdateState.mock.calls.length, 1);
    assert.equal(h.state.current.status, "error");
    assert.equal(h.state.current.available, true);
    assert.equal(h.state.current.downloaded, false);
    assert.equal(h.state.current.version, "1.2.3");
    assert.equal(
      h.state.current.installBlockedReason,
      PackagedUpdateInstallBlockedReason.ReadOnlyVolume
    );
    assert.equal(h.notifyPackagedUpdateStatus.mock.calls.length, 1);
  });

  test("emits the install-blocked telemetry event", () => {
    const h = buildHarness();

    h.controller.handleUpdateInstallBlocked("9.9.9");

    assert.equal(h.updateFailed.mock.calls.length, 1);
    const input = h.updateFailed.mock.calls[0][0] as DesktopUpdateDiagnostics;
    assert.equal(input.trigger, "install-blocked-read-only-volume");
    assert.equal(input.status, "error");
    assert.equal(input.version, "9.9.9");
    assert.equal(input.downloaded, false);
    assert.equal(input.readyToInstall, false);
  });

  test("shows the move-to-Applications dialog at most once per session", async () => {
    const h = buildHarness({ moveResponse: LATER_BUTTON_INDEX });

    // Only the first call opens a dialog; the second is suppressed by the
    // once-per-session latch and never starts (or settles) a dialog flow, so we
    // synchronize on the first flow's terminal signal, then fire the second.
    h.controller.handleUpdateInstallBlocked();
    await h.dialogFlowSettled.promise;
    h.controller.handleUpdateInstallBlocked();

    assert.equal(h.showMessageBox.mock.calls.length, 1);
    const dialogOptions = h.showMessageBox.mock.calls[0][0] as {
      title: string;
      buttons: string[];
    };
    assert.equal(dialogOptions.title, UPDATE_BLOCKED_DIALOG_TITLE);
    assert.deepEqual(dialogOptions.buttons, [
      UPDATE_BLOCKED_MOVE_BUTTON,
      UPDATE_BLOCKED_LATER_BUTTON,
    ]);
  });

  test("moves the app when the user picks Move & Update", async () => {
    const h = buildHarness({
      moveResponse: MOVE_BUTTON_INDEX,
      moveSucceeds: true,
    });

    h.controller.handleUpdateInstallBlocked();
    await h.dialogFlowSettled.promise;

    assert.equal(h.moveToApplicationsFolder.mock.calls.length, 1);
    assert.equal(h.showErrorBox.mock.calls.length, 0);
  });

  test("falls back to manual-steps error box when the move fails", async () => {
    const h = buildHarness({
      moveResponse: MOVE_BUTTON_INDEX,
      moveSucceeds: false,
    });

    h.controller.handleUpdateInstallBlocked("4.5.6");
    await h.dialogFlowSettled.promise;

    assert.equal(h.moveToApplicationsFolder.mock.calls.length, 1);
    assert.equal(h.showErrorBox.mock.calls.length, 1);
    const [title, body] = h.showErrorBox.mock.calls[0] as [string, string];
    assert.equal(title, UPDATE_BLOCKED_DIALOG_TITLE);
    assert.match(body, APPLICATIONS_STEP_PATTERN);
  });

  test("respects a Later choice without moving the app", async () => {
    const h = buildHarness({ moveResponse: LATER_BUTTON_INDEX });

    h.controller.handleUpdateInstallBlocked();
    await h.dialogFlowSettled.promise;

    assert.equal(h.moveToApplicationsFolder.mock.calls.length, 0);
    assert.equal(h.showErrorBox.mock.calls.length, 0);
  });
});

describe("UpdateBlockedController.canMoveBlockedUpdateToApplications", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test("is false before any block is recorded", () => {
    const h = buildHarness();
    assert.equal(h.controller.canMoveBlockedUpdateToApplications(), false);
  });

  test("is true once a read-only-volume block is recorded", () => {
    const h = buildHarness();
    h.controller.handleUpdateInstallBlocked();
    assert.equal(h.controller.canMoveBlockedUpdateToApplications(), true);
  });

  test("is false for a non-blocked error state", () => {
    const h = buildHarness();
    h.setPackagedUpdateState({ status: "error", error: "network" });
    assert.equal(h.controller.canMoveBlockedUpdateToApplications(), false);
  });
});

describe("UpdateBlockedController.attemptMoveToApplications", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test("returns true when the underlying move succeeds", () => {
    const h = buildHarness({ moveSucceeds: true });
    assert.equal(h.controller.attemptMoveToApplications(), true);
  });

  test("swallows a thrown move error and returns false", () => {
    const h = buildHarness({ moveThrows: true });
    assert.equal(h.controller.attemptMoveToApplications(), false);
    assert.equal(h.moveToApplicationsFolder.mock.calls.length, 1);
  });
});
