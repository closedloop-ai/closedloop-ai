import assert from "node:assert/strict";
import { test } from "vitest";
import {
  OperationDispatcher,
  type OperationRequestContext,
} from "../src/server/operation-dispatcher.js";
import { parseBody } from "../src/server/operations/parse-body.js";
import { GatewayRouter } from "../src/server/router.js";
import { EMPTY_CAPABILITIES } from "../src/shared/contracts.js";

test("gateway request bodies distinguish empty, valid, and malformed JSON", () => {
  const withBody = (body: string): OperationRequestContext =>
    ({ body }) as OperationRequestContext;

  assert.deepEqual(parseBody(withBody("  \n")), {});
  assert.deepEqual(parseBody(withBody('{"branchId":"branch-1"}')), {
    branchId: "branch-1",
  });
  assert.equal(parseBody(withBody("{not-json")), null);
});

test("the router exposes binary paths only when both host adapters are wired", async () => {
  const partial = new OperationDispatcher();
  new GatewayRouter(
    { ...ROUTER_OPTIONS, getBinaryPaths: () => ({ git: "/usr/bin/git" }) },
    partial
  );

  assert.equal(await dispatchBinaryPaths(partial), false);

  const complete = new OperationDispatcher();
  new GatewayRouter(
    {
      ...ROUTER_OPTIONS,
      getBinaryPaths: () => ({ git: "/usr/bin/git" }),
      applyBinaryPathPatch: () => ({ git: "/usr/bin/git" }),
    },
    complete
  );

  assert.equal(await dispatchBinaryPaths(complete), true);
});

function dispatchBinaryPaths(
  dispatcher: OperationDispatcher
): Promise<boolean> {
  return dispatcher.dispatch({
    method: "GET",
    pathname: "/api/gateway/settings/binary-paths",
    params: {},
    query: new URLSearchParams(),
    rawBody: Buffer.alloc(0),
    body: "",
    request: {},
    response: {
      statusCode: 200,
      setHeader: () => undefined,
      end: () => undefined,
    },
  } as unknown as OperationRequestContext);
}

const ROUTER_OPTIONS = {
  webAppOrigin: "https://app.example.test",
  machineName: "gateway-input-fallbacks",
  version: "0.0.0-test",
  capabilities: EMPTY_CAPABILITIES,
  getActivePort: () => 0,
  getAllowedDirectories: () => [],
  getGatewayId: () => "",
};
