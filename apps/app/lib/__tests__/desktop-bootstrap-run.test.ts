// @vitest-environment node

import {
  DesktopSignInMethod,
  encodeDesktopGatewayPublicKey,
} from "@repo/api/src/types/desktop-authorize-url";
import { describe, expect, it } from "vitest";
import {
  createDesktopAuthorizeRun,
  encodeDesktopAuthorizeRunCookie,
} from "../desktop-authorize-run";
import { desktopBootstrapBrowserRunFromCookie } from "../desktop-bootstrap-run";

const ISSUED_AT = Date.UTC(2026, 9, 4, 12, 0, 0);
const PUBLIC_KEY_PEM =
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAabc123+/def==\n-----END PUBLIC KEY-----";

function runCookie(consumed = false, bootstrapSupported = true): string {
  const query = new URLSearchParams({
    code_challenge: "challenge-abc",
    code_challenge_method: "S256",
    state: "state-xyz",
    redirect_uri: "http://127.0.0.1:49152/cb",
    gateway_id: "gateway-1",
    gateway_public_key: encodeDesktopGatewayPublicKey(PUBLIC_KEY_PEM),
    provider: DesktopSignInMethod.GitHub,
    ...(bootstrapSupported ? { bootstrap_supported: "1" } : {}),
  });
  const run = createDesktopAuthorizeRun(`?${query.toString()}`, ISSUED_AT);
  if (run === null) {
    throw new Error("fixture must produce a valid Desktop authorize run");
  }
  const cookie = encodeDesktopAuthorizeRunCookie({
    ...run,
    ...(consumed ? { consumed: true as const } : {}),
  });
  if (cookie === null) {
    throw new Error("fixture must encode");
  }
  return cookie;
}

describe("desktopBootstrapBrowserRunFromCookie", () => {
  it("projects a valid pending run onto the bootstrap mint boundary", () => {
    expect(
      desktopBootstrapBrowserRunFromCookie(runCookie(), ISSUED_AT)
    ).toEqual({
      bootstrapSupported: true,
      codeChallenge: "challenge-abc",
      codeChallengeMethod: "S256",
      gatewayId: "gateway-1",
      gatewayPublicKeyPem: PUBLIC_KEY_PEM,
      redirectUri: "http://127.0.0.1:49152/cb",
      state: "state-xyz",
    });
  });

  it("preserves an older Desktop run without claiming bootstrap support", () => {
    expect(
      desktopBootstrapBrowserRunFromCookie(runCookie(false, false), ISSUED_AT)
    ).toMatchObject({ bootstrapSupported: false });
  });

  it("does not reopen a consumed run", () => {
    expect(
      desktopBootstrapBrowserRunFromCookie(runCookie(true), ISSUED_AT)
    ).toBeNull();
  });

  it("rejects malformed and expired cookie values", () => {
    expect(desktopBootstrapBrowserRunFromCookie("%%%", ISSUED_AT)).toBeNull();
    expect(
      desktopBootstrapBrowserRunFromCookie(
        runCookie(),
        ISSUED_AT + 10 * 60 * 1000
      )
    ).toBeNull();
  });
});
