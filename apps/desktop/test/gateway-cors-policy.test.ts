import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isLoopbackOrigin,
  isOriginAllowed,
  sameOrigin,
} from "../src/server/gateway-cors-policy.js";
import { ADDITIONAL_TRUSTED_WEB_APP_ORIGINS } from "../src/shared/contracts.js";

const PROD_ORIGIN = "https://app.closedloop.ai";
// Pin the stage origin as a literal so a typo in the allowlist fails this test
// rather than silently passing via `ADDITIONAL_TRUSTED_WEB_APP_ORIGINS[0]`.
const STAGE_ORIGIN = "https://app.closedloop-stage.ai";

test("allowlist pins the stage web-app origin literally", () => {
  assert.ok(
    ADDITIONAL_TRUSTED_WEB_APP_ORIGINS.includes(STAGE_ORIGIN),
    "ADDITIONAL_TRUSTED_WEB_APP_ORIGINS must contain the stage web-app origin"
  );
});

test("missing origin is allowed (non-browser / same-origin request)", () => {
  const policy = { webAppOrigin: PROD_ORIGIN, prodOriginsOnly: true };
  assert.equal(isOriginAllowed(undefined, policy), true);
  assert.equal(isOriginAllowed(null, policy), true);
  assert.equal(isOriginAllowed("", policy), true);
});

test('opaque "null" origin is rejected', () => {
  assert.equal(
    isOriginAllowed("null", {
      webAppOrigin: PROD_ORIGIN,
      prodOriginsOnly: true,
    }),
    false
  );
});

test("configured prod web-app origin is allowed", () => {
  assert.equal(
    isOriginAllowed(PROD_ORIGIN, {
      webAppOrigin: PROD_ORIGIN,
      prodOriginsOnly: true,
    }),
    true
  );
});

test("stage web-app origin is allowed even under prodOriginsOnly", () => {
  assert.equal(
    isOriginAllowed(STAGE_ORIGIN, {
      webAppOrigin: PROD_ORIGIN,
      prodOriginsOnly: true,
    }),
    true
  );
});

test("stage web-app origin is allowed when prodOriginsOnly is off", () => {
  assert.equal(
    isOriginAllowed(STAGE_ORIGIN, {
      webAppOrigin: PROD_ORIGIN,
      prodOriginsOnly: false,
    }),
    true
  );
});

test("suffix-spoof of the stage origin is rejected", () => {
  // `sameOrigin` compares the full URL origin, so an attacker-controlled host
  // that merely ends with the trusted host must not be allowed.
  const spoofs = [
    "https://app.closedloop-stage.ai.evil.com",
    "https://evil-app.closedloop-stage.ai",
    "http://app.closedloop-stage.ai",
    "https://app.closedloop-stage.ai:8443",
  ];
  for (const spoof of spoofs) {
    assert.equal(
      isOriginAllowed(spoof, {
        webAppOrigin: PROD_ORIGIN,
        prodOriginsOnly: true,
      }),
      false,
      `${spoof} must be rejected`
    );
  }
});

test("unknown origin is rejected under prodOriginsOnly", () => {
  assert.equal(
    isOriginAllowed("https://example.com", {
      webAppOrigin: PROD_ORIGIN,
      prodOriginsOnly: true,
    }),
    false
  );
});

test("loopback origins are allowed when prodOriginsOnly is off", () => {
  const policy = { webAppOrigin: PROD_ORIGIN, prodOriginsOnly: false };
  for (const origin of [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
    "http://app.localhost:3000",
  ]) {
    assert.equal(isOriginAllowed(origin, policy), true, `${origin} allowed`);
  }
});

test("loopback origins are rejected when prodOriginsOnly is on", () => {
  assert.equal(
    isOriginAllowed("http://localhost:3000", {
      webAppOrigin: PROD_ORIGIN,
      prodOriginsOnly: true,
    }),
    false
  );
});

// ISS-5299: cover the catch arms in sameOrigin (line 26) and isLoopbackOrigin
// (line 43) — both return false when URL construction throws on a malformed string.

test("sameOrigin returns false for malformed URL strings", () => {
  assert.equal(sameOrigin("%%%", "https://example.com"), false);
  assert.equal(sameOrigin("https://example.com", "%%%"), false);
  assert.equal(sameOrigin("not-a-url", "also-not-a-url"), false);
});

test("isLoopbackOrigin returns false for malformed URL strings", () => {
  assert.equal(isLoopbackOrigin("%%%"), false);
  assert.equal(isLoopbackOrigin("::1"), false);
});
