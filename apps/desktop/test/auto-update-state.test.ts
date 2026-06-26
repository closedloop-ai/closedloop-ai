import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  assertPackagedUpdateReadyToInstall,
  createInitialPackagedUpdateState,
  mergePackagedUpdateState,
  PACKAGED_UPDATE_NOT_DOWNLOADED_MESSAGE,
  toPackagedUpdateStatusPayload,
} from "../src/main/packaged-update-state.js";

describe("packaged update readiness state", () => {
  test("available and downloading states are not installable", () => {
    const available = mergePackagedUpdateState(
      createInitialPackagedUpdateState(),
      {
        status: "available",
        available: true,
        version: "0.14.29",
      }
    );
    const downloading = mergePackagedUpdateState(available, {
      status: "downloading",
      percent: 42.5,
    });

    assert.deepEqual(toPackagedUpdateStatusPayload(available), {
      status: "available",
      updateAvailable: true,
      readyToInstall: false,
      version: "0.14.29",
    });
    assert.deepEqual(toPackagedUpdateStatusPayload(downloading), {
      status: "downloading",
      updateAvailable: true,
      readyToInstall: false,
      version: "0.14.29",
      percent: 42.5,
    });
    assert.throws(
      () => assertPackagedUpdateReadyToInstall(downloading),
      new RegExp(PACKAGED_UPDATE_NOT_DOWNLOADED_MESSAGE)
    );
  });

  test("downloaded state is immediately ready to install", () => {
    const downloaded = mergePackagedUpdateState(
      createInitialPackagedUpdateState(),
      {
        status: "downloaded",
        available: true,
        downloaded: true,
        version: "0.14.29",
        percent: 100,
      }
    );

    assert.doesNotThrow(() => assertPackagedUpdateReadyToInstall(downloaded));
    assert.deepEqual(toPackagedUpdateStatusPayload(downloaded), {
      status: "downloaded",
      updateAvailable: true,
      readyToInstall: true,
      version: "0.14.29",
      percent: 100,
    });
  });

  test("error status is non-installable and carries the bounded error message", () => {
    const failed = mergePackagedUpdateState(
      createInitialPackagedUpdateState(),
      {
        status: "error",
        error: "download failed",
      }
    );

    assert.deepEqual(toPackagedUpdateStatusPayload(failed), {
      status: "error",
      updateAvailable: false,
      readyToInstall: false,
      error: "download failed",
    });
  });
});
