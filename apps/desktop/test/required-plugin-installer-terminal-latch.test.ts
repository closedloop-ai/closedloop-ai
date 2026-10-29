/**
 * @file required-plugin-installer-terminal-latch.test.ts
 * @description ISS-6170 regression coverage: the distribution installer must
 * STOP retrying an install it has already classified as permanently impossible,
 * and must not stop retrying anything else.
 *
 * A distribution referencing `cl-sweep` — a pack absent from the running build's
 * catalog seed — produced 24 identical `install of 'cl-sweep' FAILED … this
 * build cannot install it` errors in one log window, because `reconcile()` fires
 * on every cloud-online transition and on runtime-ready and re-ran the identical
 * failing request each time.
 *
 * The regression this file exists to catch is NOT "it stopped retrying". It is
 * the pair: latching too little leaves the 24 lines, and latching too broadly
 * turns a deferral or a network blip into a pack that never installs again —
 * strictly worse, and silent. So the headline case drives BOTH directions off
 * one fixture and asserts attempt COUNTS, which an implementation that latches
 * everything cannot satisfy.
 */

import assert from "node:assert/strict";
import { CatalogItemSource } from "@repo/api/src/types/distribution";
import { describe, test } from "vitest";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import {
  RequiredPluginInstaller,
  type TerminalInstallFailureNotice,
} from "../src/main/packs/required-plugin-installer.js";
import {
  TERMINAL_INSTALL_LATCH_MAX_PACKS,
  TerminalInstallLatch,
} from "../src/main/packs/terminal-install-latch.js";
import {
  StreamRunErrorCode,
  type StreamRunResult,
} from "../src/shared/install-run-contract.js";
import {
  COMPUTE_TARGET_ID,
  makeAutoInstallDist,
  makeClientOptions,
  makeFakeFetch,
} from "./support/required-plugin-installer-fixtures.js";

const CATALOG_MISS_MESSAGE = "pack_id not in catalog: cl-sweep";
const VERSION_SKEW_RE = /not in this desktop build's catalog/;
const RECONCILE_PASSES = 3;

/**
 * The `cl-sweep` distribution from the ticket: a curated pack this build's
 * compiled-in catalog seed does not contain.
 */
function makeSweepDist() {
  return makeAutoInstallDist({
    catalogItem: {
      id: "ci-sweep",
      name: "cl-sweep",
      source: CatalogItemSource.Curated,
      targetKind: "plugin",
    },
    catalogItemId: "ci-sweep",
    id: "dist-sweep",
  });
}

/** Silence the gateway log for cases whose contract is not the log level. */
function muteGatewayLog(): () => void {
  gatewayLog.error = () => undefined;
  gatewayLog.warn = () => undefined;
  return () => {
    Reflect.deleteProperty(gatewayLog, "error");
    Reflect.deleteProperty(gatewayLog, "warn");
  };
}

/**
 * An installer that has already seen the catalog-seed signal.
 *
 * ISS-4428 makes this the DEFAULT for these cases rather than an extra: on a
 * fresh database `pack_catalog` is seeded by deferred maintenance, so nothing is
 * allowed to be called terminal until that landed. Every case below is about
 * what happens AFTER the seed; the pre-seed contract has its own case.
 */
function seededInstaller(
  opts: ConstructorParameters<typeof RequiredPluginInstaller>[0]
): RequiredPluginInstaller {
  const installer = new RequiredPluginInstaller({
    ...opts,
    // notifyRuntimeReady() IS the catalog-seeded signal; a null target makes it
    // record the seed and skip the reconcile, which is exactly what we want here.
    resolveRuntimeReadyTarget: () => null,
  });
  installer.notifyRuntimeReady();
  return installer;
}

describe("RequiredPluginInstaller — ISS-6170 terminal give-up", () => {
  test("a catalog miss is attempted once while a runtime-not-ready deferral keeps retrying", async () => {
    // ONE fixture, BOTH directions. `cl-sweep` fails permanently; `rtk` is
    // deferred because the runtime is not ready (runInstall resolves null). An
    // implementation that latches every failure fails the second assertion; one
    // that latches nothing fails the first.
    const { fetch: fakeFetch, statusBodies } = makeFakeFetch([
      makeSweepDist(),
      makeAutoInstallDist(),
    ]);
    const attempts = new Map<string, number>();
    const restoreLog = muteGatewayLog();

    const installer = seededInstaller({
      distributionsClient: makeClientOptions(fakeFetch),
      getInstalledVersion: () => Promise.resolve(null),
      runInstall: (packId) => {
        attempts.set(packId, (attempts.get(packId) ?? 0) + 1);
        if (packId === "cl-sweep") {
          return Promise.resolve({
            error: {
              code: StreamRunErrorCode.NotFound,
              message: CATALOG_MISS_MESSAGE,
            },
            started: false,
          } satisfies StreamRunResult);
        }
        // Runtime not ready — the benign deferral seen on the same tag.
        return Promise.resolve(null);
      },
    });

    try {
      for (let pass = 0; pass < RECONCILE_PASSES; pass++) {
        await installer.reconcile(COMPUTE_TARGET_ID);
      }
    } finally {
      restoreLog();
    }

    assert.equal(
      attempts.get("cl-sweep"),
      1,
      "a pack this build cannot install must be attempted exactly once, not once per reconcile"
    );
    assert.equal(
      attempts.get("rtk"),
      RECONCILE_PASSES,
      "a runtime-not-ready deferral must keep its retry eligibility on every reconcile"
    );

    // The give-up must stay legible to the cloud on every pass: a permanently
    // skipped install that stopped reporting would be indistinguishable from one
    // that succeeded.
    assert.equal(statusBodies.length, RECONCILE_PASSES);
    for (const body of statusBodies) {
      const skewed = body.reports.find(
        (report) => report.distributionId === "dist-sweep"
      );
      assert.equal(skewed?.status, "failed");
      assert.match(String(skewed?.failureReason), VERSION_SKEW_RE);
    }
  });

  test("the first give-up names the pack, the distribution and the code", async () => {
    const { fetch: fakeFetch } = makeFakeFetch([makeSweepDist()]);
    const notices: TerminalInstallFailureNotice[] = [];
    const restoreLog = muteGatewayLog();

    const installer = seededInstaller({
      distributionsClient: makeClientOptions(fakeFetch),
      getInstalledVersion: () => Promise.resolve(null),
      onTerminalInstallFailure: (notice) => {
        notices.push(notice);
      },
      runInstall: () =>
        Promise.resolve({
          error: {
            code: StreamRunErrorCode.NotFound,
            message: CATALOG_MISS_MESSAGE,
          },
          started: false,
        } satisfies StreamRunResult),
    });

    try {
      for (let pass = 0; pass < RECONCILE_PASSES; pass++) {
        await installer.reconcile(COMPUTE_TARGET_ID);
      }
    } finally {
      restoreLog();
    }

    // Cadence is the sibling case's contract ("re-raised on later reconciles");
    // this one owns the PAYLOAD, which is what the sinks branch on: the closed
    // error code routes the alert, and the reason carries the user's remedy.
    assert.equal(notices[0].firstGiveUp, true);
    assert.equal(notices[0].code, StreamRunErrorCode.NotFound);
    assert.equal(notices[0].packId, "cl-sweep");
    assert.equal(notices[0].distributionId, "dist-sweep");
    assert.match(notices[0].reason, VERSION_SKEW_RE);
  });

  test("the repeated ERROR line is emitted once, not once per reconcile", async () => {
    const { fetch: fakeFetch } = makeFakeFetch([makeSweepDist()]);
    const errors: string[] = [];
    gatewayLog.error = (_tag: string, message: string) => {
      errors.push(message);
    };

    const installer = seededInstaller({
      distributionsClient: makeClientOptions(fakeFetch),
      getInstalledVersion: () => Promise.resolve(null),
      runInstall: () =>
        Promise.resolve({
          error: {
            code: StreamRunErrorCode.NotFound,
            message: CATALOG_MISS_MESSAGE,
          },
          started: false,
        } satisfies StreamRunResult),
    });

    try {
      for (let pass = 0; pass < RECONCILE_PASSES; pass++) {
        await installer.reconcile(COMPUTE_TARGET_ID);
      }
    } finally {
      Reflect.deleteProperty(gatewayLog, "error");
    }

    assert.equal(errors.length, 1, "24 identical error lines is the defect");
    assert.match(errors[0], VERSION_SKEW_RE);
  });

  test("an unrecognized error code keeps retrying and never gives up", async () => {
    // Version skew at a trust boundary: a peer emitting a code this build's
    // vocabulary does not carry. `classifyStreamRunRetry` degrades an unknown
    // code to TRANSIENT on purpose, so it must not latch. The cast is what makes
    // the unreachable-by-type case reachable — which is the point.
    const unknownCode = "EWHOKNOWS" as StreamRunErrorCode;
    const { fetch: fakeFetch } = makeFakeFetch([makeSweepDist()]);
    const notices: TerminalInstallFailureNotice[] = [];
    let attempts = 0;
    const restoreLog = muteGatewayLog();

    const installer = seededInstaller({
      distributionsClient: makeClientOptions(fakeFetch),
      getInstalledVersion: () => Promise.resolve(null),
      onTerminalInstallFailure: (notice) => {
        notices.push(notice);
      },
      runInstall: () => {
        attempts++;
        return Promise.resolve({
          error: { code: unknownCode, message: "something new happened" },
          started: false,
        } satisfies StreamRunResult);
      },
    });

    try {
      for (let pass = 0; pass < RECONCILE_PASSES; pass++) {
        await installer.reconcile(COMPUTE_TARGET_ID);
      }
    } finally {
      restoreLog();
    }

    assert.equal(attempts, RECONCILE_PASSES);
    assert.deepEqual(notices, []);
  });

  test("a runInstall that throws keeps retrying and never gives up", async () => {
    const { fetch: fakeFetch } = makeFakeFetch([makeSweepDist()]);
    const notices: TerminalInstallFailureNotice[] = [];
    let attempts = 0;
    const restoreLog = muteGatewayLog();

    const installer = seededInstaller({
      distributionsClient: makeClientOptions(fakeFetch),
      getInstalledVersion: () => Promise.resolve(null),
      onTerminalInstallFailure: (notice) => {
        notices.push(notice);
      },
      runInstall: () => {
        attempts++;
        return Promise.reject(new Error("orchestrator exploded"));
      },
    });

    try {
      for (let pass = 0; pass < RECONCILE_PASSES; pass++) {
        await installer.reconcile(COMPUTE_TARGET_ID);
      }
    } finally {
      restoreLog();
    }

    assert.equal(attempts, RECONCILE_PASSES);
    assert.deepEqual(notices, []);
  });

  test("a catalog miss BEFORE the seed lands keeps retrying — ISS-4428", async () => {
    // On a fresh database `pack_catalog` is seeded by deferred startup
    // maintenance, while `reconcile()` also fires on the cloud-online
    // transition, which does not wait for it. An install attempted in that
    // window fails ENOTFOUND for a reason that has NOTHING to do with this
    // build's catalog, and ISS-4428 added `onCatalogSeeded` ->
    // notifyRuntimeReady() precisely to retry it. Latching there would turn the
    // ordinary fresh-install ordering into a pack that can never install until
    // the app is relaunched.
    //
    // Note this installer is built directly, NOT via seededInstaller: the whole
    // point is that the seed signal has not arrived.
    const { fetch: fakeFetch } = makeFakeFetch([makeSweepDist()]);
    const notices: TerminalInstallFailureNotice[] = [];
    let attempts = 0;
    const restoreLog = muteGatewayLog();

    const installer = new RequiredPluginInstaller({
      distributionsClient: makeClientOptions(fakeFetch),
      getInstalledVersion: () => Promise.resolve(null),
      onTerminalInstallFailure: (notice) => {
        notices.push(notice);
      },
      runInstall: () => {
        attempts++;
        return Promise.resolve({
          error: {
            code: StreamRunErrorCode.NotFound,
            message: CATALOG_MISS_MESSAGE,
          },
          started: false,
        } satisfies StreamRunResult);
      },
    });

    try {
      for (let pass = 0; pass < RECONCILE_PASSES; pass++) {
        await installer.reconcile(COMPUTE_TARGET_ID);
      }
    } finally {
      restoreLog();
    }

    assert.equal(
      attempts,
      RECONCILE_PASSES,
      "a pre-seed catalog miss must keep its retry eligibility — the seed's own callback is what fixes it"
    );
    assert.deepEqual(
      notices,
      [],
      "nothing may be reported as a permanent give-up before the catalog is known to be seeded"
    );
  });

  test("the give-up is re-raised on later reconciles, flagged as not-first", async () => {
    // The monitored sink only consumes its one report once the telemetry lane
    // ACCEPTED it, so it needs these later chances; the user notification keys
    // off `firstGiveUp` to stay once-only. A latched pack that stopped raising
    // anything would drop the alert whenever the lane was closed at latch time.
    const { fetch: fakeFetch } = makeFakeFetch([makeSweepDist()]);
    const notices: TerminalInstallFailureNotice[] = [];
    const restoreLog = muteGatewayLog();

    const installer = seededInstaller({
      distributionsClient: makeClientOptions(fakeFetch),
      getInstalledVersion: () => Promise.resolve(null),
      onTerminalInstallFailure: (notice) => {
        notices.push(notice);
      },
      runInstall: () =>
        Promise.resolve({
          error: {
            code: StreamRunErrorCode.NotFound,
            message: CATALOG_MISS_MESSAGE,
          },
          started: false,
        } satisfies StreamRunResult),
    });

    try {
      for (let pass = 0; pass < RECONCILE_PASSES; pass++) {
        await installer.reconcile(COMPUTE_TARGET_ID);
      }
    } finally {
      restoreLog();
    }

    assert.equal(notices.length, RECONCILE_PASSES);
    assert.deepEqual(
      notices.map((notice) => notice.firstGiveUp),
      [true, false, false],
      "exactly one raise may be the first; the rest are retries for the monitored sink"
    );
  });

  test("latching one pack does not suppress a different pack's install", async () => {
    const { fetch: fakeFetch } = makeFakeFetch([
      makeSweepDist(),
      makeAutoInstallDist(),
    ]);
    const installed: string[] = [];
    const restoreLog = muteGatewayLog();

    const installer = seededInstaller({
      distributionsClient: makeClientOptions(fakeFetch),
      getInstalledVersion: () => Promise.resolve(null),
      runInstall: (packId) => {
        if (packId === "cl-sweep") {
          return Promise.resolve({
            error: {
              code: StreamRunErrorCode.NotFound,
              message: CATALOG_MISS_MESSAGE,
            },
            started: false,
          } satisfies StreamRunResult);
        }
        installed.push(packId);
        return Promise.resolve({
          runId: 7,
          started: true,
        } satisfies StreamRunResult);
      },
    });

    try {
      for (let pass = 0; pass < RECONCILE_PASSES; pass++) {
        await installer.reconcile(COMPUTE_TARGET_ID);
      }
    } finally {
      restoreLog();
    }

    assert.deepEqual(installed, ["rtk", "rtk", "rtk"]);
  });

  test("saturating the latch does not hand every latched pack its retries back", async () => {
    // The cap is only a bound if reaching it is STABLE. `reconcile()` re-walks
    // the same cloud-assigned list in the same order every pass, so evicting the
    // oldest entry to admit the overflow un-latches a pack that is still
    // permanently uninstallable — and processing THAT pack next pass evicts the
    // one after it, cascading through the whole latch until every pack is
    // attempted, logged and re-notified on every reconcile. That is the exact
    // storm this ticket exists to stop, restored above the cap.
    const overflow = TERMINAL_INSTALL_LATCH_MAX_PACKS + 1;
    const dists = Array.from({ length: overflow }, (_unused, i) =>
      makeAutoInstallDist({
        catalogItem: {
          id: `ci-${i}`,
          name: `pack-${i}`,
          source: CatalogItemSource.Curated,
          targetKind: "plugin",
        },
        catalogItemId: `ci-${i}`,
        id: `dist-${i}`,
      })
    );
    const { fetch: fakeFetch } = makeFakeFetch(dists);
    const attempts = new Map<string, number>();
    const firstGiveUps: string[] = [];
    const restoreLog = muteGatewayLog();

    const installer = seededInstaller({
      distributionsClient: makeClientOptions(fakeFetch),
      getInstalledVersion: () => Promise.resolve(null),
      onTerminalInstallFailure: (notice) => {
        if (notice.firstGiveUp) {
          firstGiveUps.push(notice.packId);
        }
      },
      runInstall: (packId) => {
        attempts.set(packId, (attempts.get(packId) ?? 0) + 1);
        return Promise.resolve({
          error: {
            code: StreamRunErrorCode.NotFound,
            message: CATALOG_MISS_MESSAGE,
          },
          started: false,
        } satisfies StreamRunResult);
      },
    });

    try {
      for (let pass = 0; pass < RECONCILE_PASSES; pass++) {
        await installer.reconcile(COMPUTE_TARGET_ID);
      }
    } finally {
      restoreLog();
    }

    const retriedUnderCap = Array.from(
      { length: TERMINAL_INSTALL_LATCH_MAX_PACKS },
      (_unused, i) => `pack-${i}`
    ).filter((packId) => attempts.get(packId) !== 1);
    assert.deepEqual(
      retriedUnderCap,
      [],
      "every pack that fitted under the cap must be attempted exactly once for the life of the process, no matter how far the assigned list overflows it"
    );
    assert.equal(
      attempts.get(`pack-${overflow - 1}`),
      RECONCILE_PASSES,
      "the refused overflow pack is the only one that keeps retrying — it never gave up, so it never latched"
    );
    // whitlockk: the user-facing notification is armed by `firstGiveUp`, and a
    // re-latch after an eviction is indistinguishable from a first latch, so a
    // cascading latch also re-notifies on every reconcile.
    assert.equal(
      firstGiveUps.length,
      TERMINAL_INSTALL_LATCH_MAX_PACKS,
      "the once-only give-up must fire at most once per pack for the life of the process"
    );
  });
});

describe("TerminalInstallLatch — ISS-6170 bound", () => {
  test("latch reports only the transition into the latched state", () => {
    const latch = new TerminalInstallLatch();

    const record = { code: StreamRunErrorCode.NotFound, reason: "gone" };

    assert.equal(latch.latch("cl-sweep", record), true);
    assert.equal(
      latch.latch("cl-sweep", {
        code: StreamRunErrorCode.NoCommand,
        reason: "gone again",
      }),
      false
    );
    assert.deepEqual(
      latch.recordFor("cl-sweep"),
      record,
      "the first record wins; a repeat must not overwrite what was reported"
    );
    assert.equal(latch.recordFor("rtk"), undefined);
  });

  test("growth is capped by refusing the new key, never by evicting a latched one", () => {
    const latch = new TerminalInstallLatch();
    const overflow = TERMINAL_INSTALL_LATCH_MAX_PACKS + 1;
    const admitted: string[] = [];
    for (let i = 0; i < overflow; i++) {
      const latched = latch.latch(`pack-${i}`, {
        code: StreamRunErrorCode.NotFound,
        reason: `reason-${i}`,
      });
      if (latched) {
        admitted.push(`pack-${i}`);
      }
    }

    assert.equal(
      admitted.length,
      TERMINAL_INSTALL_LATCH_MAX_PACKS,
      "cloud-supplied pack ids must not grow the map past the cap"
    );
    assert.equal(
      latch.recordFor("pack-0")?.reason,
      "reason-0",
      "a latched pack must never be evicted to make room: it is still permanently uninstallable, and un-latching it hands its retries back"
    );
    assert.equal(
      latch.recordFor(`pack-${overflow - 1}`),
      undefined,
      "at saturation the new key is refused, so it keeps retrying instead of displacing a pack that already gave up"
    );
  });
});

describe("StreamRunErrorCode — ISS-6170 wire mirror", () => {
  test("the producer vocabulary matches what the ingest schema accepts", () => {
    // `packages/observability` cannot import `apps/desktop`, so the `z.enum` in
    // `packages/observability/telemetry/schema.ts` that validates
    // `diagnostics.distributionInstallGaveUp.reason` is a HAND-HELD mirror of
    // this const. A code added here and not there makes
    // `desktopTelemetryEventSchema` reject the WHOLE give-up event as
    // `telemetry.validation_failed` — silently, and again on every retry —
    // because the in-process path never runs the wire schema.
    //
    // `scripts/lint/rules/no-unmirrored-desktop-telemetry-enum.ts` is the gate
    // that normally polices this, but it is structurally blind here: it scans
    // `apps/desktop/src/main/telemetry/` and `.../database/`, and
    // `StreamRunErrorCode` lives in `apps/desktop/src/shared/` because the boot
    // path needs it import-free. So this pin is the guard instead. The literals
    // are deliberately spelled out rather than derived from the const under
    // test; the duplication IS the test, and the sibling assertion lives in
    // `packages/observability/__tests__/telemetry-schema.test.ts`.
    assert.deepEqual(Object.values(StreamRunErrorCode).sort(), [
      "EBADCWD",
      "ECWDREQUIRED",
      "EINFLIGHT",
      "ENOCLI",
      "ENOCOMMAND",
      "ENOTFOUND",
    ]);
  });
});
