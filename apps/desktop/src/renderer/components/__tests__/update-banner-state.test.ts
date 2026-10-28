import { describe, expect, it } from "vitest";
import { PackagedUpdateInstallBlockedReason } from "../../../shared/packaged-update-install-blocked-reason";
import {
  INITIAL_UPDATE_BANNER_STATE,
  isUpdateApplyEnabled,
  isUpdateBannerVisible,
  isUpdateInstallBlocked,
  reduceUpdateAvailableEvent,
  reduceUpdateStatusEvent,
  UPDATE_INSTALL_BLOCKED_BANNER_MESSAGE,
  type UpdateBannerState,
  updateBannerMessage,
} from "../update-banner-state";

// FEA-1497: behavior guards for the React UpdateBanner's decision logic.
// PR #264 replaced the old inline-JS update banner; the renderer no longer
// renders raw HTML, so we unit-test the pure visibility/apply reducers that
// drive the component instead of string-matching index.html.
describe("update banner state (desktop:update-status / desktop:update-available)", () => {
  it("initial idle state hides the banner and disables apply", () => {
    expect(isUpdateBannerVisible(INITIAL_UPDATE_BANNER_STATE)).toBe(false);
    expect(isUpdateApplyEnabled(INITIAL_UPDATE_BANNER_STATE)).toBe(false);
  });

  it("not-available status keeps the banner hidden", () => {
    const next = reduceUpdateStatusEvent(INITIAL_UPDATE_BANNER_STATE, {
      status: "not-available",
      updateAvailable: false,
      readyToInstall: false,
    });
    expect(isUpdateBannerVisible(next)).toBe(false);
  });

  it("available status shows the banner but does not enable apply", () => {
    const next = reduceUpdateStatusEvent(INITIAL_UPDATE_BANNER_STATE, {
      status: "available",
      updateAvailable: true,
      readyToInstall: false,
      version: "0.14.30",
    });
    expect(next.status).toBe("available");
    expect(isUpdateBannerVisible(next)).toBe(true);
    expect(isUpdateApplyEnabled(next)).toBe(false);
    expect(updateBannerMessage(next)).toMatch(VERSION_0_14_30);
  });

  it("downloading status surfaces progress and stays non-installable", () => {
    const next = reduceUpdateStatusEvent(INITIAL_UPDATE_BANNER_STATE, {
      status: "downloading",
      updateAvailable: true,
      readyToInstall: false,
      version: "0.14.30",
      percent: 42.6,
    });
    expect(isUpdateBannerVisible(next)).toBe(true);
    expect(isUpdateApplyEnabled(next)).toBe(false);
    expect(updateBannerMessage(next)).toMatch(PERCENT_43);
  });

  it("downloaded + readyToInstall enables the Apply / Restart action", () => {
    const next = reduceUpdateStatusEvent(INITIAL_UPDATE_BANNER_STATE, {
      status: "downloaded",
      updateAvailable: true,
      readyToInstall: true,
      version: "0.14.30",
      percent: 100,
    });
    expect(isUpdateBannerVisible(next)).toBe(true);
    expect(isUpdateApplyEnabled(next)).toBe(true);
    expect(updateBannerMessage(next)).toMatch(READY_TO_INSTALL);
  });

  it("error status shows the banner with a bounded message", () => {
    const next = reduceUpdateStatusEvent(INITIAL_UPDATE_BANNER_STATE, {
      status: "error",
      updateAvailable: false,
      readyToInstall: false,
      error: "download failed",
    });
    expect(isUpdateBannerVisible(next)).toBe(true);
    expect(isUpdateApplyEnabled(next)).toBe(false);
    expect(updateBannerMessage(next)).toMatch(DOWNLOAD_FAILED);
  });

  it("read-only install block shows a friendly warning and disables apply", () => {
    const next = reduceUpdateStatusEvent(INITIAL_UPDATE_BANNER_STATE, {
      status: "error",
      updateAvailable: true,
      readyToInstall: true,
      error: "should not be shown",
      installBlockedReason: PackagedUpdateInstallBlockedReason.ReadOnlyVolume,
    });

    expect(isUpdateBannerVisible(next)).toBe(true);
    expect(isUpdateInstallBlocked(next)).toBe(true);
    expect(isUpdateApplyEnabled(next)).toBe(false);
    expect(updateBannerMessage(next)).toBe(
      UPDATE_INSTALL_BLOCKED_BANNER_MESSAGE
    );
    expect(updateBannerMessage(next)).not.toMatch(UPDATE_ERROR_PREFIX);
  });

  it("unknown install block reasons fall back to the generic error treatment", () => {
    const next = reduceUpdateStatusEvent(INITIAL_UPDATE_BANNER_STATE, {
      status: "error",
      updateAvailable: true,
      readyToInstall: false,
      error: "download failed",
      installBlockedReason: "future-reason",
    });

    expect(isUpdateInstallBlocked(next)).toBe(false);
    expect(next.installBlockedReason).toBeUndefined();
    expect(updateBannerMessage(next)).toBe("Update error: download failed");
  });

  it("malformed update-status payloads are ignored (untrusted boundary)", () => {
    const base = reduceUpdateStatusEvent(INITIAL_UPDATE_BANNER_STATE, {
      status: "downloaded",
      updateAvailable: true,
      readyToInstall: true,
      version: "0.14.30",
    });
    expect(reduceUpdateStatusEvent(base, null)).toBe(base);
    expect(reduceUpdateStatusEvent(base, { status: "bogus" })).toBe(base);
    expect(reduceUpdateStatusEvent(base, "downloaded")).toBe(base);
  });

  it("update-available nudge escalates idle to available with version", () => {
    const next = reduceUpdateAvailableEvent(INITIAL_UPDATE_BANNER_STATE, {
      updateAvailable: true,
      version: "0.14.30",
      readyToInstall: false,
    });
    expect(next.status).toBe("available");
    expect(next.updateAvailable).toBe(true);
    expect(next.readyToInstall).toBe(false);
    expect(next.version).toBe("0.14.30");
    expect(isUpdateBannerVisible(next)).toBe(true);
  });

  it("update-available nudge never regresses a read-only install block", () => {
    const blocked = reduceUpdateStatusEvent(INITIAL_UPDATE_BANNER_STATE, {
      status: "error",
      updateAvailable: true,
      readyToInstall: false,
      version: "0.14.30",
      error: "move the app",
      installBlockedReason: PackagedUpdateInstallBlockedReason.ReadOnlyVolume,
    });
    const afterNudge = reduceUpdateAvailableEvent(blocked, {
      updateAvailable: true,
      version: "0.14.31",
      readyToInstall: false,
    });

    expect(afterNudge.status).toBe("error");
    expect(isUpdateInstallBlocked(afterNudge)).toBe(true);
    expect(isUpdateApplyEnabled(afterNudge)).toBe(false);
    expect(afterNudge.version).toBe("0.14.31");
    expect(updateBannerMessage(afterNudge)).toBe(
      UPDATE_INSTALL_BLOCKED_BANNER_MESSAGE
    );
  });

  it("later update-status payloads clear a stale read-only install block", () => {
    const blocked = reduceUpdateStatusEvent(INITIAL_UPDATE_BANNER_STATE, {
      status: "error",
      updateAvailable: true,
      readyToInstall: false,
      version: "0.14.30",
      error: "move the app",
      installBlockedReason: PackagedUpdateInstallBlockedReason.ReadOnlyVolume,
    });
    const genericError = reduceUpdateStatusEvent(blocked, {
      status: "error",
      updateAvailable: false,
      readyToInstall: false,
      error: "download failed",
    });
    const downloaded = reduceUpdateStatusEvent(blocked, {
      status: "downloaded",
      updateAvailable: true,
      readyToInstall: true,
      version: "0.14.31",
    });

    expect(isUpdateInstallBlocked(genericError)).toBe(false);
    expect(updateBannerMessage(genericError)).toBe(
      "Update error: download failed"
    );
    expect(isUpdateInstallBlocked(downloaded)).toBe(false);
    expect(isUpdateApplyEnabled(downloaded)).toBe(true);
    expect(updateBannerMessage(downloaded)).toMatch(VERSION_0_14_31);
  });
});

describe("reduceUpdateStatusEvent", () => {
  it("ignores an object detail with a missing status field", () => {
    const prev = INITIAL_UPDATE_BANNER_STATE;
    const next = reduceUpdateStatusEvent(prev, { updateAvailable: true });
    expect(next).toBe(prev);
  });

  it("applies a recognized status and derives every optional field", () => {
    const next = reduceUpdateStatusEvent(INITIAL_UPDATE_BANNER_STATE, {
      status: "downloading",
      updateAvailable: true,
      readyToInstall: false,
      version: "1.2.3",
      percent: 50,
      error: "boom",
      installBlockedReason: PackagedUpdateInstallBlockedReason.ReadOnlyVolume,
    });
    expect(next).toEqual({
      status: "downloading",
      updateAvailable: true,
      readyToInstall: false,
      version: "1.2.3",
      percent: 50,
      error: "boom",
      installBlockedReason: PackagedUpdateInstallBlockedReason.ReadOnlyVolume,
    });
  });

  it("defaults optional fields when their types do not match (all ternary false branches)", () => {
    const next = reduceUpdateStatusEvent(INITIAL_UPDATE_BANNER_STATE, {
      status: "available",
      updateAvailable: "yes",
      readyToInstall: 1,
      version: 42,
      percent: "50",
      error: false,
      installBlockedReason: "some-other-reason",
    });
    expect(next).toEqual({
      status: "available",
      updateAvailable: false,
      readyToInstall: false,
      version: undefined,
      percent: undefined,
      error: undefined,
      installBlockedReason: undefined,
    });
  });
});

describe("reduceUpdateAvailableEvent", () => {
  it("ignores a non-object detail (asRecord false branch reached via optional chaining)", () => {
    const prev = INITIAL_UPDATE_BANNER_STATE;
    expect(reduceUpdateAvailableEvent(prev, "nope")).toBe(prev);
  });

  it("ignores a detail whose updateAvailable is not exactly true", () => {
    const prev = INITIAL_UPDATE_BANNER_STATE;
    expect(reduceUpdateAvailableEvent(prev, { updateAvailable: false })).toBe(
      prev
    );
    expect(reduceUpdateAvailableEvent(prev, {})).toBe(prev);
  });

  it("keeps the prior version when the nudge carries a non-string version", () => {
    const prev: UpdateBannerState = {
      ...INITIAL_UPDATE_BANNER_STATE,
      version: "1.0.0",
    };
    const next = reduceUpdateAvailableEvent(prev, {
      updateAvailable: true,
      version: 99,
    });
    expect(next.version).toBe("1.0.0");
  });

  it("does not regress an in-progress download blocked on install", () => {
    const prev: UpdateBannerState = {
      status: "error",
      updateAvailable: false,
      readyToInstall: false,
      installBlockedReason: PackagedUpdateInstallBlockedReason.ReadOnlyVolume,
    };
    const next = reduceUpdateAvailableEvent(prev, {
      updateAvailable: true,
      version: "2.0.0",
    });
    expect(next.status).toBe("error");
    expect(next.updateAvailable).toBe(true);
    expect(next.version).toBe("2.0.0");
  });

  it("does not regress a downloading or downloaded status", () => {
    const downloading: UpdateBannerState = {
      status: "downloading",
      updateAvailable: true,
      readyToInstall: false,
    };
    expect(
      reduceUpdateAvailableEvent(downloading, { updateAvailable: true }).status
    ).toBe("downloading");

    const downloaded: UpdateBannerState = {
      status: "downloaded",
      updateAvailable: true,
      readyToInstall: true,
    };
    const afterNudge = reduceUpdateAvailableEvent(downloaded, {
      updateAvailable: true,
      readyToInstall: false,
    });
    expect(afterNudge.status).toBe("downloaded");
    expect(isUpdateApplyEnabled(afterNudge)).toBe(true);
  });
});

describe("isUpdateBannerVisible", () => {
  it("is visible for an error status regardless of other flags", () => {
    expect(
      isUpdateBannerVisible({
        status: "error",
        updateAvailable: false,
        readyToInstall: false,
      })
    ).toBe(true);
  });

  it("is hidden for idle and not-available statuses", () => {
    expect(
      isUpdateBannerVisible({
        status: "idle",
        updateAvailable: true,
        readyToInstall: true,
      })
    ).toBe(false);
    expect(
      isUpdateBannerVisible({
        status: "not-available",
        updateAvailable: true,
        readyToInstall: true,
      })
    ).toBe(false);
  });

  it("falls through to the updateAvailable || readyToInstall check for other statuses", () => {
    expect(
      isUpdateBannerVisible({
        status: "downloading",
        updateAvailable: true,
        readyToInstall: false,
      })
    ).toBe(true);
    expect(
      isUpdateBannerVisible({
        status: "downloading",
        updateAvailable: false,
        readyToInstall: true,
      })
    ).toBe(true);
    expect(
      isUpdateBannerVisible({
        status: "downloading",
        updateAvailable: false,
        readyToInstall: false,
      })
    ).toBe(false);
  });
});

describe("isUpdateApplyEnabled", () => {
  it("requires the downloaded status and readyToInstall true", () => {
    expect(
      isUpdateApplyEnabled({
        status: "available",
        updateAvailable: true,
        readyToInstall: true,
      })
    ).toBe(false);
    expect(
      isUpdateApplyEnabled({
        status: "downloaded",
        updateAvailable: true,
        readyToInstall: false,
      })
    ).toBe(false);
    expect(
      isUpdateApplyEnabled({
        status: "downloaded",
        updateAvailable: true,
        readyToInstall: true,
      })
    ).toBe(true);
  });
});

describe("updateBannerMessage", () => {
  it("returns the install-blocked message ahead of the status switch", () => {
    expect(
      updateBannerMessage({
        status: "error",
        updateAvailable: false,
        readyToInstall: false,
        installBlockedReason: PackagedUpdateInstallBlockedReason.ReadOnlyVolume,
      })
    ).toBe(UPDATE_INSTALL_BLOCKED_BANNER_MESSAGE);
  });

  it("names the version when downloaded carries one, else the generic sentence", () => {
    expect(
      updateBannerMessage({
        status: "downloaded",
        updateAvailable: true,
        readyToInstall: true,
        version: "1.2.3",
      })
    ).toBe("Version 1.2.3 is ready to install.");
    expect(
      updateBannerMessage({
        status: "downloaded",
        updateAvailable: true,
        readyToInstall: true,
      })
    ).toBe("A new version is ready to install.");
  });

  it("formats the downloading percent and version only when present", () => {
    expect(
      updateBannerMessage({
        status: "downloading",
        updateAvailable: true,
        readyToInstall: false,
        version: "1.2.3",
        percent: 12.6,
      })
    ).toBe("Downloading update 1.2.3 (13%)...");
    expect(
      updateBannerMessage({
        status: "downloading",
        updateAvailable: true,
        readyToInstall: false,
      })
    ).toBe("Downloading update...");
  });

  it("names the version when available carries one, else the generic sentence", () => {
    expect(
      updateBannerMessage({
        status: "available",
        updateAvailable: true,
        readyToInstall: false,
        version: "1.2.3",
      })
    ).toBe("Version 1.2.3 is available and downloading.");
    expect(
      updateBannerMessage({
        status: "available",
        updateAvailable: true,
        readyToInstall: false,
      })
    ).toBe("A new version is available.");
  });

  it("names the error message when present, else the generic retry sentence", () => {
    expect(
      updateBannerMessage({
        status: "error",
        updateAvailable: false,
        readyToInstall: false,
        error: "network unreachable",
      })
    ).toBe("Update error: network unreachable");
    expect(
      updateBannerMessage({
        status: "error",
        updateAvailable: false,
        readyToInstall: false,
      })
    ).toBe("Update failed. It will retry automatically.");
  });

  it("falls through to the empty-string default for idle/not-available", () => {
    expect(
      updateBannerMessage({
        status: "idle",
        updateAvailable: false,
        readyToInstall: false,
      })
    ).toBe("");
    expect(
      updateBannerMessage({
        status: "not-available",
        updateAvailable: false,
        readyToInstall: false,
      })
    ).toBe("");
  });
});

describe("isUpdateInstallBlocked", () => {
  it("requires both the error status and the read-only-volume reason", () => {
    expect(
      isUpdateInstallBlocked({
        status: "error",
        updateAvailable: false,
        readyToInstall: false,
      })
    ).toBe(false);
    expect(
      isUpdateInstallBlocked({
        status: "downloaded",
        updateAvailable: false,
        readyToInstall: true,
        installBlockedReason: PackagedUpdateInstallBlockedReason.ReadOnlyVolume,
      })
    ).toBe(false);
    expect(
      isUpdateInstallBlocked({
        status: "error",
        updateAvailable: false,
        readyToInstall: false,
        installBlockedReason: PackagedUpdateInstallBlockedReason.ReadOnlyVolume,
      })
    ).toBe(true);
  });
});

const VERSION_0_14_30 = /0\.14\.30/;
const VERSION_0_14_31 = /0\.14\.31/;
const PERCENT_43 = /43%/;
const READY_TO_INSTALL = /ready to install/i;
const DOWNLOAD_FAILED = /download failed/;
const UPDATE_ERROR_PREFIX = /Update error:/;
