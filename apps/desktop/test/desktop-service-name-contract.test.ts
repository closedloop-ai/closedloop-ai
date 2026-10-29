/**
 * ISS-6332 drift guard: the `service.name` the desktop OTel runtime stamps on
 * its resource must be the contract-owned value, not a module-local literal.
 * It reads the attribute back off a record the runtime actually emitted, so a
 * producer that stops sourcing the value from the contract fails here.
 *
 * It deliberately does NOT pin the literal — both sides import the same
 * constant, so a change to the contract's own value moves them together and
 * leaves this green. That half is owned by the `toEqual` on
 * `TelemetryServiceName` in the contract's `__tests__/source-literals.test.ts`.
 */
import assert from "node:assert/strict";
import {
  TelemetryAttribute,
  TelemetryServiceName,
} from "@closedloop-ai/telemetry-contract/attributes";
import { metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { afterEach, test } from "vitest";
import {
  createDesktopOtelRuntime,
  type DesktopOtelRuntime,
} from "../src/main/telemetry/app-otel-runtime.js";
import { DesktopOtelSignal } from "../src/shared/renderer-otel-bridge-constants.js";

let activeRuntime: DesktopOtelRuntime | null = null;

afterEach(async () => {
  await activeRuntime?.shutdown();
  activeRuntime = null;
  // `sdk.shutdown()` stops the providers but leaves them registered globally;
  // a later file in a shared runner would otherwise get a dead tracer.
  trace.disable();
  metrics.disable();
  logs.disable();
});

test("the runtime stamps the contract-owned service.name on its resource", async () => {
  activeRuntime = createDesktopOtelRuntime({
    appVersion: "1.2.3",
    bufferLimit: 100,
    env: {},
    getAppInstallationId: () => "install_service_name_contract",
    isPackaged: true,
    metricExportIntervalMs: 60_000,
  });
  await activeRuntime.start();
  logs
    .getLogger("desktop-service-name-contract", "1.0.0")
    .emit({ eventName: "desktop.log" });
  await activeRuntime.shutdown();

  const record = activeRuntime
    .getBufferedRecords()
    .find((item) => item.signal === DesktopOtelSignal.Log);
  assert.equal(
    record?.resourceAttributes[TelemetryAttribute.ServiceName],
    TelemetryServiceName.Desktop
  );
});
