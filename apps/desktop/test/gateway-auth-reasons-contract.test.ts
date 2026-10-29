/**
 * The wire half of `AuthReason` (ISS-7591).
 *
 * Every gateway rejection suite now asserts against `AuthReason` rather than a
 * repeated literal, so a reworded member would move production and its tests
 * together and stay green while already-installed browser and relay clients
 * stopped recognizing the reason. This is the one place the strings are written
 * out independently: a diff here means a cross-process contract is changing on
 * purpose.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { AuthReason } from "../src/server/gateway-auth-reasons.js";

test("AuthReason is exactly the reason strings the gateway puts on the wire", () => {
  assert.deepEqual(AuthReason, {
    OriginNotAllowed: "origin not allowed in prod-origins-only mode",
    SessionTokenWithoutOrigin:
      "session token present but Origin header missing",
    SessionStoreMissing: "session store not configured",
    SessionTokenInvalid: "invalid or expired session token, or origin mismatch",
    NoCredential: "no credential provided",
    BrowserSessionRequired: "session token required for browser requests",
  });
});
