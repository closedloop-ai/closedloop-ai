/**
 * @file dead-end-telemetry-preload-hop.test.ts
 * @description ISS-7249 (whitlockk review, `preload-common.ts:516`): nothing
 * exercised `createDesktopApi().recordDeadEndTelemetry` through the PRODUCTION
 * preload hop. The suites that existed either stubbed `window.desktopApi`
 * wholesale in the renderer or called the registrar and the recorder directly,
 * so the one link between them — the preload method that names the channel and
 * shapes the reply — was the only part nothing covered. Deleting it, or aiming
 * it at the wrong channel, left every one of them green.
 *
 * So this drives the whole chain in one pass: the renderer's own reporter →
 * `createDesktopApi` → an `ipcRenderer` stand-in wired to the REAL registered
 * `ipcMain` handler → the REAL recorder → the emit sink. The only test doubles
 * are the two process edges (the IPC transport and the OTel runtime); every
 * production module between them is the shipped one.
 */
import assert from "node:assert/strict";
import {
  DeadEndPhase,
  DeadEndReason,
  DeadEndState,
  DeadEndTreatment,
} from "@closedloop-ai/telemetry-contract/app";
import { afterEach, test } from "vitest";
import {
  DeadEndTelemetryIpcChannel,
  registerDeadEndTelemetryIpcHandlers,
} from "../src/main/ipc/dead-end-telemetry-ipc.js";
import { createDesktopApi } from "../src/main/preload-common.js";
import type { DesktopDeadEndEventInput } from "../src/main/telemetry/app-otel-runtime-dead-end.js";
import { createDeadEndTelemetryRecorder } from "../src/main/telemetry/dead-end-telemetry-recorder.js";
import { reportDeadEndEvent } from "../src/renderer/hooks/use-dead-end-telemetry.js";
import {
  DEAD_END_TELEMETRY_CHANNEL,
  type DeadEndTelemetryPayload,
} from "../src/shared/dead-end-telemetry-contract.js";

const TRUSTED_SENDER = { id: "trusted-renderer" };

/**
 * Everything between the two process edges, wired the way the composition root
 * wires it in `desktop-ipc-registration.ts`. `runtimeTakesRecord` is the OTel
 * edge: `emitDeadEndEvent` no-ops (returning false) until the runtime has
 * started, which is the production case behind an honest `{ ok: false }`.
 */
function createHop({ runtimeTakesRecord = true } = {}) {
  const emitted: DesktopDeadEndEventInput[] = [];
  const handlers = new Map<
    string,
    (event: unknown, ...args: unknown[]) => unknown
  >();
  const invokedChannels: string[] = [];

  const recorder = createDeadEndTelemetryRecorder({
    emit: (input) => {
      if (!runtimeTakesRecord) {
        return false;
      }
      emitted.push(input);
      return true;
    },
  });

  registerDeadEndTelemetryIpcHandlers(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    {
      isTrustedSender: (sender) => sender === TRUSTED_SENDER,
      recordDeadEndTelemetry: (payload) => recorder.record(payload),
    }
  );

  const desktopApi = createDesktopApi({
    // The transport edge: carry the channel and the payload to the registered
    // main handler exactly as Electron's `ipcRenderer.invoke` would.
    invoke: (channel: string, ...args: unknown[]) => {
      invokedChannels.push(channel);
      const handler = handlers.get(channel);
      if (!handler) {
        return Promise.reject(
          new Error(`no main handler registered for ${channel}`)
        );
      }
      return Promise.resolve(handler({ sender: TRUSTED_SENDER }, ...args));
    },
    on: () => undefined,
    removeListener: () => undefined,
    send: () => undefined,
  });

  return { desktopApi, emitted, handlers, invokedChannels };
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

afterEach(() => {
  if (originalWindow) {
    Object.defineProperty(globalThis, "window", originalWindow);
    return;
  }
  Reflect.deleteProperty(globalThis, "window");
});

/** The renderer's reporter reads `window.desktopApi` and nothing else. */
function installRendererWindow(desktopApi: unknown): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { desktopApi },
    writable: true,
  });
}

function renderedPayload(): DeadEndTelemetryPayload {
  return {
    treatment: DeadEndTreatment.SessionsListUnavailable,
    phase: DeadEndPhase.Rendered,
    state: DeadEndState.Unavailable,
    reason: DeadEndReason.PermissionDenied,
    retryOffered: true,
    retryAttempt: 0,
    httpStatus: 403,
  };
}

test("the renderer's reporter reaches the runtime through the real preload method", async () => {
  const { desktopApi, emitted, invokedChannels } = createHop();
  installRendererWindow(desktopApi);

  reportDeadEndEvent(renderedPayload());
  // The reporter deliberately fires and forgets (a telemetry failure must not
  // add a second message to a failing screen), so drain the invoke it started
  // rather than assert on a promise it never hands back.
  await Promise.resolve();
  await Promise.resolve();

  // The preload method must name THIS channel: aiming it at another one, or
  // deleting it, is exactly what nothing caught before.
  assert.deepEqual(invokedChannels, [DEAD_END_TELEMETRY_CHANNEL]);
  // Every field survives the hop, including the `httpStatus` the list read's
  // 403 contributes — the value whitlockk's `dead-end-cause.ts` finding is about.
  assert.deepEqual(emitted, [renderedPayload()]);
});

test("the preload method answers with whether the record was actually taken", async () => {
  const taken = createHop();
  assert.deepEqual(
    await taken.desktopApi.recordDeadEndTelemetry(renderedPayload()),
    {
      ok: true,
    }
  );

  // A record emitted before the runtime started is DROPPED. The reply has to
  // say so: a flat `{ ok: true }` over a dropped record is the confident wrong
  // value ISS-7249 exists to stop, one layer below the screen.
  const dropped = createHop({ runtimeTakesRecord: false });
  assert.deepEqual(
    await dropped.desktopApi.recordDeadEndTelemetry(renderedPayload()),
    { ok: false }
  );
  assert.deepEqual(dropped.emitted, []);
});

test("an untrusted sender is refused before the recorder sees the payload", () => {
  // The preload hop cannot be the only gate: `assertTrustedIpcSender` runs on
  // the main side, so a payload arriving from anything but the renderer window
  // must never reach the recorder.
  const { emitted, handlers } = createHop();
  const handler = handlers.get(DeadEndTelemetryIpcChannel.RecordDeadEnd);

  assert.ok(handler, "the dead-end channel must be registered");
  assert.throws(() =>
    handler({ sender: { id: "hostile" } }, renderedPayload())
  );
  assert.deepEqual(emitted, []);
});
