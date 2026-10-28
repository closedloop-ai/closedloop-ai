/**
 * @file update-error-channel-and-restart-target.test.ts
 * @description ISS-7247 coverage for the two derived decisions in the update
 * lane that had none, and whose failure modes are both silent:
 *
 *   1. `isUpdateDownloadPhaseError` — electron-updater reports a failed CHECK
 *      and a failed DOWNLOAD on one `error` channel. Getting the split wrong
 *      makes every unreachable-feed install look like a dying download, or the
 *      reverse, and the contract states the two must not be folded together.
 *   2. `resolveUpdateRestartTargetVersion` — decides whether a quit arms an
 *      upgrade expectation at all. Too narrow and most upgrades are never
 *      reported (`autoInstallOnAppQuit` stages on an ORDINARY quit, with no
 *      user action); too broad and every quit arms an expectation the next boot
 *      reports as a failed upgrade.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  isUpdateDownloadPhaseError,
  type PackagedUpdateState,
} from "../src/main/update/packaged-update-state.js";
import { resolveUpdateRestartTargetVersion } from "../src/main/update/update-restart-target.js";

const CURRENT_VERSION = "0.16.696";
const OFFERED_VERSION = "0.16.1451";

function stateWith(patch: Partial<PackagedUpdateState>): PackagedUpdateState {
  return { status: "idle", available: false, downloaded: false, ...patch };
}

test("an error before any update was offered is a check failure, not a download failure", () => {
  for (const status of ["idle", "not-available"] as const) {
    assert.equal(
      isUpdateDownloadPhaseError(stateWith({ status }), CURRENT_VERSION),
      false,
      `${status} must route to check_failed`
    );
  }
});

test("an error while an update was in flight is a download failure", () => {
  for (const status of ["available", "downloading", "downloaded"] as const) {
    assert.equal(
      isUpdateDownloadPhaseError(
        stateWith({ status, version: OFFERED_VERSION }),
        CURRENT_VERSION
      ),
      true,
      `${status} must route to download_failed`
    );
  }
});

test("a SECOND error in the same download stays a download failure", () => {
  // The first error patches status to "error", so a status-only rule would
  // report every follow-up error as a check failure. electron-updater emits
  // more than one error per download.
  assert.equal(
    isUpdateDownloadPhaseError(
      stateWith({ status: "error", version: OFFERED_VERSION }),
      CURRENT_VERSION
    ),
    true
  );
});

test("a repeat CHECK failure is not laundered into a download failure", () => {
  // `update-not-available` records the INSTALLED build as the version, so
  // presence of a version cannot be the discriminator — only a version that
  // differs from the running one means something was actually offered.
  assert.equal(
    isUpdateDownloadPhaseError(
      stateWith({ status: "error", version: CURRENT_VERSION }),
      CURRENT_VERSION
    ),
    false
  );
  assert.equal(
    isUpdateDownloadPhaseError(stateWith({ status: "error" }), CURRENT_VERSION),
    false
  );
});

test("a check that fails after the download finished is a check failure (ISS-11447)", () => {
  // Spelled out, not read off the prefix constant: it is electron-updater's
  // wording, and a fixture built from our constant would agree with our typo.
  const checkDetail = "Cannot check for updates: Error: net::ERR_TIMED_OUT";
  for (const status of ["available", "downloading", "downloaded"] as const) {
    assert.equal(
      isUpdateDownloadPhaseError(
        stateWith({ status, version: OFFERED_VERSION }),
        CURRENT_VERSION,
        checkDetail
      ),
      false,
      `${status} + a check detail must route to check_failed`
    );
  }
  assert.equal(
    isUpdateDownloadPhaseError(
      stateWith({ status: "error", version: OFFERED_VERSION }),
      CURRENT_VERSION,
      checkDetail
    ),
    false,
    "a check after a failed download must route to check_failed"
  );
  assert.equal(
    isUpdateDownloadPhaseError(
      stateWith({ status: "downloaded", version: OFFERED_VERSION }),
      CURRENT_VERSION,
      "Error: net::ERR_TIMED_OUT\n    at SimpleURLLoaderWrapper"
    ),
    true,
    "a download failure's stack detail must stay download_failed"
  );
});

test("a downloaded update arms an expectation on an ordinary quit, with no explicit apply", () => {
  // The common path, and the one the first cut missed entirely:
  // autoInstallOnAppQuit is on by default, so the majority of upgrades happen
  // without anyone clicking "Restart to update".
  assert.equal(
    resolveUpdateRestartTargetVersion({
      applyingUpdate: false,
      autoInstallOnAppQuit: true,
      currentVersion: CURRENT_VERSION,
      state: stateWith({
        status: "downloaded",
        downloaded: true,
        version: OFFERED_VERSION,
      }),
    }),
    OFFERED_VERSION
  );
});

test("an explicit apply arms an expectation even when auto-install-on-quit is off", () => {
  // Translocation and the fake-feed seam both disable autoInstallOnAppQuit.
  assert.equal(
    resolveUpdateRestartTargetVersion({
      applyingUpdate: true,
      autoInstallOnAppQuit: false,
      currentVersion: CURRENT_VERSION,
      state: stateWith({
        status: "downloaded",
        downloaded: true,
        version: OFFERED_VERSION,
      }),
    }),
    OFFERED_VERSION
  );
});

test("a quit that will install nothing arms no expectation", () => {
  // Each of these would otherwise strand an expectation that the next boot
  // reports as a failed upgrade that never happened.
  const cases: {
    name: string;
    input: Parameters<typeof resolveUpdateRestartTargetVersion>[0];
  }[] = [
    {
      name: "nothing downloaded",
      input: {
        applyingUpdate: false,
        autoInstallOnAppQuit: true,
        currentVersion: CURRENT_VERSION,
        state: stateWith({ status: "available", version: OFFERED_VERSION }),
      },
    },
    {
      name: "downloaded but auto-install disabled and no apply",
      input: {
        applyingUpdate: false,
        autoInstallOnAppQuit: false,
        currentVersion: CURRENT_VERSION,
        state: stateWith({
          status: "downloaded",
          downloaded: true,
          version: OFFERED_VERSION,
        }),
      },
    },
    {
      name: "the downloaded artifact is the running version",
      input: {
        applyingUpdate: true,
        autoInstallOnAppQuit: true,
        currentVersion: CURRENT_VERSION,
        state: stateWith({
          status: "downloaded",
          downloaded: true,
          version: CURRENT_VERSION,
        }),
      },
    },
  ];
  for (const { name, input } of cases) {
    assert.equal(
      resolveUpdateRestartTargetVersion(input),
      undefined,
      `${name} must arm no expectation`
    );
  }
});
