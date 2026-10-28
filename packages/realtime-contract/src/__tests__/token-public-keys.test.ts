import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseRealtimeTokenPublicKeys } from "../token-public-keys";

const KID = "0b2c4d6e-1f3a-4b5c-8d7e-9f0a1b2c3d4e";

describe("parseRealtimeTokenPublicKeys (ISS-11966)", () => {
  it("reads the infrastructure token_public_keys shape: kid to SPKI PEM", () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });

    const keys = parseRealtimeTokenPublicKeys(pemMap(pair.publicKey));

    expect([...(keys?.keys() ?? [])]).toEqual([KID]);
  });

  it("treats a blank env value as missing", () => {
    expect(parseRealtimeTokenPublicKeys(undefined)).toBeUndefined();
    expect(parseRealtimeTokenPublicKeys("  ")).toBeUndefined();
  });

  it.each([
    ["an empty object", "{}"],
    ["non-JSON", "not json"],
    ["a non-PEM entry", JSON.stringify({ [KID]: "not a pem" })],
    [
      "an EC key",
      pemMap(generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey),
    ],
    [
      "an RSA key under 2048 bits",
      pemMap(generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey),
    ],
    [
      "a private key",
      JSON.stringify({
        [KID]: generateKeyPairSync("rsa", {
          modulusLength: 2048,
        }).privateKey.export({ type: "pkcs8", format: "pem" }),
      }),
    ],
    [
      "a map keyed by key ARN rather than the bare key ID",
      JSON.stringify({
        [`arn:aws:kms:us-east-1:123456789012:key/${KID}`]: generateKeyPairSync(
          "rsa",
          { modulusLength: 2048 }
        ).publicKey.export({ type: "spki", format: "pem" }),
      }),
    ],
  ])("throws on %s", (_label, raw) => {
    expect(() => parseRealtimeTokenPublicKeys(raw)).toThrow(
      "REALTIME_TOKEN_PUBLIC_KEYS"
    );
  });
});

function pemMap(publicKey: KeyObject): string {
  return JSON.stringify({
    [KID]: publicKey.export({ type: "spki", format: "pem" }),
  });
}
