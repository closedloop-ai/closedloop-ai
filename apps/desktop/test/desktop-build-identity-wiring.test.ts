/**
 * ISS-9743: the composition root must hand telemetry a build identity that can
 * name a source build, and must read the build VERSION off the same binding its
 * two siblings use.
 *
 * Driven as an AST guard for the reason `desktop-client-attribution-wiring.test.ts`
 * gives: `desktop-services.ts` statically imports `electron`, so it cannot be
 * constructed in a node test. This is the sanctioned `ts.createSourceFile`
 * alternative to a raw text scan (`scripts/lint/rules/no-raw-text-source-scan.ts`).
 *
 * Both links are invisible to every runnable test. Passing `app.getVersion()`
 * here compiles and keeps the whole suite green while telemetry reports the
 * ELECTRON version on an unpackaged launch — the `43.0.0` observed in the fleet
 * against this app's `electron: ^43.0.0` pin, and a value that disagreed with
 * both the OTel `service.version` and the ISS-8749 request attribution resolved
 * a few lines away.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  calleeArgument,
  initializerCall,
  memberCalleeArgument,
  propertyInitializer,
  propertyInitializerText,
} from "./desktop-services-ast-helpers.js";

const OTEL_RUNTIME_CALLEE = "createDesktopOtelRuntime";
const BUILD_COMMIT_RESOLVER = "resolveDesktopBuildCommit";
const GENERATED_COMMIT_CONSTANT = "BUILD_COMMIT_HASH";
const BARE_IDENTIFIER_PATTERN = /^[A-Za-z_$][\w$]*$/;

test("telemetry reads the build version off the same binding the OTel resource uses", () => {
  const observabilityInit = memberCalleeArgument("Observability", "init");
  const otelRuntime = calleeArgument(OTEL_RUNTIME_CALLEE);

  assert.ok(observabilityInit, "Observability.init is never called");
  assert.ok(otelRuntime, `${OTEL_RUNTIME_CALLEE} is never called`);

  const telemetryVersion = propertyInitializerText(
    observabilityInit,
    "desktopClientVersion"
  );
  const resourceVersion = propertyInitializerText(otelRuntime, "appVersion");

  assert.ok(telemetryVersion, "telemetry is given no desktop client version");
  assert.equal(
    telemetryVersion,
    resourceVersion,
    "the telemetry client version and the OTel `service.version` come from different expressions, so they can drift"
  );
  // A shared IDENTIFIER, not a shared call: `app.getVersion()` here is the
  // unhardened third resolution that leaked the Electron version.
  assert.match(telemetryVersion, BARE_IDENTIFIER_PATTERN);
});

test("telemetry is given the build commit, resolved from the generated build info", () => {
  const observabilityInit = memberCalleeArgument("Observability", "init");
  assert.ok(observabilityInit, "Observability.init is never called");

  const commit = propertyInitializer(observabilityInit, "desktopBuildCommit");
  assert.ok(
    commit,
    "telemetry is given no build commit, so no source build can be named"
  );

  const call = initializerCall(commit);
  assert.equal(
    call?.callee,
    BUILD_COMMIT_RESOLVER,
    "the build commit does not go through the resolver that rejects a non-sha"
  );
  assert.deepEqual(
    call?.argumentNames,
    [GENERATED_COMMIT_CONSTANT],
    "the build commit is not read from the generated build-info constant"
  );
});
