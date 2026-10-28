/**
 * ISS-12211: the composition root must hand the OTel runtime the API-route
 * transport, with the relay `/telemetry` transport as its fallback.
 *
 * The behavior suite builds the transport by hand, so it stays green if
 * `desktop-services.ts` goes back to the relay transport alone, or drops the
 * fallback that keeps a new build sending to an API without the route. The
 * composition root statically imports `electron`, so the link is read off the
 * AST (see `desktop-services-ast-helpers.ts`).
 */
import assert from "node:assert/strict";
import type { Node } from "typescript6";
import {
  forEachChild,
  isCallExpression,
  isConditionalExpression,
  isIdentifier,
  isVariableDeclaration,
} from "typescript6";
import { test } from "vitest";
import {
  calleeArgument,
  desktopServicesSource,
  initializerCall,
  propertyInitializer,
  propertyInitializerText,
} from "./desktop-services-ast-helpers.js";

test("the runtime exports through the API route, falling back to the relay lane", () => {
  const runtimeOptions = calleeArgument("createDesktopOtelRuntime");
  assert.ok(runtimeOptions, "createDesktopOtelRuntime is never called");
  const runtimeTransport = propertyInitializerText(
    runtimeOptions,
    "telemetryTransport"
  );
  assert.ok(runtimeTransport, "the runtime is built without a transport");

  const declared = variableInitializer(runtimeTransport);
  assert.ok(
    declared && isConditionalExpression(declared),
    "the runtime's transport is not built behind the egress gate"
  );
  const built = declared.whenTrue;
  assert.ok(
    isCallExpression(built) &&
      isIdentifier(built.expression) &&
      built.expression.text === "createApiOtlpTelemetryTransport",
    "the runtime's transport is not the API-route transport"
  );

  const apiOptions = calleeArgument("createApiOtlpTelemetryTransport");
  assert.ok(apiOptions);
  const origin = initializerCall(
    propertyInitializer(apiOptions, "getApiOrigin") ?? apiOptions
  );
  assert.equal(origin?.deferred, true, "the API origin is read once at boot");
  assert.equal(origin?.callee, "getApiOrigin");
  const fallback = initializerCall(
    propertyInitializer(apiOptions, "fallback") ?? apiOptions
  );
  assert.equal(
    fallback?.callee,
    "createRelayTelemetryTransport",
    "the API-route transport has no relay fallback"
  );
});

function variableInitializer(name: string): Node | undefined {
  let found: Node | undefined;
  const visit = (node: Node): void => {
    if (
      !found &&
      isVariableDeclaration(node) &&
      isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found = node.initializer;
    }
    forEachChild(node, visit);
  };
  forEachChild(desktopServicesSource(), visit);
  return found;
}
