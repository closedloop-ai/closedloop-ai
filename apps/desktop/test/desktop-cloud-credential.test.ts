/**
 * FEA-3425: the shared session-only cloud-credential policy. Behavioral
 * coverage of each consumer lane lives with that lane's tests (components
 * client, trace-comment CRUD, parent-session post); this file pins the policy
 * itself so the "session token, thrown-read-is-no-session" rule has exactly one
 * owner. Session-only since PLN-1437 Phase 4a (the static-key fallback is gone).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDesktopCloudCredential } from "../src/main/auth/desktop-cloud-credential.js";

const TOKEN_READ_ERROR_PATTERN = /keychain locked/;

test("returns the first-party session token when present", async () => {
  const credential = await resolveDesktopCloudCredential({
    getAccessToken: () => Promise.resolve("session-token-1"),
  });

  assert.deepEqual(credential, { token: "session-token-1" });
});

test("treats a thrown token read as no-session and reports it, never throws", async () => {
  const reported: unknown[] = [];
  const credential = await resolveDesktopCloudCredential(
    {
      getAccessToken: () => Promise.reject(new Error("keychain locked")),
    },
    (error) => reported.push(error)
  );

  assert.equal(credential, null);
  assert.equal(reported.length, 1);
  assert.match(String(reported[0]), TOKEN_READ_ERROR_PATTERN);
});

test("returns null when no session token exists", async () => {
  const credential = await resolveDesktopCloudCredential({
    getAccessToken: () => Promise.resolve(null),
  });

  assert.equal(credential, null);
});

test("returns null when no sources are provided at all", async () => {
  assert.equal(await resolveDesktopCloudCredential({}), null);
});
