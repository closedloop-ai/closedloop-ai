import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  INITIAL_UPDATE_BANNER_STATE,
  isUpdateApplyEnabled,
  isUpdateBannerVisible,
  reduceUpdateAvailableEvent,
  reduceUpdateStatusEvent,
  updateBannerMessage,
} from "../src/renderer/components/update-banner-state.js";

// FEA-1497: behavior guards for the React UpdateBanner's decision logic.
// PR #264 replaced the old inline-JS update banner; the renderer no longer
// renders raw HTML, so we unit-test the pure visibility/apply reducers that
// drive the component instead of string-matching index.html.
describe("update banner state (desktop:update-status / desktop:update-available)", () => {
  test("initial idle state hides the banner and disables apply", () => {
    assert.equal(isUpdateBannerVisible(INITIAL_UPDATE_BANNER_STATE), false);
    assert.equal(isUpdateApplyEnabled(INITIAL_UPDATE_BANNER_STATE), false);
  });

  test("not-available status keeps the banner hidden", () => {
    const next = reduceUpdateStatusEvent(INITIAL_UPDATE_BANNER_STATE, {
      status: "not-available",
      updateAvailable: false,
      readyToInstall: false,
    });
    assert.equal(isUpdateBannerVisible(next), false);
  });

  test("available status shows the banner but does not enable apply", () => {
    const next = reduceUpdateStatusEvent(INITIAL_UPDATE_BANNER_STATE, {
      status: "available",
      updateAvailable: true,
      readyToInstall: false,
      version: "0.14.30",
    });
    assert.equal(next.status, "available");
    assert.equal(isUpdateBannerVisible(next), true);
    assert.equal(isUpdateApplyEnabled(next), false);
    assert.match(updateBannerMessage(next), /0\.14\.30/);
  });

  test("downloading status surfaces progress and stays non-installable", () => {
    const next = reduceUpdateStatusEvent(INITIAL_UPDATE_BANNER_STATE, {
      status: "downloading",
      updateAvailable: true,
      readyToInstall: false,
      version: "0.14.30",
      percent: 42.6,
    });
    assert.equal(isUpdateBannerVisible(next), true);
    assert.equal(isUpdateApplyEnabled(next), false);
    assert.match(updateBannerMessage(next), /43%/);
  });

  test("downloaded + readyToInstall enables the Apply / Restart action", () => {
    const next = reduceUpdateStatusEvent(INITIAL_UPDATE_BANNER_STATE, {
      status: "downloaded",
      updateAvailable: true,
      readyToInstall: true,
      version: "0.14.30",
      percent: 100,
    });
    assert.equal(isUpdateBannerVisible(next), true);
    assert.equal(isUpdateApplyEnabled(next), true);
    assert.match(updateBannerMessage(next), /ready to install/i);
  });

  test("readyToInstall must require the downloaded status (defensive gate)", () => {
    // A spoofed/stale payload claiming readiness without the downloaded status
    // must not enable apply, mirroring the main-process invariant.
    const spoofed = reduceUpdateStatusEvent(INITIAL_UPDATE_BANNER_STATE, {
      status: "available",
      updateAvailable: true,
      readyToInstall: true,
    });
    assert.equal(isUpdateApplyEnabled(spoofed), false);
  });

  test("error status shows the banner with a bounded message", () => {
    const next = reduceUpdateStatusEvent(INITIAL_UPDATE_BANNER_STATE, {
      status: "error",
      updateAvailable: false,
      readyToInstall: false,
      error: "download failed",
    });
    assert.equal(isUpdateBannerVisible(next), true);
    assert.equal(isUpdateApplyEnabled(next), false);
    assert.match(updateBannerMessage(next), /download failed/);
  });

  test("malformed update-status payloads are ignored (untrusted boundary)", () => {
    const base = reduceUpdateStatusEvent(INITIAL_UPDATE_BANNER_STATE, {
      status: "downloaded",
      updateAvailable: true,
      readyToInstall: true,
      version: "0.14.30",
    });
    assert.equal(reduceUpdateStatusEvent(base, null), base);
    assert.equal(reduceUpdateStatusEvent(base, { status: "bogus" }), base);
    assert.equal(reduceUpdateStatusEvent(base, "downloaded"), base);
  });

  test("update-available nudge escalates idle to available with version", () => {
    const next = reduceUpdateAvailableEvent(INITIAL_UPDATE_BANNER_STATE, {
      updateAvailable: true,
      version: "0.14.30",
      readyToInstall: false,
    });
    assert.equal(next.status, "available");
    assert.equal(next.updateAvailable, true);
    assert.equal(next.version, "0.14.30");
    assert.equal(isUpdateBannerVisible(next), true);
  });

  test("update-available nudge never regresses a downloaded state", () => {
    const downloaded = reduceUpdateStatusEvent(INITIAL_UPDATE_BANNER_STATE, {
      status: "downloaded",
      updateAvailable: true,
      readyToInstall: true,
      version: "0.14.30",
    });
    const afterNudge = reduceUpdateAvailableEvent(downloaded, {
      updateAvailable: true,
      version: "0.14.30",
      readyToInstall: false,
    });
    assert.equal(afterNudge.status, "downloaded");
    assert.equal(isUpdateApplyEnabled(afterNudge), true);
  });

  test("update-available with updateAvailable falsey is a no-op", () => {
    assert.equal(
      reduceUpdateAvailableEvent(INITIAL_UPDATE_BANNER_STATE, {
        updateAvailable: false,
      }),
      INITIAL_UPDATE_BANNER_STATE
    );
  });
});
