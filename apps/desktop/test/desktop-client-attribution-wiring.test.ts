/**
 * ISS-8749: the composition root must actually publish the client attribution,
 * and must publish the SAME build identity the OTel resource stamps.
 *
 * Driven as an AST guard rather than by loading the module: `desktop-services.ts`
 * statically imports `electron`, so it cannot be constructed in a node test at
 * all. This is the sanctioned `ts.createSourceFile` alternative to a raw text
 * scan (`scripts/lint/rules/no-raw-text-source-scan.ts`), and it is used the way
 * `initial-window-reveal-wiring.test.ts` uses it: for the one link no runnable
 * test can reach.
 *
 * What it is actually guarding is drift, not presence. Resolving the desktop
 * build version a second time for the header would compile, pass every other
 * test, and let the version a desktop record carries and the version the API
 * span records for the request that produced it disagree — with nothing
 * anywhere saying so. Reading both off one binding is what makes them equal by
 * construction, so the binding identity is what this asserts.
 */
import assert from "node:assert/strict";
import type { ObjectLiteralExpression } from "typescript6";
import { test } from "vitest";
import {
  calleeArgument,
  desktopServicesSource,
  initializerCall,
  propertyInitializer,
  propertyInitializerText,
} from "./desktop-services-ast-helpers.js";

const PUBLISH_CALLEE = "setDesktopClientAttributionResolver";
const OTEL_RUNTIME_CALLEE = "createDesktopOtelRuntime";
const INSTALLATION_ID_ACCESSOR = "getNodeUuidForTelemetry";
const BARE_IDENTIFIER_PATTERN = /^[A-Za-z_$][\w$]*$/;
const RESOLVER_ARROW_PATTERN =
  /setDesktopClientAttributionResolver\(\s*\(\)\s*=>/;

test("the composition root publishes a DEFERRED attribution resolver", () => {
  // The eager form threw `Cannot read properties of undefined (reading
  // 'getOrCreateNodeUuid')` on boot and killed desktop startup: `nodeUuidStore`
  // is assigned from this composition function's own return value, so a value
  // published here cannot read it at all. Only a resolver can.
  assert.match(desktopServicesSource().getFullText(), RESOLVER_ARROW_PATTERN);
});

test("the composition root publishes the Desktop client attribution", () => {
  const published = publishedAttributionArgument();

  assert.ok(published, `${PUBLISH_CALLEE} is never called`);
  const installationId = propertyInitializer(published, "installationId");
  assert.ok(
    installationId,
    "the published attribution names no installation id"
  );
  assert.equal(
    initializerCall(installationId)?.callee,
    INSTALLATION_ID_ACCESSOR,
    "the published installation id is not the telemetry node uuid"
  );
});

test("the published client version is the same binding the OTel resource uses", () => {
  const published = publishedAttributionArgument();
  const otelRuntime = calleeArgument(OTEL_RUNTIME_CALLEE);

  assert.ok(published && otelRuntime);
  const publishedVersion = propertyInitializerText(published, "clientVersion");
  const resourceVersion = propertyInitializerText(otelRuntime, "appVersion");

  assert.ok(
    publishedVersion,
    "the published attribution names no client version"
  );
  assert.equal(
    publishedVersion,
    resourceVersion,
    "the attested client version and the OTel `service.version` come from different expressions, so they can drift"
  );
  // A shared IDENTIFIER, not a shared call — two calls to the same resolver are
  // two resolutions, which is the drift this guards.
  assert.match(publishedVersion, BARE_IDENTIFIER_PATTERN);
});

function publishedAttributionArgument(): ObjectLiteralExpression | undefined {
  return calleeArgument(PUBLISH_CALLEE);
}
