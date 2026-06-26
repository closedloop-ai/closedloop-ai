import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  DESKTOP_POP_GATEWAY_ID_HEADER,
  DESKTOP_POP_SIGNATURE_HEADER,
  DESKTOP_POP_TIMESTAMP_HEADER,
} from "../src/main/desktop-pop.js";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { registerSymphonyPlanLoopRoutes } from "../src/server/operations/symphony-plan-loop.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("plan-loop cancel signs the managed Desktop API-key DELETE request", async () => {
  const dispatcher = new OperationDispatcher();
  const repoPath = path.join(os.tmpdir(), "desktop-plan-loop-pop-repo");
  let capturedUrl: string | undefined;
  let capturedHeaders: Headers | undefined;
  let capturedSigningRequest: unknown;

  globalThis.fetch = async (url, init) => {
    capturedUrl = String(url);
    capturedHeaders = new Headers(init?.headers as HeadersInit);
    return new Response(null, { status: 204 });
  };

  registerSymphonyPlanLoopRoutes(
    dispatcher,
    () => [os.tmpdir()],
    () => "sk_live_desktop",
    () => "https://api.closedloop.test",
    undefined,
    () => "DESKTOP_MANAGED",
    (request) => {
      capturedSigningRequest = request;
      return {
        [DESKTOP_POP_GATEWAY_ID_HEADER]: "gateway-1",
        [DESKTOP_POP_TIMESTAMP_HEADER]: "1713984000",
        [DESKTOP_POP_SIGNATURE_HEADER]: "signature",
      };
    }
  );

  const response = createResponseCapture();
  const handled = await dispatcher.dispatch({
    method: "POST",
    pathname: "/api/gateway/symphony/plan-loop/TICKET-1/cancel",
    params: {},
    query: new URLSearchParams(),
    rawBody: Buffer.from(
      JSON.stringify({ repoPath, loopId: "loop-123" }),
      "utf8"
    ),
    body: JSON.stringify({ repoPath, loopId: "loop-123" }),
    request: {} as IncomingMessage,
    response: response.response,
  });

  assert.equal(handled, true);
  assert.equal(capturedUrl, "https://api.closedloop.test/loops/loop-123");
  assert.deepEqual(capturedSigningRequest, {
    method: "DELETE",
    pathname: "/loops/loop-123",
  });
  assert.equal(capturedHeaders?.get("Authorization"), "Bearer sk_live_desktop");
  assert.equal(
    capturedHeaders?.get(DESKTOP_POP_GATEWAY_ID_HEADER),
    "gateway-1"
  );
  assert.equal(
    capturedHeaders?.get(DESKTOP_POP_TIMESTAMP_HEADER),
    "1713984000"
  );
  assert.equal(capturedHeaders?.get(DESKTOP_POP_SIGNATURE_HEADER), "signature");
  assert.equal(response.statusCode(), 200);
});

function createResponseCapture(): {
  response: ServerResponse;
  statusCode: () => number;
} {
  const response = {
    statusCode: 0,
    setHeader: () => undefined,
    end: () => undefined,
  };
  return {
    response: response as unknown as ServerResponse,
    statusCode: () => response.statusCode,
  };
}
