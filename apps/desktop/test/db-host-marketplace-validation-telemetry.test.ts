/**
 * @file db-host-marketplace-validation-telemetry.test.ts
 * @description ISS-8331 — malformed remote marketplace metadata is detected on
 * the DB-host store thread, but the monitored app.exception runtime lives in
 * Electron main. This pins the child telemetry relay's main-side handoff.
 */

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { AppExceptionOrigin } from "@closedloop-ai/telemetry-contract/app-exception-origin";
import { afterEach, test } from "vitest";
import { DbHostClient } from "../src/main/database/db-host/db-host-client.js";
import { DbHostResponseKind } from "../src/main/database/db-host/db-host-protocol.js";
import type {
  DesktopAppExceptionEventInput,
  DesktopOtelRuntime,
} from "../src/main/telemetry/app-otel-runtime.js";
import { Observability } from "../src/main/telemetry/observability.js";
import { processExceptionTelemetryBridge } from "../src/main/telemetry/process-exception-telemetry-bridge.js";
import type {
  DbHostChildListenerArgs,
  DbHostChildMessageListener,
} from "./db-host-fake-child-support.js";

afterEach(() => {
  processExceptionTelemetryBridge.clearRuntime();
  Observability.reset();
});

test("marketplace validation telemetry crosses the DB host and reaches main app.exception monitoring", () => {
  const appExceptions: DesktopAppExceptionEventInput[] = [];
  processExceptionTelemetryBridge.bindRuntime({
    emitAppExceptionEvent: (input: DesktopAppExceptionEventInput) => {
      appExceptions.push(input);
    },
  } as unknown as DesktopOtelRuntime);
  processExceptionTelemetryBridge.markRuntimeStarted();

  const genericTelemetry: unknown[] = [];
  Observability.init({
    telemetrySend: (event) => genericTelemetry.push(event),
  });

  let messageListener: DbHostChildMessageListener | undefined;
  const child = {
    stderr: null,
    on(...args: DbHostChildListenerArgs): unknown {
      if (args[0] === "message") {
        messageListener = args[1];
      }
      return child;
    },
    postMessage() {
      // Main → child boot is outside this handoff test.
    },
    kill() {
      // no-op for the fake
    },
  };
  const client = new DbHostClient({
    onEmit: () => undefined,
    onLog: () => undefined,
    fork: () => child,
  });
  client
    .start({ dataDir: path.join(os.tmpdir(), "iss8331-main") })
    .catch(() => {
      // The fake never answers Ready; only the message listener is under test.
    });
  assert.ok(messageListener);

  messageListener({
    kind: DbHostResponseKind.Telemetry,
    event: {
      severity: "error",
      category: "catalog.marketplace_manifest_invalid",
      message:
        "Remote marketplace manifest contained invalid plugin metadata; invalid_manifest=0 invalid_plugins=2 invalid_descriptions=1",
    },
  });

  assert.equal(genericTelemetry.length, 0);
  assert.equal(appExceptions.length, 1);
  const reported = appExceptions[0];
  assert.equal(reported?.origin, AppExceptionOrigin.Main);
  assert.ok(reported?.error instanceof Error);
  // The name is the stable grouping key; the counts ride the message so the
  // monitored exception can tell a corrupt manifest from one bad plugin.
  assert.equal(reported.error.name, "MarketplaceManifestValidationError");
  assert.equal(
    reported.error.message,
    "Remote marketplace manifest contained invalid plugin metadata; invalid_manifest=0 invalid_plugins=2 invalid_descriptions=1"
  );
});

test("a relayed marketplace event with no message still reports under the canonical text", () => {
  const appExceptions: DesktopAppExceptionEventInput[] = [];
  processExceptionTelemetryBridge.bindRuntime({
    emitAppExceptionEvent: (input: DesktopAppExceptionEventInput) => {
      appExceptions.push(input);
    },
  } as unknown as DesktopOtelRuntime);
  processExceptionTelemetryBridge.markRuntimeStarted();
  Observability.init({ telemetrySend: () => undefined });

  let messageListener: DbHostChildMessageListener | undefined;
  const child = {
    stderr: null,
    on(...args: DbHostChildListenerArgs): unknown {
      if (args[0] === "message") {
        messageListener = args[1];
      }
      return child;
    },
    postMessage() {
      // Main → child boot is outside this handoff test.
    },
    kill() {
      // no-op for the fake
    },
  };
  const client = new DbHostClient({
    onEmit: () => undefined,
    onLog: () => undefined,
    fork: () => child,
  });
  client
    .start({ dataDir: path.join(os.tmpdir(), "iss8331-main-fallback") })
    .catch(() => {
      // The fake never answers Ready; only the message listener is under test.
    });
  assert.ok(messageListener);

  messageListener({
    kind: DbHostResponseKind.Telemetry,
    event: {
      severity: "error",
      category: "catalog.marketplace_manifest_invalid",
      message: "",
    },
  });

  assert.equal(appExceptions.length, 1);
  const [appException] = appExceptions;
  assert.ok(appException);
  assert.equal(
    (appException.error as Error).message,
    "Remote marketplace manifest contained invalid plugin metadata"
  );
});
