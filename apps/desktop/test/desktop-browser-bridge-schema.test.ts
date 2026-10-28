import assert from "node:assert/strict";
import { test } from "vitest";
import {
  type BridgeResponse,
  bridgeResponseSchema,
  classifyBridgeRequest,
  desktopBrowserBridgeLimits,
  desktopBrowserBridgeRequestOutcome,
  isWithinBridgePayloadLimit,
  parseBridgeHostRequest,
  parseBridgeManifest,
  parseBridgeResponse,
} from "../src/shared/desktop-browser-bridge-schema.mjs";

/**
 * The bounds the broker used to carry as its own constants. Written out here
 * rather than read back off `desktopBrowserBridgeLimits`, because a test that
 * derives its expectation from the value under test stays green when that value
 * is widened — which is exactly the regression the move to a shared schema could
 * introduce.
 */
test("desktop browser bridge schema preserves the broker's bounds", () => {
  assert.deepEqual(desktopBrowserBridgeLimits, {
    identifierLength: 128,
    keyLength: 128,
    manifestDepth: 12,
    manifestEntries: 512,
    payloadBytes: 2 * 1024 * 1024,
  });
});

/**
 * The UNIT, which is the whole defect: `maxHttpBufferSize` counts bytes, and a
 * bound measured in UTF-16 code units admitted three-byte text at three times
 * the size it thought it was passing. Three-byte characters — one UTF-16 unit
 * each — so the old `.length` check called this payload half the limit while
 * its encoding sits above it.
 */
test("desktop browser bridge measures the payload bound in UTF-8 bytes", () => {
  const threeByteCharacters = "一".repeat(
    desktopBrowserBridgeLimits.payloadBytes / 2
  );

  assert.ok(
    threeByteCharacters.length < desktopBrowserBridgeLimits.payloadBytes
  );
  assert.ok(
    new TextEncoder().encode(threeByteCharacters).byteLength >
      desktopBrowserBridgeLimits.payloadBytes
  );
  assert.equal(isWithinBridgePayloadLimit(threeByteCharacters), false);
  assert.equal(isWithinBridgePayloadLimit("within"), true);
});

/**
 * Keys-covered guard. The `Record<keyof BridgeResponse, true>` annotation fails
 * `tsc` when the declared wire type gains a field, and the literal below fails
 * at runtime when the schema gains one — so neither half can grow without the
 * other, and a field the schema does not know can never be silently dropped at
 * the boundary.
 */
test("desktop browser bridge response schema covers every declared field", () => {
  const declared: Record<keyof BridgeResponse, true> = {
    clientId: true,
    error: true,
    requestId: true,
    result: true,
  };

  assert.deepEqual(Object.keys(bridgeResponseSchema.shape).sort(), [
    "clientId",
    "error",
    "requestId",
    "result",
  ]);
  assert.deepEqual(Object.keys(declared).sort(), [
    "clientId",
    "error",
    "requestId",
    "result",
  ]);
});

test("desktop browser bridge schema bounds manifest depth, entries and keys", () => {
  assert.notEqual(parseBridgeManifest(nestedManifest(12)), null);
  assert.equal(parseBridgeManifest(nestedManifest(13)), null);

  assert.notEqual(parseBridgeManifest(wideManifest(512)), null);
  assert.equal(parseBridgeManifest(wideManifest(513)), null);

  assert.equal(
    parseBridgeManifest({
      entries: { ["k".repeat(129)]: { kind: "method" } },
      kind: "object",
    }),
    null
  );
  assert.equal(parseBridgeManifest({ kind: "nonsense" }), null);
});

test("desktop browser bridge schema parses the shapes both ingresses exchange", () => {
  assert.deepEqual(
    classifyBridgeRequest({
      args: [1],
      kind: "invoke",
      path: ["db", "getSessions"],
      requestId: "request-1",
    }),
    {
      outcome: desktopBrowserBridgeRequestOutcome.Accepted,
      request: {
        args: [1],
        kind: "invoke",
        path: ["db", "getSessions"],
        requestId: "request-1",
      },
    }
  );
  assert.deepEqual(
    parseBridgeHostRequest({
      args: [],
      clientId: "client-1",
      kind: "invoke-remote",
      remoteFunctionId: "fn-1",
      requestId: "request-2",
    }),
    {
      args: [],
      clientId: "client-1",
      kind: "invoke-remote",
      remoteFunctionId: "fn-1",
      requestId: "request-2",
    }
  );
  assert.deepEqual(
    parseBridgeResponse({
      clientId: "client-1",
      error: { message: "too big", reason: "payload-too-large" },
      requestId: "request-3",
    }),
    {
      clientId: "client-1",
      error: { message: "too big", reason: "payload-too-large" },
      requestId: "request-3",
    }
  );

  // A host request with no clientId is what the CLIENT sends the broker; the
  // host ingress must not accept it, and neither ingress accepts an empty path.
  assert.equal(
    parseBridgeHostRequest({
      args: [],
      kind: "invoke",
      path: ["getSettings"],
      requestId: "request-4",
    }),
    null
  );
  // The two refusals stay APART, because the broker names them differently to
  // the caller: a shape it must correct versus a payload it must split.
  assert.deepEqual(
    classifyBridgeRequest({
      args: [],
      kind: "invoke",
      path: [],
      requestId: "request-5",
    }),
    { outcome: desktopBrowserBridgeRequestOutcome.Invalid }
  );
  assert.deepEqual(
    classifyBridgeRequest({
      args: ["x".repeat(desktopBrowserBridgeLimits.payloadBytes + 1)],
      kind: "invoke",
      path: ["db", "getSessions"],
      requestId: "request-6",
    }),
    { outcome: desktopBrowserBridgeRequestOutcome.TooLarge }
  );
  assert.equal(parseBridgeResponse({ clientId: "client-1" }), null);
});

function nestedManifest(depth: number): unknown {
  let node: unknown = { kind: "method" };
  for (let level = 0; level < depth; level += 1) {
    node = { entries: { nested: node }, kind: "object" };
  }
  return node;
}

function wideManifest(count: number): unknown {
  const entries: Record<string, unknown> = {};
  for (let index = 0; index < count; index += 1) {
    entries[`entry${index}`] = { kind: "method" };
  }
  return { entries, kind: "object" };
}
