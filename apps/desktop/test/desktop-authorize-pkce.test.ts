import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  DESKTOP_PKCE_CODE_CHALLENGE_METHOD,
  generateDesktopPkce,
  generateOAuthState,
} from "../src/main/desktop-authorize-pkce.js";

const BASE64URL = /^[A-Za-z0-9\-_]+$/;

test("generateDesktopPkce derives an S256 challenge over the verifier", () => {
  const pkce = generateDesktopPkce();

  assert.equal(pkce.codeChallengeMethod, "S256");
  assert.equal(DESKTOP_PKCE_CODE_CHALLENGE_METHOD, "S256");
  const expected = createHash("sha256")
    .update(pkce.codeVerifier)
    .digest("base64url");
  assert.equal(pkce.codeChallenge, expected);
});

test("the verifier is 43–128 base64url chars (RFC 7636 §4.1 unreserved subset)", () => {
  const { codeVerifier } = generateDesktopPkce();

  assert.ok(
    codeVerifier.length >= 43 && codeVerifier.length <= 128,
    `verifier length ${codeVerifier.length} out of range`
  );
  // base64url is a strict subset of the RFC 7636 unreserved set.
  assert.match(codeVerifier, BASE64URL);
});

test("generateDesktopPkce derives deterministically from the injected RNG", () => {
  const bytes = Buffer.alloc(32, 7);
  const pkce = generateDesktopPkce(() => bytes);

  assert.equal(pkce.codeVerifier, bytes.toString("base64url"));
  assert.equal(
    pkce.codeChallenge,
    createHash("sha256").update(bytes.toString("base64url")).digest("base64url")
  );
});

test("successive PKCE verifiers differ (fresh entropy)", () => {
  assert.notEqual(
    generateDesktopPkce().codeVerifier,
    generateDesktopPkce().codeVerifier
  );
});

test("generateOAuthState is base64url, injectable, and non-repeating", () => {
  const bytes = Buffer.alloc(32, 3);

  assert.equal(
    generateOAuthState(() => bytes),
    bytes.toString("base64url")
  );
  assert.match(generateOAuthState(), BASE64URL);
  assert.notEqual(generateOAuthState(), generateOAuthState());
});
