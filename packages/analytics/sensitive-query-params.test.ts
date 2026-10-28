import { DESKTOP_AUTHORIZE_QUERY_PARAMS } from "@repo/api/src/types/desktop-authorize-url";
import { describe, expect, it } from "vitest";
import { SENSITIVE_QUERY_PARAMS } from "./sensitive-query-params";

/**
 * The wire names this repo considers safe to leave readable in analytics. Kept
 * as literals here on purpose: the module under test derives its list BY
 * SUBTRACTION from the canonical const, so a test that derived the expectation
 * the same way would agree with any bug in that derivation.
 */
const EXPECTED_SAFE_WIRE_NAMES = [
  "code_challenge_method",
  "platform",
  "provider",
  "framing",
];

describe("SENSITIVE_QUERY_PARAMS", () => {
  it("masks every secret-, identifier-, and PII-bearing desktop authorize param", () => {
    expect(SENSITIVE_QUERY_PARAMS).toEqual(
      expect.arrayContaining([
        DESKTOP_AUTHORIZE_QUERY_PARAMS.state,
        DESKTOP_AUTHORIZE_QUERY_PARAMS.codeChallenge,
        DESKTOP_AUTHORIZE_QUERY_PARAMS.redirectUri,
        DESKTOP_AUTHORIZE_QUERY_PARAMS.gatewayId,
        DESKTOP_AUTHORIZE_QUERY_PARAMS.gatewayPublicKey,
        DESKTOP_AUTHORIZE_QUERY_PARAMS.deviceName,
        DESKTOP_AUTHORIZE_QUERY_PARAMS.emailHint,
      ])
    );
  });

  it("masks the desktop pairing authorization code", () => {
    expect(SENSITIVE_QUERY_PARAMS).toContain("code");
  });

  it("masks the signed-out detour's nested redirect target", () => {
    // The whole authorize URL lives inside this ONE param's value on
    // `/connect/github`, and posthog-js compares top-level keys only — it never
    // unwraps a nested url. Without this entry the case above is satisfied on a
    // URL shape the signed-out flow never actually produces.
    expect(SENSITIVE_QUERY_PARAMS).toContain("redirect_url");
  });

  it("leaves the four non-identifying flow dimensions readable", () => {
    for (const wireName of EXPECTED_SAFE_WIRE_NAMES) {
      expect(SENSITIVE_QUERY_PARAMS).not.toContain(wireName);
    }
  });

  it("fails closed: any authorize param that is not explicitly safe is masked", () => {
    const safe = new Set(EXPECTED_SAFE_WIRE_NAMES);
    // Not a restatement of the first case: this one is computed from the LIVE
    // const, so a param added to the wire contract tomorrow — a new secret
    // nobody thought to list — is expected here the moment it exists. That is
    // the property an enumerated deny-list cannot have.
    const mustBeMasked = Object.values(DESKTOP_AUTHORIZE_QUERY_PARAMS).filter(
      (wireName) => !safe.has(wireName)
    );

    expect(SENSITIVE_QUERY_PARAMS).toEqual(
      expect.arrayContaining(mustBeMasked)
    );
  });
});
