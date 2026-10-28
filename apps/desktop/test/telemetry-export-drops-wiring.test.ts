/**
 * ISS-11866 (R4): the composition root must give the lifecycle heartbeat the
 * export counters of the transport the runtime exports through.
 *
 * `getTelemetryExportCounts` is optional, so deleting it from
 * `desktop-services.ts` leaves every behavior test in
 * `telemetry-export-drops-heartbeat.test.ts` green while no packaged heartbeat
 * carries a count. The composition root statically imports `electron`, so this
 * link is read off the AST (see `desktop-services-ast-helpers.ts`).
 */
import assert from "node:assert/strict";
import {
  isArrowFunction,
  isCallExpression,
  isConditionalExpression,
  isIdentifier,
  isPropertyAccessExpression,
} from "typescript6";
import { test } from "vitest";
import {
  calleeArgument,
  initializerCall,
  propertyInitializer,
  propertyInitializerText,
} from "./desktop-services-ast-helpers.js";

test("the heartbeat reads its export counters off the runtime's own relay transport", () => {
  const lifecycleOptions = calleeArgument("createDesktopAppLifecycleTelemetry");
  assert.ok(
    lifecycleOptions,
    "createDesktopAppLifecycleTelemetry is never called"
  );
  const runtimeOptions = calleeArgument("createDesktopOtelRuntime");
  assert.ok(runtimeOptions, "createDesktopOtelRuntime is never called");
  const runtimeTransport = propertyInitializerText(
    runtimeOptions,
    "telemetryTransport"
  );
  assert.ok(runtimeTransport, "the runtime is built without a transport");

  const initializer = propertyInitializer(
    lifecycleOptions,
    "getTelemetryExportCounts"
  );
  assert.ok(
    initializer && isConditionalExpression(initializer),
    "the heartbeat is built without an export-counter reader guarded on the transport"
  );
  assert.ok(
    isIdentifier(initializer.condition) &&
      initializer.condition.text === runtimeTransport,
    "the export-counter reader is not guarded on the runtime's transport"
  );
  const reader = initializerCall(initializer.whenTrue);
  assert.ok(reader, "the export-counter reader calls nothing");
  assert.equal(
    reader.deferred,
    true,
    "the counters are read once at composition time, so every heartbeat reports zeros"
  );
  assert.equal(reader.callee, "getDiagnostics");
  const reads = initializer.whenTrue;
  assert.ok(
    isArrowFunction(reads) &&
      isCallExpression(reads.body) &&
      isPropertyAccessExpression(reads.body.expression) &&
      reads.body.expression.expression.getText() === runtimeTransport,
    "the counters are read off a different transport than the one the runtime exports through"
  );
});
