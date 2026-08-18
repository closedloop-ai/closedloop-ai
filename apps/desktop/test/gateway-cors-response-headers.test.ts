/**
 * ISS-6084 -- the CORS headers the gateway actually puts on the wire.
 *
 * `gateway-cors-policy.test.ts` covers the pure allow/deny predicate. Nothing
 * covered the RESPONDER, so the contract the web app's health probe depends on
 * -- echo the requesting origin, and vary on it -- was unguarded even though the
 * code already satisfied it.
 *
 * ISS-6084 was reported with an observed `Access-Control-Allow-Origin:
 * http://127.0.0.1:3000` answering a request from `https://app.closedloop.ai`.
 * That is NOT the shipped default (`DEFAULT_WEB_APP_ORIGIN` is the prod origin);
 * it is what a gateway configured to a local dev web app answers. The last test
 * here pins that case so the difference stays legible: a misconfigured or
 * older-build gateway must degrade to an ordinary CORS rejection and must never
 * claim to allow an origin it does not.
 */
import assert from "node:assert/strict";
import os from "node:os";
import { test } from "node:test";
import { LoopSchedulerContext } from "../src/main/loop/loop-scheduler-context.js";
import { GatewayRouter } from "../src/server/router.js";
import {
  ADDITIONAL_TRUSTED_WEB_APP_ORIGINS,
  DEFAULT_WEB_APP_ORIGIN,
  EMPTY_CAPABILITIES,
} from "../src/shared/contracts.js";
import { dispatchMockRequest } from "./gateway-server-test-doubles.js";

const LEGACY_DEV_WEB_APP_ORIGIN = "http://127.0.0.1:3000";
const VARIES_ON_ORIGIN_RE = /\bOrigin\b/;

function createRouter(webAppOrigin: string): GatewayRouter {
  return new GatewayRouter({
    webAppOrigin,
    getAllowedDirectories: () => [os.tmpdir()],
    machineName: "cors-header-test-machine",
    version: "0.1.0-test",
    capabilities: EMPTY_CAPABILITIES,
    getActivePort: () => 19_432,
    getGatewayId: () => "cors-header-test-gateway",
    schedulers: new LoopSchedulerContext(),
  });
}

async function healthHeaders(
  webAppOrigin: string,
  requestOrigin: string | undefined
): Promise<Map<string, string | number | readonly string[]>> {
  const response = await dispatchMockRequest({
    router: createRouter(webAppOrigin),
    method: "GET",
    path: "/health",
    headers: requestOrigin === undefined ? {} : { origin: requestOrigin },
  });
  return response.headers;
}

test("the shipped default web-app origin is the production origin", () => {
  // The ticket asked whether the bad ACAO was a shipped default. It is not:
  // a stock build advertises production, so LocalElectron is not broken for
  // customers. Pinned here so a regression to a dev origin fails the suite.
  assert.equal(DEFAULT_WEB_APP_ORIGIN, "https://app.closedloop.ai");
});

test("health echoes the production origin and varies on Origin", async () => {
  const headers = await healthHeaders(
    DEFAULT_WEB_APP_ORIGIN,
    DEFAULT_WEB_APP_ORIGIN
  );

  assert.equal(
    headers.get("access-control-allow-origin"),
    DEFAULT_WEB_APP_ORIGIN
  );
  // Without Vary: Origin a shared cache can serve one origin's ACAO to another.
  assert.match(String(headers.get("vary")), VARIES_ON_ORIGIN_RE);
});

test("health echoes a first-party stage origin", async () => {
  const stageOrigin = ADDITIONAL_TRUSTED_WEB_APP_ORIGINS[0];
  assert.ok(stageOrigin, "expected at least one additional trusted origin");

  const headers = await healthHeaders(DEFAULT_WEB_APP_ORIGIN, stageOrigin);

  // Echoed, not collapsed to the configured prod origin: the stage app probes
  // the same loopback health endpoint and would otherwise be CORS-blocked.
  assert.equal(headers.get("access-control-allow-origin"), stageOrigin);
});

test("health never answers a disallowed origin with a wildcard", async () => {
  const headers = await healthHeaders(
    DEFAULT_WEB_APP_ORIGIN,
    "https://evil.example.com"
  );

  const allowOrigin = String(headers.get("access-control-allow-origin"));
  assert.notEqual(allowOrigin, "*");
  assert.notEqual(allowOrigin, "https://evil.example.com");
  // Private Network Access must not be granted to an origin that is not allowed.
  assert.equal(headers.get("access-control-allow-private-network"), undefined);
});

test("a gateway pointed at a local dev web app rejects the production origin", async () => {
  // The exact shape ISS-6084 observed. It is a configuration difference, not a
  // shipped defect: the response must simply not claim to allow the prod
  // origin, so the web app's probe fails as an ordinary CORS rejection rather
  // than reaching a gateway that was never configured to trust it.
  const headers = await healthHeaders(
    LEGACY_DEV_WEB_APP_ORIGIN,
    DEFAULT_WEB_APP_ORIGIN
  );

  assert.notEqual(
    headers.get("access-control-allow-origin"),
    DEFAULT_WEB_APP_ORIGIN
  );
  assert.equal(headers.get("access-control-allow-private-network"), undefined);
});

test("a non-browser request with no Origin still gets a usable ACAO", async () => {
  const headers = await healthHeaders(DEFAULT_WEB_APP_ORIGIN, undefined);

  // Old desktop builds and non-browser callers send no Origin. The responder
  // falls back to the configured origin rather than omitting the header, which
  // is what keeps a version-skewed caller working.
  assert.equal(
    headers.get("access-control-allow-origin"),
    DEFAULT_WEB_APP_ORIGIN
  );
});
