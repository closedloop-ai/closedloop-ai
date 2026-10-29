/**
 * Unit tests for Ed25519 SPKI PEM validation.
 */
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createEd25519PublicKey } from "../desktop-pop-utils";
import {
  ed25519SpkiBase64ToPem,
  normalizeEd25519SpkiPublicKeyPem,
} from "../ed25519-spki-pem";

describe("normalizeEd25519SpkiPublicKeyPem", () => {
  it("accepts and normalizes a valid Ed25519 SPKI public key", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const pem = publicKey.export({ format: "pem", type: "spki" }).toString();

    expect(normalizeEd25519SpkiPublicKeyPem(pem)).toBe(pem);
  });

  it("rejects PEM input that is not an Ed25519 public key", () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = publicKey.export({ format: "pem", type: "spki" }).toString();

    expect(normalizeEd25519SpkiPublicKeyPem(pem)).toBeNull();
  });

  it("rejects malformed PEM data", () => {
    expect(normalizeEd25519SpkiPublicKeyPem("not-a-pem")).toBeNull();
  });
});

function spkiBase64(publicKey: KeyObject): string {
  return publicKey.export({ format: "der", type: "spki" }).toString("base64");
}

describe("ed25519SpkiBase64ToPem", () => {
  it("produces a PEM the refresh path's PoP verifier accepts as the same key", () => {
    const spki = spkiBase64(generateKeyPairSync("ed25519").publicKey);
    const pem = ed25519SpkiBase64ToPem(spki);
    const parsed = createEd25519PublicKey(pem);
    expect(parsed).not.toBeNull();
    expect(
      parsed?.export({ format: "der", type: "spki" }).toString("base64")
    ).toBe(spki);
  });

  it("refuses a public key that is not Ed25519", () => {
    expect(() =>
      ed25519SpkiBase64ToPem(
        spkiBase64(generateKeyPairSync("x25519").publicKey)
      )
    ).toThrow("expected ed25519");
  });

  it("refuses bytes that are not an SPKI", () => {
    expect(() =>
      ed25519SpkiBase64ToPem(Buffer.from("not a key").toString("base64"))
    ).toThrow();
  });
});
