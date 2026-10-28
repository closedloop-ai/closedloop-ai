/**
 * ISS-9082: the composition root must actually give the lifecycle heartbeat a
 * capture-status reader.
 *
 * `getAgentMonitorRuntimeStatus` is optional on the lifecycle options, because a
 * caller with no verdict must omit the attribute rather than invent one — which
 * means dropping this one property from `desktop-services.ts` leaves every
 * behavior test in `agent-monitor-capture-alive-heartbeat.test.ts` green while
 * shipping the exact silence ISS-8906 ran a day in. That is the link this
 * guards, and it is the only one no runnable test can reach: the composition
 * root statically imports `electron`, so it cannot be constructed here.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { appHostAccessor } from "./desktop-app-host-ast-helpers.js";
import {
  calleeArgument,
  initializerCall,
  propertyInitializer,
} from "./desktop-services-ast-helpers.js";

const LIFECYCLE_TELEMETRY_CALLEE = "createDesktopAppLifecycleTelemetry";
const CAPTURE_STATUS_OPTION = "getAgentMonitorRuntimeStatus";
const CAPTURE_STATUS_ACCESSOR = "getAgentMonitorRuntimeStatusKindForTelemetry";
const CAPTURE_LIVENESS_HELPER = "resolveCaptureLivenessStatus";
const CAPTURE_FAILED_FIELD = "agentMonitorFailed";

test("the composition root reads the capture status off the app host", () => {
  const options = calleeArgument(LIFECYCLE_TELEMETRY_CALLEE);
  assert.ok(options, `${LIFECYCLE_TELEMETRY_CALLEE} is never called`);

  const initializer = propertyInitializer(options, CAPTURE_STATUS_OPTION);
  assert.ok(
    initializer,
    "the lifecycle heartbeat is built without a capture-status reader, so every heartbeat it emits is process liveness only"
  );
  const reader = initializerCall(initializer);
  assert.ok(reader, "the capture-status reader calls nothing");
  // Read through the host on each call rather than snapshotted at composition
  // time: a runtime that fails after boot must be reported by the next tick.
  assert.equal(
    reader.deferred,
    true,
    "the capture status is resolved once at composition time, so a runtime that fails after boot is never reported"
  );
  assert.equal(
    reader.callee,
    CAPTURE_STATUS_ACCESSOR,
    `the capture-status reader does not go through \`${CAPTURE_STATUS_ACCESSOR}\`, so it is not reporting the app's own Agent Monitor verdict`
  );
});

/**
 * ISS-9082 review: the host accessor must fold the terminal capture-failure
 * flag in, not read the DB-runtime `kind` alone.
 *
 * This is a second, independent link no runnable test reaches — `app.ts`
 * statically imports `electron` — and reverting it to the bare `.kind` read
 * leaves the helper's own unit tests green while restoring the false-healthy
 * heartbeat.
 */
test("the app host derives capture liveness rather than reading the DB-runtime kind", () => {
  const initializer = appHostAccessor(CAPTURE_STATUS_ACCESSOR);
  assert.ok(initializer, `${CAPTURE_STATUS_ACCESSOR} is not on the app host`);
  const accessor = initializerCall(initializer);
  assert.ok(
    accessor,
    `${CAPTURE_STATUS_ACCESSOR} calls nothing, so it cannot be deriving anything`
  );
  assert.equal(
    accessor.callee,
    CAPTURE_LIVENESS_HELPER,
    `the accessor does not go through \`${CAPTURE_LIVENESS_HELPER}\`, so a hook-listener bind failure still reports the install healthy`
  );
  assert.ok(
    accessor.argumentNames.includes(CAPTURE_FAILED_FIELD),
    `the accessor never passes \`${CAPTURE_FAILED_FIELD}\`, which is where the hook listener's terminal bind failure lands`
  );
});
