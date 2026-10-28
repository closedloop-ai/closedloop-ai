/**
 * @file required-plugin-installer-options-opt-in-broadcast.test.ts
 * @description ISS-6704: the opt-in broadcast must never carry the presigned
 * `assetDownloadUrl` across the IPC boundary.
 *
 * `toOptInDistributionDto` — the projection that drops the URL — is already
 * unit-tested in `packages/api/src/types/distribution.test.ts`. What was not
 * tested is the WIRING: that `onOptInAvailable` runs a distribution through
 * that projection BEFORE `webContents.send`. Deleting the `.map(...)` call and
 * broadcasting the raw DTOs leaves that unit suite entirely green while a live
 * 15-minute presigned S3 capability URL reaches the renderer.
 *
 * So these assertions are made on the argument `webContents.send` actually
 * received, never on the projection's return value.
 *
 * ISS-6170 adds the same kind of wiring claim for the terminal give-up: the
 * factory is what decides that a give-up reaches the monitored telemetry lane
 * unconditionally and the user notification only behind its Labs gate. The
 * installer's own suite proves the give-up fires once; only this file proves
 * where it goes.
 */

import assert from "node:assert/strict";
import type { DistributionDto } from "@repo/api/src/types/distribution";
import { describe, test } from "vitest";
import type { AgentDashboardDesignSystemRuntime } from "../src/main/dashboard/agent-dashboard-design-system-runtime.js";
import type { TerminalInstallFailureNotice } from "../src/main/packs/required-plugin-installer.js";
import type {
  RequiredPluginInstallerOptionsParams,
  RequiredPluginInstallerSettingsPort,
} from "../src/main/packs/required-plugin-installer-options.js";
import {
  buildRequiredPluginInstallerOptions,
  OPT_IN_AVAILABLE_CHANNEL,
} from "../src/main/packs/required-plugin-installer-options.js";
import { resetDistributionInstallGaveUpTelemetryForTests } from "../src/main/telemetry/distribution-install-terminal-telemetry.js";
import { Observability } from "../src/main/telemetry/observability.js";
import type { TelemetryEventPayload } from "../src/main/telemetry/telemetry-protocol.js";
import type { DesktopWindow } from "../src/main/window.js";
import {
  StreamRunErrorCode,
  type StreamRunResult,
} from "../src/shared/install-run-contract.js";
import { makeOptInDist } from "./support/required-plugin-installer-fixtures.js";

const PRESIGNED_URL = "https://s3.example.com/presigned/gstack.zip?token=leak";

/**
 * ISS-6170. The category and the remedy are spelled as INDEPENDENT literals,
 * never read back off the producer: deriving either from the module under test
 * would make these assertions agree with whatever it emits, which is the one
 * thing they exist to refuse.
 */
const TELEMETRY_CATEGORY = "distribution.install_gave_up";
const UPDATE_DESKTOP_RE = /update Closedloop Desktop/;

/** The notice the installer raises on the reconcile that gives up. */
const TERMINAL_NOTICE: TerminalInstallFailureNotice = {
  code: StreamRunErrorCode.NotFound,
  distributionId: "dist-sweep",
  firstGiveUp: true,
  packId: "cl-sweep",
  reason:
    "pack 'cl-sweep' is not in this desktop build's catalog — this build cannot install it (update Closedloop Desktop, or the distribution references a pack that no longer exists): pack_id not in catalog: cl-sweep",
};

/** The same give-up, re-raised on a LATER reconcile of an already-latched pack. */
const REPEAT_NOTICE: TerminalInstallFailureNotice = {
  ...TERMINAL_NOTICE,
  firstGiveUp: false,
};

/**
 * Record what reaches the telemetry lane, restoring the singleton exactly.
 *
 * The restore ASSIGNS THE ORIGINAL BACK rather than deleting the key, which is
 * the opposite of what the sibling `gatewayLog` capture does — and the
 * difference is load-bearing. `gatewayLog` is an object whose methods live on a
 * prototype, so deleting the own property uncovers the real one; a `static` is
 * an own property of the class itself, so deleting it would remove
 * `getTelemetryEmitter` outright for every later test in this process.
 */
function captureTelemetry(sink: TelemetryEventPayload[]): () => void {
  const original = Observability.getTelemetryEmitter;
  Observability.getTelemetryEmitter = () => ({
    emit: (event: TelemetryEventPayload) => {
      sink.push(event);
    },
  });
  return () => {
    Observability.getTelemetryEmitter = original;
  };
}

type SentMessage = { channel: string; payload: unknown };

/**
 * A `DesktopWindow` stand-in whose guarded delivery seam is a recording spy.
 */
function fakeWindow(): {
  cleared: string[];
  desktopWindow: DesktopWindow;
  sent: SentMessage[];
} {
  const cleared: string[] = [];
  const sent: SentMessage[] = [];
  const desktopWindow = {
    clearRendererSnapshot: (channel: string) => {
      cleared.push(channel);
    },
    sendToRenderer: (channel: string, payload: unknown) => {
      sent.push({ channel, payload });
      return false;
    },
  } as unknown as DesktopWindow;
  return { cleared, desktopWindow, sent };
}

function buildOptions(
  overrides: Partial<RequiredPluginInstallerOptionsParams> = {}
) {
  return buildRequiredPluginInstallerOptions({
    getAccessToken: () => Promise.resolve("token"),
    getApiOrigin: () => "https://api.example.com",
    getDesignSystemRuntime: () => null,
    resolveRuntimeReadyTarget: () => null,
    installCoachingDistribution: () =>
      Promise.reject(new Error("not exercised")),
    getWindow: () => fakeWindow().desktopWindow,
    settings: makeSettings(false),
    createNotification: () => ({ show: () => undefined }),
    ...overrides,
  });
}

/**
 * A settings port stand-in. `notificationsEnabled` is the ISS-6170 Labs gate;
 * the decline members are inert here because no case in this file drives them.
 */
function makeSettings(
  notificationsEnabled: boolean
): RequiredPluginInstallerSettingsPort {
  return {
    isDistributionDeclined: () => false,
    recordDeclinedDistribution: () => undefined,
    getFlag: () => notificationsEnabled,
  };
}

/** The single opt-in DTO under test, carrying a live presigned asset URL. */
function optInDistWithPresignedUrl(): DistributionDto {
  return makeOptInDist({ assetDownloadUrl: PRESIGNED_URL });
}

describe("buildRequiredPluginInstallerOptions opt-in broadcast (ISS-6704)", () => {
  test("the payload sent over IPC carries no assetDownloadUrl key", () => {
    const { desktopWindow, sent } = fakeWindow();
    const options = buildOptions({ getWindow: () => desktopWindow });

    options.onOptInAvailable?.([optInDistWithPresignedUrl()]);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].channel, OPT_IN_AVAILABLE_CHANNEL);
    const broadcast = sent[0].payload as Record<string, unknown>[];
    assert.equal(broadcast.length, 1);
    // `hasOwn`, not `=== undefined`: an explicitly-serialized `null` would still
    // be a field the renderer must not be handed, and the projection's contract
    // is that the key is absent entirely.
    assert.equal(Object.hasOwn(broadcast[0], "assetDownloadUrl"), false);
    // The control — the broadcast must still be the distribution the banner
    // needs, or "no assetDownloadUrl" would also be satisfied by sending `[{}]`.
    assert.equal(broadcast[0].id, "dist-opt-001");
    assert.deepEqual(broadcast[0].catalogItem, {
      id: "ci-opt-001",
      name: "GStack",
      targetKind: "plugin",
      coaching: undefined,
    });
  });

  test("no assetDownloadUrl reaches the renderer even in the serialized form", () => {
    const { desktopWindow, sent } = fakeWindow();
    const options = buildOptions({ getWindow: () => desktopWindow });

    options.onOptInAvailable?.([optInDistWithPresignedUrl()]);

    // The structured-clone/JSON view of the same payload: a nested carrier of
    // the URL (e.g. a spread that kept it under the catalog item) would slip
    // past a top-level key check but not past this one.
    assert.equal(
      JSON.stringify(sent[0].payload).includes(PRESIGNED_URL),
      false
    );
  });

  test("forwards an empty authoritative snapshot through the window owner", () => {
    const { desktopWindow, sent } = fakeWindow();
    const options = buildOptions({ getWindow: () => desktopWindow });

    options.onOptInAvailable?.([]);

    assert.deepEqual(sent, [
      { channel: OPT_IN_AVAILABLE_CHANNEL, payload: [] },
    ]);
  });

  test("clears the retained snapshot through the window owner", () => {
    const { cleared, desktopWindow } = fakeWindow();
    const options = buildOptions({ getWindow: () => desktopWindow });

    options.clearOptInSnapshot?.();

    assert.deepEqual(cleared, [OPT_IN_AVAILABLE_CHANNEL]);
  });
});

describe("buildRequiredPluginInstallerOptions runtime deferral (ISS-6704)", () => {
  test("runInstall resolves null instead of throwing while the runtime has not booted", async () => {
    const options = buildOptions({ getDesignSystemRuntime: () => null });

    assert.equal(await options.runInstall("pack-1", "claude"), null);
  });

  test("getInstalledVersion resolves null instead of throwing while the runtime has not booted", async () => {
    const options = buildOptions({ getDesignSystemRuntime: () => null });

    assert.equal(await options.getInstalledVersion("pack-1"), null);
  });

  test("both delegate to the runtime once it has booted", async () => {
    // The control for the two deferrals above: a body hardwired to `null` would
    // satisfy them, and the installer would never install anything.
    const installResult = { ok: true } as unknown as StreamRunResult;
    const calls: string[] = [];
    const runtime = {
      installPack: (packId: string, harness: string) => {
        calls.push(`install:${packId}:${harness}`);
        return Promise.resolve(installResult);
      },
      getInstalledPackVersion: (packId: string) => {
        calls.push(`version:${packId}`);
        return Promise.resolve("1.2.3");
      },
    } as unknown as AgentDashboardDesignSystemRuntime;
    const options = buildOptions({ getDesignSystemRuntime: () => runtime });

    assert.equal(await options.runInstall("pack-1", "claude"), installResult);
    assert.equal(await options.getInstalledVersion("pack-1"), "1.2.3");
    assert.deepEqual(calls, ["install:pack-1:claude", "version:pack-1"]);
  });
});

describe("buildRequiredPluginInstallerOptions terminal give-up sinks (ISS-6170)", () => {
  test("routes the give-up to the user notification when the Labs flag is on", () => {
    const shown: Array<{ title: string; body: string }> = [];
    const options = buildOptions({
      settings: makeSettings(true),
      createNotification: (notificationOptions) => ({
        show: () => {
          shown.push(notificationOptions);
        },
      }),
    });

    options.onTerminalInstallFailure?.(TERMINAL_NOTICE);

    assert.equal(shown.length, 1);
    // The remedy the user can act on has to survive into the body — a
    // notification that only says "install failed" sends nobody anywhere.
    assert.match(shown[0].body, UPDATE_DESKTOP_RE);
  });

  test("stays silent to the user while the Labs flag is off, the shipped default", () => {
    // ISS-4779 closed-by-default. The control for the case above: a body that
    // ignored the gate would satisfy it and leak the notification on every
    // install that has not opted in.
    const shown: unknown[] = [];
    const options = buildOptions({
      settings: makeSettings(false),
      createNotification: () => ({
        show: () => {
          shown.push(true);
        },
      }),
    });

    options.onTerminalInstallFailure?.(TERMINAL_NOTICE);

    assert.deepEqual(shown, []);
  });

  test("emits the monitored give-up telemetry even with the notification flag off", () => {
    // The give-up must reach the monitored lane regardless of the UI gate: an
    // operator who never turned the toggle on must still not lose the signal,
    // or a permanently skipped install is indistinguishable from a successful
    // one everywhere outside that one machine's log.
    const emitted: TelemetryEventPayload[] = [];
    const restore = captureTelemetry(emitted);
    resetDistributionInstallGaveUpTelemetryForTests();
    const options = buildOptions({
      settings: makeSettings(false),
      createNotification: () => ({ show: () => undefined }),
    });

    try {
      options.onTerminalInstallFailure?.(TERMINAL_NOTICE);
    } finally {
      restore();
      resetDistributionInstallGaveUpTelemetryForTests();
    }

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].category, TELEMETRY_CATEGORY);
    assert.deepEqual(emitted[0].diagnostics, {
      distributionInstallGaveUp: { reason: StreamRunErrorCode.NotFound },
    });
  });

  test("a re-raised give-up retries the telemetry but does not re-notify the user", () => {
    // The two sinks have deliberately different cadences. The monitored one must
    // get another chance — its own latch is not consumed until the lane accepted
    // the event, so a give-up raised while the authenticated HTTP lane was still
    // coming up would otherwise be lost for good. The notification must not fire
    // again: a repeat is not a retry, it is nagging about something already seen.
    const emitted: TelemetryEventPayload[] = [];
    const shown: unknown[] = [];
    const restore = captureTelemetry(emitted);
    resetDistributionInstallGaveUpTelemetryForTests();
    const options = buildOptions({
      settings: makeSettings(true),
      createNotification: () => ({
        show: () => {
          shown.push(true);
        },
      }),
    });

    try {
      options.onTerminalInstallFailure?.(REPEAT_NOTICE);
    } finally {
      restore();
      resetDistributionInstallGaveUpTelemetryForTests();
    }

    assert.equal(
      emitted.length,
      1,
      "the monitored give-up must be re-attempted on a later reconcile"
    );
    assert.deepEqual(shown, []);
  });
});
